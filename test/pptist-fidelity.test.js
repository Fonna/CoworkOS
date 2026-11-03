import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { styleDeck } from "./fixtures/pptist-style.mjs";
import { normalizePresentation } from "../dist/src/software/pptist/model.js";
import { exportPptx } from "../dist/src/software/pptist/export.js";
import { layoutWarnings } from "../dist/src/software/pptist/layout.js";
import { pptistRuntimeAdapter as adapter } from "../dist/src/applications/adapters/pptist-runtime-adapter.js";

test("headless PPTX exports CSS font families as valid Office font attributes", async () => {
  const doc = normalizePresentation(styleDeck());
  doc.slides[0].elements[0].defaultFontName = '"PingFang SC", sans-serif';
  for (const row of doc.slides[2].elements[1].data)
    for (const cell of row) cell.style.fontname = '"PingFang SC", Arial';
  doc.slides.splice(1, 1);
  const zip = await JSZip.loadAsync(await exportPptx(doc, "quoted-fonts"));
  for (const path of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
    const xml = await zip.file(path).async("string");
    assert.match(xml, /typeface="PingFang SC"/);
    assert.doesNotMatch(xml, /typeface=""|typeface="[^"<>]*,(?: Arial| sans-serif)/);
  }
});

test("headless PPTX retains chart presentation and styled table cells in editable Office XML", async () => {
  const doc = normalizePresentation(styleDeck());
  const zip = await JSZip.loadAsync(await exportPptx(doc, "fidelity"));
  const chart = await zip.file("ppt/charts/chart1.xml").async("string");
  assert.doesNotMatch(chart, /<c:legend>/);
  assert.match(chart, /<c:showVal val="1"/);
  assert.match(chart, /<a:srgbClr val="FFFFFF"/);
  assert.match(chart, /营收（万元）/);
  assert.match(chart, /<c:v>210<\/c:v>/);
  const cover = await zip.file("ppt/slides/slide1.xml").async("string");
  for (const [name, value] of [
    ["tIns", 18288],
    ["rIns", 36576],
    ["bIns", 54864],
    ["lIns", 73152]
  ])
    assert.match(cover, new RegExp(`${name}="${value}"`));
  const table = await zip.file("ppt/slides/slide3.xml").async("string");
  for (const color of ["9C4D10", "1D3855", "16304B", "56708C", "FFFFFF"])
    assert.match(table, new RegExp(`val="${color}"`));
  assert.match(table, /<a:rPr[^>]*sz="1764"/);
  assert.match(table, /<a:rPr[^>]*b="1"/);
  assert.match(table, /<a:tr h="502920"/);
  assert.match(await zip.file("ppt/notesSlides/notesSlide1.xml").async("string"), /人工备注必须保留/);
  doc.slides[1].elements[1].options = { showLegend: true, showLabel: false };
  const inverse = await JSZip.loadAsync(await exportPptx(doc, "options"));
  const changed = await inverse.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async("string");
  assert.match(changed, /<c:legend>/);
  assert.doesNotMatch(changed, /<c:showVal val="1"/);
});

test("table merges exclude covered source cells and keep plain text literal", async () => {
  const doc = normalizePresentation(styleDeck());
  const table = doc.slides[2].elements[1];
  table.data[0][0].colspan = 2;
  table.data[0][0].text = "价格 <20 & >10";
  table.data[0][1].text = "COVERED_CELL";
  const zip = await JSZip.loadAsync(await exportPptx(doc, "merged"));
  const xml = await zip.file("ppt/slides/slide3.xml").async("string");
  assert.doesNotMatch(xml, /COVERED_CELL/);
  assert.match(xml, /价格 &lt;20 &amp; &gt;10/);
  assert.match(xml, /gridSpan="2"/);
});

test("normalized table rich text exports editable runs and literal comparison symbols", async () => {
  const source = styleDeck();
  source.slides[2].elements[1].data[0][0].text =
    '<span style="font-size:24.5px;color:#F59B45"><b>季度 &amp; 预算</b></span><br>下一行';
  source.slides[2].elements[1].data[1][0].text = "价格 <20 & >10";
  const doc = normalizePresentation(source);
  const zip = await JSZip.loadAsync(await exportPptx(doc, "rich-table"));
  const xml = await zip.file("ppt/slides/slide3.xml").async("string");
  assert.match(xml, /季度 &amp; 预算/);
  assert.match(xml, /下一行/);
  assert.match(xml, /价格 &lt;20 &amp; &gt;10/);
  assert.doesNotMatch(xml, /&amp;(?:amp|lt|gt);|&lt;(?:span|b|br)/);
  assert.match(xml, /<a:rPr[^>]*sz="1764"[^>]*b="1"/);
  assert.match(xml, /<a:srgbClr val="F59B45"/);
});

test("new agent text uses usable box dimensions without changing existing text or imports", () => {
  const legacy = normalizePresentation(styleDeck());
  delete legacy.slides[0].elements[1].inset;
  assert.deepEqual(
    layoutWarnings(legacy).map((w) => w.code),
    ["text_height", "page_number_wrap"]
  );
  const next = adapter.applyOperation({
    content: legacy,
    operationType: "pptist.edit",
    payload: {
      changes: [
        { type: "upsert_element", slideId: "cover", element: { id: "page", left: 870 } },
        {
          type: "upsert_element",
          slideId: "cover",
          element: { ...legacy.slides[0].elements[1], id: "new-page", top: 450 }
        },
        {
          type: "insert_slide",
          slide: { id: "new-slide", elements: [{ ...legacy.slides[0].elements[1], id: "inserted" }] }
        }
      ]
    },
    actor: { type: "agent", id: "main" }
  }).content;
  assert.equal(next.slides[0].elements[1].inset, undefined);
  assert.deepEqual(next.slides[0].elements[2].inset, [0, 0, 0, 0]);
  assert.deepEqual(next.slides[3].elements[0].inset, [0, 0, 0, 0]);
  assert.deepEqual(
    layoutWarnings(next).map((w) => w.elementId),
    ["page", "page"]
  );
  assert.equal(normalizePresentation(legacy).slides[0].elements[1].inset, undefined);
  assert.throws(
    () =>
      normalizePresentation({
        ...legacy,
        slides: [{ id: "bad", elements: [{ ...legacy.slides[0].elements[1], inset: [-1, 0, 0, 0] }] }]
      }),
    /inset/
  );
});
