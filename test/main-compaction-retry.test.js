import assert from "node:assert/strict";
import { test } from "node:test";
import { MainCompactionRetry } from "../.pi/runtime/main-compaction-retry.ts";
import { CompactionFailureBackoff } from "../dist/src/runtime/compaction-failure-backoff.js";

const model = {
  provider: "fixture",
  id: "summary-model",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1234/v1"
};
const event = (patch = {}) => ({
  type: "session_before_compact",
  reason: "threshold",
  willRetry: false,
  signal: new AbortController().signal,
  preparation: {
    firstKeptEntryId: "kept-entry",
    previousSummary: "## Goal\nPreserve the existing work.",
    messagesToSummarize: [{ role: "user", content: "Earlier task evidence", timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 53000,
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
  },
  branchEntries: [],
  ...patch
});
const failure = (patch = {}) => ({
  type: "session_compact_failed",
  reason: "threshold",
  willRetry: false,
  aborted: false,
  fromExtension: false,
  errorMessage: "Auto-compaction failed: fixture unavailable",
  ...patch
});
const fixture = () => {
  let now = 0;
  return {
    gate: new MainCompactionRetry(new CompactionFailureBackoff(() => now)),
    advance: (value) => {
      now += value;
    }
  };
};

test("Main repeated threshold failures cool down without extending the delay on native skip cancellations", () => {
  const { gate, advance } = fixture();
  assert.equal(gate.before(event(), "session", model), undefined);
  gate.failed(failure());
  advance(1000);
  assert.deepEqual(gate.before(event(), "session", model), { cancel: true });
  assert.equal(
    gate.failed(failure({ aborted: true, errorMessage: undefined })),
    true,
    "a cooldown cancellation is identifiable without cancelling a pending manual request"
  );
  advance(4000);
  assert.equal(gate.before(event(), "session", model), undefined, "skip must not extend the first 5s delay");
  gate.failed(failure());
  advance(14999);
  assert.deepEqual(gate.before(event(), "session", model), { cancel: true });
  gate.failed(failure({ aborted: true, errorMessage: undefined }));
  advance(1);
  assert.equal(gate.before(event(), "session", model), undefined);
  gate.succeeded();
  assert.equal(gate.before(event(), "session", model), undefined, "native commit clears prior failures");
});

for (const reason of ["manual", "overflow"])
  test(`Main ${reason} compaction bypasses a threshold cooldown and clears it on native success`, () => {
    const { gate } = fixture();
    gate.before(event(), "session", model);
    gate.failed(failure());
    assert.equal(gate.before(event({ reason }), "session", model), undefined);
    gate.succeeded();
    assert.equal(gate.before(event(), "session", model), undefined);
  });

test("Main aborts and failures without a live summarization attempt never create a cooldown", () => {
  const { gate } = fixture();
  gate.failed(failure());
  assert.equal(gate.before(event(), "session", model), undefined);
  gate.failed(failure({ aborted: true }));
  assert.equal(gate.before(event(), "session", model), undefined);
  gate.failed(failure({ errorMessage: undefined }));
  const controller = new AbortController();
  assert.equal(gate.before(event({ signal: controller.signal }), "session", model), undefined);
  controller.abort();
  gate.failed(failure());
  assert.equal(gate.before(event(), "session", model), undefined);
});

test("Main cooldown follows the covered prefix while fresh tail messages and usage do not reset it", () => {
  const { gate } = fixture();
  const initial = event();
  const original = structuredClone(initial.preparation);
  gate.before(initial, "session", model);
  gate.failed(failure());
  const sameCoverage = event({
    preparation: { ...initial.preparation, tokensBefore: 58000 },
    branchEntries: [{ id: "new-tail", type: "message", message: { role: "user", content: "Continue" } }]
  });
  assert.deepEqual(gate.before(sameCoverage, "session", model), { cancel: true });
  assert.deepEqual(initial.preparation, original, "tracking must not mutate the native preparation");

  for (const changed of [
    { firstKeptEntryId: "different-kept-entry" },
    { previousSummary: "A newer actual checkpoint." },
    { messagesToSummarize: [{ role: "user", content: "Additional covered evidence", timestamp: 2 }] },
    { turnPrefixMessages: [{ role: "user", content: "A covered current-turn prefix", timestamp: 2 }] },
    { isSplitTurn: true }
  ]) {
    assert.equal(
      gate.before(event({ preparation: { ...initial.preparation, ...changed } }), "session", model),
      undefined
    );
    gate.failed(failure({ aborted: true }));
  }
  assert.equal(gate.before(event(), "another-session", model), undefined);
  gate.failed(failure({ aborted: true }));
  for (const changed of [
    { provider: "another-provider" },
    { id: "another-model" },
    { api: "openai-responses" },
    { baseUrl: "http://127.0.0.1:2345/v1" }
  ]) {
    assert.equal(gate.before(event(), "session", { ...model, ...changed }), undefined);
    gate.failed(failure({ aborted: true }));
  }
  assert.deepEqual(gate.before(event(), "session", model), { cancel: true });
});
