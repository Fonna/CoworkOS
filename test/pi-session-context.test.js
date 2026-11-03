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
import { PiSession, unresolvedToolCallIds } from "../dist/src/runtime/pi-session.js";
import { TraceRecorder } from "../dist/src/storage/trace-recorder.js";
import { connectionProfile } from "../dist/src/runtime/model-profile.js";

const summaryText = "已生成 receipt.txt 一次；失败检查报告权限不足。人工批准保留中文名称，不覆盖收据。";
const policy = "必须保留中文收据；仅在隔离目录写入。";
const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM3sAAAAASUVORK5CYII=";
const user = (content, timestamp = 1) => ({ role: "user", content, timestamp });
const assistant = (content, stopReason = "stop", timestamp = 2) => ({
  role: "assistant",
  content,
  stopReason,
  api: "openai-completions",
  provider: "cowork-glm",
  model: "context-fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  timestamp
});
const toolResult = (id, text, timestamp = 3) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "write_receipt",
  content: [{ type: "text", text }],
  details: {},
  isError: false,
  timestamp
});

function stream(response, { text = "核对完成。", finish = "stop", calls } = {}) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: "context-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "context-fixture",
        choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`
    );
  send({ role: "assistant" });
  if (calls) {
    send({
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
      }))
    });
    send({}, "tool_calls");
  } else {
    send({ content: text });
    send({}, finish);
  }
  response.end("data: [DONE]\n\n");
}

async function fixture(
  t,
  handle = ({ response, summary }) => stream(response, { text: summary ? summaryText : "核对完成。" })
) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const summary = body.messages.some(
      (message) =>
        typeof message.content === "string" && message.content.includes("context summarization assistant")
    );
    const item = { body, summary, authenticated: Boolean(request.headers.authorization) };
    requests.push(item);
    await handle({ ...item, request, response, requests });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    baseUrl,
    apiKey: "isolated-compaction-fixture",
    model: "context-fixture",
    supportsImages: true,
    supportsReasoningEffort: false,
    thinkingLevel: "off",
    systemPrompt: policy,
    tools: new Map(),
    maxErrorRetries: 0,
    maxTokens: 512,
    timeoutMs: 5000
  };
}

function compactor(connection, { keepRecentTokens = 32, checkpoint, initial, now } = {}) {
  const model = {
    id: "context-fixture",
    name: "Context fixture",
    api: "openai-completions",
    provider: "cowork-glm",
    baseUrl: `${connection.baseUrl}/v1`,
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000,
    maxTokens: 512,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "cowork-glm",
      name: "Local fixture",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: { name: "Fixture key", resolve: async () => ({ auth: { apiKey: connection.apiKey } }) }
      },
      models: [model],
      api: openAICompletionsApi()
    })
  );
  return new ContextCompactor(
    models,
    model,
    { enabled: true, reserveTokens: 500, keepRecentTokens },
    initial,
    checkpoint,
    now
  );
}

const history = () => [
  {
    role: "system",
    content: policy,
    toolsAdded: [
      { name: "write_receipt", description: "写入中文收据。", parameters: { type: "object", properties: {} } }
    ],
    timestamp: 0
  },
  user("旧任务约束：保留中文名称。".repeat(300)),
  assistant([{ type: "text", text: "此前核对已完成。" }]),
  user("继续核对。", 4)
];

test(
  "PiSession really compacts long history using the configured connection",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const recordingRoot = await mkdtemp(join(tmpdir(), "atria-compaction-requests-"));
    t.after(() => rm(recordingRoot, { recursive: true, force: true }));
    const trace = new TraceRecorder(join(recordingRoot, "worker.jsonl"));
    const initial = history().filter((message) => message.role !== "system");
    const result = await new PiSession({
      ...connection,
      contextWindow: connectionProfile({ contextWindow: 1000 }).contextWindow,
      trace: { recorder: trace, taskId: "task", runId: "run", agentId: "worker" },
      initialMessages: initial,
      compaction: { reserveTokens: 500, keepRecentTokens: 32 }
    }).run("继续。");
    assert.equal(result.termination, "completed");
    assert.equal(
      connection.requests.filter((request) => request.summary).length,
      1,
      "overflow must request a real summary, not silently send the full transcript"
    );
    assert.equal(result.compaction.compactionCount, 1);
    assert.ok(connection.requests.every((request) => request.authenticated));
    const inference = connection.requests.find((request) => !request.summary).body;
    assert.ok(
      JSON.stringify(inference.messages).includes(policy),
      "compaction must retain the system policy"
    );
    assert.ok(JSON.stringify(inference.messages).includes(summaryText));
    const records = (await readFile(trace.modelRequestPath, "utf8")).trim().split("\n").map(JSON.parse);
    const requests = records.filter((record) => record.type === "model_request");
    assert.ok(requests.every((record) => record.payload.model.contextWindow === 1000));
    assert.equal(requests.length, connection.requests.length, "summary calls are also archived");
    assert.deepEqual(
      requests.map((record) => record.payload.request),
      connection.requests.map((request) => request.body)
    );
    assert.equal(
      records.filter((record) => record.type === "model_response").length,
      connection.requests.length
    );
  }
);

test("compacted context retains policy and executable tool declarations", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t);
  const saved = history();
  const before = structuredClone(saved);
  const result = await compactor(connection).compactIfNeeded(saved);
  assert.equal(result.compacted, true);
  assert.equal(connection.requests.length, 1);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[0].content, policy);
  assert.equal(result.messages[0].toolsAdded[0].name, "write_receipt");
  assert.ok(JSON.stringify(result.messages).includes(summaryText));
  assert.ok(
    !JSON.stringify(connection.requests[0].body.messages).includes(policy),
    "system policy must not be copied into conversation summary text"
  );
  assert.deepEqual(saved, before, "compression must not edit durable full history");
});

test("large provider prompt usage does not discard small recent turns", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t);
  const saved = [history()[0]];
  for (let index = 0; index < 20; index++) {
    saved.push(user(`Question ${index}: verify receipt.`, index * 2 + 1));
    saved.push(assistant([{ type: "text", text: `Receipt ${index} verified.` }], "stop", index * 2 + 2));
  }
  // A short reply can report a large prompt, including cached input.
  saved.at(-1).usage = {
    ...saved.at(-1).usage,
    input: 10,
    cacheRead: 1400,
    output: 5,
    totalTokens: 1415
  };
  const original = structuredClone(saved);
  const compact = compactor(connection, { keepRecentTokens: 70 });
  const result = await compact.compactIfNeeded(saved);
  assert.equal(result.compacted, true);
  assert.equal(connection.requests.length, 1);
  for (const index of [16, 17, 18, 19]) {
    assert.ok(result.messages.some((message) => message.content === `Question ${index}: verify receipt.`));
  }
  assert.ok(result.state.summarizedMessageCount > 1);
  assert.deepEqual(saved, original);
  const restored = compactor(connection, { keepRecentTokens: 70, initial: result.state });
  // Context request usage is reported again by the provider after inference;
  // the existing retained tail must not be summarized twice on recovery.
  const next = await restored.compactIfNeeded(saved);
  assert.equal(next.compacted, false);
  assert.equal(connection.requests.length, 1);
});

for (const [label, answer] of [
  ["empty", { text: "   " }],
  ["truncated", { text: "已生成收据但任务约束", finish: "length" }]
]) {
  test(`a ${label} summary cannot discard durable conversation context`, { timeout: 10000 }, async (t) => {
    const connection = await fixture(t, ({ response }) => stream(response, answer));
    let checkpoints = 0;
    const compact = compactor(connection, {
      checkpoint: () => {
        checkpoints += 1;
      }
    });
    const saved = history();
    const transformed = await compact.transform(saved);
    assert.equal(connection.requests.length, 1);
    assert.deepEqual(transformed, saved, "an unusable summary must fall back to complete history");
    assert.equal(compact.state.summarizedMessageCount, 0);
    assert.equal(checkpoints, 0);
  });
}

test("a failed compaction checkpoint does not commit its cursor in memory", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t);
  const compact = compactor(connection, {
    checkpoint: () => {
      throw new Error("Synthetic checkpoint write failed.");
    }
  });
  const saved = history();
  assert.deepEqual(await compact.transform(saved), saved);
  assert.equal(compact.state.summarizedMessageCount, 0);
  assert.equal(compact.state.compactionCount, 0);
});

test(
  "a single active user turn can compact completed tool exchanges while retaining a recent pair",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const saved = [history()[0], user("Complete all receipt checks without repeating writes. ".repeat(40))];
    for (let index = 1; index <= 4; index++) {
      saved.push(
        assistant(
          [{ type: "toolCall", id: `check-${index}`, name: "write_receipt", arguments: { index } }],
          "toolUse"
        ),
        toolResult(`check-${index}`, `Receipt ${index} confirmed. ${"diagnostic ".repeat(150)}`)
      );
    }
    const before = structuredClone(saved);
    const result = await compactor(connection, { keepRecentTokens: 300 }).compactIfNeeded(saved);
    assert.equal(result.compacted, true, "a long tool loop must not wait for a second user request");
    assert.deepEqual(result.messages.slice(-2), saved.slice(-2), "keep the recent call and receipt verbatim");
    assert.ok(result.state.summarizedMessageCount > 1, "the current user turn prefix was summarized");
    assert.deepEqual(saved, before, "the durable source history remains complete");
  }
);

test(
  "a recent tool result retains its originating request and call during compaction",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const saved = history().slice(0, 3);
    saved.push(user("最近要求：写入收据，不覆盖已有文件。", 4));
    saved.push(
      assistant(
        [
          {
            type: "toolCall",
            id: "recent-write",
            name: "write_receipt",
            arguments: { note: "详细约束".repeat(80) }
          }
        ],
        "toolUse",
        5
      )
    );
    saved.push(toolResult("recent-write", "写入成功 receipt.txt", 6));
    const result = await compactor(connection, { keepRecentTokens: 20 }).compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    const retained = JSON.stringify(result.messages);
    assert.match(JSON.stringify(connection.requests[0].body.messages), /最近要求/);
    assert.match(retained, /recent-write/);
    assert.equal(result.messages.filter((message) => message.role === "assistant").length, 1);
    assert.equal(result.messages.filter((message) => message.role === "toolResult").length, 1);
  }
);

test(
  "a tail boundary inside parallel tool results retains their shared call and both receipts",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const parallel = assistant(
      [
        { type: "toolCall", id: "parallel-a", name: "write_receipt", arguments: { part: "a" } },
        { type: "toolCall", id: "parallel-b", name: "write_receipt", arguments: { part: "b" } }
      ],
      "toolUse"
    );
    const firstResult = toolResult("parallel-a", `First receipt. ${"a".repeat(1200)}`);
    const secondResult = toolResult("parallel-b", `Second receipt. ${"b".repeat(400)}`);
    const saved = [
      history()[0],
      user("Perform both writes without overwriting existing files. ".repeat(60)),
      parallel,
      firstResult,
      secondResult
    ];
    const result = await compactor(connection, { keepRecentTokens: 200 }).compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    assert.deepEqual(
      result.messages.slice(-3),
      [parallel, firstResult, secondResult],
      "a candidate within the results must move back to the shared originating assistant"
    );
    assert.equal(result.state.summarizedMessageCount, 2);
  }
);

test(
  "a settled reused ID does not permit a later unresolved call to enter the summary",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const call = (version) =>
      assistant(
        [{ type: "toolCall", id: "reused-call", name: "write_receipt", arguments: { version } }],
        "toolUse"
      );
    const pending = call("PENDING_VERSION_ANCHOR");
    const latest = user("Do not repeat the pending write; inspect its result before proceeding. ".repeat(30));
    const saved = [
      history()[0],
      user("Write the first receipt. ".repeat(80)),
      call("completed"),
      toolResult("reused-call", "The first write completed."),
      pending,
      latest
    ];
    const result = await compactor(connection, { keepRecentTokens: 20 }).compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    assert.deepEqual(result.messages.slice(-2), [pending, latest]);
    assert.equal(result.state.summarizedMessageCount, 4);
    assert.deepEqual(unresolvedToolCallIds(result.messages), ["reused-call"]);
    assert.doesNotMatch(
      JSON.stringify(connection.requests[0].body.messages),
      /PENDING_VERSION_ANCHOR/,
      "the outstanding call remains in the raw tail"
    );
  }
);

test(
  "an unfinished member of a parallel call keeps the full exchange ahead of the latest user input",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const calls = assistant(
      [
        { type: "toolCall", id: "finished", name: "write_receipt", arguments: {} },
        { type: "toolCall", id: "pending", name: "write_receipt", arguments: {} }
      ],
      "toolUse"
    );
    const settled = toolResult("finished", "The first parallel operation completed.");
    const latest = user("The second operation is still pending. ".repeat(100));
    const saved = [history()[0], user("Perform both operations. ".repeat(80)), calls, settled, latest];
    const result = await compactor(connection, { keepRecentTokens: 20 }).compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    assert.deepEqual(result.messages.slice(-3), [calls, settled, latest]);
    assert.deepEqual(unresolvedToolCallIds(result.messages), ["pending"]);
    assert.equal(result.state.summarizedMessageCount, 2);
  }
);

test("an earlier result cannot settle a later repeated tool-call ID", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t);
  const call = assistant(
    [{ type: "toolCall", id: "reused-id", name: "write_receipt", arguments: {} }],
    "toolUse"
  );
  const initialMessages = [
    user("第一次写入。"),
    call,
    toolResult("reused-id", "第一次已完成。"),
    user("第二次写入。"),
    structuredClone(call)
  ];
  const result = await new PiSession({ ...connection, initialMessages, compaction: { enabled: false } }).run(
    "恢复。",
    { resume: true }
  );
  assert.equal(connection.requests.length, 1);
  assert.deepEqual(unresolvedToolCallIds(result.messages), ["reused-id"]);
  assert.equal(result.termination, "aborted", "a new action needs its own later result before completion");
});

test(
  "long real tool workflow compacts, preserves human/image context, and resumes without repeating writes",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "atria-context-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let writes = 0;
    let normalRequests = 0;
    const connection = await fixture(t, ({ response, summary }) => {
      if (summary) stream(response, { text: summaryText });
      else if (++normalRequests === 1) {
        stream(response, {
          calls: [{ id: "write-1", name: "write_receipt" }]
        });
      } else if (normalRequests === 2) {
        stream(response, { calls: [{ id: "fail-1", name: "check_permission" }] });
      } else stream(response, { text: "收据存在，失败检查已记录，等待人工确认。" });
    });
    const tools = new Map([
      [
        "write_receipt",
        {
          parameters: { type: "object", properties: {} },
          execute: async () => {
            writes += 1;
            await writeFile(join(directory, "receipt.txt"), "中文名称已保留\n", { flag: "wx" });
            return { path: "receipt.txt", written: true };
          }
        }
      ],
      [
        "check_permission",
        {
          parameters: { type: "object", properties: {} },
          execute: async () => ({ isError: true, error: "权限不足，保留已有收据。" })
        }
      ]
    ]);
    const first = await new PiSession({ ...connection, tools, compaction: { enabled: false } }).run(
      "检查中文收据。历史要求：不覆盖文件。".repeat(700)
    );
    assert.equal(first.termination, "completed");
    assert.equal(writes, 1);
    assert.equal(
      first.messages.filter((message) => message.role === "toolResult" && message.isError).length,
      1
    );
    const recovery = [
      ...structuredClone(first.messages),
      user("[Message from Main]\n人工批准保留中文名称，不覆盖收据。", 9),
      user(
        [
          { type: "text", text: "看这张最新图片并确认已有收据。" },
          { type: "image", data: imageData, mimeType: "image/png" }
        ],
        10
      )
    ];
    const original = structuredClone(recovery);
    const checkpoints = [];
    const resumed = await new PiSession({
      ...connection,
      tools,
      initialMessages: recovery,
      compaction: { reserveTokens: 253500, keepRecentTokens: 1210 },
      onCheckpoint: (state) => {
        checkpoints.push(structuredClone(state));
      }
    }).run("恢复。", { resume: true });
    assert.equal(resumed.termination, "completed");
    assert.equal(resumed.compaction.compactionCount, 1);
    const summarized = JSON.stringify(connection.requests.find((request) => request.summary).body.messages);
    assert.match(summarized, /receipt.txt/);
    assert.match(summarized, /权限不足/);
    assert.match(summarized, /人工批准保留中文名称/);
    assert.equal(writes, 1);
    assert.equal(await readFile(join(directory, "receipt.txt"), "utf8"), "中文名称已保留\n");
    assert.deepEqual(recovery, original);
    assert.ok(
      !JSON.stringify(resumed.messages).includes("<summary>"),
      "compression summaries must not become user-visible conversation messages"
    );
    const inference = connection.requests.filter((request) => !request.summary).at(-1).body;
    assert.match(JSON.stringify(inference.messages), /人工批准保留中文名称/);
    assert.match(JSON.stringify(inference.messages), /data:image\/png;base64/);
    assert.equal(inference.tools.find((tool) => tool.function.name === "write_receipt").type, "function");
    assert.match(JSON.stringify(inference.messages), new RegExp(policy));
    const checkpoint = checkpoints.at(-1);
    assert.ok(!JSON.stringify(checkpoint.messages).includes("<summary>"));
    assert.equal(checkpoint.compaction.compactionCount, 1);
    const summaries = connection.requests.filter((request) => request.summary).length;
    const rerun = await new PiSession({
      ...connection,
      tools,
      initialMessages: checkpoint.messages,
      initialCompaction: checkpoint.compaction,
      compaction: { reserveTokens: 253500, keepRecentTokens: 1210 }
    }).run("继续确认。", { resume: true });
    assert.equal(rerun.termination, "completed");
    assert.equal(rerun.compaction.compactionCount, 1);
    assert.equal(connection.requests.filter((request) => request.summary).length, summaries);
    assert.equal(writes, 1);
  }
);

test(
  "iterative compaction updates the prior summary once and restores the effective tool loadout",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const saved = history();
    const first = await compactor(connection).compactIfNeeded(saved);
    const oldCursor = first.state.summarizedMessageCount;
    const checkpoint = structuredClone(first.state);
    const resumed = compactor(connection, { initial: checkpoint });
    const unchanged = await resumed.compactIfNeeded(saved);
    assert.equal(unchanged.compacted, false);
    assert.equal(connection.requests.length, 1, "restoring a persisted summary must not regenerate it");
    saved.push(assistant([{ type: "text", text: "接着核对新文件。" }], "stop", 5));
    saved.push({
      role: "system",
      content: "更新要求：只读核对。",
      toolsRemoved: [{ name: "write_receipt" }],
      toolsAdded: [
        { name: "read_receipt", description: "读取收据。", parameters: { type: "object", properties: {} } }
      ],
      sections: { workspace: "隔离目录二" },
      timestamp: 6
    });
    saved.push(user("第二阶段要求：只读核对，不再写入。".repeat(250), 7));
    saved.push(assistant([{ type: "text", text: "第二阶段分析已完成。" }], "stop", 8));
    saved.push(user("继续最后确认。", 9));
    const result = await resumed.compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    assert.equal(result.state.compactionCount, 2);
    assert.ok(result.state.summarizedMessageCount > oldCursor);
    const updateRequest = JSON.stringify(connection.requests[1].body.messages);
    assert.match(updateRequest, /previous-summary/);
    assert.match(updateRequest, /人工批准保留中文名称/);
    assert.match(updateRequest, /第二阶段要求/);
    assert.doesNotMatch(updateRequest, /旧任务约束：保留中文名称/);
    assert.match(result.messages[0].content, /更新要求：只读核对/);
    assert.deepEqual(
      result.messages[0].toolsAdded.map((tool) => tool.name),
      ["read_receipt"]
    );
    assert.equal(result.messages[0].sections.workspace, "隔离目录二");
    assert.deepEqual(checkpoint, first.state);
  }
);

test("an oversized first turn cannot create an empty system-only summary", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t);
  const saved = [history()[0], user("完整首轮要求".repeat(1000))];
  const result = await compactor(connection, { keepRecentTokens: 20 }).compactIfNeeded(saved);
  assert.equal(result.compacted, false);
  assert.deepEqual(result.messages, saved);
  assert.equal(connection.requests.length, 0);
});

test(
  "an oversized newest input can retain itself while older complete turns are compacted",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    const latest = user("最新大输入必须逐字保留。".repeat(300), 8);
    const saved = [...history().slice(0, 3), latest];
    const result = await compactor(connection, { keepRecentTokens: 20 }).compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    assert.deepEqual(result.messages.at(-1), latest);
    assert.equal(result.state.summarizedMessageCount, 3);
  }
);

for (const mode of ["orphan-result", "duplicate-result", "settled-reuse"]) {
  test(
    `ordered tool receipts handle ${mode} without crediting future actions`,
    { timeout: 10000 },
    async (t) => {
      const connection = await fixture(t);
      const call = () =>
        assistant([{ type: "toolCall", id: "same-id", name: "write_receipt", arguments: {} }], "toolUse");
      const initialMessages =
        mode === "orphan-result"
          ? [user("核对。"), toolResult("same-id", "无对应调用的旧结果。"), call()]
          : [
              user("第一次。"),
              call(),
              toolResult("same-id", "第一次完成。"),
              ...(mode === "duplicate-result" ? [toolResult("same-id", "重复旧结果。 ")] : []),
              user("第二次。"),
              call(),
              ...(mode === "settled-reuse" ? [toolResult("same-id", "第二次完成。 ")] : [])
            ];
      const result = await new PiSession({
        ...connection,
        initialMessages,
        compaction: { enabled: false }
      }).run("恢复。", { resume: true });
      assert.equal(connection.requests.length, 1);
      assert.equal(result.termination, mode === "settled-reuse" ? "completed" : "aborted");
      assert.deepEqual(unresolvedToolCallIds(result.messages), mode === "settled-reuse" ? [] : ["same-id"]);
    }
  );
}

test(
  "cancelling an in-flight summary preserves history and can recover without replaying a settled tool",
  { timeout: 10000 },
  async (t) => {
    let begin;
    const started = new Promise((resolve) => {
      begin = resolve;
    });
    let hold = true;
    let toolRuns = 0;
    const connection = await fixture(t, ({ response, summary }) => {
      if (summary && hold) {
        begin();
        return;
      }
      stream(response, { text: summary ? summaryText : "读取已有收据，任务核对完成。" });
    });
    const tools = new Map([
      [
        "write_receipt",
        {
          parameters: { type: "object", properties: {} },
          execute: async () => {
            toolRuns += 1;
            return "必须不执行的重复写入。";
          }
        }
      ]
    ]);
    const controller = new AbortController();
    const initial = [
      user("长历史约束。".repeat(1500)),
      assistant([{ type: "toolCall", id: "settled-write", name: "write_receipt", arguments: {} }], "toolUse"),
      toolResult("settled-write", "receipt.txt 已写入一次。"),
      assistant([{ type: "text", text: "已保存中文收据。" }]),
      user("继续只读核对。", 6)
    ];
    const original = structuredClone(initial);
    const checkpoints = [];
    const session = new PiSession({
      ...connection,
      tools,
      initialMessages: initial,
      signal: controller.signal,
      compaction: { reserveTokens: 255900, keepRecentTokens: 32 },
      onCheckpoint: (state) => {
        checkpoints.push(structuredClone(state));
      }
    });
    const running = session.run("恢复。", { resume: true });
    await started;
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.termination, "cancelled");
    assert.equal(cancelled.compaction.compactionCount, 0);
    assert.equal(cancelled.compaction.summarizedMessageCount, 0);
    assert.equal(connection.requests.length, 1);
    assert.equal(connection.requests[0].summary, true);
    assert.equal(toolRuns, 0);
    assert.deepEqual(initial, original);
    assert.ok(checkpoints.every((checkpoint) => checkpoint.compaction.compactionCount === 0));
    assert.deepEqual(unresolvedToolCallIds(cancelled.messages), []);
    const before = structuredClone(cancelled.messages);
    hold = false;
    const resumed = await new PiSession({
      ...connection,
      tools,
      initialMessages: cancelled.messages,
      initialCompaction: cancelled.compaction,
      compaction: { reserveTokens: 255900, keepRecentTokens: 32 }
    }).run("继续。", { resume: true });
    assert.equal(resumed.termination, "completed");
    assert.equal(resumed.compaction.compactionCount, 1);
    assert.equal(connection.requests.filter((request) => !request.summary).length, 1);
    assert.equal(toolRuns, 0);
    assert.deepEqual(cancelled.messages, before);
  }
);

test(
  "a repeated tool loop stops at its turn budget with settled results and no false completion",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, ({ response }) =>
      stream(response, { calls: [{ id: "repeated-loop-id", name: "write_receipt" }] })
    );
    let runs = 0;
    const tools = new Map([
      [
        "write_receipt",
        {
          parameters: { type: "object", properties: {} },
          execute: async () => {
            runs += 1;
            return { run: runs };
          }
        }
      ]
    ]);
    const checkpoints = [];
    const result = await new PiSession({
      ...connection,
      tools,
      maxTurns: 2,
      compaction: { enabled: false },
      onCheckpoint: (state) => {
        checkpoints.push(structuredClone(state));
      }
    }).run("执行两轮隔离核对。 ");
    assert.equal(connection.requests.length, 2);
    assert.equal(runs, 2);
    assert.equal(result.messages.filter((message) => message.role === "toolResult").length, 2);
    assert.deepEqual(unresolvedToolCallIds(result.messages), []);
    assert.equal(result.termination, "aborted");
    assert.equal(checkpoints.at(-1).messages.at(-1).role, "toolResult");
  }
);

test(
  "a length-limited tool call is never executed as a complete side effect",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, ({ response }) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "length", object: "chat.completion.chunk", created: 1, model: "context-fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "unfinished", type: "function", function: { name: "write_receipt", arguments: '{"path":"partial' } }] }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`
      );
    });
    let runs = 0;
    const tools = new Map([
      [
        "write_receipt",
        {
          parameters: { type: "object", properties: { path: { type: "string" } } },
          execute: async () => {
            runs += 1;
            return "written";
          }
        }
      ]
    ]);
    const result = await new PiSession({
      ...connection,
      tools,
      maxTurns: 1,
      compaction: { enabled: false }
    }).run("写入隔离收据。");
    assert.equal(connection.requests.length, 1);
    assert.equal(runs, 0);
    assert.equal(result.assistant.stopReason, "length");
    assert.equal(result.termination, "aborted");
  }
);

