import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PersonalContextStore } from "../dist/src/runtime/personal-context-store.js";
import { PersonalContextService } from "../dist/src/runtime/personal-context-service.js";

const initialTime = Date.parse("2026-11-05T01:00:00Z");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cowork-personal-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PersonalContextStore({ path: join(root, "context.json") });
  let clock = initialTime;
  let serial = 0;
  const host = (overrides = {}) => ({
    workspaceRoot: join(root, "tasks"),
    taskId: "task-a",
    runId: "run-a",
    messageId: `message-${++serial}`,
    operationId: "op-1",
    receivedAt: "2026-11-05T01:00:00Z",
    text: "请保存这次会议安排。",
    purpose: "安排工作",
    permissions: ["read", "save", "update", "delete", "settings"],
    visibility: ["task", "project", "user"],
    projectDirectory: join(root, "project"),
    ...overrides
  });
  const service = new PersonalContextService(store, {
    now: () => clock,
    canExecute: async () => true,
    assess: async () => ({ statement: "self_report", sensitive: false, authorized: true })
  });
  const input = (overrides = {}) => ({
    kind: "arrangement",
    status: "tentative",
    title: "会议",
    content: "讨论项目",
    visibility: "user",
    quote: "保存这次会议安排",
    observedAt: "2026-11-05T01:00:00Z",
    startsAt: "2026-11-06T02:00:00Z",
    timeZone: "Asia/Shanghai",
    ...overrides
  });
  return {
    root,
    store,
    service,
    host,
    input,
    tick: (milliseconds) => {
      clock += milliseconds;
    }
  };
}

test("context persists with its event, reopens in another process, and starts disabled", async (t) => {
  const f = await fixture(t);
  const request = await f.service.openRequest(f.host());
  const saved = await request.save(f.input());
  assert.equal((await request.query([saved.id])).records.length, 0);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const query = await (await f.service.openRequest(f.host({ taskId: "task-b" }))).query([saved.id]);
  assert.equal(query.records[0].record.id, saved.id);
  assert.equal(query.records[0].record.status, "tentative");
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist/src/runtime/personal-context-store.js")).href;
  const script = `import { PersonalContextStore } from ${JSON.stringify(moduleUrl)}; const d = await new PersonalContextStore({path: process.argv[1]}).read(); console.log(JSON.stringify({id:d.records[0].id,events:d.events.length}));`;
  const reopened = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script, f.store.path], { encoding: "utf8" })
  );
  assert.equal(reopened.id, saved.id);
  assert.equal(reopened.events, 1);
});

test("correction uses CAS across independent stores and cancellation is not fulfillment", async (t) => {
  const f = await fixture(t);
  const saved = await (await f.service.openRequest(f.host())).save(f.input());
  const other = new PersonalContextService(new PersonalContextStore({ path: f.store.path }), {
    assess: async () => ({ statement: "self_report", sensitive: false, authorized: true }),
    now: () => initialTime
  });
  const a = await f.service.openRequest(f.host());
  const b = await other.openRequest(f.host());
  const results = await Promise.allSettled([
    a.update(saved.id, 1, f.input({ status: "confirmed" })),
    b.update(saved.id, 1, f.input({ status: "cancelled" }))
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "conflict");
  const current = (await f.store.read()).records[0];
  const cancelled = await (
    await f.service.openRequest(f.host())
  ).update(current.id, 2, f.input({ status: "cancelled" }));
  assert.equal(cancelled.revision, 3);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const result = await (await f.service.openRequest(f.host())).query([saved.id]);
  assert.equal(result.records[0].validity, "inactive");
  assert.equal(result.records[0].record.status, "cancelled");
});

test("expiry, review and an elapsed meeting do not invent recovery or fulfillment", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const state = await (
    await f.service.openRequest(f.host())
  ).save(
    f.input({
      kind: "temporary_state",
      status: "active",
      startsAt: undefined,
      timeZone: undefined,
      validUntil: "2026-11-05T02:00:00Z"
    })
  );
  const meeting = await (
    await f.service.openRequest(f.host())
  ).save(f.input({ startsAt: "2026-11-05T00:00:00Z", endsAt: "2026-11-05T00:30:00Z", status: "confirmed" }));
  const request = await f.service.openRequest(f.host());
  const permit = await request.prepareExecution([state.id]);
  f.tick(3_600_000);
  await assert.rejects(request.validateExecution(permit), { code: "inactive" });
  const result = await request.query([state.id, meeting.id]);
  assert.equal(result.records[0].validity, "expired");
  assert.equal(result.records[1].validity, "needs_review");
  assert.equal((await f.store.read()).records[0].status, "active");
  assert.equal((await f.store.read()).records[1].status, "confirmed");
});

