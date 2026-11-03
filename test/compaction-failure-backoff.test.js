import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompactionFailureBackoff,
  compactionFingerprint
} from "../dist/src/runtime/compaction-failure-backoff.js";

test("repeated summary failures cool down for finite intervals and remain retryable", () => {
  let now = 1000;
  const backoff = new CompactionFailureBackoff(() => now);
  assert.equal(backoff.shouldSkip("prefix"), false);
  for (const delay of [5000, 15000, 30000, 30000]) {
    backoff.recordFailure("prefix");
    assert.equal(backoff.shouldSkip("prefix"), true);
    now += delay - 1;
    assert.equal(backoff.shouldSkip("prefix"), true);
    now += 1;
    assert.equal(backoff.shouldSkip("prefix"), false, "expiry permits another ordinary attempt");
  }
});

test("different summary inputs remain eligible and a successful retry resets its failure budget", () => {
  let now = 0;
  const backoff = new CompactionFailureBackoff(() => now);
  const original = compactionFingerprint({
    model: "a",
    previousSummary: "checkpoint",
    prefix: ["older work"]
  });
  const changed = compactionFingerprint({
    model: "a",
    previousSummary: "checkpoint",
    prefix: ["new evidence"]
  });
  backoff.recordFailure(original);
  assert.equal(backoff.shouldSkip(original), true);
  assert.equal(backoff.shouldSkip(changed), false);
  backoff.recordFailure(changed);
  backoff.recordSuccess(original);
  assert.equal(backoff.shouldSkip(original), false);
  assert.equal(backoff.shouldSkip(changed), true, "success does not clear unrelated failures");
  backoff.recordFailure(original);
  now = 5000;
  assert.equal(backoff.shouldSkip(original), false, "the first delay applies again after success");
});

test("failed-input retention is bounded so a long session cannot accumulate unlimited cooldowns", () => {
  const backoff = new CompactionFailureBackoff(() => 0);
  for (let index = 0; index < 33; index++) backoff.recordFailure(`prefix-${index}`);
  assert.equal(backoff.shouldSkip("prefix-0"), false, "the oldest failure is evicted");
  assert.equal(backoff.shouldSkip("prefix-1"), true);
  assert.equal(backoff.shouldSkip("prefix-32"), true);
});
