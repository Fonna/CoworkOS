import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { pptistRuntimeAdapter } from "../dist/src/applications/adapters/pptist-runtime-adapter.js";
import { normalizePresentation, PPTIST_KIND } from "../dist/src/software/pptist/model.js";
import { CAD_KIND, defaultPart } from "../dist/src/software/cad/model.js";
const actor = { type: "user", id: "local" };
const version = (bytes) => createHash("sha256").update(bytes).digest("hex");
const document = (text) =>
  normalizePresentation({
    slides: [
      {
        id: "slide",
        elements: [
          {
            id: "text",
            type: "text",
            left: 80,
            top: 60,
            width: 600,
            height: 100,
            rotate: 0,
            content: `<p>${text}</p>`
          }
        ]
      }
    ]
  });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-source-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace-A");
  const files = join(root, "documents");
  await mkdir(files);
  const path = join(files, "original.pptx");
  const initial = document("原来的内容");
  const original = (
    await pptistRuntimeAdapter.exportResource({
      resource: { title: "original" },
      content: initial,
      format: "pptx"
    })
  ).body;
  await writeFile(path, original);
  const service = new ApplicationService(workspace);
  const instance = await service.openApplication({ taskId: "chat", appType: "pptist" });
  const made = await service.createInApplication({
    taskId: "chat",
    appInstanceId: instance.appInstanceId,
    kind: PPTIST_KIND,
    title: "original",
    initialContent: initial,
    sourceFile: { path, contentVersion: version(original) },
    actor
  });
  const resourceId = made.resource.resourceId;
  const edit = (text, id = "edit", baseRevision = 0) =>
    service.applyOperation({
      taskId: "chat",
      resourceId,
      appType: "pptist",
      operationId: id,
      operationType: "pptist.replace",
      baseRevision,
      payload: { document: document(text) },
      actor
    });
  return { root, path, original, service, resourceId, edit };
}

test("PPTX drafts and undo leave the original unchanged until an explicit save, including after restart", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.service.readResource("chat", f.resourceId)).resource.sourceFile.path,
    await realpath(f.path)
  );
  assert.deepEqual(await readFile(f.path), Buffer.from(f.original), "opening alone never rewrites the file");
  await chmod(f.path, 0o640);
  const outcome = await f.edit("修改后保存到原文件");
  assert.equal(outcome.resource.sourceFile.savedRevision, 0);
  assert.equal(outcome.resource.revision, 1);
  assert.deepEqual(await readFile(f.path), Buffer.from(f.original));
  const retry = await f.edit("修改后保存到原文件");
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(await readFile(f.path), Buffer.from(f.original));
  const restarted = new ApplicationService(join(f.root, "workspace-A"));
  const recovered = await restarted.readResource("chat", f.resourceId);
  assert.match(recovered.snapshot.content.slides[0].elements[0].content, /修改后保存到原文件/);
  assert.equal(recovered.resource.sourceFile.savedRevision, 0);
  assert.deepEqual(await readFile(f.path), Buffer.from(f.original));
  await restarted.saveSourceFile("chat", f.resourceId, 1);
  assert.equal((await stat(f.path)).mode & 0o777, 0o640);
  const zip = await JSZip.loadAsync(await readFile(f.path));
  assert.match(await zip.file("ppt/slides/slide1.xml").async("string"), /修改后保存到原文件/);
  const before = await readFile(f.path);
  await f.service.saveSourceFile("chat", f.resourceId, 1);
  assert.deepEqual(await readFile(f.path), before, "unchanged save preserves original bytes");
  await f.service.undo({ taskId: "chat", resourceId: f.resourceId, actor });
  assert.deepEqual(await readFile(f.path), before, "undo only updates the retained draft");
  await assert.rejects(f.service.saveSourceFile("chat", f.resourceId, 1), { code: "revision_conflict" });
  await f.service.saveSourceFile("chat", f.resourceId, 2);
  assert.match(
    await (await JSZip.loadAsync(await readFile(f.path))).file("ppt/slides/slide1.xml").async("string"),
    /原来的内容/
  );
  await assert.rejects(f.service.saveSourceFile("unrelated", f.resourceId), { code: "resource_not_found" });
});

test("an external change conflicts before editing and preserves the external bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, "another program changed this");
  await assert.rejects(f.edit("不能覆盖"), { code: "source_file_conflict" });
  assert.equal(await readFile(f.path, "utf8"), "another program changed this");
  assert.equal((await f.service.resources.readMetadataById(f.resourceId)).revision, 0);
  await assert.rejects(f.service.readResource("chat", f.resourceId), { code: "source_file_conflict" });
});

