import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoalescedRead } from "../web/assets/controllers/coalesced-read.js";
import { createRevisionSchedule } from "../web/assets/controllers/revision-schedule.js";
import { createConversationProjection } from "../web/assets/controllers/conversation-projection.js";
import { buildConversationExchanges } from "../web/assets/conversation.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("a slow read shares polling and queues one fresh read for explicit mutations", async () => {
  const gates = [deferred(), deferred()];
  const calls = [];
  const current = [];
  const read = createCoalescedRead(async (key, options) => {
    calls.push([key, options.poll]);
    current.push(options.isCurrent);
    await gates[calls.length - 1].promise;
  });
  const first = read("task", { poll: true });
  assert.equal(read("task", { poll: true }), first);
  assert.equal(read("task"), first);
  assert.equal(read("task"), first);
  assert.equal(calls.length, 1);
  assert.equal(current[0](), false, "the superseded response must not update the view");
  gates[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [
    ["task", true],
    ["task", false]
  ]);
  assert.equal(current[1](), true);
  gates[1].resolve();
  await first;
});

test("independent tasks can load while a stale task is pending and failures can retry", async () => {
  const gate = deferred();
  let fail = true;
  const seen = [];
  const read = createCoalescedRead(async (id) => {
    seen.push(id);
    if (id === "old") await gate.promise;
    if (id === "new" && fail) throw new Error("offline");
  });
  const old = read("old");
  await assert.rejects(read("new"), /offline/);
  fail = false;
  await read("new");
  assert.deepEqual(seen, ["old", "new", "new"]);
  gate.resolve();
  await old;
});

test("unchanged revisions back off, foreground switches and resource events bypass the delay", () => {
  let clock = 0;
  const schedule = createRevisionSchedule({ now: () => clock });
  const tabs = ["a", "b"].map((appInstanceId) => ({ appInstanceId }));
  assert.deepEqual(schedule.due(tabs, "a"), ["a", "b"]);
  schedule.observe("a", "v1");
  schedule.observe("b", "v1");
  clock = 500;
  assert.deepEqual(schedule.due(tabs, "a"), ["a"]);
  schedule.observe("a", "v1");
  clock = 1000;
  assert.deepEqual(schedule.due(tabs, "a"), []);
  assert.deepEqual(schedule.due(tabs, "b"), ["b"]);
  schedule.observe("b", "v1");
  schedule.invalidate("a");
  assert.deepEqual(schedule.due(tabs, "b"), ["a"]);
  schedule.observe("a", "v2");
  assert.deepEqual(schedule.due(tabs, "b", true), ["a", "b"]);
  schedule.due([], undefined);
  assert.deepEqual(schedule.due(tabs, "a"), ["a", "b"], "reopened windows must reload");
});

test("revision backoff bounds foreground and background staleness and reduces idle work", () => {
  let clock = 0;
  const schedule = createRevisionSchedule({ now: () => clock });
  const tabs = ["a", "b"].map((appInstanceId) => ({ appInstanceId }));
  const reads = { a: [], b: [] };
  for (clock = 0; clock <= 60000; clock += 500) {
    for (const id of schedule.due(tabs, "a")) {
      reads[id].push(clock);
      schedule.observe(id, "unchanged");
    }
  }
  assert.ok(reads.a.length < 20, `foreground checks: ${reads.a.length}`);
  assert.ok(reads.b.length < 8, `background checks: ${reads.b.length}`);
  for (const [id, limit] of [
    ["a", 4000],
    ["b", 15000]
  ])
    for (let i = 1; i < reads[id].length; i++) assert.ok(reads[id][i] - reads[id][i - 1] <= limit);
});

const user = (id) => ({ role: "user", id, timestamp: id, content: `request ${id}` });
const start = (message) => ({ type: "message_start", message });

test("stream deltas reuse historical groups; delivery, rewritten history and replay rebuild ownership", () => {
  const project = createConversationProjection();
  const messages = [user(1), { role: "assistant", timestamp: 2, content: "done" }, user(3)];
  const events = [start(messages[0]), { type: "main.run_completed" }, start(messages[2])];
  const first = project(messages, [], events);
  events.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "next" } });
  const delta = project(messages, [], events);
  assert.equal(delta, first, "append-only deltas retain the settled grouping");
  assert.equal(delta[0], first[0]);
  assert.deepEqual(delta, buildConversationExchanges(messages, events));
  const steering = { ...user(4), interjected: true };
  messages.push(steering);
  events.push(start(steering));
  const delivered = project(messages, [], events);
  assert.notEqual(delivered, delta);
  assert.deepEqual(delivered, buildConversationExchanges(messages, events));
  const replayed = events.slice();
  assert.notEqual(project(messages, [], replayed), delivered);
  messages[0] = { ...messages[0], content: "edited" };
  assert.deepEqual(project(messages, [], replayed), buildConversationExchanges(messages, replayed));
  assert.deepEqual(project([], [], []), []);
});

test("indexed matching retains first-unmatched order for repeated text and colliding timestamps", () => {
  const messages = [
    { role: "user", content: "same", timestamp: 1 },
    { role: "user", content: "same", timestamp: 1 },
    { role: "user", content: "same", timestamp: 2 }
  ];
  const events = messages.map((message, index) => ({ ...start(message), marker: index }));
  const exchanges = buildConversationExchanges(messages, events);
  assert.deepEqual(
    exchanges.map((entry) => entry.events[0].marker),
    [0, 1, 2]
  );
});
