import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectionController } from "../web/assets/controllers/connection-controller.js";

function fixture(t, read, tabs = [], hidden = false) {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget();
  const document = (globalThis.document = new EventTarget());
  document.hidden = hidden;
  const events = [];
  let refreshes = 0;
  const host = { openTabs: tabs, handleEvent: (event) => events.push(event) };
  const state = { selected: null, tasks: [] };
  const detailReads = [];
  const controller = createConnectionController({
    state,
    loadDetail: (id) => detailReads.push(id),
    getWorkbench: () => host,
    readApplicationRevisions: read,
    refreshWorkbench: () => {
      refreshes += 1;
    }
  });
  t.after(() => {
    controller.dispose();
    globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
  });
  return {
    controller,
    state,
    detailReads,
    host,
    events,
    document,
    get refreshes() {
      return refreshes;
    }
  };
}

test("committed revisions reach standalone editors, deduplicate and survive conversation stream closure", async (t) => {
  let revision = 0;
  const entry = { kind: "application", appInstanceId: "instance", resourceId: "resource", title: "文稿" };
  const f = fixture(t, async () => ({ instances: [{ ...entry, revision }] }), [entry]);
  await f.controller.refreshApplications();
  await f.controller.refreshApplications();
  assert.deepEqual(
    f.events.map((event) => event.revision),
    [0]
  );
  assert.equal(f.refreshes, 0);
  f.controller.close();
  revision = 1;
  await f.controller.refreshApplications();
  assert.deepEqual(
    f.events.map((event) => event.revision),
    [0, 1]
  );
  assert.equal(f.events[1].type, "resource.operation_applied");
  assert.equal(f.refreshes, 0, "an edit refreshes its adapter without remounting the tab");
});

test("automatic revision checks pause when hidden, catch up on return, and explicit reads remain available", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let reads = 0;
  const entry = { kind: "application", appInstanceId: "instance", resourceId: "resource", title: "文稿" };
  const f = fixture(
    t,
    async () => {
      reads++;
      return { instances: [] };
    },
    [entry],
    true
  );
  t.mock.timers.tick(2000);
  await Promise.resolve();
  assert.equal(reads, 0);
  await f.controller.refreshApplications();
  assert.equal(reads, 1, "an explicit operation is allowed while hidden");
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(reads, 2, "returning refreshes immediately");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  f.document.hidden = true;
  f.document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(2000);
  assert.equal(reads, 2);
  await f.controller.refreshApplications();
  assert.equal(reads, 3);
});

test("creating a resource in an empty app refreshes tabs once, with all app types routed uniformly", async (t) => {
  const entries = ["text-editor", "pptist", "cad", "blender"].map((appType) => ({
    kind: "application",
    appInstanceId: appType,
    appType,
    title: appType
  }));
  const versions = entries.map((entry) => ({
    ...entry,
    resourceId: `resource-${entry.appType}`,
    revision: 1
  }));
  const f = fixture(t, async () => ({ instances: versions }), entries);
  await f.controller.refreshApplications();
  assert.equal(f.refreshes, 1);
  assert.deepEqual(
    f.events.map((event) => event.appType),
    ["text-editor", "pptist", "cad", "blender"]
  );
  f.host.openTabs = versions;
  await f.controller.refreshApplications();
  assert.equal(f.refreshes, 1);
  assert.equal(f.events.length, 4);
});

test("an adapter read failure retries the same committed revision", async (t) => {
  const entry = { kind: "application", appInstanceId: "instance", resourceId: "resource", title: "文稿" };
  const f = fixture(t, async () => ({ instances: [{ ...entry, revision: 1 }] }), [entry]);
  let calls = 0;
  f.host.handleEvent = async () => ++calls > 1;
  await f.controller.refreshApplications();
  await f.controller.refreshApplications();
  await f.controller.refreshApplications();
  assert.equal(calls, 2);
});

test("revision checks merge overlapping requests and discard closed instances from a delayed response", async (t) => {
  let resolveRead,
    reads = 0;
  const f = fixture(t, () => {
    reads += 1;
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  }, [{ kind: "application", appInstanceId: "instance", resourceId: "resource", title: "文稿" }]);
  const pending = f.controller.refreshApplications();
  await f.controller.refreshApplications();
  assert.equal(reads, 1);
  f.host.openTabs = [];
  resolveRead({
    instances: [{ appInstanceId: "instance", resourceId: "resource", revision: 2, title: "文稿" }]
  });
  await pending;
  assert.deepEqual(f.events, []);
  assert.equal(f.refreshes, 0);
});

test("failed revision reads retry and disposing aborts a pending read without touching the editor", async (t) => {
  let calls = 0,
    signal,
    resolveRead;
  const f = fixture(
    t,
    async (nextSignal) => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      signal = nextSignal;
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    },
    [{ kind: "application", appInstanceId: "instance", resourceId: "resource", title: "文稿" }]
  );
  await f.controller.refreshApplications();
  const pending = f.controller.refreshApplications();
  assert.equal(calls, 2);
  f.controller.dispose();
  assert.equal(signal.aborted, true);
  resolveRead({
    instances: [{ appInstanceId: "instance", resourceId: "resource", revision: 2, title: "文稿" }]
  });
  await pending;
  assert.deepEqual(f.events, []);
});

test("only the selected open SSE connection slows fallback polling, and disconnect requests recovery", (t) => {
  const f = fixture(t);
  const streams = [];
  window.EventSource = class {
    constructor() {
      streams.push(this);
    }
    close() {}
  };
  const previousSource = globalThis.EventSource;
  globalThis.EventSource = window.EventSource;
  t.after(() => {
    if (previousSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousSource;
  });
  f.state.selected = "a";
  f.state.tasks = ["a", "b"].map((taskId) => ({ taskId, status: "running", activeRunId: taskId }));
  f.controller.connect("a");
  assert.equal(f.controller.isStreaming("a"), false);
  streams[0].onopen();
  assert.equal(f.controller.isStreaming("a"), true);
  f.state.selected = "b";
  f.controller.connect("b");
  streams[1].onopen();
  streams[0].onerror();
  assert.equal(f.controller.isStreaming("b"), true, "an old stream cannot change the new connection");
  assert.deepEqual(f.detailReads, []);
  streams[1].onerror();
  assert.equal(f.controller.isStreaming("b"), false);
  assert.deepEqual(f.detailReads, ["b"]);
  f.controller.connect("b");
  streams[2].onopen();
  f.controller.close();
  assert.equal(f.controller.isStreaming("b"), false);
});

test("page restoration bypasses a warmed revision backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const entry = { kind: "application", appInstanceId: "a", resourceId: "r", title: "document" };
  const f = fixture(t, async () => {
    reads++;
    return { instances: [{ ...entry, revision: 1 }] };
  }, [entry]);
  await f.controller.refreshApplications();
  await f.controller.refreshApplications();
  assert.equal(reads, 2);
  await f.controller.refreshApplications({ poll: true });
  assert.equal(reads, 2, "an unchanged background window is sleeping");
  f.document.hidden = true;
  f.document.dispatchEvent(new Event("visibilitychange"));
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(reads, 3, "restoration must not wait for the previous deadline");
});
