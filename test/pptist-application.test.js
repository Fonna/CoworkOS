import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import CryptoJS from "crypto-js";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { pptistRuntimeAdapter as adapter } from "../dist/src/applications/adapters/pptist-runtime-adapter.js";
import { normalizePresentation, plainText, PPTIST_KIND } from "../dist/src/software/pptist/model.js";
const actor = { type: "user", id: "local" };
const element = {
  id: "title",
  type: "text",
  left: 80,
  top: 60,
  width: 800,
  height: 100,
  rotate: 0,
  content: "<p><strong>标题 &amp; 测试</strong></p>"
};
const deck = () =>
  normalizePresentation({ slides: [{ id: "one", elements: [element], remark: "<p>备注</p>" }] });
const apply = (content, changes) =>
  adapter.applyOperation({ content, operationType: "pptist.edit", payload: { changes }, actor });

test("PPTist reads expose real slide IDs and recover from guessed IDs", async () => {
  const content = adapter.createContent({});
  const resource = { title: "空白文稿", revision: 0 };
  const read = adapter.agentTools().find((tool) => tool.name === "pptist_read_presentation");
  const catalog = await read.execute({ content, resource, params: {} });
  const slideId = catalog.result.outline[0].id;
  assert.equal(slideId, content.slides[0].id);
  for (const guessed of ["1", "intro", "slide-1"]) {
    await assert.rejects(read.execute({ content, resource, params: { slideId: guessed } }), (error) => {
      assert.equal(error.code, "invalid_operation");
      assert.deepEqual(error.details.availableSlides, [{ id: slideId, page: 1 }]);
      assert.deepEqual(error.details.nextAction, { tool: "pptist_read_presentation", arguments: {} });
      return true;
    });
  }
  const page = await read.execute({ content, resource, params: { slideId } });
  assert.equal(page.result.slide.id, slideId);
  assert.equal(resource.revision, 0);
});

test("PPTist edits are atomic, preserve unmentioned content and invert all changes", () => {
  const before = deck();
  const result = apply(before, [
    { type: "upsert_element", slideId: "one", element: { id: "title", left: 90 } },
    { type: "insert_slide", slide: { id: "two", elements: [] } },
    { type: "reorder_slides", ids: ["two", "one"] }
  ]);
  assert.equal(result.content.slides[1].elements[0].content, before.slides[0].elements[0].content);
  assert.equal(result.content.slides[1].elements[0].left, 90);
  assert.deepEqual(
    adapter.applyOperation({ content: result.content, ...result.inverse, actor }).content,
    before
  );
  assert.throws(
    () =>
      apply(before, [
        { type: "upsert_element", slideId: "one", element: { id: "title", left: 90 } },
        { type: "delete_slide", slideId: "missing" }
      ]),
    /找不到/
  );
  assert.equal(before.slides[0].elements[0].left, 80);
  assert.throws(() => apply(before, [{ type: "delete_slide", slideId: "one" }]), /1–200/);
});

test("PPTist sanitizes rich content, accepts line geometry and rejects invalid media/charts", () => {
  const doc = normalizePresentation({
    slides: [
      {
        id: "one",
        elements: [
          {
            ...element,
            content: '<p onclick="evil()">A &amp; B<script>evil()</script><img src=x onerror=evil()></p>'
          },
          { id: "line", type: "line", left: 0, top: 0, width: 2, start: [0, 0], end: [100, 100] }
        ]
      }
    ]
  });
  assert.equal(plainText(doc.slides[0].elements[0].content), "A & B\n");
  assert.equal(doc.slides[0].elements[1].width, 2);
  assert.throws(
    () =>
      normalizePresentation({
        slides: [{ id: "one", elements: [{ ...element, type: "image", src: "file:///etc/passwd" }] }]
      }),
    /媒体/
  );
  assert.throws(
    () =>
      normalizePresentation({
        slides: [
          {
            id: "one",
            elements: [
              {
                ...element,
                type: "chart",
                chartType: "line",
                data: { labels: ["a"], series: [[null]], legends: ["b"] }
              }
            ]
          }
        ]
      }),
    /图表/
  );
  assert.throws(
    () => normalizePresentation({ slides: [{ id: "one", elements: [element, element] }] }),
    /重复/
  );
});

