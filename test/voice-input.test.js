import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceInput } from "../web/assets/controllers/voice-input.js";

function fixture({ supported = true, throws = false, immediateStart = true, nativeVoice } = {}) {
  let recognizer;
  let context = "first-conversation";
  let saved = 0;
  const messages = [];
  const listeners = new Map();
  const attributes = new Map();
  const button = {
    classList: { toggle() {} },
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name)
  };
  const input = { value: "原有草稿", focus() {} };
  class Recognition {
    constructor() {
      recognizer = this;
    }
    start() {
      if (throws) throw new Error("microphone unavailable");
      if (immediateStart) this.onstart();
    }
    stop() {
      this.onend();
    }
    abort() {
      this.aborted = true;
      this.onend();
    }
  }
  const controller = createVoiceInput({
    button,
    input,
    getContext: () => context,
    onChange: () => saved++,
    showToast: (message) => messages.push(message),
    Recognition: supported ? Recognition : undefined,
    nativeVoice
  });
  return {
    button,
    input,
    attributes,
    messages,
    controller,
    start: () => listeners.get("click")(),
    recognize: (text) => recognizer.onresult({ results: [[{ transcript: text }]] }),
    switchConversation: () => {
      context = "second-conversation";
      input.value = "第二个会话的草稿";
    },
    recognizer: () => recognizer,
    saved: () => saved
  };
}

test("voice input appends to the current draft instead of overwriting typing", () => {
  const voice = fixture();
  voice.start();
  voice.input.value += "，聆听期间继续编辑";
  voice.recognize("补充语音");
  assert.equal(voice.input.value, "原有草稿，聆听期间继续编辑\n补充语音");
  assert.equal(voice.saved(), 1);
  assert.equal(voice.attributes.get("aria-pressed"), "true");
  voice.recognizer().onend();
  assert.equal(voice.attributes.get("aria-pressed"), "false");
});

