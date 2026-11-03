import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import {
  createModels,
  createProvider,
  getCurrentSystemPrompt,
  normalizeContext
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { MainRequestRetry } from "../dist/src/runtime/main-request-retry.js";
import { recordModelRequests } from "../dist/src/runtime/model-request-recording.js";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";
import { ModelRequestRecorder } from "../dist/src/storage/model-request-recorder.js";

async function replayAtProvider(
  t,
  { memory, user, wireSystem, contextWindow = 256_000, project = "", skills = "" }
) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-retry-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = createCoworkModel({
    baseUrl: "http://fixture.invalid/v1",
    api: "openai-completions",
    model: "original-model",
    contextWindow,
    maxTokens: 64,
    supportsReasoningEffort: false
  });
  const tools = [
    { name: "fixture_tool", description: "Fixture", parameters: { type: "object", properties: {} } }
  ];
  const context = normalizeContext({
    messages: [
      {
        role: "system",
        content: "Original system",
        sections: { user_memory: memory, project_experience: project, project_skills: skills },
        toolsAdded: tools,
        timestamp: 0
      },
      { role: "user", content: user, timestamp: 1 }
    ]
  });
  const body = JSON.stringify({
    model: model.id,
    messages: [
      { role: "system", content: wireSystem ?? getCurrentSystemPrompt(context.messages) },
      { role: "user", content: user }
    ],
    tools: [{ type: "function", function: tools[0] }],
    max_tokens: 64,
    temperature: 0.37,
    stream: true
  });
  const environment = {
    projectDirectory: root,
    binding: "fixture-binding",
    executionScope: { version: 1, taskStorageRoot: root, projectDirectory: root, application: null }
  };
  const store = new MainRequestStore(mainRequestPath(root, "task"), "task");
  await store.begin({
    runId: "original-run",
    requestId: "original-request",
    model,
    context,
    body,
    endpoint: `${model.baseUrl}/chat/completions`,
    environment: { projectDirectory: root, binding: environment.binding },
    executionScope: environment.executionScope
  });
  await store.settle("original-request", "failed");
  const retry = new MainRequestRetry(
    store,
    "retry-run",
    async () => environment,
    "original-request",
    undefined,
    undefined,
    {
      beginTurn() {},
      protectReplayScope() {},
      memoryReserveTokens: () => 64
    }
  );
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: "Memory retry fixture",
      baseUrl: model.baseUrl,
      models: [model],
      auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
      api: recordModelRequests(
        openAICompletionsApi(),
        new ModelRequestRecorder(join(root, "archive.jsonl"), {
          taskId: "task",
          runId: "retry-run",
          agentId: "main"
        }),
        retry
      )
    })
  );
  const sent = [];
  return {
    store,
    sent,
    run: (nextMemory, nextProject = project, nextSkills = skills) =>
      models.completeSimple(
        model,
        normalizeContext({
          messages: [
            {
              role: "system",
              content: "Live prompt must not replace the archived one",
              sections: {
                user_memory: nextMemory,
                project_experience: nextProject,
                project_skills: nextSkills
              },
              toolsAdded: tools,
              timestamp: 0
            },
            { role: "user", content: "short current input", timestamp: 2 }
          ]
        }),
        {
          apiKey: "fixture",
          maxRetries: 0,
          fetch: async (input, init) => {
            sent.push({ input, body: JSON.parse(init.body) });
            return new Response(protocolStream("openai-completions", { text: "Done" }), {
              headers: { "content-type": "text/event-stream" }
            });
          }
        }
      )
  };
}

test("memory retry updates the system section while preserving identical text explicitly present in user input", async (t) => {
  const user = "An explicit literal: Original system\n\nOLD_MEMORY";
  const f = await replayAtProvider(t, { memory: "OLD_MEMORY", user });
  assert.equal((await f.run("NEW_MEMORY")).stopReason, "stop");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.messages[0].content, "Original system\n\nNEW_MEMORY");
  assert.equal(f.sent[0].body.messages[1].content, user);
  assert.equal(f.sent[0].body.temperature, 0.37);
});

test("memory retry rechecks the archived full conversation budget before injecting current memory", async (t) => {
  const user = "u".repeat(2000);
  const f = await replayAtProvider(t, { memory: "OLD_MEMORY", user, contextWindow: 1000 });
  assert.equal((await f.run("NEW_MEMORY".repeat(200))).stopReason, "stop");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.messages[0].content, "Original system");
  assert.equal(f.sent[0].body.messages[1].content, user, "never truncate original user input for memory");
  assert.equal(f.sent[0].body.max_tokens, 64);
});

