const { spawn } = require("node:child_process");
const { access, constants } = require("node:fs/promises");
const path = require("node:path");

const messages = {
  microphone_denied: "麦克风访问被拒绝，请在系统设置 → 隐私与安全性 → 麦克风中允许 CoworkOS，再重启 App",
  microphone_restricted: "系统限制了麦克风访问，请检查系统或设备管理设置",
  speech_denied: "语音识别访问被拒绝，请在系统设置 → 隐私与安全性 → 语音识别中允许 CoworkOS，再重启 App",
  speech_restricted: "系统限制了语音识别访问，请检查系统或设备管理设置",
  input_unavailable: "没有可用的音频输入设备，请连接麦克风后重试",
  recognizer_unavailable: "系统语音识别暂不可用，请检查网络或稍后重试",
  unsupported_locale: "系统暂不支持中文语音识别，请检查 macOS 的听写语言设置",
  audio_start_failed: "无法启动麦克风，请检查输入设备和系统麦克风权限",
  no_speech: "没有检测到声音，请再试一次",
  recognition_failed: "系统语音识别失败，请检查网络或稍后重试",
  recognition_timeout: "语音识别等待超时，请重新尝试",
  assets_unavailable: "系统语音识别资源不可用，请在系统设置中启用中文听写并稍后重试",
  dictation_disabled: "系统听写未启用，请在系统设置 → 键盘中开启听写",
  recognition_busy: "系统语音识别正在使用中，请稍后重试",
  network_unavailable: "无法连接系统语音识别服务，请检查网络后重试",
  speech_authorization_failed: "无法取得系统语音识别权限，请重启 App 后重试",
  helper_missing: "语音识别组件未安装，请重新构建或安装最新版 CoworkOS",
  helper_failed: "语音识别组件已退出，请重新尝试",
  invalid_response: "语音识别组件返回了无效结果，请更新 CoworkOS 后重试",
  response_limit: "语音识别内容过长，请分段输入"
};

function sessionId(input) {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.sessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.sessionId)
  )
    throw new Error("无效的语音输入会话");
  return input.sessionId;
}

