import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { TraceRecorder } from "../dist/src/storage/trace-recorder.js";
import { ModelRequestRecorder, sanitizeRecording } from "../dist/src/storage/model-request-recorder.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";
import { recordModelRequests } from "../dist/src/runtime/model-request-recording.js";
import { pathToFileURL } from "node:url";

const rows = async (path) => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: persist actual requests before sending, including prompt, schemas and tool round trips`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-request-recording-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const trace = new TraceRecorder(join(root, "agent.jsonl"));
    const saved = [];
    const provider = await modelProtocolFixture(api, async (body, requests) => {
      const records = (await rows(trace.modelRequestPath)).filter(
        (record) => record.type === "model_request"
      );
      // A crash after the server receives a call must still leave its input on disk.
      saved.push(records.at(-1));
      assert.equal(records.length, requests.length);
      assert.deepEqual(records.at(-1).payload.request, body);
      return requests.length === 1
        ? { name: "verify_key", arguments: { key: "ordinary-user-key" } }
        : { text: "recording completed" };
    });
    t.after(() => provider.close());
    const session = new PiSession({
      api,
      baseUrl: provider.baseUrl,
      apiKey: "fixture-credential",
      model: "protocol-fixture",
      thinkingLevel: "low",
      maxTokens: 1024,
      maxTurns: 3,
      systemPrompt: "Exact system prompt for training.",
      trace: { recorder: trace, taskId: "task-record", runId: "run-record", agentId: "worker" },
      tools: new Map([
        [
          "verify_key",
          {
            description: "Verify an ordinary key.",
            parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
            execute: async ({ key }) => ({ key, totalTokens: 123 })
          }
        ]
      ])
    });
    await session.run("Please verify the key.");
    const records = await rows(trace.modelRequestPath);
    const requests = records.filter((record) => record.type === "model_request");
    const responses = records.filter((record) => record.type === "model_response");
    assert.equal(requests.length, 2);
    assert.equal(responses.length, 2);
    assert.equal(saved.length, 2);
    assert.ok(
      records.every(
        (record) =>
          record.schemaVersion === 1 && record.taskId === "task-record" && record.agentId === "worker"
      )
    );
    assert.ok(records.every((record) => record.producer.version !== "unknown"));
    assert.equal(requests[0].payload.systemPrompt, "Exact system prompt for training.");
    assert.equal(requests[0].payload.tools[0].parameters.properties.key.type, "string");
    assert.ok(JSON.stringify(requests[1].payload.request).includes("ordinary-user-key"));
    assert.ok(JSON.stringify(requests[1].payload.request).includes("123"));
    assert.equal(requests[0].payload.systemPromptSha256.length, 64);
    assert.equal(responses[1].requestId, requests[1].requestId);
    assert.equal(responses[1].payload.message.stopReason, "stop");
    assert.equal(typeof responses[1].payload.message.usage.totalTokens, "number");
    assert.ok(
      records
        .filter((record) => record.type === "model_response_http")
        .every((record) => record.payload.status === 200)
    );
    assert.ok(!(await readFile(trace.modelRequestPath, "utf8")).includes("fixture-credential"));
    if (process.platform !== "win32") assert.equal((await stat(trace.modelRequestPath)).mode & 0o777, 0o600);
  });
}

test("request recorder snapshots concurrent writes and redacts credentials without losing schemas or token settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-request-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "requests.jsonl");
  const recorder = new ModelRequestRecorder(path, { taskId: "task", runId: "run", agentId: "main" }, [
    "private-fixture-value"
  ]);
  const message = {
    apiKey: "credential",
    max_tokens: 8000,
    usage: { totalTokens: 55 },
    content: "prefix private-fixture-value suffix",
    key: "modelled-key",
    properties: { password: { type: "string" } }
  };
  const first = recorder.record("model_request", "request-one", message);
  message.content = "mutated";
  await Promise.all([first, recorder.record("model_response", "request-one", { content: "done" })]);
  const records = await rows(path);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [1, 2]
  );
  assert.equal(records[0].payload.content, "prefix [REDACTED] suffix");
  assert.equal(records[0].payload.apiKey, "[REDACTED]");
  assert.equal(records[0].payload.max_tokens, 8000);
  assert.equal(records[0].payload.usage.totalTokens, 55);
  assert.equal(records[0].payload.key, "modelled-key");
  assert.deepEqual(records[0].payload.properties.password, { type: "string" });
});

test("credential fields are redacted inside wire JSON arguments and tool results while ordinary JSON stays exact", () => {
  const ordinary = '{ "key": "ordinary-user-key", "max_tokens": 8000 }';
  const recorded = sanitizeRecording(
    {
      function: {
        arguments: JSON.stringify({ password: "user-credential", key: "ordinary-user-key" })
      },
      arguments: JSON.stringify({ access_token: "oauth-credential", items: [{ key: "ordinary-key" }] }),
      content: JSON.stringify({
        result: JSON.stringify({ client_secret: "client-credential", totalTokens: 5 })
      }),
      ordinary,
      schema: JSON.stringify({ properties: { password: { type: "string" } } }),
      escapedSecret: JSON.stringify({ text: 'a "quoted" configured secret' })
    },
    ['a "quoted" configured secret']
  );
  assert.deepEqual(JSON.parse(recorded.function.arguments), {
    password: "[REDACTED]",
    key: "ordinary-user-key"
  });
  assert.deepEqual(JSON.parse(recorded.arguments), {
    access_token: "[REDACTED]",
    items: [{ key: "ordinary-key" }]
  });
  assert.deepEqual(JSON.parse(JSON.parse(recorded.content).result), {
    client_secret: "[REDACTED]",
    totalTokens: 5
  });
  assert.equal(recorded.ordinary, ordinary);
  assert.deepEqual(JSON.parse(recorded.schema), { properties: { password: { type: "string" } } });
  assert.deepEqual(JSON.parse(recorded.escapedSecret), { text: "[REDACTED]" });
});

test("an archive write failure stops the provider before HTTP transmission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-request-write-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blocked = join(root, "blocked");
  await writeFile(blocked, "This fixture prevents creating the archive directory.");
  const recorder = new ModelRequestRecorder(join(blocked, "requests.jsonl"), {
    taskId: "task",
    runId: "run",
    agentId: "main"
  });
  const model = createCoworkModel({
    baseUrl: "https://fixture.example/v1",
    api: "openai-completions",
    model: "fixture",
    supportsReasoningEffort: false
  });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: "Archive failure fixture",
      baseUrl: model.baseUrl,
      auth: { apiKey: { name: "Fixture key", resolve: async () => ({ auth: { apiKey: "local-fixture" } }) } },
      models: [model],
      api: recordModelRequests(openAICompletionsApi(), recorder)
    })
  );
  let sent = 0;
  const result = await models.completeSimple(
    model,
    {
      systemPrompt: "Test archive durability.",
      messages: [{ role: "user", content: "fixture", timestamp: 1 }]
    },
    {
      apiKey: "local-fixture",
      maxRetries: 0,
      fetch: async () => {
        sent++;
        throw new Error("Unexpected network call");
      }
    }
  );
  assert.equal(sent, 0);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /EEXIST|ENOTDIR/);
});

for (const [name, layout] of [
  ["coworkos", ["src", "storage"]],
  ["coworkos", ["dist", "src", "storage"]],
  ["coworkos-app", ["dist", "src", "storage"]],
  ["atria-cowork-cli", ["dist", "src", "storage"]]
]) {
  test(`request archives retain release and Pi versions for ${name} in ${layout.join("/")}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-published-recorder-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, ...layout);
    await mkdir(directory, { recursive: true });
    const modulePath = join(directory, "model-request-recorder.js");
    await copyFile(new URL("../dist/src/storage/model-request-recorder.js", import.meta.url), modulePath);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name,
        version: "0.1.2-fixture",
        type: "module",
        dependencies: {
          "@earendil-works/pi-agent-core": "0.87.1",
          "@earendil-works/pi-ai": "0.87.1",
          "@earendil-works/pi-coding-agent": "0.87.1"
        }
      })
    );
    const { ModelRequestRecorder: InstalledRecorder } = await import(pathToFileURL(modulePath).href);
    const path = join(root, "requests.jsonl");
    await new InstalledRecorder(path, { taskId: "task", runId: "run", agentId: "main" }).record(
      "model_request",
      "request",
      {}
    );
    const [record] = await rows(path);
    assert.deepEqual(record.producer, {
      name: "CoworkOS",
      version: "0.1.2-fixture",
      piAgentCore: "0.87.1",
      piAi: "0.87.1",
      piCodingAgent: "0.87.1"
    });
  });
}

test("a response-status archive failure closes the opened response and preserves the write error", async () => {
  const writeError = new Error("fixture archive full");
  const recorded = [];
  const recorder = {
    record: async (type) => {
      recorded.push(type);
      if (type === "model_response_http") throw writeError;
    }
  };
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
        throw new Error("fixture cancellation failure");
      }
    })
  );
  const source = (_model, _context, options) => ({
    async *[Symbol.asyncIterator]() {
      await options.fetch("https://fixture.example/v1", { body: JSON.stringify({ fixture: true }) });
      assert.fail("A failed archive must terminate the provider stream");
    }
  });
  const model = createCoworkModel({
    baseUrl: "https://fixture.example/v1",
    api: "openai-completions",
    model: "fixture",
    supportsReasoningEffort: false
  });
  const stream = recordModelRequests({ stream: source, streamSimple: source }, recorder).streamSimple(
    model,
    { systemPrompt: "fixture", messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
    { fetch: async () => response }
  );
  const result = await stream.result();
  assert.equal(cancelled, true);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, writeError.message);
  assert.deepEqual(recorded, ["model_request", "model_response_http"]);
});
