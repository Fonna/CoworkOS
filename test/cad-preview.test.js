import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { cadRuntimeAdapter } from "../dist/src/applications/adapters/cad-runtime-adapter.js";
import { emptyProgram, CAD_PROGRAM_KIND } from "../dist/src/software/cad/program.js";
import { previewProgram, inspectProgram } from "../dist/src/software/cad/program-preview.js";
import { configuredSupportsImages, runtimeSettingsEnv } from "../dist/src/runtime/runtime-settings.js";
const actor = { type: "user", id: "local" };
async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), "atria-cad-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const created = await service.createResource({
    taskId: "a",
    kind: CAD_PROGRAM_KIND,
    title: "设计.cad.json",
    actor,
    initialContent: { ...emptyProgram(), ...(source ? { source } : {}) }
  });
  const id = created.resource.resourceId;
  const read = () => service.readResource("a", id);
  const edit = (operationId, baseRevision, document) =>
    service.applyOperation({
      taskId: "a",
      resourceId: id,
      appType: "cad",
      operationId,
      baseRevision,
      operationType: "cad.program.replace",
      payload: { program: document },
      actor
    });
  return { service, id, read, edit };
}
test("invalid source is saved, read and exported without computation, then preview failure is recoverable", async (t) => {
  const invalid = 'module.exports.main=()=>{throw new Error("saved compile error")};';
  const { service, id, read, edit } = await fixture(t, invalid);
  const tools = cadRuntimeAdapter.agentTools(),
    reader = tools.find((t) => t.name === "cad_read_model"),
    preview = tools.find((t) => t.name === "cad_preview");
  let saved = await read();
  const result = await reader.execute({
    content: saved.snapshot.content,
    resource: saved.resource,
    params: {}
  });
  assert.equal(result.result.model.source, invalid);
  assert.equal(result.result.preview.status, "not_checked");
  assert.equal("geometry" in result.result, false);
  const context = cadRuntimeAdapter.summarizeContext({
    content: saved.snapshot.content,
    selection: { schema: "cad.program-solid/v1", data: { id: "solid_0" }, summary: "old verified entity" }
  });
  assert.match(context.selectionSummary, /旧预览/);
  assert.doesNotMatch(context.selectionSummary, /old verified entity/);
  const exported = await service.renderForDownload({ taskId: "a", resourceId: id, format: "jscad" });
  assert.ok(exported.body.includes(invalid));
  await assert.rejects(
    preview.execute({ content: saved.snapshot.content, resource: saved.resource, params: {} }),
    (e) => {
      assert.equal(e.details.sourceSaved, true);
      assert.match(e.message, /saved compile error/);
      return true;
    }
  );
  saved = await read();
  assert.equal(saved.resource.revision, 0);
  assert.equal(saved.snapshot.content.source, invalid);
  const again = await reader.execute({
    content: saved.snapshot.content,
    resource: saved.resource,
    params: {}
  });
  assert.equal(again.result.preview.status, "failed");
  await edit("fix", 0, emptyProgram());
  saved = await read();
  const checked = await preview.execute({
    content: saved.snapshot.content,
    resource: saved.resource,
    params: {}
  });
  assert.equal(checked.result.status, "ready");
  assert.deepEqual(checked.result.dimensions, [40, 40, 60]);
  assert.equal(inspectProgram(saved.snapshot.content).status, "ready");
  await service.undo({ taskId: "a", resourceId: id, actor });
  assert.equal((await read()).snapshot.content.source, invalid);
});
test("long sandbox jobs leave the event loop and document edits available, and cannot overwrite newer source", async (t) => {
  const { read, edit } = await fixture(t, "module.exports.main=()=>{while(true){}}");
  const initial = await read();
  let settled = false,
    ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const pending = previewProgram(initial.snapshot.content, 700).finally(() => {
    settled = true;
    clearInterval(timer);
  });
  await edit("save-during-calculation", 0, emptyProgram());
  assert.equal(settled, false, "saving does not wait for the old geometry job");
  const failed = await pending;
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /超时/);
  assert.ok(ticks > 2);
  assert.equal((await read()).snapshot.content.source, emptyProgram().source);
  assert.notEqual(inspectProgram((await read()).snapshot.content).status, "failed");
});
function pngPixels(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset),
      name = bytes.toString("ascii", offset + 4, offset + 8);
    if (name === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(compressed));
}
test("four-view feedback is a real decodable raster of current geometry and reports each object", async () => {
  const source = await readFile("test/fixtures/cad-rocket.jscad", "utf8");
  const document = { ...emptyProgram(), source, parameters: { radius: 23 } };
  const preview = await previewProgram(document);
  assert.equal(preview.status, "ready");
  assert.equal(preview.report.objects.length, 14);
  assert.equal(preview.report.parameters.radius, 23);
  assert.ok(preview.report.triangles > 4000);
  assert.ok(preview.report.objects.every((o) => o.bounds.length === 2 && o.triangles > 0));
  const bytes = Buffer.from(preview.png, "base64"),
    pixels = pngPixels(bytes),
    width = bytes.readUInt32BE(16);
  assert.equal(width, 768);
  assert.equal(pixels.length, 768 * (768 * 3 + 1));
  for (let tile = 0; tile < 4; tile++) {
    let covered = 0;
    for (let y = Math.floor(tile / 2) * 384 + 40; y < (Math.floor(tile / 2) + 1) * 384 - 30; y++)
      for (let x = (tile % 2) * 384 + 30; x < ((tile % 2) + 1) * 384 - 30; x++)
        if (pixels[y * (width * 3 + 1) + 1 + x * 3] !== 27) covered++;
    assert.ok(covered > 1000, "each view contains computed geometry");
  }
  const changed = await previewProgram({ ...document, parameters: { radius: 28 } });
  assert.notEqual(changed.png, preview.png);
  assert.notDeepEqual(changed.report.dimensions, preview.report.dimensions);
});
test("preview images export through the ordinary authenticated resource contract", async (t) => {
  const { service, id } = await fixture(t);
  const exported = await service.renderForDownload({ taskId: "a", resourceId: id, format: "png" });
  assert.equal(exported.mimeType, "image/png");
  assert.ok(exported.fileName.endsWith("-views.png"));
  assert.ok(pngPixels(exported.body).length > 0);
});
test("vision capability defaults off and honors explicit configuration and environment", () => {
  assert.equal(configuredSupportsImages({}), false);
  assert.equal(configuredSupportsImages({ COWORK_SUPPORTS_IMAGES: "true" }), true);
  assert.equal(configuredSupportsImages({ COWORK_SUPPORTS_IMAGES: "0" }), false);
  assert.throws(() => configuredSupportsImages({ COWORK_SUPPORTS_IMAGES: "maybe" }), /supportsImages/);
  const previous = process.env.COWORK_SUPPORTS_IMAGES;
  try {
    delete process.env.COWORK_SUPPORTS_IMAGES;
    assert.equal(configuredSupportsImages(runtimeSettingsEnv({ supportsImages: true })), true);
    process.env.COWORK_SUPPORTS_IMAGES = "0";
    assert.equal(configuredSupportsImages(runtimeSettingsEnv({ supportsImages: true })), false);
  } finally {
    if (previous === undefined) delete process.env.COWORK_SUPPORTS_IMAGES;
    else process.env.COWORK_SUPPORTS_IMAGES = previous;
  }
});

test("cancelling a running or queued preview frees its slot without marking the source invalid", async () => {
  const document = {
    ...emptyProgram(),
    source: "module.exports.main=()=>{while(true){}} // cancellation fixture"
  };
  const first = new AbortController(),
    second = new AbortController(),
    queued = new AbortController();
  const a = previewProgram(document, 20_000, first.signal);
  const b = previewProgram(document, 20_000, second.signal);
  const c = previewProgram(document, 20_000, queued.signal);
  const rejected = assert.rejects(c, /取消/);
  queued.abort();
  await rejected;
  // Allow acquire's continuation to create both workers before cancelling.
  await new Promise((resolve) => setImmediate(resolve));
  first.abort();
  second.abort();
  const results = await Promise.all([a, b]);
  assert.ok(results.every((result) => result.status === "failed" && /取消/.test(result.error)));
  assert.equal(inspectProgram(document).status, "not_checked");
  assert.equal((await previewProgram(emptyProgram())).status, "ready");
});
