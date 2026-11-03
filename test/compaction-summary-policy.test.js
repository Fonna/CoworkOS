import assert from "node:assert/strict";
import { test } from "node:test";
import { compact, generateBranchSummary, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import { guardCompactionSummaries } from "../dist/src/runtime/compaction-summary-guard.js";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";

const model = createCoworkModel({
  baseUrl: "http://127.0.0.1/v1",
  api: "openai-completions",
  model: "isolated-summary-policy",
  supportsReasoningEffort: false
});
const history = [{ role: "user", content: "USER_REQUIREMENT: preserve the API.", timestamp: 1 }];
const previous = "## Goal\nPREVIOUS_CHECKPOINT: implement the parser.\n## Progress\nOld pending review.";
const textOf = (context) =>
  context.messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.filter((block) => block.type === "text").map((block) => block.text)
    )
    .join("\n");
const returning = (capture) => {
  const call = (requestModel, context, options) => {
    capture(context, options);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "A valid historical checkpoint; review remains unverified." }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 2
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  };
  return { stream: call, streamSimple: call };
};
const summarize = (streams, oldSummary, focus) =>
  generateSummaryWithUsage(
    history,
    model,
    16384,
    "fixture",
    undefined,
    undefined,
    focus,
    oldSummary,
    "off",
    streams.streamSimple
  );

test("native initial/update summaries reconcile evidence without accumulating every old fact", async () => {
  for (const oldSummary of [undefined, previous]) {
    const requests = [];
    const streams = guardCompactionSummaries(returning((context) => requests.push(context)));
    await summarize(streams, oldSummary, "FOCUS_ANCHOR: preserve the remaining parser failure.");
    assert.equal(requests.length, 1, "policy adds no model request");
    const text = textOf(requests[0]);
    assert.match(text, /Reconcile/);
    assert.doesNotMatch(text, /PRESERVE all existing information/);
    assert.match(text, /unknown completion/);
    assert.match(text, /earlier passing test/);
    assert.ok(text.includes(history[0].content));
    assert.ok(text.includes("FOCUS_ANCHOR: preserve the remaining parser failure."));
    assert.equal(text.includes("<previous-summary>"), Boolean(oldSummary));
    if (oldSummary) assert.ok(text.includes(oldSummary), "prior evidence is not rewritten before generation");
    for (const heading of [
      "## Goal",
      "## Constraints & Preferences",
      "## Progress",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context"
    ])
      assert.ok(text.includes(heading));
  }
});

test("native policy preserves additional focus even when it quotes native instruction text", async () => {
  for (const [oldSummary, quote] of [
    [
      undefined,
      "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work."
    ],
    [
      previous,
      "The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags."
    ]
  ]) {
    const focus = `Keep the literal prompt excerpt for reference: ${quote}`;
    const requests = [];
    await summarize(
      guardCompactionSummaries(returning((context) => requests.push(context))),
      oldSummary,
      focus
    );
    assert.equal(requests.length, 1);
    const text = textOf(requests[0]);
    assert.match(text, /Reconcile the previous checkpoint/);
    assert.doesNotMatch(text, /PRESERVE all existing information/);
    assert.ok(text.endsWith(`Additional focus: ${focus}`), "focus remains verbatim data");
    if (oldSummary) assert.ok(text.includes(oldSummary));
  }
});

test("native split-turn request has its own coverage and concise prefix format", async () => {
  const requests = [];
  const streams = guardCompactionSummaries(returning((context) => requests.push(context)));
  await compact(
    {
      firstKeptEntryId: "kept-message",
      messagesToSummarize: history,
      turnPrefixMessages: [{ role: "user", content: "PREFIX_ONLY: investigate the timeout.", timestamp: 3 }],
      isSplitTurn: true,
      tokensBefore: 53000,
      previousSummary: previous,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32 }
    },
    model,
    "fixture",
    undefined,
    undefined,
    undefined,
    "off",
    streams.streamSimple
  );
  assert.equal(requests.length, 2, "retain native history plus prefix requests");
  const prefix = textOf(requests[1]);
  assert.match(prefix, /unknown completion/);
  assert.match(prefix, /Do not infer or recreate later messages/);
  assert.ok(prefix.includes("PREFIX_ONLY"));
  assert.ok(!prefix.includes("PREVIOUS_CHECKPOINT"));
  for (const heading of ["## Original Request", "## Progress So Far", "## Context Needed to Continue"])
    assert.ok(prefix.includes(heading));
  assert.ok(!prefix.includes("## Goal"), "prefix must not become a second full history summary");
});

test("native branch summaries retain their own instructions and requested focus", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  const entries = [
    {
      type: "message",
      id: "branch-user",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: history[0]
    }
  ];
  let baseline;
  let adapted;
  const options = { model, apiKey: "fixture", customInstructions: "BRANCH_FOCUS" };
  await generateBranchSummary(entries, {
    ...options,
    streamFn: returning((context) => (baseline = context)).streamSimple
  });
  await generateBranchSummary(entries, {
    ...options,
    streamFn: guardCompactionSummaries(returning((context) => (adapted = context))).streamSimple
  });
  assert.deepEqual(adapted, baseline, "a shared summary system prompt does not identify compaction kind");
});

test("ordinary and unknown tool-free contexts pass through without prompt edits", async () => {
  let native;
  await summarize(returning((context) => (native = context)));
  const unknown = {
    ...native,
    messages: native.messages.map((message) =>
      message.role === "user"
        ? {
            ...message,
            content: [{ type: "text", text: "A custom checkpoint request with its own format." }]
          }
        : message
    )
  };
  const ordinary = normalizeContext({
    systemPrompt: "Answer the user's request.",
    messages: [{ role: "user", content: textOf(native), timestamp: 1 }]
  });
  for (const request of [unknown, ordinary]) {
    let forwarded;
    await guardCompactionSummaries(returning((context) => (forwarded = context)))
      .streamSimple(model, request, {})
      .result();
    assert.equal(forwarded, request);
  }
});