test("an opaque archived system payload refuses stale-memory replay before HTTP and retains recovery evidence", async (t) => {
  const f = await replayAtProvider(t, {
    memory: "OLD_MEMORY",
    user: "Original user input",
    wireSystem: "Opaque hook system with OLD_MEMORY"
  });
  const before = await readFile(f.store.filePath, "utf8");
  const result = await f.run("");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /记忆或项目经验已变化/);
  assert.equal(f.sent.length, 0);
  assert.equal(await readFile(f.store.filePath, "utf8"), before);
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(
    `${api}: real Main retries refresh disabled, deleted and edited memory while preserving the original request`,
    { timeout: 120_000 },
    async (t) => {
      const received = [];
      let dashboard, taskId, rejectNext;
      const provider = createServer(async (request, response) => {
        if (request.method !== "POST") {
          response.writeHead(200, { "content-type": "application/json" });
          return response.end(JSON.stringify({ data: [{ id: "original-model" }] }));
        }
        const raw = await readFixtureRequestBody(request);
        const snapshot = await new MainRequestStore(
          mainRequestPath(dashboard.workspaceRoot, taskId),
          taskId
        ).read();
        received.push({ raw, path: request.url, body: JSON.parse(raw), snapshot });
        if (rejectNext) {
          rejectNext = false;
          response.writeHead(400, { "content-type": "application/json" });
          return response.end('{"error":{"message":"isolated memory retry failure"}}');
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(protocolStream(api, { text: "原请求已恢复。" }));
      });
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      t.after(async () => {
        await dashboard?.stop();
        provider.closeAllConnections();
        await new Promise((done) => provider.close(done));
      });
      dashboard = await startDashboard({
        modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
        model: "original-model",
        config: { api, mainMaxTokens: 73 }
      });
      await mkdir(join(dashboard.root, "pi"), { recursive: true });
      await writeFile(
        join(dashboard.root, "pi", "settings.json"),
        JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
      );
      const call = async (path, body) => {
        const response = await fetch(dashboard.base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const value = await response.json();
        assert.ok(response.ok, JSON.stringify(value));
        return value;
      };
      const settle = async (status) => {
        for (let attempt = 0; attempt < 600; attempt++) {
          const detail = await call(`/api/tasks/${taskId}`);
          if (!detail.runtime.active) {
            assert.equal(detail.task.status, status, JSON.stringify(detail.task));
            return detail;
          }
          await delay(50);
        }
        assert.fail("The real Main retry did not settle");
      };

      for (const change of ["unchanged", "disabled", "deleted", "edited"]) {
        taskId = `memory-retry-${change}`;
        const previous = `OLD_PRIVATE_MEMORY_${change.toUpperCase()}`;
        const current = `NEW_PRIVATE_MEMORY_${change.toUpperCase()}`;
        await call("/api/user-memory", { action: "set_enabled", enabled: true });
        let profile = await call("/api/user-memory");
        await call("/api/user-memory", {
          action: "save_text",
          content: previous,
          revision: profile.revision
        });
        profile = await call("/api/user-memory");
        await call("/api/tasks", { taskId, goal: "保留原始用户输入。" });
        rejectNext = true;
        await call(`/api/tasks/${taskId}/run`, { prompt: "保留原始用户输入。" });
        const failed = await settle("failed");
        const original = received.at(-1);
        assert.ok(original.raw.includes(previous));
        if (change === "disabled") await call("/api/user-memory", { action: "set_enabled", enabled: false });
        if (change === "deleted")
          await call("/api/user-memory", {
            action: "forget",
            id: profile.entries[0].id,
            revision: profile.entries[0].revision
          });
        if (change === "edited")
          await call("/api/user-memory", {
            action: "save_text",
            content: current,
            revision: profile.revision
          });
        await writeFile(join(dashboard.root, "config.json"), JSON.stringify({ api, mainMaxTokens: 149 }));
        await dashboard.restart({ newPort: true });
        const beforeRetry = received.length;
        await call(`/api/tasks/${taskId}/run`, {
          resume: true,
          retryRequestId: failed.retryRequest.requestId
        });
        const completed = await settle("completed");
        assert.equal(received.length, beforeRetry + 1, "replay one provider request only");
        const replay = received.at(-1);
        assert.equal(replay.path, original.path);
        assert.equal(replay.snapshot.body, replay.raw, "persist the refreshed wire request before HTTP");
        assert.deepEqual(replay.snapshot.model, original.snapshot.model);
        assert.deepEqual(replay.snapshot.executionScope, original.snapshot.executionScope);
        assert.equal(replay.snapshot.sessionId, original.snapshot.sessionId);
        assert.equal(replay.snapshot.retryOf, original.snapshot.requestId);
        assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
        if (change === "unchanged") {
          assert.equal(replay.raw, original.raw, "unchanged memory retains byte-exact retry");
          assert.deepEqual(replay.snapshot.context, original.snapshot.context);
        } else {
          assert.ok(!replay.raw.includes(previous), "removed memory must never be sent by replay");
          assert.ok(!JSON.stringify(replay.snapshot.context).includes(previous));
          assert.equal(replay.raw.includes(current), change === "edited");
          const field = api === "openai-responses" ? "input" : "messages";
          const nonSystem = (items) =>
            items.filter((message) => !["system", "developer"].includes(message.role));
          assert.deepEqual(nonSystem(replay.body[field]), nonSystem(original.body[field]));
          const parameters = (body) =>
            Object.fromEntries(Object.entries(body).filter(([key]) => key !== field));
          assert.deepEqual(
            parameters(replay.body),
            parameters(original.body),
            "preserve original generation parameters"
          );
        }
      }
    }
  );
}

for (const change of ["disabled", "edited"])
  test(`project experience retry ${change} refreshes host project facts and generated catalog only`, async (t) => {
    const user = "Literal OLD_PROJECT remains explicit user input.";
    const f = await replayAtProvider(t, {
      memory: "PERSONAL_MEMORY",
      project: "OLD_PROJECT",
      skills: "OLD_SKILL",
      user
    });
    const next = change === "edited" ? "NEW_PROJECT" : "";
    assert.equal((await f.run("PERSONAL_MEMORY", next, "")).stopReason, "stop");
    const sent = f.sent[0].body;
    assert.equal(sent.messages[0].content, `Original system\n\nPERSONAL_MEMORY${next ? `\n\n${next}` : ""}`);
    assert.equal(sent.messages[1].content, user);
    assert.equal(sent.model, "original-model");
    assert.equal(sent.temperature, 0.37);
    assert.equal(JSON.stringify(sent).includes("OLD_SKILL"), false);
  });