test("deletion clears private content and blocks old saves, updates and permits after restart", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const oldHost = f.host();
  const old = await f.service.openRequest(oldHost);
  const saved = await old.save(f.input({ status: "confirmed", content: "private-content-to-remove" }));
  const permit = await old.prepareExecution([saved.id]);
  const stale = await f.service.openRequest(f.host());
  await (await f.service.openRequest(f.host())).forget(saved.id, 1);
  assert.equal((await f.store.read()).records.length, 0);
  assert.equal((await readFile(f.store.path, "utf8")).includes("private-content-to-remove"), false);
  await assert.rejects(stale.save(f.input()), { code: "conflict" });
  await assert.rejects(old.validateExecution(permit), { code: "conflict" });
  const reopened = new PersonalContextService(new PersonalContextStore({ path: f.store.path }), {
    assess: async () => ({ statement: "self_report", sensitive: false, authorized: true })
  });
  await assert.rejects((await reopened.openRequest(oldHost)).save(f.input()), { code: "conflict" });
  const newRequest = await f.service.openRequest(f.host());
  await assert.rejects(newRequest.update(saved.id, 1, f.input()), { code: "not_found" });
  assert.equal((await new PersonalContextStore({ path: f.store.path }).read()).records.length, 0);
});

test("host request identity deduplicates saves and conflicting replays preserve original data", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const a = await f.service.openRequest(host);
  const first = await a.save(f.input());
  const replay = await (await f.service.openRequest(host)).save(f.input());
  assert.deepEqual(replay, first);
  const newRun = await f.service.openRequest({ ...host, runId: "replacement-run" });
  assert.deepEqual(await newRun.save(f.input()), first);
  await assert.rejects(a.save(f.input({ title: "another title" })), { code: "conflict" });
  assert.equal((await f.store.read()).records.length, 1);
  assert.equal((await f.store.read()).events.length, 1);
});

test("trusted source assessment rejects hypotheticals, third parties and unauthorized persistence", async (t) => {
  const f = await fixture(t);
  for (const statement of ["hypothetical", "third_party"]) {
    const service = new PersonalContextService(f.store, {
      assess: async () => ({ statement, sensitive: false, authorized: true })
    });
    await assert.rejects((await service.openRequest(f.host())).save(f.input()), { code: "source_rejected" });
  }
  const service = new PersonalContextService(f.store, {
    assess: async () => ({ statement: "self_report", sensitive: false, authorized: false })
  });
  await assert.rejects((await service.openRequest(f.host())).save(f.input()), { code: "permission_denied" });
  await assert.rejects(
    (await f.service.openRequest(f.host())).save(f.input({ quote: "not in user message" })),
    { code: "source_rejected" }
  );
  assert.equal((await f.store.read()).records.length, 0);
});

test("scope and sensitivity are host enforced, including same Task IDs in different roots", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const task = await (await f.service.openRequest(f.host())).save(f.input({ visibility: "task" }));
  const project = await (await f.service.openRequest(f.host())).save(f.input({ visibility: "project" }));
  const foreign = await f.service.openRequest(
    f.host({ workspaceRoot: join(f.root, "different"), projectDirectory: undefined })
  );
  assert.equal((await foreign.query([task.id, project.id])).records.length, 0);
  await assert.rejects(foreign.forget(task.id, 1), { code: "permission_denied" });
  const sensitive = new PersonalContextService(f.store, {
    now: () => initialTime,
    assess: async () => ({ statement: "self_report", sensitive: true, authorized: true })
  });
  await assert.rejects((await sensitive.openRequest(f.host())).save(f.input()), {
    code: "permission_denied"
  });
  const saved = await (await sensitive.openRequest(f.host({ sensitiveConsent: true }))).save(f.input());
  assert.equal((await (await sensitive.openRequest(f.host())).query([saved.id])).records.length, 0);
  assert.equal(
    (await (await sensitive.openRequest(f.host({ sensitiveConsent: true }))).query([saved.id])).records
      .length,
    1
  );
});