/** One bounded native recognizer, owned by the trusted main window's current draft. */
function createDesktopSpeechInput({
  appRoot,
  development = false,
  env = process.env,
  platform = process.platform,
  onEvent = () => {},
  spawnProcess = spawn,
  executableAccess = access,
  startupTimeout = 30_000,
  sessionTimeout = 75_000,
  stopTimeout = 8_000,
  terminationDelay = 400,
  killDelay = 1_200
}) {
  const executable =
    development && env.COWORK_SPEECH_INPUT_EXECUTABLE
      ? path.resolve(env.COWORK_SPEECH_INPUT_EXECUTABLE)
      : path.join(appRoot, "dist/src/gui/atria-speech-input");
  let active,
    disposed = false;
  const children = new Set();
  const seen = new Set();
  const remember = (id) => {
    seen.add(id);
    if (seen.size > 64) seen.delete(seen.values().next().value);
  };
  const emit = (record, event) => {
    if (record.finished || active !== record) return;
    try {
      onEvent({ sessionId: record.id, ...event });
    } catch {
      // A destroyed window must not prevent recognizer cleanup.
    }
  };
  const clearTimers = (record) => {
    for (const timer of record.timers) clearTimeout(timer);
    record.timers.clear();
  };
  const later = (record, callback, duration) => {
    const timer = setTimeout(() => {
      record.timers.delete(timer);
      callback();
    }, duration);
    record.timers.add(timer);
    return timer;
  };
  const send = (record, command) => {
    if (!record.child || record.closed || record.child.stdin.destroyed) return;
    try {
      record.child.stdin.write(`${command}\n`, () => {});
    } catch {
      // close/error is handled by the bounded process lifecycle below.
    }
  };
  const retire = (record) => {
    if (!record.child || record.closed || record.retired) return;
    record.retired = true;
    send(record, "cancel");
    later(
      record,
      () => {
        if (!record.closed) record.child.kill("SIGTERM");
      },
      terminationDelay
    );
    later(
      record,
      () => {
        if (!record.closed) record.child.kill("SIGKILL");
      },
      killDelay
    );
  };
  const finish = (record, reason) => {
    if (record.finished) return;
    clearTimers(record);
    emit(record, { type: "ended", reason });
    record.finished = true;
    if (active === record) active = undefined;
    remember(record.id);
    retire(record);
  };
  const fail = (record, code) => {
    if (record.finished) return;
    emit(record, { type: "error", code, message: messages[code] || messages.recognition_failed });
    finish(record, "error");
  };
  const receive = (record, line) => {
    if (record.finished || active !== record) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return fail(record, "invalid_response");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(record, "invalid_response");
    if (value.type === "started") {
      if (record.started) return;
      if (
        typeof value.locale !== "string" ||
        value.locale.replaceAll("_", "-").toLowerCase() !== "zh-cn" ||
        !["on-device", "apple-network"].includes(value.mode)
      )
        return fail(record, "invalid_response");
      record.started = true;
      clearTimeout(record.startTimer);
      record.timers.delete(record.startTimer);
      emit(record, { type: "started", locale: "zh-CN", mode: value.mode });
    } else if (value.type === "result") {
      if (
        !record.started ||
        value.final !== true ||
        typeof value.transcript !== "string" ||
        value.transcript.includes("\0")
      )
        return fail(record, "invalid_response");
      if (value.transcript.length > 16_000) return fail(record, "response_limit");
      if (!value.transcript.trim()) return fail(record, "no_speech");
      if (record.result) return;
      record.result = true;
      emit(record, { type: "result", transcript: value.transcript, final: true });
    } else if (value.type === "error") {
      if (typeof value.code !== "string" || value.code.length > 64) return fail(record, "invalid_response");
      fail(record, Object.hasOwn(messages, value.code) ? value.code : "recognition_failed");
    } else if (value.type === "ended") {
      if (typeof value.reason !== "string" || !/^[a-z_-]{1,64}$/.test(value.reason))
        return fail(record, "invalid_response");
      finish(record, value.reason);
    } else fail(record, "invalid_response");
  };
  const cancelActive = () => {
    if (active) finish(active, "cancelled");
    return Promise.all([...children].map((child) => child.done));
  };
  return {
    async start(input) {
      const id = sessionId(input);
      if (platform !== "darwin") throw new Error("系统语音输入目前仅支持 Mac App");
      if (disposed) throw new Error("应用正在关闭，请稍后重试");
      if (seen.has(id)) return false;
      if (active) {
        if (active.id === id) return true;
        throw new Error("已有语音输入正在进行，请先停止当前会话");
      }
      // Register before awaiting access/retired processes: cancel during permission
      // preparation must invalidate this start rather than create a ghost session.
      const record = { id, timers: new Set(), buffer: "", bytes: 0 };
      active = record;
      try {
        await Promise.all([...children].map((child) => child.done));
        if (record.finished || disposed) return false;
        await executableAccess(executable, constants.X_OK);
        if (record.finished || disposed) return false;
        // Speech needs no model credentials or renderer/backend configuration.
        const helperEnv = Object.fromEntries(
          ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"]
            .filter((key) => typeof env[key] === "string")
            .map((key) => [key, env[key]])
        );
        record.child = spawnProcess(executable, ["--listen", "--locale", "zh-CN"], {
          env: helperEnv,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true
        });
        record.done = new Promise((resolve) => {
          record.resolve = resolve;
        });
        children.add(record);
        record.child.stdin.on("error", () => {});
        record.child.stdout.setEncoding("utf8");
        record.child.stdout.on("data", (chunk) => {
          if (record.finished) return;
          record.bytes += Buffer.byteLength(chunk, "utf8");
          record.buffer += chunk;
          if (record.bytes > 512 * 1024 || Buffer.byteLength(record.buffer, "utf8") > 128 * 1024)
            return fail(record, "response_limit");
          let newline;
          while ((newline = record.buffer.indexOf("\n")) !== -1) {
            const line = record.buffer.slice(0, newline).replace(/\r$/, "");
            record.buffer = record.buffer.slice(newline + 1);
            if (line) receive(record, line);
            if (record.finished) break;
          }
        });
        record.child.on("error", () => fail(record, "helper_failed"));
        record.child.once("close", () => {
          record.closed = true;
          clearTimers(record);
          if (!record.finished) {
            if (record.buffer.trim()) fail(record, "invalid_response");
            else fail(record, "helper_failed");
          }
          children.delete(record);
          record.resolve();
        });
        record.startTimer = later(record, () => fail(record, "recognition_timeout"), startupTimeout);
        later(record, () => fail(record, "recognition_timeout"), sessionTimeout);
        return true;
      } catch (error) {
        fail(
          record,
          error?.code === "ENOENT" || error?.code === "EACCES" ? "helper_missing" : "helper_failed"
        );
        return false;
      }
    },
    stop(input) {
      const id = sessionId(input);
      if (!active || active.id !== id || active.stopping) return false;
      if (!active.child) {
        finish(active, "cancelled");
        return true;
      }
      const record = active;
      record.stopping = true;
      send(record, "stop");
      later(record, () => fail(record, "recognition_timeout"), stopTimeout);
      return true;
    },
    cancel(input) {
      const id = sessionId(input);
      if (active?.id === id) finish(active, "cancelled");
      // A cancel that arrives before start cannot later launch the same session.
      remember(id);
      return true;
    },
    cancelActive,
    async dispose() {
      disposed = true;
      cancelActive();
      await Promise.all([...children].map((child) => child.done));
    }
  };
}

module.exports = { createDesktopSpeechInput };
