import { ui } from "../ui/language.js";
const browserErrors = {
  "no-speech": ui("没有检测到声音，请再试一次"),
  "audio-capture": ui("无法读取麦克风，请检查输入设备和系统麦克风权限"),
  "not-allowed": ui("麦克风访问被拒绝，请在浏览器或系统设置中允许麦克风"),
  "service-not-allowed": ui("当前浏览器的语音识别服务不可用，可使用 Mac App 的系统语音输入"),
  network: ui("无法连接浏览器语音识别服务，请检查网络，或使用 Mac App 的系统语音输入"),
  "language-not-supported": ui("当前语音识别服务不支持中文，请使用系统听写或 Mac App")
};

/** Speech sessions belong to the draft that started listening, including permission waits. */
export function createVoiceInput({
  button,
  input,
  getContext,
  onChange,
  showToast,
  Recognition,
  nativeVoice
}) {
  const native =
    nativeVoice?.supported === true &&
    ["start", "stop", "cancel", "onEvent"].every((name) => typeof nativeVoice[name] === "function")
      ? nativeVoice
      : undefined;
  let active;
  let sequence = 0;
  const render = (phase = "idle") => {
    const busy = phase !== "idle";
    button.classList.toggle("listening", busy);
    button.setAttribute("aria-pressed", String(busy));
    button.setAttribute("data-voice-state", phase);
    button.setAttribute("aria-busy", String(phase === "starting" || phase === "stopping"));
    button.setAttribute("aria-label", busy ? ui("停止语音输入") : ui("语音输入"));
    button.title = busy
      ? phase === "starting"
        ? ui("正在准备语音输入，点击停止")
        : phase === "stopping"
          ? ui("正在完成语音识别")
          : ui("停止聆听")
      : native
        ? ui("语音输入（macOS 系统识别）")
        : Recognition
          ? ui("语音输入（浏览器识别，需识别服务可用）")
          : ui("当前浏览器不支持语音输入，可使用系统听写");
  };
  button.disabled = !native && !Recognition;
  render();

  const nativeCall = (operation, session) => {
    try {
      return Promise.resolve(native[operation]({ sessionId: session.sessionId }));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const cancel = () => {
    const previous = active;
    active = undefined;
    render();
    if (!previous) return;
    if (previous.sessionId) {
      void nativeCall("cancel", previous).catch(() => {});
      return;
    }
    try {
      if (previous.recognition.abort) previous.recognition.abort();
      else previous.recognition.stop();
    } catch {
      // A recognizer may already have ended while its final callback is queued.
    }
  };
  const syncContext = () => {
    if (active && active.context !== getContext()) cancel();
  };
  const ownsDraft = (session) => {
    if (active !== session) return false;
    if (session.context !== getContext()) {
      cancel();
      return false;
    }
    return true;
  };
  const append = (session, text) => {
    if (!ownsDraft(session) || typeof text !== "string") return;
    const transcript = text.trim();
    if (!transcript) return;
    const separator = input.value && !/\s$/.test(input.value) ? "\n" : "";
    input.value += separator + transcript;
    onChange();
    input.focus();
    showToast(ui("语音已加入草稿"));
  };
  const fail = (session, message) => {
    if (!ownsDraft(session)) return;
    cancel();
    showToast(message);
  };
  const unsubscribe = native?.onEvent((event) => {
    const session = active;
    if (!session || event?.sessionId !== session.sessionId || !ownsDraft(session)) return;
    if (event.type === "started") {
      session.started = true;
      if (!session.stopping) {
        render("listening");
        showToast(ui("正在聆听…说完后点击麦克风"));
      }
    } else if (event.type === "result" && !session.receivedFinal) {
      if (typeof event.transcript !== "string" || !event.transcript.trim()) return;
      session.receivedFinal = true;
      append(session, event.transcript);
    } else if (event.type === "error") {
      fail(
        session,
        typeof event.message === "string" && event.message.trim()
          ? event.message
          : ui("系统语音识别暂不可用，请稍后重试")
      );
    } else if (event.type === "ended") {
      active = undefined;
      render();
    }
  });
  const start = () => {
    syncContext();
    if (active) {
      if (!active.started) return cancel();
      if (active.stopping) return;
      const session = active;
      session.stopping = true;
      render("stopping");
      if (session.sessionId) {
        void nativeCall("stop", session).catch(() => {
          fail(session, ui("无法结束语音识别，请重新尝试"));
        });
      } else {
        try {
          session.recognition.stop();
        } catch {
          cancel();
        }
      }
      return;
    }
    if (native) {
      const session = { sessionId: `voice-${Date.now()}-${++sequence}`, context: getContext() };
      active = session;
      render("starting");
      showToast(ui("正在准备系统语音输入，首次使用请允许麦克风和语音识别权限"));
      void nativeCall("start", session).catch((error) => {
        const message =
          typeof error?.message === "string"
            ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
            : ui("无法启动系统语音识别，请重试");
        fail(session, message);
      });
      return;
    }
    if (!Recognition) return;
    try {
      const recognition = new Recognition();
      const session = { recognition, context: getContext() };
      active = session;
      render("starting");
      recognition.lang = "zh-CN";
      recognition.interimResults = false;
      recognition.onstart = () => {
        if (!ownsDraft(session)) return;
        session.started = true;
        if (!session.stopping) {
          render("listening");
          showToast(ui("正在聆听…说完后点击麦克风"));
        }
      };
      recognition.onresult = (event) => {
        if (!ownsDraft(session)) return;
        const transcript = Array.from(event.results)
          .slice(event.resultIndex || 0)
          .map((result) => result[0]?.transcript || "")
          .join("");
        append(session, transcript);
      };
      recognition.onerror = (event) => {
        if (event.error === "aborted") {
          if (ownsDraft(session)) cancel();
          return;
        }
        fail(session, browserErrors[event.error] || ui("浏览器语音识别暂不可用，请稍后重试"));
      };
      recognition.onend = () => {
        if (active !== session) return;
        active = undefined;
        render();
      };
      recognition.start();
    } catch {
      cancel();
      showToast(ui("无法启动语音输入，请检查麦克风权限和识别服务"));
    }
  };
  button.addEventListener("click", start);
  return {
    syncContext,
    cancel,
    destroy() {
      cancel();
      unsubscribe?.();
      button.removeEventListener("click", start);
    }
  };
}