test("new facts and disabled use invalidate permits; only deletion remains allowed while disabled", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const request = await f.service.openRequest(f.host());
  const saved = await request.save(f.input({ status: "confirmed" }));
  const permit = await request.prepareExecution([saved.id]);
  await (await f.service.openRequest(f.host())).save(f.input({ title: "new arrangement" }));
  await assert.rejects(request.validateExecution(permit), { code: "conflict" });
  const fresh = await request.prepareExecution([saved.id]);
  await (await f.service.openRequest(f.host())).configure({ enabled: false });
  await assert.rejects(request.validateExecution(fresh), { code: "conflict" });
  const off = await f.service.openRequest(f.host());
  assert.equal((await off.query([saved.id])).records.length, 0);
  await off.forget(saved.id, 1);
});

test("invalid interval, timezone and kind status cannot be persisted; unknown fields reject", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { endsAt: "2026-11-06T01:00:00Z" },
    { timeZone: "Not/AZone" },
    { kind: "temporary_state", status: "confirmed" },
    { ownerKey: "model-chosen" }
  ])
    await assert.rejects((await f.service.openRequest(f.host())).save(f.input(patch)));
  assert.equal((await f.store.read()).records.length, 0);
});

test("malformed and future snapshots are preserved and never read as an empty context", async (t) => {
  const f = await fixture(t);
  for (const raw of ["{broken", '{"version":99}']) {
    await writeFile(f.store.path, raw);
    await assert.rejects(f.store.read(), { code: "storage_invalid" });
    await assert.rejects(f.service.openRequest(f.host()), { code: "storage_invalid" });
    assert.equal(await readFile(f.store.path, "utf8"), raw);
  }
});

test("bounded record capacity rejects a new record without losing facts or emitting its event", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 200; index++)
    await (await f.service.openRequest(f.host())).save(f.input({ title: `arrangement-${index}` }));
  const before = await f.store.read();
  await assert.rejects(
    (await f.service.openRequest(f.host())).save(f.input({ content: "overflow-not-committed" })),
    { code: "capacity" }
  );
  const after = await f.store.read();
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.events, before.events);
  assert.equal((await readFile(f.store.path, "utf8")).includes("overflow-not-committed"), false);
});

test("outbox survives reopening, has no private body and acknowledgements are repeatable", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  await (await f.service.openRequest(f.host())).save(f.input({ content: "private-event-body" }));
  const pending = await f.service.pendingChanges();
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(pending).includes("private-event-body"), false);
  const reopened = new PersonalContextService(new PersonalContextStore({ path: f.store.path }), {
    assess: async () => ({ statement: "self_report", sensitive: false, authorized: true })
  });
  assert.deepEqual(await reopened.pendingChanges(), pending);
  assert.equal(await reopened.acknowledgeChange(pending[0].eventId, pending[0]), true);
  assert.equal(await reopened.acknowledgeChange(pending[0].eventId, pending[0]), false);
  assert.equal((await f.store.read()).records.length, 1);
  assert.equal((await f.service.pendingChanges()).length, 0);
});

test("permits require live host authorization and cannot be forged or reused after service restart", async (t) => {
  const f = await fixture(t);
  let allowed = true;
  const service = new PersonalContextService(f.store, {
    now: () => initialTime,
    assess: async () => ({ statement: "self_report", sensitive: false, authorized: true }),
    canExecute: async () => allowed
  });
  await (await service.openRequest(f.host())).configure({ enabled: true });
  const request = await service.openRequest(f.host());
  const record = await request.save(f.input({ status: "confirmed" }));
  const permit = await request.prepareExecution([record.id]);
  await request.validateExecution(permit);
  await assert.rejects(request.validateExecution({ ...permit }), { code: "permission_denied" });
  allowed = false;
  await assert.rejects(request.validateExecution(permit), { code: "permission_denied" });
  allowed = true;
  await assert.rejects((await service.openRequest(f.host())).validateExecution(permit), {
    code: "permission_denied"
  });
  const noExecutionHook = new PersonalContextService(f.store, {
    assess: async () => ({ statement: "self_report", sensitive: false, authorized: true })
  });
  await assert.rejects((await noExecutionHook.openRequest(f.host())).prepareExecution([record.id]), {
    code: "permission_denied"
  });
});

