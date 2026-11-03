import { test } from "node:test";
import assert from "node:assert/strict";
import { BlenderDocumentSession } from "../web/assets/blender/document-session.js";

function fixture() {
  let revision = 0,
    nativeRuns = 0,
    failCommand = false;
  let model = { version: 1, projectId: "a".repeat(32), snapshot: null, source: "", parameters: {} };
  const committed = new Map(),
    storage = new Map();
  const read = () => ({
    resource: { resourceId: "scene", revision, title: "场景" },
    snapshot: { content: structuredClone(model), revision }
  });
  const check = (body) => {
    if (body.baseRevision !== revision) {
      const error = new Error("conflict");
      error.code = "revision_conflict";
      throw error;
    }
  };
  const api = {
    readResource: async () => read(),
    applyOperation: async (_task, _resource, body) => {
      if (!committed.has(body.operationId)) {
        check(body);
        model = { ...model, ...body.payload };
        revision++;
        committed.set(body.operationId, true);
      }
      return read();
    },
    executeResourceCommand: async (_task, _resource, body) => {
      if (!committed.has(body.operationId)) {
        check(body);
        nativeRuns++;
        revision++;
        model = { ...model, snapshot: String(nativeRuns).padStart(32, "0") };
        committed.set(body.operationId, true);
      }
      if (failCommand) {
        failCommand = false;
        throw new TypeError("connection lost after commit");
      }
      return read();
    }
  };
  const session = new BlenderDocumentSession({
    api,
    taskId: "task",
    resourceId: "scene",
    storage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    }
  });
  return {
    session,
    api,
    read,
    storage,
    runs: () => nativeRuns,
    loseCommand: () => {
      failCommand = true;
    },
    external: () => {
      revision++;
      model = { ...model, parameters: { manual: 9 } };
    }
  };
}
test("Blender source draft saves before object edits and confirmed operations clear only their own draft", async () => {
  const f = fixture();
  await f.session.load();
  f.session.editSource("main", { width: 3 });
  f.session.editObject({ id: "b".repeat(32), position: [4, 0, 0] });
  assert.equal(await f.session.save(), true);
  assert.equal(f.session.revision, 2);
  assert.equal(f.read().snapshot.content.source, "main");
  assert.equal(f.runs(), 1);
  assert.equal(f.session.dirty, false);
  assert.equal(f.storage.size, 0);
});

test("a clean Blender session retries an unsaved original file and refuses closing on failure", async () => {
  const f = fixture();
  await f.session.load();
  f.session.resource.sourceFile = { path: "/Documents/scene.blend", savedRevision: -1 };
  f.api.saveSourceFile = async () => {
    throw new Error("original write failed");
  };
  assert.equal(await f.session.save(), false);
  assert.match(f.session.error, /original write failed/);
  f.api.saveSourceFile = async (_task, _id, revision) => ({
    resource: {
      ...f.session.resource,
      sourceFile: { path: "/Documents/scene.blend", savedRevision: revision }
    }
  });
  assert.equal(await f.session.save(), true);
  assert.equal(f.session.resource.sourceFile.savedRevision, f.session.revision);
  assert.equal(f.session.error, "");
});
test("lost run response survives reload and retry does not execute a second native run", async () => {
  const f = fixture();
  await f.session.load();
  f.session.editSource("main");
  f.loseCommand();
  assert.equal(await f.session.run(), false);
  assert.ok(f.session.pending);
  assert.equal(f.runs(), 1);
  await f.session.load();
  assert.ok(f.session.pending);
  assert.equal(await f.session.run(), true);
  assert.equal(f.runs(), 1);
  assert.equal(f.session.pending, null);
  assert.equal(f.session.dirty, false);
});
test("collaborator changes preserve local source and object drafts and failed reload cannot discard them", async () => {
  const f = fixture();
  await f.session.load();
  f.session.editSource("draft");
  f.session.editObject({ id: "b".repeat(32), roughness: 0.4 });
  f.external();
  await f.session.refresh();
  assert.equal(f.session.model.source, "draft");
  assert.ok(f.session.error);
  assert.equal(await f.session.save(), false);
  assert.equal(f.session.model.source, "draft");
  assert.equal(f.session.edits["b".repeat(32)].roughness, 0.4);
  f.api.readResource = async () => {
    throw new Error("offline");
  };
  assert.equal(await f.session.reload(), false);
  assert.equal(f.session.model.source, "draft");
});
test("refresh acknowledges a recovered read and a preserved source draft conflict", async () => {
  const f = fixture();
  await f.session.load();
  f.external();
  const read = f.api.readResource;
  f.api.readResource = async () => {
    throw new Error("offline");
  };
  assert.equal(await f.session.refresh(), false);
  assert.equal(f.session.revision, 0);
  assert.match(f.session.error, /读取失败/);
  f.api.readResource = read;
  assert.equal(await f.session.refresh(), true);
  assert.equal(f.session.revision, 1);
  assert.equal(f.session.error, "");
  f.session.editSource("human draft");
  f.external();
  assert.equal(await f.session.refresh(), true);
  assert.equal(f.session.model.source, "human draft");
  assert.match(f.session.error, /草稿已保留/);
});

test("a refresh that started before saving cannot roll back the committed scene", async () => {
  const f = fixture();
  await f.session.load();
  const original = f.api.readResource,
    stale = f.read();
  let release;
  f.api.readResource = () =>
    new Promise((resolve) => {
      release = () => resolve(stale);
    });
  const poll = f.session.refresh();
  f.api.readResource = original;
  f.session.editSource("new");
  assert.equal(await f.session.save(), true);
  release();
  await poll;
  assert.equal(f.session.revision, 1);
  assert.equal(f.session.model.source, "new");
});
test("invalid parameter input survives failed save and reload until corrected", async () => {
  const f = fixture();
  await f.session.load();
  f.session.editParameters('{"width":');
  assert.equal(f.session.dirty, true);
  assert.equal(await f.session.save(), false);
  assert.equal(f.read().resource.revision, 0);
  assert.equal(f.session.parameterDraft, '{"width":');
  await f.session.load();
  assert.equal(f.session.parameterDraft, '{"width":');
  assert.equal(await f.session.run(), false);
  assert.equal(f.runs(), 0);
  f.session.editParameters('{"width":3}');
  assert.equal(f.session.parameterDraft, undefined);
  assert.equal(await f.session.save(), true);
  assert.deepEqual(f.read().snapshot.content.parameters, { width: 3 });
  assert.equal(f.session.dirty, false);
  assert.equal(f.storage.size, 0);
});
test("invalid object fields survive reload and cannot save or run an older valid edit", async () => {
  const f = fixture(),
    objectId = "b".repeat(32);
  await f.session.load();
  f.session.editObject({ id: objectId, position: [4, 0, 0] });
  f.session.editObjectInput({ id: objectId, key: "position.0", value: "", error: "请输入有效数值" });
  assert.equal(await f.session.save(), false);
  assert.equal(f.runs(), 0);
  assert.equal(f.read().resource.revision, 0);
  await f.session.load();
  assert.equal(f.session.objectDrafts[objectId]["position.0"].value, "");
  assert.equal(await f.session.run(), false);
  assert.equal(f.runs(), 0);
  f.session.editObjectInput({
    id: objectId,
    key: "position.0",
    value: "8",
    edit: { position: [8, 0, 0] }
  });
  assert.equal(await f.session.save(), true);
  assert.equal(f.runs(), 1);
  assert.equal(f.session.dirty, false);
  assert.equal(f.storage.size, 0);
});
