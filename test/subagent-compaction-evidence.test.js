import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ContextCompactor } from "../dist/src/runtime/context-compaction.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const assistant = (content, timestamp) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "compaction-evidence-fixture",
  model: "protocol-fixture",
  stopReason: "stop",
  usage,
  timestamp
});
const history = () => [
  { role: "user", content: "Implement the parser without changing its public API.", timestamp: 1 },
  assistant(
    [
      {
        type: "toolCall",
        id: "verification-call",
        name: "run_command",
        arguments: { command: "python replace.py; go test ./...", cwd: "/fixture/project" }
      }
    ],
    2
  ),
  {
    role: "toolResult",
    toolCallId: "verification-call",
    toolName: "run_command",
    isError: false,
    details: { exitCode: 0 },
    content: [
      {
        type: "text",
        text:
          "AssertionError: replacement did not reach the file write\n" +
          "MIDDLE_DIAGNOSTIC_SHOULD_NOT_BE_REPLAYED ".repeat(200) +
          "\nok example/parser (cached)\nTEST_TAIL_ANCHOR: this is the existing code, not the intended replacement."
      }
    ],
    timestamp: 3
  },
  assistant(
    [
      {
        type: "text",
        text: "LATER_CHANGE_ANCHOR: parser.js was changed after that command; current code is not verified."
      }
    ],
    4
  ),
  { role: "user", content: "Continue the current implementation.", timestamp: 5 }
];

async function fixture(
  t,
  { text = "Checkpoint: replacement failed; current parser remains unverified.", responseStream } = {}
) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readFixtureRequestBody(request));
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(responseStream?.(requests.length) ?? protocolStream("openai-completions", { text }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const model = {
    id: "protocol-fixture",
    name: "Compaction evidence fixture",
    api: "openai-completions",
    provider: "compaction-evidence-fixture",
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
      name: "Local evidence fixture",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: "Fixture key",
          resolve: async () => ({ auth: { apiKey: "isolated-evidence-fixture" } })
        }
      },
      models: [model],
      api: openAICompletionsApi()
    })
  );
  return {
    requests,
    connection: {
      api: model.api,
      model: model.id,
      baseUrl: model.baseUrl,
      apiKey: "isolated-evidence-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      maxErrorRetries: 0,
      timeoutMs: 5000,
      tools: new Map()
    },
    create: (initial, checkpoint, now) =>
      new ContextCompactor(
        models,
        model,
        { enabled: true, reserveTokens: 500, keepRecentTokens: 1 },
        initial,
        checkpoint,
        now
      )
  };
}

test(
  "Subagent summary receives bounded head/tail evidence and keeps later changes in order",
  { timeout: 10000 },
  async (t) => {
    const local = await fixture(t);
    const messages = history();
    const original = structuredClone(messages);
    const checkpoints = [];
    const compactor = local.create(undefined, (state) => checkpoints.push(state));
    const result = await compactor.compactIfNeeded(messages);
    assert.equal(result.compacted, true);
    assert.equal(local.requests.length, 1, "projection must not add a summary model request");
    const prompt = JSON.stringify(local.requests[0].messages);
    assert.match(prompt, /AssertionError: replacement did not reach the file write/);
    assert.match(prompt, /TEST_TAIL_ANCHOR/, "native summary input must retain the test result tail");
    assert.match(prompt, /verification-call/);
    assert.match(prompt, /exitCode=0/);
    assert.match(prompt, /LATER_CHANGE_ANCHOR/);
    assert.ok(prompt.indexOf("TEST_TAIL_ANCHOR") < prompt.indexOf("LATER_CHANGE_ANCHOR"));
    assert.deepEqual(messages, original, "summary projection must not edit the durable transcript");
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].summarizedMessageCount, result.state.summarizedMessageCount);
    assert.equal(result.messages.at(-1).content, "Continue the current implementation.");
    const resumed = local.create(checkpoints[0]);
    assert.equal((await resumed.compactIfNeeded(messages)).compacted, false);
    assert.equal(local.requests.length, 1, "resuming the checkpoint must not summarize that prefix again");
  }
);

