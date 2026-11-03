import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import {
  CAD_PROGRAM_KIND,
  CAD_COMPUTE_LIMITS,
  emptyProgram,
  normalizeProgram
} from "../dist/src/software/cad/program.js";
import { CadDocumentSession } from "../web/assets/cad/document-session.js";

test("large UTF-8 CAD source drafts restore without evaluation and stay within the source byte budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-cad-large-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const created = await service.createResource({
    taskId: "draft-task",
    kind: CAD_PROGRAM_KIND,
    title: "草稿.cad.json",
    initialContent: emptyProgram(),
    actor: { type: "user", id: "local" }
  });
  const resourceId = created.resource.resourceId;
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key),
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key)
  };
  const create = () =>
    new CadDocumentSession({
      api: { readResource: (taskId, id) => service.readResource(taskId, id) },
      taskId: "draft-task",
      resourceId,
      storage,
      normalize: normalizeProgram,
      operationType: "cad.program.replace",
      payloadKey: "program"
    });
  const original = create();
  await original.load();
  // A syntax error remains an editable draft. Restoring it never evaluates
  // user code, regardless of whether its geometry would be valid.
  const source = `// ${"中".repeat(300000)}\nfunction broken( {`;
  assert.ok(source.length > 256000);
  assert.ok(new TextEncoder().encode(source).byteLength < CAD_COMPUTE_LIMITS.maxSourceBytes);
  original.edit({ ...original.model, source });
  const restored = create();
  await restored.load();
  assert.equal(restored.model.source, source);
  assert.equal(restored.dirty, true);
  assert.equal(restored.error, "");
  const saved = await service.readResource("draft-task", resourceId);
  assert.equal(saved.resource.revision, 0);
  assert.equal(saved.snapshot.content.source, emptyProgram().source);

  // The character count alone is below 1 MiB, but UTF-8 is above the limit.
  const oversized = "中".repeat(Math.floor(CAD_COMPUTE_LIMITS.maxSourceBytes / 3) + 1);
  assert.ok(oversized.length < CAD_COMPUTE_LIMITS.maxSourceBytes);
  const oversizedRecord = JSON.stringify({
    model: { ...original.model, source: oversized },
    revision: original.revision
  });
  storage.setItem(original.key, oversizedRecord);
  const bounded = create();
  await bounded.load();
  assert.equal(bounded.model.source, saved.snapshot.content.source);
  assert.equal(bounded.dirty, false);
  assert.equal(storage.getItem(original.key), oversizedRecord, "rejected records remain recoverable");
});

test("a 1 MiB CAD source survives escaped JSON persistence, revision commit and reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-cad-source-json-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const actor = { type: "user", id: "local" };
  const created = await service.createResource({
    taskId: "source-task",
    kind: CAD_PROGRAM_KIND,
    title: "完整源码.cad.json",
    actor
  });
  const prefix = "module.exports.main=()=>[];\n";
  const source = prefix + "\n".repeat(CAD_COMPUTE_LIMITS.maxSourceBytes - Buffer.byteLength(prefix));
  const program = normalizeProgram({ ...emptyProgram(), source });
  assert.equal(Buffer.byteLength(source), CAD_COMPUTE_LIMITS.maxSourceBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(program)) > 2 * 1024 * 1024);
  await service.applyOperation({
    taskId: "source-task",
    resourceId: created.resource.resourceId,
    appType: "cad",
    operationId: "large-source",
    operationType: "cad.program.replace",
    baseRevision: 0,
    payload: { program },
    actor
  });
  const reopened = await new ApplicationService(root).readResource(
    "source-task",
    created.resource.resourceId
  );
  assert.equal(reopened.resource.revision, 1);
  assert.equal(reopened.snapshot.content.source, source);
  assert.equal(reopened.operations[0].operationId, "large-source");
});