test("expired consent hides private records from new readers while explicit deletion remains available", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const saved = await (
    await f.service.openRequest(f.host({ consentUntil: "2026-11-05T01:10:00Z" }))
  ).save(f.input());
  f.tick(600_000);
  const reader = await f.service.openRequest(f.host());
  assert.equal((await reader.query([saved.id])).records.length, 0);
  await reader.forget(saved.id, 1);
  assert.equal((await f.store.read()).records.length, 0);
});

test("uncertain facts, future states and review deadlines cannot authorize execution", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const future = await (
    await f.service.openRequest(f.host())
  ).save(
    f.input({
      kind: "temporary_state",
      status: "active",
      startsAt: undefined,
      timeZone: undefined,
      validFrom: "2026-11-05T02:00:00Z",
      reviewAt: "2026-11-05T03:00:00Z"
    })
  );
  const request = await f.service.openRequest(f.host());
  assert.equal((await request.query([future.id])).records[0].validity, "not_yet_valid");
  await assert.rejects(request.prepareExecution([future.id]), { code: "inactive" });
  f.tick(7_200_000);
  assert.equal((await request.query([future.id])).records[0].validity, "needs_review");
  const uncertainService = new PersonalContextService(f.store, {
    now: () => initialTime,
    assess: async () => ({ statement: "uncertain", sensitive: false, authorized: true }),
    canExecute: async () => true
  });
  const uncertainRequest = await uncertainService.openRequest(f.host());
  const uncertain = await uncertainRequest.save(f.input({ status: "confirmed" }));
  await assert.rejects(uncertainRequest.prepareExecution([uncertain.id]), { code: "inactive" });
});

test("old read requests stay revoked after disabling and enabling context again", async (t) => {
  const f = await fixture(t);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  const oldHost = f.host();
  const old = await f.service.openRequest(oldHost);
  const saved = await old.save(f.input());
  await (await f.service.openRequest(f.host())).configure({ enabled: false });
  assert.equal((await old.query([saved.id])).records.length, 0);
  await (await f.service.openRequest(f.host())).configure({ enabled: true });
  await assert.rejects(old.query([saved.id]), { code: "conflict" });
  await assert.rejects((await f.service.openRequest(oldHost)).query([saved.id]), { code: "conflict" });
  assert.equal((await (await f.service.openRequest(f.host())).query([saved.id])).records.length, 1);
});

test("independent writer processes preserve both accepted facts and pending events", async (t) => {
  const f = await fixture(t);
  await f.store.read();
  const serviceUrl = pathToFileURL(join(process.cwd(), "dist/src/runtime/personal-context-service.js")).href;
  const storeUrl = pathToFileURL(join(process.cwd(), "dist/src/runtime/personal-context-store.js")).href;
  const script = `import {PersonalContextService} from ${JSON.stringify(serviceUrl)}; import {PersonalContextStore} from ${JSON.stringify(storeUrl)}; const s = new PersonalContextService(new PersonalContextStore({path:process.argv[1]}), {assess:async()=>({statement:"self_report",sensitive:false,authorized:true})}); const request = await s.openRequest(JSON.parse(process.argv[2])); await request.save(JSON.parse(process.argv[3]));`;
  const run = promisify(execFile);
  await Promise.all(
    ["first", "second"].map((title) =>
      run(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        f.store.path,
        JSON.stringify(f.host()),
        JSON.stringify(f.input({ title }))
      ])
    )
  );
  const state = await f.store.read();
  assert.deepEqual(state.records.map((r) => r.title).sort(), ["first", "second"]);
  assert.equal(state.events.length, 2);
});

test("deletion removes abandoned module temporary snapshots while preserving unrelated files", async (t) => {
  const f = await fixture(t);
  const saved = await (
    await f.service.openRequest(f.host())
  ).save(f.input({ content: "old-private-snapshot" }));
  const abandoned = `${f.store.path}.tmp-${randomUUID()}`;
  const unrelated = `${f.store.path}.tmp-user-notes`;
  const request = await f.service.openRequest(f.host());
  await writeFile(abandoned, await readFile(f.store.path));
  await writeFile(unrelated, "keep this user file");
  await request.forget(saved.id, 1);
  await assert.rejects(readFile(abandoned), { code: "ENOENT" });
  assert.equal(await readFile(unrelated, "utf8"), "keep this user file");
  assert.equal((await readFile(f.store.path, "utf8")).includes("old-private-snapshot"), false);
});
