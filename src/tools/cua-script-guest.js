// Installed only inside QuickJS. This module never executes guest code in Node.
export function installCuaGuest() {
  const rpc = globalThis.__cuaRpc;
  const print = globalThis.__cuaPrint;
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const GuestWeakMap = WeakMap,
    GuestError = Error;
  const getDescriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn;
  function boundedStringify(value) {
    const depths = new GuestWeakMap();
    return stringify(value, function (_key, entry) {
      if (entry && typeof entry === "object") {
        const depth = (depths.get(this) ?? -1) + 1;
        if (depth > 24) {
          const error = new GuestError("CUA JSON nesting exceeds the limit");
          error.errorCode = "output_limit";
          throw error;
        }
        depths.set(entry, depth);
      }
      return entry;
    });
  }
  function failureResult(thrown) {
    let fields = "",
      hasMessage = false;
    if (thrown && (typeof thrown === "object" || typeof thrown === "function")) {
      const keys = [
        "message",
        "name",
        "stack",
        "errorCode",
        "dispatchStatus",
        "requiresObservation",
        "status",
        "authorizationRequired",
        "nextStep"
      ];
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        try {
          const descriptor = getDescriptor(thrown, key);
          if (!descriptor || !hasOwn(descriptor, "value")) continue;
          const value = descriptor.value,
            type = typeof value;
          if (type !== "string" && type !== "number" && type !== "boolean") continue;
          // Quote primitives only: no guest toJSON, recursive graph or getter is invoked.
          fields +=
            (fields ? "," : "") +
            stringify(key) +
            ":" +
            stringify(type === "string" ? value.slice(0, 2048) : value);
          if (key === "message") hasMessage = true;
        } catch {}
      }
    }
    if (!hasMessage)
      fields +=
        (fields ? "," : "") +
        '"message":' +
        stringify(typeof thrown === "string" ? thrown.slice(0, 2048) : "CUA script failed");
    return '{"ok":false,"error":{' + fields + "}}";
  }
  async function call(name, params) {
    const reply = parse(await rpc(name, boundedStringify(params || {})));
    if (!reply.ok) {
      const error = new Error(reply.error.error || reply.error.message || "CUA tool failed");
      Object.assign(error, reply.error);
      throw error;
    }
    return reply.value;
  }
  function optionsFor(options, fields) {
    const selected = {};
    for (const field of fields) if (options[field] !== undefined) selected[field] = options[field];
    return selected;
  }
  function observationRequired(value = {}) {
    return Object.assign(
      new GuestError("Fresh observation required before further input; do not resend the previous action"),
      {
        errorCode: "observation_required",
        dispatchStatus: value.dispatchStatus || "not_sent",
        requiresObservation: true
      }
    );
  }
  function waited(value, options) {
    if (value.status !== "condition_met" && options.allowTimeout !== true)
      throw Object.assign(new GuestError("CUA wait condition was not met"), {
        errorCode: "wait_timeout",
        status: value.status,
        dispatchStatus: "not_sent"
      });
    return value;
  }
  class Window {
    constructor(sessionId) {
      this.sessionId = sessionId;
      this.observation = null;
      this.requiresObservation = false;
    }
    async observe() {
      this.observation = null;
      this.requiresObservation = true;
      const value = await call("computer_observe", { sessionId: this.sessionId });
      this.observation = value;
      this.requiresObservation = false;
      return value;
    }
    async act(action) {
      if (this.requiresObservation) throw observationRequired();
      if (!this.observation) await this.observe();
      const observationId = this.observation.observationId;
      this.observation = null;
      this.requiresObservation = true;
      const value = await call("computer_act", { sessionId: this.sessionId, observationId, action });
      this.observation = value.observation || null;
      if (value.requiresObservation) throw observationRequired(value);
      this.requiresObservation = false;
      return value;
    }
    async wait(condition, options = {}) {
      this.observation = null;
      this.requiresObservation = true;
      const value = await call("computer_wait", {
        sessionId: this.sessionId,
        condition,
        ...optionsFor(options, ["timeoutMs"])
      });
      this.observation = value.observation || null;
      this.requiresObservation = !this.observation;
      if (value.requiresObservation) throw observationRequired(value);
      return waited(value, options);
    }
    async release() {
      this.observation = null;
      this.requiresObservation = true;
      return call("computer_release", { sessionId: this.sessionId });
    }
  }
  class Locator {
    constructor(tab, target) {
      this.tab = tab;
      this.target = target;
    }
    nth(index) {
      return new Locator(this.tab, { ...this.target, nth: index });
    }
    locator(target) {
      const { scope = [], frameId, ...atom } = this.target;
      return new Locator(this.tab, { ...target, scope: [...scope, atom], ...(frameId ? { frameId } : {}) });
    }
    getByRole(role, options = {}) {
      return this.locator({ kind: "role", role, name: options.name });
    }
    getByLabel(text) {
      return this.locator({ kind: "label", text });
    }
    getByText(text) {
      return this.locator({ kind: "text", text });
    }
    getByTestId(text) {
      return this.locator({ kind: "testId", text });
    }
    click(options = {}) {
      return this.tab.act(
        { type: "click", target: this.target, ...optionsFor(options, ["expectDownload"]) },
        options
      );
    }
    fill(value, options = {}) {
      return this.tab.act({ type: "fill", target: this.target, value }, options);
    }
    press(key, options = {}) {
      return this.tab.act({ type: "press", target: this.target, key }, options);
    }
    select(value, options = {}) {
      return this.tab.act({ type: "select", target: this.target, value }, options);
    }
    waitFor(options = {}) {
      return this.tab.wait(
        { type: "element", target: this.target, state: options.state || "visible" },
        options
      );
    }
  }
  class Tab {
    constructor(pageId, observation = null, frameId) {
      this.pageId = pageId;
      this.observation = observation;
      this.frameId = frameId;
      this.requiresObservation = false;
    }
    async observe(options = {}) {
      this.observation = null;
      const wasRequired = this.requiresObservation;
      this.requiresObservation = true;
      const value = await call("browser_observe", {
        pageId: this.pageId,
        ...(this.frameId ? { frameId: this.frameId } : {}),
        ...optionsFor(options, ["timeoutMs", "observation", "frameId"])
      });
      this.observation = value.observationStatus === "omitted" ? null : value;
      this.requiresObservation =
        value.requiresObservation === true || (value.observationStatus === "omitted" ? wasRequired : false);
      return value;
    }
    async act(action, options = {}) {
      if (this.requiresObservation) throw observationRequired();
      const observationId = options.observationId || this.observation?.observationId;
      this.observation = null;
      this.requiresObservation = true;
      const value = await call("browser_act", {
        pageId: this.pageId,
        action,
        ...(action.target?.frameId || this.frameId
          ? { frameId: action.target?.frameId || this.frameId }
          : {}),
        ...(["click_at", "drag", "scroll"].includes(action.type) && observationId ? { observationId } : {}),
        ...optionsFor(options, ["timeoutMs", "observation"])
      });
      this.observation = value.observation || null;
      if (value.requiresObservation) throw observationRequired(value);
      this.requiresObservation = false;
      return value;
    }
    goto(url, options = {}) {
      return this.act({ type: "navigate", url }, options);
    }
    clickAt(x, y, options = {}) {
      return this.act({ type: "click_at", x, y, ...optionsFor(options, ["button"]) }, options);
    }
    drag(from, to, options = {}) {
      return this.act({ type: "drag", from, to }, options);
    }
    scroll(x, y, deltaX, deltaY, options = {}) {
      return this.act({ type: "scroll", x, y, deltaX, deltaY }, options);
    }
    async wait(condition, options = {}) {
      const wasRequired = this.requiresObservation;
      this.observation = null;
      this.requiresObservation = true;
      const value = await call("browser_wait", {
        pageId: this.pageId,
        condition,
        ...(condition.target?.frameId || this.frameId
          ? { frameId: condition.target?.frameId || this.frameId }
          : {}),
        ...optionsFor(options, ["timeoutMs", "observation"])
      });
      this.observation = value.observation || null;
      this.requiresObservation =
        value.requiresObservation === true || (this.observation ? false : wasRequired);
      if (value.requiresObservation) throw observationRequired(value);
      return waited(value, options);
    }
    close() {
      this.observation = null;
      this.requiresObservation = true;
      return call("browser_close", { pageId: this.pageId });
    }
    frame(frameId) {
      return new Tab(this.pageId, null, frameId);
    }
    locator(target) {
      return new Locator(this, { ...target, ...(this.frameId ? { frameId: this.frameId } : {}) });
    }
    getByRole(role, options = {}) {
      return this.locator({ kind: "role", role, name: options.name });
    }
    getByLabel(text) {
      return this.locator({ kind: "label", text });
    }
    getByText(text) {
      return this.locator({ kind: "text", text });
    }
    getByTestId(text) {
      return this.locator({ kind: "testId", text });
    }
  }
  Object.defineProperty(globalThis, "state", { value: {}, writable: false, configurable: false });
  Object.defineProperty(globalThis, "cua", {
    value: Object.freeze({
      computer: Object.freeze({
        status: () => call("computer_status", {}),
        discover: () => call("computer_discover", {}),
        async select(params) {
          const value = await call("computer_select", params);
          if (!value.session || !value.session.sessionId)
            throw new Error("computer_select did not return a session");
          return new Window(value.session.sessionId);
        },
        use: (sessionId) => new Window(sessionId)
      }),
      browser: Object.freeze({
        async open(url, options = {}) {
          const value = await call("browser_open", { url, ...options });
          if (!value.pageId) throw new Error("browser_open did not return a pageId");
          return new Tab(value.pageId, value);
        },
        use: (pageId) => new Tab(pageId)
      }),
      emitImage: (imageRef) => call("__emit_image", { imageRef })
    }),
    writable: false,
    configurable: false
  });
  Object.defineProperty(globalThis, "console", {
    value: Object.freeze({
      log: (...args) => print(boundedStringify(args)),
      info: (...args) => print(boundedStringify(args)),
      warn: (...args) => print(boundedStringify(args))
    }),
    writable: false,
    configurable: false
  });
  // Capture JSON builtins so a cell cannot replace host-result parsing or serialization.
  Object.defineProperty(globalThis, "__cuaResult", {
    value: boundedStringify,
    writable: false,
    configurable: false
  });
  Object.defineProperty(globalThis, "__cuaFailure", {
    value: failureResult,
    writable: false,
    configurable: false
  });
  delete globalThis.__cuaRpc;
  delete globalThis.__cuaPrint;
}
