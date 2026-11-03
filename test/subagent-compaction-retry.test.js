import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ContextCompactor } from "../dist/src/runtime/context-compaction.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const currentPolicy = "CURRENT_POLICY: inspect receipts without overwriting or repeating successful writes.";
const previousSummary = "LAST_VALID_SUMMARY: receipt.txt exists and was verified; do not repeat its write.";
const replacementSummary =
  "NEW_VALID_SUMMARY: implementation remains in progress; existing receipts stay intact.";
const currentTool = {
  name: "inspect_receipt",
  description: "Inspect the existing receipt without rewriting it.",
  parameters: { type: "object", properties: {} }
};
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "compaction-retry-fixture",
  model: "protocol-fixture",
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  timestamp: 2
});
const initialState = () => ({ summary: previousSummary, summarizedMessageCount: 3, compactionCount: 2 });
const history = () => [
  { role: "system", content: currentPolicy, toolsAdded: [currentTool], timestamp: 0 },
  user("ALREADY_SUMMARIZED_RAW_PREFIX: keep this out of inference. ".repeat(100)),
  assistant("The first receipt was created once and verified."),
  user("Continue the unfinished implementation without repeating completed writes."),
  assistant("UNSUMMARIZED_RAW_WORK: current verification remains unfinished. ".repeat(100)),
  user("Continue.")
];
const contentText = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
const promptText = (body) => body.messages.map((message) => contentText(message.content)).join("\n");

async function fixture(t, handle) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readFixtureRequestBody(request));
    const summary = promptText(body).includes("context summarization assistant");
    requests.push({ body, summary });
    await handle({ response, body, summary, requests });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const model = {
    id: "protocol-fixture",
    name: "Compaction retry fixture",
    api: "openai-completions",
    provider: "compaction-retry-fixture",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 512,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: "Local retry fixture",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: { name: "Fixture key", resolve: async () => ({ auth: { apiKey: "isolated-retry-fixture" } }) }
      },
      models: [model],
      api: openAICompletionsApi()
    })
  );
  return {
    requests,
    create: ({ initial = initialState(), checkpoint, now } = {}) =>
      new ContextCompactor(
        models,
        model,
        { enabled: true, reserveTokens: 500, keepRecentTokens: 32 },
        initial,
        checkpoint,
        now
      ),
    connection: {
      api: model.api,
      model: model.id,
      baseUrl: model.baseUrl,
      apiKey: "isolated-retry-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      maxErrorRetries: 0,
      timeoutMs: 5000,
      systemPrompt: currentPolicy,
      compaction: { reserveTokens: 500, keepRecentTokens: 32 }
    }
  };
}

function reply(response, value = { text: replacementSummary }) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(protocolStream("openai-completions", value));
}
function fail(response) {
  response.writeHead(500, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "Synthetic temporary summary failure." } }));
}
function assertFallback(messages, source) {
  assert.equal(messages[0].content, currentPolicy);
  assert.deepEqual(messages[0].toolsAdded, [currentTool]);
  assert.match(contentText(messages[1].content), /LAST_VALID_SUMMARY/);
  assert.doesNotMatch(JSON.stringify(messages), /ALREADY_SUMMARIZED_RAW_PREFIX/);
  assert.deepEqual(messages.slice(2), source.slice(3));
}

test("Subagent retries the same summary prefix after 5s, 15s and capped 30s delays", async (t) => {
  let failing = true;
  const local = await fixture(t, ({ response }) => (failing ? fail(response) : reply(response)));
  let now = 1000;
  const checkpoints = [];
  const compact = local.create({ now: () => now, checkpoint: (state) => checkpoints.push(state) });
  const before = compact.state;
  const messages = history();
  for (const [index, delay] of [5000, 15000, 30000, 30000].entries()) {
    assertFallback(await compact.transform(messages), messages);
    assert.equal(local.requests.length, index + 1, "the cooldown eventually permits another attempt");
    assert.deepEqual(compact.state, before);
    assert.equal(checkpoints.length, 0);
    const samePrefix = [...messages, assistant("Recent progress.")];
    assertFallback(await compact.transform(samePrefix), samePrefix);
    assert.equal(
      local.requests.length,
      index + 1,
      "new raw tail messages do not bypass the same-prefix cooldown"
    );
    now += delay - 1;
    assert.equal((await compact.compactIfNeeded(messages)).compacted, false);
    assert.equal(local.requests.length, index + 1);
    now += 1;
  }
  failing = false;
  const recovered = await compact.compactIfNeeded(messages);
  assert.equal(recovered.compacted, true);
  assert.equal(local.requests.length, 5);
  assert.equal(checkpoints.length, 1);
  assert.equal(recovered.state.compactionCount, before.compactionCount + 1);
  assert.equal(recovered.state.summary, replacementSummary);
  assert.ok(recovered.state.summarizedMessageCount > before.summarizedMessageCount);
  assert.match(promptText(local.requests.at(-1).body), /<previous-summary>/);
});