test("PPTist table cells retain allowed rich formatting while filtering other HTML", () => {
  const style = { bold: true, fontsize: "24.5px", backcolor: "#16304B", align: "center" };
  const source = {
    slides: [
      {
        id: "table-slide",
        elements: [
          {
            ...element,
            type: "table",
            colWidths: [1],
            data: [
              [
                {
                  id: "cell",
                  text: '<span style="font-size:24.5px;color:#F59B45" data-layout="review"><b>季度 &amp; 预算</b></span><button type="button">说明</button><br>下一行',
                  colspan: 1,
                  rowspan: 1,
                  style
                }
              ]
            ]
          }
        ]
      }
    ]
  };
  const saved = normalizePresentation(source).slides[0].elements[0].data[0][0];
  assert.match(saved.text, /<b>季度 &amp; 预算<\/b>/);
  assert.match(saved.text, /font-size:24\.5px/);
  assert.match(saved.text, /color:#F59B45/);
  assert.match(saved.text, /说明<br\s*\/?>下一行/);
  assert.doesNotMatch(saved.text, /button|data-layout/);
  assert.deepEqual(saved.style, style);
  assert.match(source.slides[0].elements[0].data[0][0].text, /<button/);
});

test("PPTist saves >4 MiB, survives reload, rejects stale writes and supports undo without raising other apps limits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-pptist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root),
    taskId = "pptist-test";
  const { resource } = await service.createResource({ taskId, kind: PPTIST_KIND, title: "演示", actor });
  assert.equal(adapter.definition.displayName, "PPT 演示文稿");
  const doc = deck();
  doc.slides[0].elements.push({
    ...element,
    id: "image",
    type: "image",
    src: "data:image/png;base64," + "A".repeat(5 * 1024 * 1024)
  });
  const op = {
    taskId,
    resourceId: resource.resourceId,
    appType: "pptist",
    operationId: "large-save",
    operationType: "pptist.replace",
    baseRevision: 0,
    payload: { document: doc },
    actor
  };
  const saved = await service.applyOperation(op);
  assert.equal(saved.resource.revision, 1);
  assert.equal((await service.applyOperation(op)).deduplicated, true);
  const fresh = new ApplicationService(root);
  const read = await fresh.readResource(taskId, resource.resourceId);
  assert.equal(read.snapshot.content.slides[0].elements[1].src.length, 5 * 1024 * 1024 + 22);
  await assert.rejects(
    fresh.applyOperation({ ...op, operationId: "stale" }),
    (e) => e.code === "revision_conflict"
  );
  await fresh.undo({ taskId, resourceId: resource.resourceId, baseRevision: 1, actor });
  assert.equal(
    (await fresh.readResource(taskId, resource.resourceId)).snapshot.content.slides[0].elements.length,
    0
  );
  await assert.rejects(
    service.createResource({
      taskId,
      kind: "text/plain",
      title: "large.txt",
      initialContent: "x".repeat(3 * 1024 * 1024),
      actor
    }),
    (e) => e.code === "resource_too_large"
  );
});