test(
  "an update summary failure falls back to the persisted summary and raw tail",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, ({ response }) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic update summary failure." } }));
    });
    const saved = [
      ...history(),
      assistant([{ type: "text", text: "New unfinished work. ".repeat(200) }]),
      user("Continue from the last verified receipt.")
    ];
    const initial = {
      summary: "PERSISTED_CHECKPOINT: receipt.txt exists, do not repeat its write.",
      summarizedMessageCount: 3,
      compactionCount: 1
    };
    let checkpoints = 0;
    const compact = compactor(connection, { initial, checkpoint: () => checkpoints++ });
    const before = compact.state;
    const fallback = await compact.transform(saved);
    assert.match(JSON.stringify(fallback), /PERSISTED_CHECKPOINT/);
    assert.doesNotMatch(JSON.stringify(fallback), /旧任务约束/);
    assert.deepEqual(fallback.slice(2), saved.slice(3));
    assert.equal(fallback[0].content, policy);
    assert.deepEqual(compact.state, before);
    assert.equal(checkpoints, 0);
  }
);

test(
  "a failed real summary request preserves context and a later retry can persist compaction",
  { timeout: 10000 },
  async (t) => {
    let summaries = 0;
    const connection = await fixture(t, ({ response, summary }) => {
      if (summary && ++summaries === 1) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Synthetic temporary summary failure." } }));
      } else stream(response, { text: summaryText });
    });
    let saves = 0;
    let now = 1000;
    const compact = compactor(connection, {
      now: () => now,
      checkpoint: () => {
        saves += 1;
      }
    });
    const saved = history();
    assert.deepEqual(await compact.transform(saved), saved);
    assert.equal(compact.state.compactionCount, 0);
    assert.equal(saves, 0);
    now += 5000;
    const result = await compact.compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    assert.equal(compact.state.compactionCount, 1);
    assert.equal(summaries, 2);
    assert.equal(saves, 1);
    assert.match(JSON.stringify(connection.requests[1].body.messages), /旧任务约束/);
  }
);