test("a newly covered Subagent prefix may retry during the previous prefix cooldown", async (t) => {
  let failing = true;
  const local = await fixture(t, ({ response }) => (failing ? fail(response) : reply(response)));
  const compact = local.create({ now: () => 1000 });
  const messages = history();
  await compact.transform(messages);
  assert.equal(local.requests.length, 1);
  failing = false;
  const expanded = [
    ...messages,
    assistant("A new implementation step finished."),
    user("Newest request. ".repeat(30))
  ];
  const result = await compact.compactIfNeeded(expanded);
  assert.equal(result.compacted, true);
  assert.equal(local.requests.length, 2);
  assert.equal(result.state.summarizedMessageCount, expanded.length - 1);
  assert.deepEqual(result.messages.at(-1), expanded.at(-1));
});

test("an aborted Subagent summary leaves its old checkpoint usable without starting a cooldown", async (t) => {
  const controller = new AbortController();
  let abortRequest = true;
  const local = await fixture(t, ({ response }) => {
    if (abortRequest) controller.abort();
    else reply(response);
  });
  const checkpoints = [];
  const compact = local.create({ now: () => 1000, checkpoint: (state) => checkpoints.push(state) });
  const before = compact.state;
  const messages = history();
  assertFallback(await compact.transform(messages, controller.signal), messages);
  assert.deepEqual(compact.state, before);
  assert.equal(checkpoints.length, 0);
  abortRequest = false;
  const recovered = await compact.compactIfNeeded(messages);
  assert.equal(recovered.compacted, true);
  assert.equal(local.requests.length, 2, "cancellation must not delay an immediate retry");
  assert.equal(checkpoints.length, 1);
});

test("an unpersisted Subagent update keeps the last checkpoint and cools down before recovery", async (t) => {
  const local = await fixture(t, ({ response }) => reply(response));
  let now = 1000;
  let saves = 0;
  const compact = local.create({
    now: () => now,
    checkpoint: () => {
      if (++saves === 1) throw new Error("Synthetic checkpoint storage failure.");
    }
  });
  const before = compact.state;
  const messages = history();
  assertFallback(await compact.transform(messages), messages);
  assert.deepEqual(compact.state, before);
  assertFallback(await compact.transform(messages), messages);
  assert.equal(local.requests.length, 1);
  assert.equal(saves, 1);
  now += 5000;
  const recovered = await compact.compactIfNeeded(messages);
  assert.equal(recovered.compacted, true);
  assert.equal(local.requests.length, 2);
  assert.equal(saves, 2);
  assert.equal(recovered.state.summary, replacementSummary);
});

test(
  "real PiSession keeps policy, tools and the old summary across a failed update and a tool continuation",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "atria-summary-retry-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let inferences = 0;
    const local = await fixture(t, ({ response, summary }) => {
      if (summary) fail(response);
      else
        reply(
          response,
          ++inferences === 1
            ? { name: currentTool.name, arguments: {} }
            : { text: "The existing receipt is intact." }
        );
    });
    const messages = history();
    const original = structuredClone(messages);
    const checkpointPath = join(directory, "checkpoint.json");
    let checkpointWrites = Promise.resolve();
    const checkpoints = [];
    let toolRuns = 0;
    const result = await new PiSession({
      ...local.connection,
      initialMessages: messages,
      initialCompaction: initialState(),
      tools: new Map([
        [
          currentTool.name,
          {
            ...currentTool,
            execute: async () => {
              toolRuns++;
              return "Receipt intact.";
            }
          }
        ]
      ]),
      onCheckpoint: (state) => {
        checkpoints.push(structuredClone(state));
        checkpointWrites = checkpointWrites.then(() => writeFile(checkpointPath, JSON.stringify(state)));
        return checkpointWrites;
      }
    }).run("Continue.");
    assert.equal(result.termination, "completed");
    assert.equal(toolRuns, 1);
    assert.equal(
      local.requests.filter((request) => request.summary).length,
      1,
      "the second inference reuses the last checkpoint during cooldown"
    );
    assert.equal(inferences, 2);
    for (const { body } of local.requests.filter((request) => !request.summary)) {
      const text = promptText(body);
      assert.match(text, /CURRENT_POLICY/);
      assert.match(text, /LAST_VALID_SUMMARY/);
      assert.match(text, /UNSUMMARIZED_RAW_WORK/);
      assert.doesNotMatch(text, /ALREADY_SUMMARIZED_RAW_PREFIX/);
      assert.deepEqual(
        body.tools.map((tool) => tool.function.name),
        [currentTool.name]
      );
    }
    for (const checkpoint of checkpoints) {
      assert.equal(checkpoint.compaction.summary, previousSummary);
      assert.equal(checkpoint.compaction.summarizedMessageCount, 3);
      assert.equal(checkpoint.compaction.compactionCount, 2);
    }
    await checkpointWrites;
    const persisted = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.deepEqual(persisted.compaction, initialState());
    assert.match(
      JSON.stringify(persisted.messages),
      /ALREADY_SUMMARIZED_RAW_PREFIX/,
      "durable history remains complete"
    );
    assert.deepEqual(messages.slice(0, original.length), original);
  }
);
