import { test } from "node:test";
import assert from "node:assert/strict";
import { PresentationSession } from "../web/assets/pptist/document-session.js";
const doc = (text) => ({ version: 1, slides: [{ id: "one", elements: [], remark: text }] });
function fixture() {
  let document = doc("original"),
    revision = 0,
    failRead = false,
    loseResponse = false,
    hold;
  const storage = new Map(),
    commits = new Map();
  const read = () => ({
    resource: { revision, title: "demo" },
    snapshot: { content: structuredClone(document) }
  });
  const api = {
    readResource: async () => {
      if (failRead) throw Error("offline");
      return read();
    },
    applyOperation: async (t, r, op) => {
      if (hold) await hold;
      if (!commits.has(op.operationId)) {
        if (op.baseRevision !== revision)
          throw Object.assign(Error("conflict"), { code: "revision_conflict" });
        document = structuredClone(op.payload.document);
        revision++;
        commits.set(op.operationId, read());
      }
      if (loseResponse) throw Error("lost response");
      return commits.get(op.operationId);
    }
  };
  const options = {
    api,
    taskId: "task",
    resourceId: "deck",
    storage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k)
    }
  };
  return {
    session: new PresentationSession(options),
    options,
    api,
    read,
    stored: storage,
    remote: (d) => {
      document = d;
      revision++;
    },
    readFails: (v) => (failRead = v),
    lose: (v) => (loseResponse = v),
    hold: (p) => (hold = p)
  };
}
test("unknown save retries the same operation after reload without duplicating history", async () => {
  const f = fixture();
  await f.session.load();
  f.session.edit(doc("human"));
  f.lose(true);
  assert.equal(await f.session.save(), false);
  assert.ok(f.session.pending);
  assert.equal(f.read().resource.revision, 1);
  const reopened = new PresentationSession(f.options);
  await reopened.load();
  f.lose(false);
  assert.equal(await reopened.save(), true);
  assert.equal(f.read().resource.revision, 1);
  assert.equal(reopened.dirty, false);
  assert.equal(f.stored.size, 0);
});
test("edits typed during an in-flight save are retained and committed separately", async () => {
  const f = fixture();
  await f.session.load();
  let release;
  f.hold(new Promise((r) => (release = r)));
  f.session.edit(doc("first"));
  const pending = f.session.save();
  f.session.edit(doc("second"));
  release();
  await pending;
  assert.equal(f.session.document.slides[0].remark, "second");
  assert.equal(f.session.dirty, true);
  await f.session.save();
  assert.equal(f.read().snapshot.content.slides[0].remark, "second");
  assert.equal(f.read().resource.revision, 2);
});
test("conflict and failed reload preserve local draft; successful reload is explicit", async () => {
  const f = fixture();
  await f.session.load();
  f.session.edit(doc("human"));
  f.remote(doc("agent"));
  assert.equal(await f.session.save(), false);
  assert.match(f.session.error, /冲突/);
  f.readFails(true);
  await assert.rejects(f.session.reload(), /offline/);
  assert.equal(f.session.document.slides[0].remark, "human");
  assert.equal(f.session.dirty, true);
  f.readFails(false);
  await f.session.reload();
  assert.equal(f.session.document.slides[0].remark, "agent");
  assert.equal(f.session.dirty, false);
});
test("stale poll cannot overwrite newer local edits", async () => {
  const f = fixture();
  await f.session.load();
  let release;
  f.api.readResource = () => new Promise((r) => (release = r));
  const refresh = f.session.refresh();
  f.session.edit(doc("typed"));
  release({ resource: { revision: 2 }, snapshot: { content: doc("remote") } });
  await refresh;
  assert.equal(f.session.document.slides[0].remark, "typed");
  assert.equal(f.session.dirty, true);
});
test("refresh acknowledgement retries a failed read and reports a preserved draft conflict as observed", async () => {
  const f = fixture();
  await f.session.load();
  f.remote(doc("first stage"));
  f.readFails(true);
  assert.equal(await f.session.refresh(), false);
  assert.equal(f.session.revision, 0);
  assert.match(f.session.error, /读取失败/);
  f.readFails(false);
  assert.equal(await f.session.refresh(), true);
  assert.equal(f.session.revision, 1);
  assert.equal(f.session.error, "");
  f.session.edit(doc("human draft"));
  f.remote(doc("second stage"));
  assert.equal(await f.session.refresh(), true);
  assert.equal(f.session.document.slides[0].remark, "human draft");
  assert.match(f.session.error, /冲突/);
});

test("remote edit after an uncertain commit is not overwritten by the retry", async () => {
  const f = fixture();
  await f.session.load();
  f.session.edit(doc("human"));
  f.lose(true);
  await f.session.save();
  f.remote(doc("agent"));
  f.lose(false);
  await f.session.save();
  assert.equal(f.session.document.slides[0].remark, "agent");
  assert.equal(f.read().resource.revision, 2);
});
