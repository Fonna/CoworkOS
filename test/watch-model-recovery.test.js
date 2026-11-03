import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WatchManagement } from "../dist/src/runtime/watch-management.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";

for (const scope of ["session", "background"])
  test(`${scope}: a terminal analysis failure retries and a lost cache recovers without another model call`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-watch-model-recovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let unavailable = true,
      calls = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume the actual Pi request */
      }
      calls++;
      if (unavailable) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture outage" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: `reply-${calls}`, object: "chat.completion.chunk", created: 1, model: "recovery-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "classification: relevant_change\nConfirmed threshold evidence." }, finish_reason: "stop" }] })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const store = new LocalWorkspaceStore(root);
    await store.createTask("parent", { goal: "observe", capabilities: { maxAttempts: 1 } });
    await store.createRun("parent", "main-parent");
    const source = join(root, "metric.json");
    const metric = (value) =>
      writeFile(
        source,
        JSON.stringify({ metric: "loss", value, unit: "ratio", observedAt: new Date().toISOString() })
      );
    await metric(0);
    const created = await new WatchManagement(root, resolve(".")).create("parent", "main-parent", {
      task: "classify the loss event",
      template: "metric-threshold",
      source,
      scope,
      eventMode: "analyze",
      config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 },
      cadenceSeconds: 60
    });
    await store.updateTask(created.taskId, { capabilities: { maxAttempts: 1 } });
    const programs = new WatchProgramStore(root);
    const force = () =>
      programs.updateVirtualAgentState(created.taskId, created.programId, created.monitorId, {
        retryAt: undefined,
        pollRetryAt: undefined,
        analysisRetryAt: undefined,
        lastCheckedAt: "1970-01-01T00:00:00Z"
      });
    const options = {
      workspaceRoot: root,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "local-fixture",
      supportsReasoningEffort: false
    };
    await metric(3);
    await force();
    const failed = await new WatchSupervisor(options).runCycle();
    assert.equal(failed.failures[0].stage, "execute");
    const first = await programs.readVirtualAgentState(created.taskId, created.programId, created.monitorId);
    assert.equal(first.processing, false);
    assert.equal(first.modelRunCount, 1);
    assert.match(first.lastSummary, /fixture outage/);
    assert.doesNotMatch(first.lastSummary, /did not return a textual summary|\[Coordinator\]/);
    const savedFailure = JSON.parse(
      await readFile(
        join(
          root,
          created.taskId,
          "runs",
          first.analysisRunId,
          "agents",
          "subagents",
          created.monitorId,
          "result.json"
        ),
        "utf8"
      )
    );
    assert.match(savedFailure.error, /fixture outage/);
    const beforeRecovery = calls;
    unavailable = false;
    await force();
    const resumed = await new WatchSupervisor(options).runCycle();
    assert.equal(resumed.processed, 1);
    assert.equal(resumed.wakeRequests, 1);
    assert.equal(calls, beforeRecovery + 1);
    const good = await programs.readVirtualAgentState(created.taskId, created.programId, created.monitorId);
    assert.equal(good.modelRunCount, 2);
    assert.notEqual(good.lastRunId, first.analysisRunId);
    // Simulate a crash after Coordinator committed, before the observer's cache
    // and source Inbox consumption reached disk.
    const cache = join(
      root,
      created.taskId,
      "agents",
      "subagents",
      created.monitorId,
      "watcher",
      `result-${good.lastEventId}.json`
    );
    await rm(cache);
    const program = await programs.readProgram(created.taskId, created.programId);
    const monitorInbox = join(
      root,
      created.taskId,
      "runs",
      program.watchRunId ?? `watch-${created.programId}`,
      "agents",
      created.monitorId,
      "inbox-store.json"
    );
    const messages = JSON.parse(await readFile(monitorInbox, "utf8"));
    await writeFile(
      monitorInbox,
      JSON.stringify(messages.map((message) => ({ ...message, state: "ready", lease: undefined })))
    );
    await programs.updateVirtualAgentState(created.taskId, created.programId, created.monitorId, {
      lastEventId: undefined,
      retryAt: undefined,
      processing: true
    });
    const replayed = await new WatchSupervisor({ ...options, baseUrl: "", apiKey: "" }).runCycle();
    assert.equal(replayed.processed, 1);
    assert.equal(calls, beforeRecovery + 1);
    assert.equal(
      (await programs.readVirtualAgentState(created.taskId, created.programId, created.monitorId))
        .modelRunCount,
      2
    );
    const mainRunId = (await store.readTask(created.taskId)).activeRunId;
    const mainInbox = new InboxStore(
      join(root, created.taskId, "runs", mainRunId, "agents", "main", "inbox-store.json")
    );
    assert.equal(
      (await mainInbox.list("main")).filter(
        (message) => message.payload?.type === "watch.virtual_agent_result"
      ).length,
      1
    );
  });
