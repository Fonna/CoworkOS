/**
 * Drive the real page against the real server, as a person would.
 *
 * Every other UI test stubs `fetch`. This one does not: `app.js` runs in a DOM
 * and its requests go to a live Dashboard over HTTP, against real files, real
 * revisions and real MCP servers. That is the only way to catch the class of bug
 * this feature kept producing — each layer correct alone, the seam between them
 * broken.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodeFilter, parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";

const HARNESS = resolve(new URL("..", import.meta.url).pathname);

/** A DOM that `app.js` can run in, with its fetch pointed at the live server. */
export function createLiveBrowser(base) {
  const { window, document } = parseHTML(readFileSync(join(HARNESS, "web/index.html"), "utf8"));
  const saved = {
    ...globalThis,
    location: globalThis.location,
    history: globalThis.history,
    NodeFilter: globalThis.NodeFilter
  };
  const pending = new Set();
  const callbackErrors = new Set();
  let pageHidden = false;
  const realTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realImmediate = globalThis.setImmediate;
  const track = (value, callback = false) => {
    if (!value || typeof value.then !== "function") return value;
    const promise = Promise.resolve(value);
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      (error) => {
        pending.delete(promise);
        if (callback) callbackErrors.add(error);
      }
    );
    return value;
  };

  // DOM dispatch ignores an async listener's return value. Keep that actual
  // callback alive through cleanup, including work after its final HTTP body.
  const eventPrototype = window.EventTarget.prototype;
  const realAddListener = eventPrototype.addEventListener;
  const realRemoveListener = eventPrototype.removeEventListener;
  const listeners = new WeakMap();
  const listenerKey = (type, options) =>
    `${type}:${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
  eventPrototype.addEventListener = function (type, listener, options) {
    if (!listener) return realAddListener.call(this, type, listener, options);
    let target = listeners.get(this);
    if (!target) listeners.set(this, (target = new Map()));
    let registered = target.get(listener);
    if (!registered) target.set(listener, (registered = new Map()));
    const key = listenerKey(type, options);
    let wrapped = registered.get(key);
    if (!wrapped) {
      wrapped = function (event) {
        return track(
          typeof listener === "function" ? listener.call(this, event) : listener.handleEvent(event),
          true
        );
      };
      registered.set(key, wrapped);
    }
    return realAddListener.call(this, type, wrapped, options);
  };
  eventPrototype.removeEventListener = function (type, listener, options) {
    const registered = listeners.get(this)?.get(listener);
    const key = listenerKey(type, options);
    const wrapped = registered?.get(key);
    registered?.delete(key);
    return realRemoveListener.call(this, type, wrapped ?? listener, options);
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.NodeFilter = NodeFilter;
  const location = new URL(base);
  const historyCalls = [];
  globalThis.location = window.location = location;
  globalThis.history = window.history = {
    pushState(state, title, url) {
      historyCalls.push({ state, title, url });
      if (url !== undefined && url !== null) location.href = new URL(url, location).href;
    },
    replaceState(_state, _title, url) {
      if (url !== undefined && url !== null) location.href = new URL(url, location).href;
    }
  };
  globalThis.CSS ??= { escape: (v) => String(v).replace(/["\\]/g, "\\$&") };
  // The page's SSE. Real EventSource is not in Node, and the parts under test
  // here are the request/response flows, so it connects to nothing.
  globalThis.EventSource = class {
    constructor() {}
    close() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.devicePixelRatio = window.devicePixelRatio = 2;
  globalThis.innerWidth = window.innerWidth = 1440;
  globalThis.innerHeight = window.innerHeight = 900;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  // linkedom does not perform layout. Model the shell's hidden panels so its
  // dialog visibility and keyboard focus checks see the same open/closed state.
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 1, height: 1 }];
  };
  const media = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  });
  globalThis.matchMedia = window.matchMedia = media;
  // linkedom has no KeyboardEvent, and the editor listens for Ctrl+S. A plain
  // Event carrying the same fields is what the handler actually reads.
  if (!window.KeyboardEvent) {
    window.KeyboardEvent = class extends window.Event {
      constructor(type, init = {}) {
        super(type, init);
        this.key = init.key;
        this.ctrlKey = Boolean(init.ctrlKey);
        this.metaKey = Boolean(init.metaKey);
        this.shiftKey = Boolean(init.shiftKey);
      }
      preventDefault() {}
    };
  }
  const timers = new Set();
  const timeouts = new Map();
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, ms, ...args) => {
    const id = realInterval(
      function (...values) {
        return track(callback.apply(this, values), true);
      },
      ms,
      ...args
    );
    timers.add(id);
    return id;
  };
  globalThis.setTimeout = (callback, ms, ...args) => {
    let complete;
    const done = new Promise((resolve) => (complete = resolve));
    track(done);
    const id = realTimeout(
      function (...values) {
        timeouts.delete(id);
        try {
          return track(callback.apply(this, values), true);
        } finally {
          complete();
        }
      },
      ms,
      ...args
    );
    timeouts.set(id, complete);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    realClearTimeout(id);
    timeouts.get(id)?.();
    timeouts.delete(id);
  };
  const ctx = new Proxy({}, { get: () => () => {}, has: () => true });
  const create = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    const el = create(tag, ...rest);
    if (String(tag).toLowerCase() === "canvas") el.getContext = () => ctx;
    return el;
  };
  for (const canvas of document.querySelectorAll("canvas")) canvas.getContext = () => ctx;

  // The one piece that makes this a real test: relative URLs resolve to the
  // live Dashboard instead of a stub.
  const realFetch = globalThis.fetch;
  const requests = [];
  const responseBodies = (response) => {
    for (const name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
      const method = response[name];
      if (typeof method === "function")
        response[name] = function (...args) {
          return track(method.apply(this, args));
        };
    }
    if (typeof response.clone === "function") {
      const clone = response.clone;
      response.clone = function (...args) {
        return responseBodies(clone.apply(this, args));
      };
    }
    return response;
  };
  globalThis.fetch = (path, options) => {
    const url = String(path);
    const absolute = url.startsWith("http") ? url : base + url;
    requests.push(`${options?.method ?? "GET"} ${url.split("?")[0]}`);
    return track(realFetch(absolute, options).then(responseBodies));
  };

  return {
    window,
    document,
    requests,
    historyCalls,
    $: (s) => document.querySelector(s),
    $$: (s) => [...document.querySelectorAll(s)],
    async quiesce({ timeoutMs = 15000 } = {}) {
      // Stop new polls, then drain bodies, event callbacks and debounce timers.
      // Two idle event-loop turns also catch work scheduled by a completion.
      if (!pageHidden) {
        pageHidden = true;
        window.dispatchEvent(new window.Event("pagehide"));
      }
      for (const id of timers) clearInterval(id);
      let deadline;
      let draining = true;
      try {
        await Promise.race([
          (async () => {
            let idle = 0;
            while (draining && idle < 2) {
              if (pending.size) {
                idle = 0;
                await Promise.allSettled([...pending]);
              }
              await new Promise((done) => realImmediate(done));
              idle = pending.size ? 0 : idle + 1;
            }
          })(),
          new Promise((_, reject) => {
            deadline = realTimeout(() => {
              const error = new Error(`Live UI cleanup timed out with ${pending.size} pending operations`);
              error.code = "LIVE_UI_CLEANUP_TIMEOUT";
              reject(error);
            }, timeoutMs);
          })
        ]);
      } finally {
        draining = false;
        realClearTimeout(deadline);
      }
      if (callbackErrors.size)
        throw new AggregateError([...callbackErrors], "Live UI asynchronous callback failed");
    },
    restore() {
      for (const id of timers) clearInterval(id);
      for (const [id, complete] of timeouts) {
        realClearTimeout(id);
        complete();
      }
      eventPrototype.addEventListener = realAddListener;
      eventPrototype.removeEventListener = realRemoveListener;
      globalThis.setTimeout = realTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.setInterval = realInterval;
      globalThis.fetch = realFetch;
      for (const key of [
        "document",
        "window",
        "NodeFilter",
        "EventSource",
        "ResizeObserver",
        "IntersectionObserver",
        "MutationObserver",
        "devicePixelRatio",
        "innerWidth",
        "innerHeight",
        "matchMedia",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "getComputedStyle",
        "location",
        "history"
      ]) {
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
      }
    }
  };
}

const settle = (ms = 300) => new Promise((done) => setTimeout(done, ms));

async function waitFor(view, selector) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const node = view.$(selector);
    // Like a real browser, wait until the editor has finished loading before
    // sending input. Synthetic DOM events can otherwise edit a disabled field.
    if (node && !node.disabled) return node;
    await settle(50);
  }
  throw new Error(`element did not appear: ${selector}`);
}

export async function session() {
  const server = await startDashboard();
  const view = createLiveBrowser(server.base);
  const problems = [];
  const onRejection = (e) => problems.push(`unhandledRejection: ${e?.message ?? e}`);
  const onError = (e) => problems.push(`uncaught: ${e?.message ?? e}`);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onError);
  await import(`${join(HARNESS, "web/app.js")}?live=${Math.random().toString(36).slice(2)}`);
  await settle(500);
  let stopping;
  return {
    ...view,
    ...server,
    problems,
    settle,
    waitFor: (selector) => waitFor(view, selector),
    /** Click something the way a person does, and let the page react. */
    async click(selector, wait = 350) {
      const node = typeof selector === "string" ? await waitFor(view, selector) : selector;
      if (!node) throw new Error(`nothing to click: ${selector}`);
      node.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await settle(wait);
      return node;
    },
    /** Type into a field the way a person does, firing the events the page listens for. */
    async type(selector, text, wait = 250) {
      const node = await waitFor(view, selector);
      if (!node) throw new Error(`nothing to type into: ${selector}`);
      node.value = text;
      node.dispatchEvent(new view.window.Event("input", { bubbles: true }));
      await settle(wait);
      return node;
    },
    async nameDocument(title, wait = 900) {
      const field = await waitFor(view, "[data-document-name]");
      if (!field) throw new Error("document naming form is not visible");
      field.value = title;
      field
        .closest("form")
        .dispatchEvent(new view.window.Event("submit", { bubbles: true, cancelable: true }));
      await settle(wait);
    },
    /** Press a key in a field, e.g. Ctrl+S. */
    async press(selector, key, modifiers = {}, wait = 600) {
      const node = await waitFor(view, selector);
      if (!node) throw new Error(`nothing to press into: ${selector}`);
      node.dispatchEvent(new view.window.KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }));
      await settle(wait);
      return node;
    },
    stop() {
      return (stopping ??= (async () => {
        const failures = new Set();
        try {
          await view.quiesce();
        } catch (error) {
          failures.add(error);
          if (error.code === "LIVE_UI_CLEANUP_TIMEOUT") {
            // Closing the server releases stalled bodies while the DOM and
            // exception observers still exist. Never turn a timeout into pass.
            try {
              await server.stop();
              await view.quiesce({ timeoutMs: 3000 });
            } catch (cleanupError) {
              failures.add(cleanupError);
            }
          }
        } finally {
          try {
            await server.stop();
          } catch (error) {
            failures.add(error);
          } finally {
            view.restore();
            process.off("unhandledRejection", onRejection);
            process.off("uncaughtException", onError);
          }
        }
        if (failures.size === 1) throw [...failures][0];
        if (failures.size) throw new AggregateError([...failures], "Live UI cleanup failed");
      })());
    }
  };
}