test(
  "a checkpoint write failure can recover without adopting an unpersisted summary",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t);
    let attempts = 0;
    let persisted;
    let now = 1000;
    const compact = compactor(connection, {
      now: () => now,
      checkpoint: (state) => {
        attempts += 1;
        if (attempts === 1) throw new Error("Synthetic first checkpoint failure.");
        persisted = structuredClone(state);
      }
    });
    const saved = history();
    assert.deepEqual(await compact.transform(saved), saved);
    assert.equal(compact.state.compactionCount, 0);
    now += 5000;
    const result = await compact.compactIfNeeded(saved);
    assert.equal(result.compacted, true);
    assert.equal(attempts, 2);
    assert.equal(connection.requests.length, 2);
    assert.deepEqual(compact.state, persisted);
    assert.doesNotMatch(JSON.stringify(connection.requests[1].body.messages), /previous-summary/);
    assert.match(JSON.stringify(connection.requests[1].body.messages), /旧任务约束/);
  }
);

test(
  "a deadline during compaction stops before inference or tools and leaves a recoverable cursor",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, () => {});
    let tools = 0;
    const result = await new PiSession({
      ...connection,
      timeoutMs: 1000,
      initialMessages: history().filter((message) => message.role !== "system"),
      compaction: { reserveTokens: 255900, keepRecentTokens: 32 },
      tools: new Map([
        [
          "write_receipt",
          {
            parameters: { type: "object", properties: {} },
            execute: async () => {
              tools += 1;
              return "written";
            }
          }
        ]
      ])
    }).run("继续核对。 ");
    assert.equal(result.termination, "timed_out");
    assert.equal(result.compaction.compactionCount, 0);
    assert.equal(result.compaction.summarizedMessageCount, 0);
    assert.equal(connection.requests.length, 1);
    assert.equal(connection.requests[0].summary, true);
    assert.equal(tools, 0);
  }
);