test(
  "PiSession applies the continuation policy to native update summaries before provider serialization",
  { timeout: 10000 },
  async (t) => {
    const local = await fixture(t);
    const messages = history();
    const original = structuredClone(messages);
    const result = await new PiSession({
      ...local.connection,
      initialMessages: messages,
      initialCompaction: {
        summary: "PREVIOUS_CHECKPOINT_ANCHOR: parser implementation is in progress.",
        summarizedMessageCount: 0,
        compactionCount: 1
      },
      compaction: { reserveTokens: 500, keepRecentTokens: 1 }
    }).run("Continue.");
    assert.equal(result.termination, "completed");
    const summaries = local.requests.filter((request) =>
      request.messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content).includes("context summarization assistant")
      )
    );
    assert.equal(summaries.length, 1, "the policy must not require an additional model request");
    const prompt = JSON.stringify(summaries[0].messages);
    assert.match(prompt, /Reconcile the previous checkpoint/);
    assert.doesNotMatch(prompt, /PRESERVE all existing information/);
    assert.match(prompt, /PREVIOUS_CHECKPOINT_ANCHOR/);
    assert.match(prompt, /AssertionError: replacement did not reach the file write/);
    assert.match(prompt, /TEST_TAIL_ANCHOR/);
    assert.match(prompt, /verification-call/);
    assert.match(prompt, /exitCode=0/);
    assert.ok(prompt.indexOf("TEST_TAIL_ANCHOR") < prompt.indexOf("LATER_CHANGE_ANCHOR"));
    const inference = local.requests.filter((request) => !summaries.includes(request));
    assert.equal(inference.length, 1);
    const inferencePrompt = JSON.stringify(inference[0].messages);
    assert.doesNotMatch(inferencePrompt, /Reconcile the previous checkpoint/);
    assert.match(inferencePrompt, /Checkpoint: replacement failed; current parser remains unverified/);
    assert.match(inferencePrompt, /Continue\./);
    assert.equal(result.compaction.compactionCount, 2);
    assert.deepEqual(
      messages.slice(0, original.length),
      original,
      "summary adaptation must preserve the source messages"
    );
  }
);

test(
  "Subagent failed or unpersisted evidence summaries preserve the original transcript and cursor",
  { timeout: 10000 },
  async (t) => {
    const local = await fixture(t, { text: "" });
    const messages = history();
    const original = structuredClone(messages);
    const compactor = local.create();
    assert.deepEqual(await compactor.transform(messages), original);
    assert.equal(compactor.state.compactionCount, 0);
    assert.equal(compactor.state.summarizedMessageCount, 0);
    assert.equal(local.requests.length, 1);

    const unpersisted = await fixture(t);
    const persistFailure = unpersisted.create(undefined, () => {
      throw new Error("Fixture checkpoint write failed");
    });
    assert.deepEqual(await persistFailure.transform(messages), original);
    assert.equal(persistFailure.state.compactionCount, 0);
    assert.equal(persistFailure.state.summarizedMessageCount, 0);
    assert.equal(unpersisted.requests.length, 1);
    assert.deepEqual(messages, original);
  }
);

test(
  "Subagent rejects a stop summary containing text and a tool call without advancing state, then recovers",
  { timeout: 10000 },
  async (t) => {
    const incompleteText = "Checkpoint: finished, but also run another command.";
    // A gateway can return tool calls despite summary requests declaring no tools.
    // Keep a literal stop finish reason and non-empty text to isolate that case.
    const textStream = protocolStream("openai-completions", { text: incompleteText });
    const toolChunk = `data: ${JSON.stringify({
      id: "protocol",
      object: "chat.completion.chunk",
      created: 1,
      model: "protocol-fixture",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "unexpected_summary_tool",
                type: "function",
                function: { name: "run_command", arguments: '{"command":"touch unexpected"}' }
              }
            ]
          },
          finish_reason: null
        }
      ]
    })}\n\n`;
    const local = await fixture(t, {
      responseStream: (requestNumber) =>
        requestNumber === 1 ? textStream.replace("\n\n", "\n\n" + toolChunk) : undefined
    });
    const messages = history();
    const original = structuredClone(messages);
    const checkpoints = [];
    let now = 1000;
    const compactor = local.create(
      {
        summary: "EARLIER_VALID_CHECKPOINT: parser work is unfinished.",
        summarizedMessageCount: 0,
        compactionCount: 2
      },
      (state) => checkpoints.push(state),
      () => now
    );
    const initialState = compactor.state;
    const failed = await compactor.transform(messages);
    assert.equal(local.requests.length, 1);
    assert.deepEqual(
      compactor.state,
      initialState,
      "a tool call invalidates the summary even with stop and visible text"
    );
    assert.match(JSON.stringify(failed[0]), /EARLIER_VALID_CHECKPOINT/);
    assert.deepEqual(failed.slice(1), original, "the persisted summary accompanies the unchanged raw tail");
    assert.deepEqual(messages, original);
    assert.equal(checkpoints.length, 0);

    now += 5000;
    const recovered = await compactor.compactIfNeeded(messages);
    assert.equal(recovered.compacted, true);
    assert.equal(local.requests.length, 2);
    assert.equal(recovered.state.compactionCount, initialState.compactionCount + 1);
    assert.equal(recovered.state.summarizedMessageCount, 4);
    assert.equal(
      recovered.state.summary,
      "Checkpoint: replacement failed; current parser remains unverified."
    );
    assert.equal(checkpoints.length, 1);
    assert.deepEqual(messages, original);
  }
);
