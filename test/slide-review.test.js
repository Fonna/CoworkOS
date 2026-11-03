import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, realpath, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { createSlideReviewTool } from "../dist/src/tools/slide-review.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
const cfg = {
  baseUrl: "https://vision.test/v1",
  apiKey: "private-test-key",
  model: "vision-test",
  timeoutMs: 1000
};
const pass = { status: "pass", summary: "Legible", issues: [] };
const issue = {
  status: "needs_revision",
  summary: "Clipped",
  issues: [{ severity: "major", location: "title", problem: "clipped", fix: "recompose" }]
};
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const tick = () => new Promise((r) => setTimeout(r, 0));
async function setup(n = 4) {
  const root = await mkdtemp(join(tmpdir(), "atria-batch-"));
  const slides = [];
  for (let i = 0; i < n; i++) {
    const path = `slide-${i}.png`;
    await writeFile(join(root, path), Buffer.concat([pixel, Buffer.from("pixels" + i)]));
    slides.push({ path });
  }
  return { root, slides, reportPath: "preview/review.json" };
}

test("worker pool starts the next page without waiting for a slow peer; restart reuses exact evidence", async () => {
  const x = await setup();
  const started = [];
  const release = new Map();
  let active = 0,
    peak = 0;
  const analyze = async (_cfg, input) => {
    started.push(input.path);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => release.set(input.path, r));
    active--;
    const review = input.path === "slide-2.png" ? issue : pass;
    return { report: JSON.stringify(review), review, imageHash: "unused", elapsedMs: 1, cached: false };
  };
  try {
    const tool = createSlideReviewTool({ rootDirectory: x.root, visionModel: cfg, analyze });
    const work = tool.execute({ ...x, concurrency: 2 });
    while (started.length < 2) await tick();
    assert.equal(peak, 2);
    release.get("slide-0.png")();
    while (started.length < 3) await tick();
    assert.equal(started[2], "slide-2.png");
    assert.ok(!release.has("slide-3.png"));
    release.get("slide-2.png")();
    while (started.length < 4) await tick();
    release.get("slide-3.png")();
    release.get("slide-1.png")();
    const first = await work;
    assert.equal(first.summary.needsRevision, 1);
    assert.equal(first.everySubmittedPagePassed, false);
    assert.equal(peak, 2);
    let requests = 0;
    const fresh = createSlideReviewTool({
      rootDirectory: x.root,
      visionModel: cfg,
      analyze: async () => {
        requests++;
        return { report: JSON.stringify(pass), review: pass, elapsedMs: 1 };
      }
    });
    const cached = await fresh.execute(x);
    assert.equal(cached.summary.reused, 4);
    assert.equal(requests, 0);
    assert.equal(cached.summary.needsRevision, 1);
    await writeFile(join(x.root, "slide-2.png"), "fixed pixels");
    const fixed = await fresh.execute(x);
    assert.equal(requests, 1);
    assert.equal(fixed.summary.reused, 3);
    assert.equal(fixed.everySubmittedPagePassed, true);
    const saved = await readFile(join(x.root, x.reportPath), "utf8");
    assert.ok(!saved.includes(cfg.apiKey));
    assert.equal(JSON.parse(saved).checks.length, 5);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test("invalid responses stop after one retry, survive restart, and never become passing checks", async () => {
  const x = await setup(1);
  let calls = 0;
  const make = () =>
    createSlideReviewTool({
      rootDirectory: x.root,
      visionModel: cfg,
      analyze: async () => {
        calls++;
        throw new Error("malformed response");
      }
    });
  try {
    const a = await make().execute(x);
    assert.equal(calls, 2);
    assert.equal(a.summary.unreviewed, 1);
    assert.equal(a.everySubmittedPagePassed, false);
    await make().execute(x);
    assert.equal(calls, 2);
    const state = JSON.parse(await readFile(join(x.root, x.reportPath), "utf8"));
    assert.equal(state.slides[0].attempts, 2);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test("goal changes invalidate cache; duplicate pixels in a batch share evidence; cancelled work stays unreviewed", async () => {
  const x = await setup(2);
  let calls = 0;
  const tool = createSlideReviewTool({
    rootDirectory: x.root,
    visionModel: cfg,
    analyze: async () => {
      calls++;
      return { report: JSON.stringify(pass), review: pass, elapsedMs: 1 };
    }
  });
  try {
    await writeFile(join(x.root, x.slides[1].path), Buffer.concat([pixel, Buffer.from("pixels0")]));
    await tool.execute(x);
    assert.equal(calls, 1);
    const changed = { ...x, slides: x.slides.map((s) => ({ ...s, goal: "check arrow direction" })) };
    await tool.execute(changed);
    assert.equal(calls, 2);
    const controller = new AbortController();
    controller.abort();
    const a = await tool.execute(
      { ...x, slides: [{ path: x.slides[0].path, goal: "new goal" }] },
      controller.signal
    );
    assert.equal(a.summary.unreviewed, 1);
    assert.equal(calls, 2);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test("all paths are validated before requests, including output and input symlink escapes", async () => {
  const x = await setup(1),
    outside = await mkdtemp(join(tmpdir(), "atria-outside-"));
  let calls = 0;
  const tool = createSlideReviewTool({
    rootDirectory: x.root,
    visionModel: cfg,
    analyze: async () => {
      calls++;
      return { review: pass, report: JSON.stringify(pass), elapsedMs: 1 };
    }
  });
  try {
    await writeFile(join(outside, "outside.png"), "pixels");
    await symlink(outside, join(x.root, "outside"));
    await assert.rejects(() => tool.execute({ ...x, reportPath: "../bad.json" }), /escapes/);
    await assert.rejects(() => tool.execute({ ...x, reportPath: "outside/report.json" }), /escapes/);
    await assert.rejects(() => tool.execute({ ...x, slides: [{ path: "outside/outside.png" }] }), /escapes/);
    await assert.rejects(
      () => tool.execute({ ...x, reportPath: "context/messages.json" }),
      /framework state/
    );
    await assert.rejects(() => tool.execute({ ...x, reportPath: ".git/review.json" }), /framework state/);
    assert.equal(calls, 0);
  } finally {
    await rm(x.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("runtime keeps mutations sequential while independent reads are explicitly parallel", async () => {
  const x = await setup(1);
  try {
    const tools = createBuiltinTools({ rootDirectory: x.root, visionModel: cfg });
    const s = new PiSession({
      baseUrl: "https://example.test",
      apiKey: "test",
      tools,
      agentTools: [
        {
          name: "host_mutator",
          label: "Host mutator",
          description: "A host mutation with no declared execution mode",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "changed" }] })
        }
      ]
    });
    const modes = Object.fromEntries(s.agent.state.tools.map((t) => [t.name, t.executionMode]));
    assert.equal(modes.read_file, "parallel");
    assert.equal(modes.read_image, "parallel");
    assert.equal(modes.write_file, "sequential");
    assert.equal(modes.run_command, "sequential");
    assert.equal(modes.review_slides, "sequential");
    assert.equal(modes.host_mutator, "sequential");
    assert.ok(tools.has("review_slides"));
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test("session actually overlaps independent reads and serializes a batch containing a mutation", async () => {
  for (const mutate of [false, true]) {
    let active = 0,
      peak = 0,
      round = 0;
    const order = [];
    const task = (name, executionMode) => ({
      executionMode,
      parameters: { type: "object", properties: {} },
      async execute() {
        active++;
        peak = Math.max(peak, active);
        order.push(name + " start");
        await new Promise((r) => setTimeout(r, 15));
        order.push(name + " end");
        active--;
        return name;
      }
    });
    const tools = new Map([
      ["first", task("first", mutate ? "sequential" : "parallel")],
      ["second", task("second", "parallel")]
    ]);
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
      }
      const useTools = round++ === 0;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          "data: " +
            JSON.stringify({
              id: "test",
              object: "chat.completion.chunk",
              model: "glm-5.3",
              choices: [{ index: 0, delta, finish_reason }]
            }) +
            "\n\n"
        );
      send({ role: "assistant" });
      if (useTools)
        send({
          tool_calls: ["first", "second"].map((name, index) => ({
            index,
            id: "tool-" + index,
            type: "function",
            function: { name, arguments: "{}" }
          }))
        });
      else send({ content: "Done" });
      send({}, useTools ? "tool_calls" : "stop");
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const session = new PiSession({
        baseUrl: "http://127.0.0.1:" + server.address().port,
        apiKey: "test",
        tools,
        maxTurns: 5,
        thinkingLevel: "off",
        supportsReasoningEffort: false
      });
      const result = await session.run("Do both tasks");
      assert.equal(result.termination, "completed", JSON.stringify(result.messages));
      assert.equal(peak, mutate ? 1 : 2);
      if (mutate) assert.deepEqual(order, ["first start", "first end", "second start", "second end"]);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
});

test("overview shares the queue but never substitutes for page coverage; unrelated JSON stays untouched", async () => {
  const x = await setup(2);
  let calls = 0;
  const tool = createSlideReviewTool({
    rootDirectory: x.root,
    visionModel: cfg,
    analyze: async (_cfg, input) => {
      calls++;
      const review = input.path === "overview.png" ? issue : pass;
      return { report: JSON.stringify(review), review, elapsedMs: 1 };
    }
  });
  try {
    await writeFile(join(x.root, "overview.png"), "overview pixels");
    const r = await tool.execute({ ...x, overview: { path: "overview.png" } });
    assert.equal(r.slides.length, 2);
    assert.deepEqual(
      r.slides.map((p) => p.page),
      [1, 2]
    );
    assert.equal(r.overview.kind, "overview");
    assert.equal(r.overview.review.status, "needs_revision");
    assert.equal(r.everySubmittedPagePassed, true);
    assert.equal(r.summary.needsRevision, 1);
    assert.equal(calls, 3);
    await writeFile(join(x.root, "config.json"), '{"setting":"keep"}');
    await assert.rejects(() => tool.execute({ ...x, reportPath: "config.json" }), /ledger/);
    assert.equal(await readFile(join(x.root, "config.json"), "utf8"), '{"setting":"keep"}');
    assert.equal(calls, 3);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test("cancelling a running batch stops in-flight protocol requests and never starts remaining pages", async () => {
  const x = await setup(5),
    controller = new AbortController();
  let calls = 0;
  const server = createServer(async (req) => {
    req.on("error", () => {});
    for await (const chunk of req) {
    }
    calls++;
    if (calls === 2) controller.abort();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const visionModel = { ...cfg, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 10000 };
    const r = await createSlideReviewTool({ rootDirectory: x.root, visionModel }).execute(
      { ...x, concurrency: 2 },
      controller.signal
    );
    assert.equal(calls, 2);
    assert.equal(r.summary.unreviewed, 5);
    assert.equal(r.everySubmittedPagePassed, false);
    assert.equal(r.slides.filter((p) => p.attempts === 1).length, 2);
    assert.ok(r.slides.filter((p) => p.attempts).every((p) => /cancelled/i.test(p.error)));
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(x.root, { recursive: true, force: true });
  }
});

test("exact absolute render paths work inside the tool root while outside paths still fail", async () => {
  const x = await setup(1);
  try {
    const tool = createSlideReviewTool({
      rootDirectory: x.root,
      visionModel: cfg,
      analyze: async () => ({ report: JSON.stringify(pass), review: pass, elapsedMs: 1 })
    });
    const r = await tool.execute({
      slides: [{ path: join(x.root, x.slides[0].path) }],
      reportPath: join(x.root, "review.json")
    });
    assert.equal(r.summary.pass, 1);
    const direct = createBuiltinTools({ rootDirectory: x.root, supportsImages: true });
    assert.equal(
      (await direct.get("read_image").execute({ path: join(x.root, x.slides[0].path) })).content[1].type,
      "image"
    );
    await assert.rejects(
      () => tool.execute({ slides: [{ path: "/etc/passwd" }], reportPath: "other.json" }),
      /escapes/
    );
    await assert.rejects(() => direct.get("read_image").execute({ path: "/etc/passwd" }), /escapes/);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test("absolute render and ledger paths through root aliases resolve to the same evidence", async () => {
  const x = await setup(1),
    alias = x.root + "-alias";
  let calls = 0;
  await symlink(x.root, alias);
  try {
    const tool = createSlideReviewTool({
      rootDirectory: alias,
      visionModel: cfg,
      analyze: async () => {
        calls++;
        return { report: JSON.stringify(pass), review: pass, elapsedMs: 1 };
      }
    });
    const r = await tool.execute({
      slides: [{ path: join(alias, x.slides[0].path) }],
      reportPath: join(alias, "new-preview", "review.json")
    });
    assert.equal(r.summary.pass, 1);
    assert.equal(r.reportPath, "new-preview/review.json");
    const again = await tool.execute({ slides: x.slides, reportPath: "new-preview/review.json" });
    assert.equal(again.summary.reused, 1);
    assert.equal(calls, 1);
    const direct = createBuiltinTools({ rootDirectory: alias, supportsImages: true });
    assert.equal(
      (await direct.get("read_image").execute({ path: join(alias, x.slides[0].path) })).content[1].type,
      "image"
    );
  } finally {
    await rm(alias);
    await rm(x.root, { recursive: true, force: true });
  }
});

test("Task scope reads shared previews while keeping ledger writes inside the Agent's own root", async () => {
  const x = await setup(1),
    task = await setup(1);
  let calls = 0;
  try {
    const tool = createSlideReviewTool({
      rootDirectory: x.root,
      taskDirectory: task.root,
      workScope: "project",
      visionModel: cfg,
      analyze: async () => {
        calls++;
        return { report: JSON.stringify(pass), review: pass, elapsedMs: 1 };
      }
    });
    const result = await tool.execute({ slides: task.slides, reportPath: task.reportPath, scope: "task" });
    assert.equal(result.summary.pass, 1);
    assert.equal(result.reportScope, "work");
    assert.equal(calls, 1);
    assert.equal(
      JSON.parse(await readFile(join(x.root, task.reportPath), "utf8")).everySubmittedPagePassed,
      true
    );
    await assert.rejects(readFile(join(task.root, task.reportPath)), { code: "ENOENT" });
    for (const path of ["agents/other/work/review.json", "artifacts/review.json", "context/review.json"]) {
      await assert.rejects(
        tool.execute({ slides: task.slides, reportPath: join(task.root, path), scope: "task" }),
        /escapes/
      );
      await assert.rejects(readFile(join(task.root, path)), { code: "ENOENT" });
    }
    assert.equal(calls, 1, "unauthorized report paths must fail before new vision requests");
    await assert.rejects(
      tool.execute({ slides: task.slides, reportPath: "other.json", scope: "unknown" }),
      /scope/
    );
  } finally {
    await rm(x.root, { recursive: true, force: true });
    await rm(task.root, { recursive: true, force: true });
  }
});

test("an explicit own-work report directory and the host write guard apply to every persistence", async () => {
  const x = await setup(1),
    work = join(x.root, "own-work");
  await mkdir(work);
  let calls = 0,
    guarded = 0;
  try {
    const tool = createSlideReviewTool({
      rootDirectory: x.root,
      reportDirectory: work,
      visionModel: cfg,
      assertWritableReport: async (path) => {
        guarded++;
        assert.equal(path, join(await realpath(work), "preview", "review.json"));
      },
      analyze: async () => {
        calls++;
        return { report: JSON.stringify(pass), review: pass, elapsedMs: 1 };
      }
    });
    const result = await tool.execute(x);
    assert.equal(result.reportPath, "preview/review.json");
    assert.equal(result.reportScope, "work");
    assert.ok(guarded >= 4, "the write guard must run before each ledger write");
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(join(work, x.reportPath), "utf8")).reportScope, "work");
    await assert.rejects(readFile(join(x.root, x.reportPath)), { code: "ENOENT" });
    const rejected = createSlideReviewTool({
      rootDirectory: x.root,
      visionModel: cfg,
      assertWritableReport: async () => {
        throw new Error("protected report");
      }
    });
    await assert.rejects(rejected.execute(x), /protected report/);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test("malformed exhausted cached evidence cannot retain a passing status", async () => {
  const x = await setup(1);
  let calls = 0;
  const tool = createSlideReviewTool({
    rootDirectory: x.root,
    visionModel: cfg,
    analyze: async () => {
      if (++calls === 1) throw new Error("Temporary failure");
      return { report: JSON.stringify(pass), review: pass, elapsedMs: 1 };
    }
  });
  try {
    assert.equal((await tool.execute(x)).summary.pass, 1);
    assert.equal(calls, 2);
    const path = join(x.root, x.reportPath),
      saved = JSON.parse(await readFile(path, "utf8"));
    saved.checks[0].report = "invalid review";
    await writeFile(path, JSON.stringify(saved));
    const result = await tool.execute(x);
    assert.equal(result.everySubmittedPagePassed, false);
    assert.equal(result.summary.unreviewed, 1);
    assert.equal(result.slides[0].review, undefined);
    assert.equal(calls, 2);
    saved.checks[0].attempts = -1;
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(tool.execute(x), /invalid checks/);
    assert.equal(calls, 2);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`batch review preserves ${api} vision protocol and reuses unchanged pixels across a fresh tool`, async (t) => {
    const x = await setup(2);
    t.after(() => rm(x.root, { recursive: true, force: true }));
    const fixture = await modelProtocolFixture(api, () => ({ text: JSON.stringify(pass) }));
    t.after(() => fixture.close());
    const visionModel = { ...cfg, baseUrl: fixture.baseUrl, api };
    const result = await createSlideReviewTool({ rootDirectory: x.root, visionModel }).execute(x);
    assert.equal(result.summary.pass, 2);
    assert.equal(fixture.requests.length, 2);
    assert.equal(
      (await createSlideReviewTool({ rootDirectory: x.root, visionModel }).execute(x)).summary.reused,
      2
    );
    assert.equal(fixture.requests.length, 2);
    assert.doesNotMatch(await readFile(join(x.root, x.reportPath), "utf8"), /private-test-key|data:image/);
  });
}
