import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { WatcherRuntime } from "../dist/src/runtime/watcher.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

for (const api of ["openai-completions", "openai-responses"])
  for (const control of [false, true])
    test(
      `${api}: template ${control ? "direct-monitor control" : "event"} analysis keeps provider settings and replays its paused outbox without another model call`,
      { timeout: 20_000 },
      async (t) => {
        const inherited = process.env;
        process.env = Object.fromEntries(
          Object.entries(inherited).filter(
            ([name]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)
          )
        );
        const root = await mkdtemp(join(tmpdir(), "atria-watch-runtime-integration-"));
        let provider;
        t.after(async () => {
          await provider?.close();
          await rm(root, { recursive: true, force: true });
          process.env = inherited;
        });
        const taskId = "task",
          mainRunId = "main-original";
        const workspace = new LocalWorkspaceStore(root);
        await workspace.createTask(taskId, { goal: "Observe the accepted source" });
        await workspace.createRun(taskId, mainRunId);
        await workspace.transitionTask(taskId, "waiting", { runId: mainRunId, reason: "waiting_for_source" });
        const programs = new WatchProgramStore(root);
        const program = await programs.createProgram({
          taskId,
          programId: "topic",
          subject: "fixture",
          objective: "Report meaningful fixture changes"
        });
        const monitor = await programs.createVirtualAgent({
          programId: program.programId,
          task: "classify accepted events",
          profileId: "custom",
          templateId: "file-change",
          ...(control ? { eventMode: "direct" } : {}),
          cadenceSeconds: 3600,
          wake: "important",
          activate: true
        });
        await programs.updateVirtualAgentState(taskId, program.programId, monitor.monitorId, {
          lastCheckedAt: new Date().toISOString()
        });
        if (control) await programs.enqueueControl(taskId, monitor.monitorId, "Review this accepted source");
        else
          await new WatcherRuntime({
            workspaceRoot: root,
            taskId,
            runId: "watch-topic",
            programId: program.programId,
            recipientAgentId: monitor.monitorId
          }).ingest({
            watcherId: monitor.monitorId,
            source: "fixture",
            type: "fixture.changed",
            dedupeKey: "change",
            payload: { evidence: "accepted source changed" }
          });
        const mainPath = join(root, taskId, "runs", mainRunId, "agents", "main", "inbox-store.json");
        const mainInbox = new InboxStore(mainPath);
        provider = await modelProtocolFixture(api, async () => {
          await mkdir(mainPath, { recursive: true });
          return { text: "classification: relevant_change\nAccepted fixture evidence warrants a report." };
        });
        const connection = {
          workspaceRoot: root,
          baseUrl: provider.baseUrl,
          apiKey: "isolated-fixture",
          model: "protocol-fixture",
          api,
          thinkingFormat: "openai",
          thinkingLevel: "off",
          supportsReasoningEffort: false,
          supportsPromptCacheKey: false,
          supportsImages: false,
          maxTurns: 2,
          maxTokens: 512,
          contextWindow: 16_384,
          timeoutMs: 5000
        };
        const before = await workspace.readTask(taskId);
        const first = await new WatchSupervisor(connection).runCycle({ taskId });
        assert.equal(first.failures.length, 1);
        assert.match(first.failures[0].error, /EISDIR/);
        assert.equal(provider.requests.length, 1);
        const request = provider.requests[0];
        assert.equal(request.path, api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
        assert.equal(
          request.body.max_output_tokens ?? request.body.max_completion_tokens ?? request.body.max_tokens,
          512
        );
        assert.equal(
          request.body.tools?.length ?? 0,
          0,
          "a template classifier has no general or scientific tools"
        );
        assert.equal(request.body.prompt_cache_key, undefined, "the selected cache capability is respected");
        const prompt = JSON.stringify(request.body.input ?? request.body.messages);
        assert.match(prompt, /监控事件分类器/);
        assert.doesNotMatch(prompt, /Your working directory|Return a concise natural-language/);
        assert.deepEqual(await workspace.readTask(taskId), before);
        const state = () => programs.readVirtualAgentState(taskId, program.programId, monitor.monitorId);
        const outbox = control ? "pendingControlWake" : "pendingWake";
        const saved = (await state())[outbox];
        assert.equal(saved.runId, mainRunId);
        await rm(mainPath, { recursive: true });
        await programs.updateProgram(taskId, program.programId, { status: "paused" });
        const paused = await new WatchSupervisor(connection).runCycle({ taskId });
        assert.equal(paused.wakeRequests, 0);
        assert.deepEqual((await state())[outbox], saved);
        assert.equal(provider.requests.length, 1);
        await workspace.updateTask(taskId, { activeRunId: "main-newer" });
        const newer = await workspace.readTask(taskId);
        await programs.updateProgram(taskId, program.programId, { status: "monitoring" });
        const recovered = await new WatchSupervisor(connection).runCycle({ taskId });
        assert.deepEqual(recovered.failures, []);
        assert.equal(recovered.wakeRequests, 1);
        assert.equal(provider.requests.length, 1, "outbox recovery does not repeat classification");
        assert.deepEqual(await workspace.readTask(taskId), newer);
        assert.equal((await state())[outbox], undefined);
        if (control)
          assert.deepEqual(await programs.listControls(taskId, program.programId, monitor.monitorId), []);
        const [wake] = await mainInbox.list("main");
        assert.equal(wake.messageId, saved.message.messageId);
        assert.deepEqual(wake.payload, saved.message.payload);
        await mainInbox.leaseMessage("main", wake.messageId);
        await mainInbox.consume(wake.messageId);
        await new WatchSupervisor(connection).runCycle({ taskId });
        assert.equal((await mainInbox.list("main"))[0].state, "consumed");
        assert.equal(provider.requests.length, 1);
      }
    );