test("a failed original write keeps a committed operation retryable without duplicate revisions", async (t) => {
  const f = await fixture(t);
  const adapter = f.service.registry.require("pptist");
  const exportOriginal = adapter.exportResource;
  let failing = true;
  adapter.exportResource = async (input) => {
    if (failing) throw new Error("disk/export unavailable");
    return exportOriginal.call(adapter, input);
  };
  t.after(() => {
    adapter.exportResource = exportOriginal;
  });
  await f.edit("稍后重试");
  await assert.rejects(f.service.saveSourceFile("chat", f.resourceId, 1), {
    code: "source_file_write_failed"
  });
  assert.deepEqual(await readFile(f.path), Buffer.from(f.original));
  assert.equal((await f.service.resources.readMetadataById(f.resourceId)).revision, 1);
  failing = false;
  const retry = await f.edit("稍后重试");
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.resource.revision, 1);
  assert.equal(retry.resource.sourceFile.savedRevision, 0);
  assert.deepEqual(await readFile(f.path), Buffer.from(f.original));
  const saved = await f.service.saveSourceFile("chat", f.resourceId, 1);
  assert.equal(saved.sourceFile.savedRevision, 1);
  const zip = await JSZip.loadAsync(await readFile(f.path));
  assert.match(await zip.file("ppt/slides/slide1.xml").async("string"), /稍后重试/);
});

test("a restart recovers an original write interrupted before its metadata acknowledgement", async (t) => {
  const f = await fixture(t);
  const files = f.service.resources.files;
  const write = files.writeBytes.bind(files);
  files.writeBytes = async (...args) => {
    await write(...args);
    throw new Error("simulated exit after atomic original write");
  };
  await f.edit("重启前已写入");
  await assert.rejects(f.service.saveSourceFile("chat", f.resourceId, 1), {
    code: "source_file_write_failed"
  });
  const pending = await f.service.resources.readMetadataById(f.resourceId);
  assert.equal(pending.sourceFile.pending.revision, 1);
  const restarted = new ApplicationService(join(f.root, "workspace-A"));
  const read = await restarted.readResource("chat", f.resourceId);
  assert.equal(read.resource.sourceFile.savedRevision, 1);
  assert.equal(read.resource.sourceFile.pending, undefined);
  const bytes = await readFile(f.path);
  await restarted.saveSourceFile("chat", f.resourceId, 1);
  assert.deepEqual(await readFile(f.path), bytes);
  const recovered = await restarted.readResource("chat", f.resourceId, { limit: 2 });
  assert.equal(recovered.operations.length, 1);
  assert.equal(recovered.hasMore, false);
  assert.equal(recovered.operations[0].operationId, "edit");
  assert.equal(recovered.resource.revision, 1);
});

test("text and JSON originals save in their original format and changed-during-open files are rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-source-text-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(join(root, "workspace"));
  const path = join(root, "note.md");
  await writeFile(path, "# Original");
  const instance = await service.openApplication({ taskId: "chat", appType: "text-editor" });
  await assert.rejects(
    service.createInApplication({
      taskId: "chat",
      appInstanceId: instance.appInstanceId,
      kind: "text/markdown",
      title: "note.md",
      initialContent: "# Original",
      sourceFile: { path, contentVersion: version("outdated") },
      actor
    }),
    { code: "source_file_conflict" }
  );
  assert.equal((await service.instances.readInstance(instance.appInstanceId)).resourceIds.length, 0);
  const made = await service.createInApplication({
    taskId: "chat",
    appInstanceId: instance.appInstanceId,
    kind: "text/markdown",
    title: "note.md",
    initialContent: "# Original",
    sourceFile: { path, contentVersion: version("# Original") },
    actor
  });
  await service.applyOperation({
    taskId: "chat",
    resourceId: made.resource.resourceId,
    appType: "text-editor",
    operationId: "text-edit",
    operationType: "text.rewrite",
    baseRevision: 0,
    payload: { content: "# Updated" },
    actor
  });
  assert.equal(await readFile(path, "utf8"), "# Updated");
  const cadPath = join(root, "original.cad.json");
  const model = { version: 1, units: "mm", parts: [defaultPart("box", "body")] };
  await writeFile(cadPath, JSON.stringify(model));
  const cadInstance = await service.openApplication({ taskId: "chat", appType: "cad" });
  const cad = await service.createInApplication({
    taskId: "chat",
    appInstanceId: cadInstance.appInstanceId,
    kind: CAD_KIND,
    title: "original.cad.json",
    initialContent: model,
    sourceFile: { path: cadPath, contentVersion: version(JSON.stringify(model)) },
    actor
  });
  const changed = { ...model, parts: [{ ...model.parts[0], size: [70, 30, 20] }] };
  await service.applyOperation({
    taskId: "chat",
    resourceId: cad.resource.resourceId,
    appType: "cad",
    operationId: "cad-edit",
    operationType: "cad.replace",
    baseRevision: 0,
    payload: { model: changed },
    actor
  });
  assert.equal(JSON.parse(await readFile(cadPath, "utf8")).parts[0].size[0], 70);
});
