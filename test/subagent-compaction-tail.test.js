import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const contentText = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
const promptText = (body) => body.messages.map((message) => contentText(message.content)).join("\n");
const receiptText = (index) => {
  const number = String(index).padStart(2, "0");
  return (
    `RECEIPT_${number}_HEAD: step-${index}.txt was created once.\n` +
    "a".repeat(3900) +
    `\nRECEIPT_${number}_MIDDLE: preserve the original diagnostics.\n` +
    "z".repeat(3900) +
    `\nRECEIPT_${number}_TAIL: verified, do not repeat the write.`
  );
};

function assertPairedWireMessages(body) {
  const pending = new Map();
  for (const message of body.messages) {
    for (const call of message.tool_calls ?? []) {
      pending.set(call.id, (pending.get(call.id) ?? 0) + 1);
    }
    if (message.role === "tool") {
      const count = pending.get(message.tool_call_id) ?? 0;
      assert.ok(count > 0, `tool result ${message.tool_call_id} must have its preceding raw call`);
      if (count === 1) pending.delete(message.tool_call_id);
      else pending.set(message.tool_call_id, count - 1);
    }
  }
  assert.equal(pending.size, 0, "only completed exchanges are submitted for the next inference");
}

test(
  "a single-user Subagent tool loop keeps about 20k recent tokens and resumes its persisted summary cursor",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "atria-subagent-tail-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const requests = [];
    let summaries = 0;
    let inferences = 0;
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readFixtureRequestBody(request));
      const summary = promptText(body).includes("context summarization assistant");
      requests.push({ body, summary });
      const reply = summary
        ? { text: `SEMANTIC_CHECKPOINT_${++summaries}: completed receipt writes must not be repeated.` }
        : ++inferences <= 26
          ? { name: "write_step", arguments: { index: inferences } }
          : { text: "All 26 receipt writes were verified and retained." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        protocolStream("openai-completions", reply).replaceAll("call_protocol", `step-${inferences}`)
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const writes = [];
    const checkpointPath = join(directory, "checkpoint.json");
    let checkpointWrites = Promise.resolve();
    const connection = {
      api: "openai-completions",
      model: "protocol-fixture",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "isolated-subagent-tail-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      contextWindow: 32000,
      maxTokens: 512,
      maxErrorRetries: 0,
      timeoutMs: 10000,
      systemPrompt: "Create each numbered receipt once; preserve existing files and verification evidence.",
      compaction: { reserveTokens: 4000 },
      tools: new Map([
        [
          "write_step",
          {
            parameters: {
              type: "object",
              properties: { index: { type: "integer" } },
              required: ["index"]
            },
            execute: async ({ index }) => {
              await writeFile(join(directory, `step-${index}.txt`), `Created receipt ${index}.\n`, {
                flag: "wx"
              });
              writes.push(index);
              return { content: [{ type: "text", text: receiptText(index) }], details: { index } };
            }
          }
        ]
      ]),
      onCheckpoint: (checkpoint) => {
        checkpointWrites = checkpointWrites.then(() => writeFile(checkpointPath, JSON.stringify(checkpoint)));
        return checkpointWrites;
      }
    };
    const first = await new PiSession({ ...connection, maxTurns: 18 }).run(
      "Create and verify the 26 numbered receipt files, once each; finish with the verification result."
    );
    assert.equal(first.termination, "aborted", "the artificial turn limit interrupts after a tool result");
    assert.equal(first.messages.at(-1).role, "toolResult");
    assert.ok(first.compaction.compactionCount > 0, "one long user turn must trigger a real summary");
    await checkpointWrites;
    const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(first.messages)));
    assert.deepEqual(saved.compaction, first.compaction);
    assert.equal(saved.messages.filter((message) => message.role === "user").length, 1);
    assert.ok(
      !JSON.stringify(saved.messages).includes("<summary>"),
      "synthetic context stays out of the archive"
    );
    const restoredCursor = saved.compaction.summarizedMessageCount;
    const requestCountBeforeResume = requests.length;
    const resumed = await new PiSession({
      ...connection,
      initialMessages: saved.messages,
      initialCompaction: saved.compaction
    }).run("Resume from disk.", { resume: true });
    assert.equal(resumed.termination, "completed");
    assert.equal(resumed.messages.filter((message) => message.role === "user").length, 1);
    assert.ok(resumed.compaction.summarizedMessageCount > restoredCursor);
    assert.ok(resumed.compaction.compactionCount > saved.compaction.compactionCount);
    assert.deepEqual(
      writes,
      Array.from({ length: 26 }, (_, index) => index + 1)
    );
    const summaryRequests = requests.filter((request) => request.summary);
    assert.equal(summaryRequests.length, resumed.compaction.compactionCount);
    for (let index = 1; index < summaryRequests.length; index++) {
      const text = promptText(summaryRequests[index].body);
      assert.match(text, /<previous-summary>/);
      assert.ok(text.includes(`SEMANTIC_CHECKPOINT_${index}:`));
      assert.doesNotMatch(
        text.match(/<conversation>([\s\S]*?)<\/conversation>/)?.[1] ?? "",
        /RECEIPT_01_HEAD/,
        "already summarized receipts must not be summarized again after a cursor advance"
      );
    }
    const resumedSummary = requests.slice(requestCountBeforeResume).find((request) => request.summary);
    assert.ok(resumedSummary, "the restored session can extend the previous summary");
    assert.ok(promptText(resumedSummary.body).includes(saved.compaction.summary));
    const compactedInferences = requests.filter(
      (request) => !request.summary && promptText(request.body).includes("<summary>")
    );
    assert.ok(compactedInferences.length > 0);
    const firstTail = compactedInferences[0].body.messages.filter((message) => message.role === "tool");
    const recentTextTokens = firstTail.reduce(
      (total, message) => total + contentText(message.content).length / 4,
      0
    );
    assert.ok(
      recentTextTokens >= 18000 && recentTextTokens <= 22000,
      `the default recent raw tail should be about 20k tokens; saw ${recentTextTokens}`
    );
    for (const request of requests.filter((item) => !item.summary)) {
      assertPairedWireMessages(request.body);
      for (const message of request.body.messages.filter((item) => item.role === "tool")) {
        const index = Number(message.tool_call_id.match(/step-(\d+)/)?.[1]);
        assert.equal(contentText(message.content), receiptText(index), "retained tool results stay verbatim");
      }
    }
    for (const index of writes) {
      assert.equal(
        await readFile(join(directory, `step-${index}.txt`), "utf8"),
        `Created receipt ${index}.\n`
      );
    }
    await checkpointWrites;
    const finalCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.deepEqual(finalCheckpoint.compaction, resumed.compaction);
    assert.deepEqual(finalCheckpoint.messages, JSON.parse(JSON.stringify(resumed.messages)));
  }
);