function nativeBridge() {
  const calls = [];
  const pendingStarts = new Map();
  const pendingStops = new Map();
  let listener;
  const sessionId = () => calls.filter(([operation]) => operation === "start").at(-1)[1].sessionId;
  const defer = (pending, id) =>
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  return {
    calls,
    supported: true,
    start(options) {
      calls.push(["start", options]);
      return defer(pendingStarts, options.sessionId);
    },
    stop(options) {
      calls.push(["stop", options]);
      return defer(pendingStops, options.sessionId);
    },
    cancel(options) {
      calls.push(["cancel", options]);
      return Promise.resolve();
    },
    onEvent(handler) {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
    emit(value) {
      listener?.(value);
    },
    ready(id = sessionId()) {
      pendingStarts.get(id)?.resolve();
    },
    rejectStart(id, error) {
      pendingStarts.get(id)?.reject(error);
    },
    rejectStop(id, error) {
      pendingStops.get(id)?.reject(error);
    },
    sessionId
  };
}

test("desktop voice works without Web Speech and appends only its own final result", async () => {
  const native = nativeBridge();
  const voice = fixture({ supported: false, nativeVoice: native });
  assert.equal(voice.button.disabled, false);
  voice.start();
  const sessionId = native.sessionId();
  assert.match(voice.attributes.get("aria-label"), /停止/);
  native.emit({ sessionId: "another-session", type: "result", transcript: "错误结果" });
  native.emit({ sessionId, type: "started" });
  voice.input.value += "，识别期间继续输入";
  native.emit({ sessionId, type: "result", transcript: " " });
  native.emit({ sessionId, type: "result", transcript: "系统识别的补充内容" });
  native.emit({ sessionId, type: "result", transcript: "系统识别的补充内容" });
  assert.equal(voice.input.value, "原有草稿，识别期间继续输入\n系统识别的补充内容");
  assert.equal(voice.saved(), 1);
  voice.start();
  assert.deepEqual(native.calls.at(-1), ["stop", { sessionId }]);
  native.emit({ sessionId, type: "ended" });
  assert.equal(voice.attributes.get("aria-pressed"), "false");
  native.ready();
  await Promise.resolve();
  voice.controller.destroy();
});

test("desktop permission wait cancels on project change and rejects all late results", async () => {
  const native = nativeBridge();
  const voice = fixture({ supported: false, nativeVoice: native });
  voice.start();
  const sessionId = native.sessionId();
  voice.switchConversation();
  voice.controller.syncContext();
  assert.deepEqual(native.calls.at(-1), ["cancel", { sessionId }]);
  native.ready();
  await Promise.resolve();
  native.emit({ sessionId, type: "started" });
  native.emit({ sessionId, type: "result", transcript: "不应加入新项目" });
  assert.equal(voice.input.value, "第二个会话的草稿");
  assert.equal(voice.saved(), 0);
  assert.equal(voice.attributes.get("aria-pressed"), "false");
  voice.controller.destroy();
});

test("desktop speech failures preserve drafts, release listening state and allow retry", () => {
  const native = nativeBridge();
  const voice = fixture({ supported: false, nativeVoice: native });
  voice.start();
  native.emit({
    sessionId: native.sessionId(),
    type: "error",
    code: "speech-denied",
    message: "请在系统设置开启语音识别权限"
  });
  assert.match(voice.messages.at(-1), /系统设置.*语音识别/);
  assert.equal(voice.input.value, "原有草稿");
  assert.equal(voice.attributes.get("aria-pressed"), "false");
  voice.start();
  assert.equal(native.calls.filter(([operation]) => operation === "start").length, 2);
  voice.controller.destroy();
});

test("clicking again during desktop permission wait cancels immediately and can start a new session", async () => {
  const native = nativeBridge();
  const voice = fixture({ supported: false, nativeVoice: native });
  voice.start();
  const firstId = native.sessionId();
  voice.start();
  assert.deepEqual(native.calls.at(-1), ["cancel", { sessionId: firstId }]);
  assert.equal(voice.attributes.get("aria-pressed"), "false");
  voice.start();
  const nextId = native.calls.at(-1)[1].sessionId;
  assert.notEqual(nextId, firstId);
  native.ready();
  await Promise.resolve();
  native.emit({ sessionId: firstId, type: "result", transcript: "上次取消的结果" });
  assert.equal(voice.input.value, "原有草稿");
  native.emit({ sessionId: nextId, type: "started" });
  native.emit({ sessionId: nextId, type: "result", transcript: "新的输入" });
  assert.equal(voice.input.value, "原有草稿\n新的输入");
  voice.controller.destroy();
});

for (const settlement of ["resolve", "reject"]) {
  test(`a canceled desktop start can ${settlement} late without changing the retry session`, async (t) => {
    const native = nativeBridge();
    const voice = fixture({ supported: false, nativeVoice: native });
    t.after(() => voice.controller.destroy());
    voice.start();
    const firstId = native.sessionId();
    voice.start();
    voice.start();
    const nextId = native.sessionId();
    assert.notEqual(nextId, firstId);
    native.emit({ sessionId: nextId, type: "started" });
    const messageCount = voice.messages.length;
    if (settlement === "resolve") native.ready(firstId);
    else native.rejectStart(firstId, new Error("上次授权请求已失效"));
    await Promise.resolve();
    for (const type of ["started", "result", "error", "ended"]) {
      native.emit({
        sessionId: firstId,
        type,
        transcript: "取消会话的结果",
        message: "取消会话的错误"
      });
    }
    assert.equal(voice.attributes.get("data-voice-state"), "listening");
    assert.equal(voice.messages.length, messageCount);
    assert.equal(voice.input.value, "原有草稿");
    native.emit({ sessionId: nextId, type: "result", transcript: "新的语音内容" });
    assert.equal(voice.input.value, "原有草稿\n新的语音内容");
    assert.equal(voice.saved(), 1);
  });
}

test("a rejected desktop stop releases busy without ended and allows a safe retry", async (t) => {
  const native = nativeBridge();
  const voice = fixture({ supported: false, nativeVoice: native });
  t.after(() => voice.controller.destroy());
  voice.start();
  const firstId = native.sessionId();
  native.emit({ sessionId: firstId, type: "started" });
  voice.start();
  assert.equal(voice.attributes.get("data-voice-state"), "stopping");
  native.rejectStop(firstId, new Error("stop unavailable"));
  await Promise.resolve();
  assert.equal(voice.attributes.get("data-voice-state"), "idle");
  assert.equal(voice.input.value, "原有草稿");
  assert.match(voice.messages.at(-1), /无法结束语音识别/);
  assert.deepEqual(native.calls.at(-1), ["cancel", { sessionId: firstId }]);
  voice.start();
  const nextId = native.sessionId();
  native.emit({ sessionId: nextId, type: "started" });
  native.emit({ sessionId: firstId, type: "ended" });
  native.emit({ sessionId: firstId, type: "result", transcript: "上次停止后的结果" });
  assert.equal(voice.attributes.get("data-voice-state"), "listening");
  native.emit({ sessionId: nextId, type: "result", transcript: "重试成功" });
  assert.equal(voice.input.value, "原有草稿\n重试成功");
});

test("clicking during browser permission wait cancels and isolates all late callbacks from retry", (t) => {
  const voice = fixture({ immediateStart: false });
  t.after(() => voice.controller.destroy());
  voice.start();
  const first = voice.recognizer();
  assert.equal(voice.attributes.get("data-voice-state"), "starting");
  voice.start();
  assert.equal(first.aborted, true);
  assert.equal(voice.attributes.get("data-voice-state"), "idle");
  voice.start();
  const next = voice.recognizer();
  next.onstart();
  const messageCount = voice.messages.length;
  first.onstart();
  first.onerror({ error: "network" });
  first.onend();
  first.onresult({ resultIndex: 0, results: [[{ transcript: "取消识别的结果" }]] });
  assert.equal(voice.attributes.get("data-voice-state"), "listening");
  assert.equal(voice.messages.length, messageCount);
  assert.equal(voice.input.value, "原有草稿");
  next.onresult({ resultIndex: 0, results: [[{ transcript: "新的识别结果" }]] });
  assert.equal(voice.input.value, "原有草稿\n新的识别结果");
  assert.equal(voice.saved(), 1);
});

test("Web Speech network errors report the recognition service rather than microphone permission", () => {
  const voice = fixture();
  voice.start();
  voice.recognizer().onerror({ error: "network" });
  assert.match(voice.messages.at(-1), /语音识别服务.*网络/);
  assert.doesNotMatch(voice.messages.at(-1), /麦克风权限/);
  assert.equal(voice.attributes.get("aria-pressed"), "false");
  assert.equal(voice.input.value, "原有草稿");
});

test("a late speech result cannot change another conversation or revive a canceled listener", () => {
  const voice = fixture();
  voice.start();
  voice.switchConversation();
  voice.recognize("属于第一个会话的结果");
  assert.equal(voice.input.value, "第二个会话的草稿");
  assert.equal(voice.saved(), 0);
  assert.equal(voice.recognizer().aborted, true);
  voice.recognize("排队的结果");
  assert.equal(voice.input.value, "第二个会话的草稿");
});

test("unavailable speech and startup failures leave drafts intact with a clear state", () => {
  const unsupported = fixture({ supported: false });
  assert.equal(unsupported.button.disabled, true);
  assert.match(unsupported.button.title, /不支持/);
  unsupported.start();
  assert.equal(unsupported.input.value, "原有草稿");
  const failed = fixture({ throws: true });
  assert.doesNotThrow(() => failed.start());
  assert.equal(failed.attributes.get("aria-pressed"), "false");
  assert.match(failed.messages.at(-1), /无法启动/);
  assert.equal(failed.input.value, "原有草稿");
});