test("PPTist exports native JSON/encrypted source and editable PPTX text/charts/notes", async () => {
  const doc = deck();
  doc.slides[0].elements.push({
    ...element,
    id: "chart",
    type: "chart",
    chartType: "column",
    data: { labels: ["甲", "乙"], legends: ["系列"], series: [[10, 20]] }
  });
  const resource = { title: "安全/导出", revision: 0 };
  const json = await adapter.exportResource({ resource, content: doc, format: "json" });
  const native = await adapter.exportResource({ resource, content: doc, format: "pptist" });
  assert.deepEqual(
    JSON.parse(CryptoJS.AES.decrypt(native.body, "pptist").toString(CryptoJS.enc.Utf8)),
    JSON.parse(json.body)
  );
  const pptx = await adapter.exportResource({ resource, content: doc, format: "pptx" });
  assert.equal(pptx.fileName, "安全-导出.pptx");
  const zip = await JSZip.loadAsync(pptx.body);
  assert.match(await zip.file("docProps/core.xml").async("string"), /<dc:creator>CoworkOS<\/dc:creator>/);
  assert.match(await zip.file("ppt/slides/slide1.xml").async("string"), /标题 &amp; 测试/);
  assert.match(await zip.file("ppt/notesSlides/notesSlide1.xml").async("string"), /备注/);
  assert.match(await zip.file("ppt/charts/chart1.xml").async("string"), /<c:v>20<\/c:v>/);
  const read = await adapter
    .agentTools()
    .find((t) => t.name === "pptist_read_presentation")
    .execute({ content: doc, resource, params: { slideId: "one" } });
  assert.equal(read.result.slide.id, "one");
  const write = await adapter
    .agentTools()
    .find((t) => t.name === "pptist_edit_presentation")
    .execute({ params: { changes: [{ type: "update_slide", slideId: "one", props: { remark: "更新" } }] } });
  assert.equal(
    adapter.applyOperation({ content: doc, ...write.operations[0], actor }).content.slides[0].remark,
    "更新"
  );
});

test("native import uses the existing application command/CAS interface and cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-pptist-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root),
    taskId = "import-test";
  const { resource } = await service.createResource({ taskId, kind: PPTIST_KIND, title: "导入", actor });
  const source = await adapter.exportResource({ resource, content: deck(), format: "pptist" });
  const input = {
    taskId,
    resourceId: resource.resourceId,
    operationId: "import-one",
    baseRevision: 0,
    body: Buffer.from(source.body),
    actor
  };
  const imported = await service.importNativeResource(input);
  assert.equal(imported.resource.revision, 1);
  assert.equal(imported.snapshot.content.slides[0].id, "one");
  assert.equal((await service.importNativeResource(input)).deduplicated, true);
  await assert.rejects(
    service.importNativeResource({ ...input, operationId: "import-stale" }),
    (e) => e.code === "revision_conflict"
  );
  await assert.rejects(
    adapter.importResource({ body: Buffer.from("malformed") }),
    (e) => e.code === "invalid_operation" && !/pptist/i.test(e.message)
  );
  await assert.rejects(
    adapter.importResource({ body: Buffer.from(source.body), signal: AbortSignal.abort(Error("cancelled")) }),
    /cancelled/
  );
  await assert.rejects(
    adapter.exportResource({
      resource,
      content: deck(),
      format: "pptx",
      signal: AbortSignal.abort(Error("cancelled"))
    }),
    /cancelled/
  );
});
test("mixed rich-text formatting stays editable and same-size media changes appear in review", async () => {
  const doc = deck();
  doc.slides[0].elements[0].content =
    '<p><strong>Bold</strong><span style="font-size:32px;color:#ff0000"> red &amp; plain</span></p>';
  const { body } = await adapter.exportResource({
    resource: { title: "rich" },
    content: doc,
    format: "pptx"
  });
  const zip = await JSZip.loadAsync(body);
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.match(xml, /<a:rPr[^>]*b="1"/);
  assert.match(xml, /<a:srgbClr val="ff0000"/i);
  assert.match(xml, /red &amp; plain/);
  const a = deck(),
    b = deck();
  a.slides[0].elements.push({ ...element, type: "image", id: "image", src: "data:image/png;base64,AAAA" });
  b.slides[0].elements.push({ ...element, type: "image", id: "image", src: "data:image/png;base64,BBBB" });
  assert.notEqual(await adapter.reviewContent(a), await adapter.reviewContent(b));
});
