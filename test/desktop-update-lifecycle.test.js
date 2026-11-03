import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";

const { prepareDesktopChange } = createRequire(import.meta.url)("../desktop/update-lifecycle.cjs");
const idleTask = { taskId: "task/encoded", status: "completed", activeRunId: "run-1" };
const detail = (task = idleTask, active = false) => ({ task, runtime: { active } });
const reply = (body, status = 200) => Response.json(body, { status });

function fixture(handler = () => reply({ tasks: [] })) {
  const calls = [];
  const backend = {
    url: "http://127.0.0.1:43210",
    token: "fixture-session-token",
    stops: 0,
    stop() {
      this.stops++;
    }
  };
  return {
    backend,
    calls,
    documents: { request: async () => true },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.method, "GET");
      assert.equal(options.headers["x-atria-token"], backend.token);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return handler(url, calls.length);
    }
  };
}

test("idle preparation authenticates actual loopback HTTP and saves before the second snapshot", async (t) => {
  const order = [];
  const token = "loopback-fixture-token";
  const server = createServer((request, response) => {
    assert.equal(request.headers["x-atria-token"], token);
    assert.equal(request.method, "GET");
    order.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/tasks" ? { tasks: [idleTask] } : detail()));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  let stops = 0;
  const backend = {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    stop: () => stops++
  };
  await prepareDesktopChange({
    backend,
    documents: {
      async request() {
        order.push("save documents and drafts");
        return true;
      }
    }
  });
  assert.deepEqual(order, [
    "/api/tasks",
    "/api/tasks/task%2Fencoded",
    "save documents and drafts",
    "/api/tasks",
    "/api/tasks/task%2Fencoded"
  ]);
  assert.equal(stops, 0, "only the host may stop the backend after successful preparation");
});

test("persisted running tasks block changes without requesting a renderer save", async () => {
  const input = fixture(() => reply({ tasks: [{ taskId: "running", status: "running" }] }));
  let saves = 0;
  input.documents.request = async () => saves++;
  await assert.rejects(prepareDesktopChange(input), /任务正在运行/);
  assert.equal(saves, 0);
  assert.equal(input.calls.length, 1);
  assert.equal(input.backend.stops, 0);
});

test("active runtime and a newly running detail both block otherwise settled task indexes", async (t) => {
  for (const value of [detail(idleTask, true), detail({ ...idleTask, status: "running" }, false)]) {
    await t.test(value.runtime.active ? "active runtime" : "running detail", async () => {
      const input = fixture((url) => reply(url.endsWith("/api/tasks") ? { tasks: [idleTask] } : value));
      let saves = 0;
      input.documents.request = async () => saves++;
      await assert.rejects(prepareDesktopChange(input), /任务正在运行/);
      assert.equal(saves, 0);
      assert.equal(input.backend.stops, 0);
    });
  }
});

test("a task starting while documents save is caught by the second snapshot", async () => {
  let running = false;
  let finishSave;
  const input = fixture(() =>
    reply({ tasks: running ? [{ taskId: "new-run", status: "running", activeRunId: "run-2" }] : [] })
  );
  input.documents.request = () =>
    new Promise((resolve) => {
      finishSave = resolve;
    });
  const pending = prepareDesktopChange({ ...input, action: "修改模型连接" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.calls.length, 1);
  assert.equal(typeof finishSave, "function");
  running = true;
  finishSave(true);
  await assert.rejects(pending, /再修改模型连接/);
  assert.equal(input.calls.length, 2);
  assert.equal(input.backend.stops, 0);
});

test("post-save detail checks catch runtime activity absent from the list", async () => {
  let saved = false;
  const input = fixture((url) =>
    reply(url.endsWith("/api/tasks") ? { tasks: [idleTask] } : detail(idleTask, saved))
  );
  input.documents.request = async () => {
    saved = true;
    return true;
  };
  await assert.rejects(prepareDesktopChange(input), /任务正在运行/);
  assert.equal(input.calls.length, 4);
  assert.equal(input.backend.stops, 0);
});

test("missing authentication or non-loopback backend endpoints fail before any save or request", async (t) => {
  const invalid = [
    undefined,
    { url: "http://127.0.0.1:1234" },
    { url: "http://127.0.0.1:1234", token: "" },
    { url: "http://127.0.0.1:1234", token: "bad\r\ntoken" },
    { url: "https://example.invalid:1234", token: "fixture" },
    { url: "http://127.0.0.1", token: "fixture" },
    { url: "http://user:password@127.0.0.1:1234", token: "fixture" },
    { url: "http://127.0.0.1:1234/other", token: "fixture" },
    { url: "http://127.0.0.1:1234/?token=fixture", token: "fixture" }
  ];
  for (const [index, backend] of invalid.entries()) {
    await t.test(`invalid backend ${index}`, async () => {
      const input = fixture();
      let saved = false;
      input.documents.request = async () => (saved = true);
      await assert.rejects(prepareDesktopChange({ ...input, backend }), /无法确认任务运行状态/);
      assert.equal(input.calls.length, 0);
      assert.equal(saved, false);
    });
  }
});

test("invalid task indexes fail closed instead of assuming an empty workspace", async (t) => {
  const invalid = [
    null,
    {},
    [],
    { tasks: {} },
    { tasks: [null] },
    { tasks: [{ status: "completed" }] },
    { tasks: [{ taskId: "task", status: "unknown" }] },
    { tasks: [{ taskId: "task", status: "completed", activeRunId: 1 }] },
    { tasks: [idleTask, idleTask] }
  ];
  for (const [index, body] of invalid.entries()) {
    await t.test(`invalid index ${index}`, async () => {
      const input = fixture(() => reply(body));
      let saved = false;
      input.documents.request = async () => (saved = true);
      await assert.rejects(prepareDesktopChange(input), /无法确认任务运行状态/);
      assert.equal(saved, false);
      assert.equal(input.backend.stops, 0);
    });
  }
});

test("missing, mismatched or non-boolean detail runtime cannot authorize a shutdown", async (t) => {
  for (const [index, body] of [
    {},
    { task: idleTask },
    { task: idleTask, runtime: { active: "false" } },
    detail({ ...idleTask, taskId: "different-task" }),
    detail({ ...idleTask, status: "unknown" })
  ].entries()) {
    await t.test(`invalid detail ${index}`, async () => {
      const input = fixture((url) => reply(url.endsWith("/api/tasks") ? { tasks: [idleTask] } : body));
      let saved = false;
      input.documents.request = async () => (saved = true);
      await assert.rejects(prepareDesktopChange(input), /无法确认任务运行状态/);
      assert.equal(saved, false);
      assert.equal(input.backend.stops, 0);
    });
  }
});

test("network, HTTP and JSON failures remain safe before and after the document save", async (t) => {
  const failures = [
    () => {
      throw new Error("private server response");
    },
    () => reply({ error: "private server response" }, 401),
    () => new Response("not-json", { status: 200 })
  ];
  for (const [index, fail] of failures.entries()) {
    for (const phase of ["before", "after"]) {
      await t.test(`${phase}-save failure ${index}`, async () => {
        let saved = false;
        const input = fixture(() => (phase === "before" || saved ? fail() : reply({ tasks: [] })));
        input.documents.request = async () => (saved = true);
        await assert.rejects(prepareDesktopChange(input), (error) => {
          assert.match(error.message, /无法确认任务运行状态/);
          assert.doesNotMatch(error.message, /private/);
          return true;
        });
        assert.equal(saved, phase === "after");
        assert.equal(input.backend.stops, 0);
      });
    }
  }
});

test("failed document and draft saves do not recheck or stop the backend", async (t) => {
  for (const outcome of [false, undefined, "true", new Error("private document detail")]) {
    await t.test(String(outcome), async () => {
      const input = fixture();
      input.documents.request = async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      };
      await assert.rejects(prepareDesktopChange(input), (error) => {
        assert.match(error.message, /文档和草稿未能保存/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      });
      assert.equal(input.calls.length, 1);
      assert.equal(input.backend.stops, 0);
    });
  }
  const input = fixture();
  await assert.rejects(prepareDesktopChange({ ...input, documents: {} }), /无法保存文档和草稿/);
  assert.equal(input.calls.length, 0);
});

test("a failed preparation can be retried using the current task snapshot", async () => {
  let active = true;
  let saves = 0;
  const input = fixture(() =>
    reply({ tasks: [{ taskId: "task", status: active ? "running" : "completed" }] })
  );
  input.documents.request = async () => {
    saves++;
    return true;
  };
  await assert.rejects(prepareDesktopChange(input), /任务正在运行/);
  active = false;
  await prepareDesktopChange(input);
  assert.equal(saves, 1);
  assert.equal(input.backend.stops, 0);
});
