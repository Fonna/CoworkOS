import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import pptxgen from "pptxgenjs";
import { buildDeck } from "../.pi/skills/presentations/scripts/build_deck.mjs";
import { checkBackend } from "../.pi/skills/presentations/scripts/check_backend.mjs";
import { renderSlides } from "../.pi/skills/presentations/scripts/render_slides.mjs";

const exec = promisify(execFile);
const audit = resolve(".pi/skills/presentations/scripts/audit_slides.py");
test("editable deck generation validates packages, refuses dense text and detects broken geometry/references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-presentation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "deck.pptx");
  await buildDeck(
    {
      title: "Evidence",
      slides: [
        { type: "cover", title: "Editable evidence" },
        {
          type: "chart",
          title: "Illustrative data",
          takeaway: "Example only",
          source: "Illustrative, not measured",
          chart: {
            type: "bar",
            unit: "issues",
            labels: ["A", "B"],
            series: [{ name: "Example", values: [3, 0] }]
          }
        }
      ]
    },
    output
  );
  const { stdout } = await exec("python3", [audit, output]);
  assert.equal(JSON.parse(stdout).valid, true);
  await exec("python3", [
    "-c",
    "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1]);assert b'Editable evidence' in z.read('ppt/slides/slide1.xml');assert any(n.startswith('ppt/charts/chart') for n in z.namelist())",
    output
  ]);
  const layout = JSON.parse(await readFile(join(root, "deck.layout.json"), "utf8"));
  assert.ok(layout.slides[1].elements.some((e) => e.type === "chart"));
  const bad = join(root, "bad.pptx"),
    p = new pptxgen();
  p.layout = "LAYOUT_WIDE";
  p.addSlide().addText("Outside", { x: 14, y: 2, w: 2, h: 1 });
  await p.writeFile({ fileName: bad });
  await assert.rejects(exec("python3", [audit, bad]), (e) =>
    JSON.parse(e.stdout).errors.some((issue) => issue.code === "out_of_bounds")
  );
  await exec("python3", [
    "-c",
    "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'a') as z:z.writestr('ppt/slides/_rels/broken.xml.rels','<Relationships><Relationship Id=\"missing\" Target=\"../media/missing.png\"/></Relationships>')",
    output
  ]);
  await assert.rejects(exec("python3", [audit, output]), (e) =>
    JSON.parse(e.stdout).errors.some((issue) => issue.code === "broken_relationship")
  );
  await assert.rejects(
    buildDeck({ slides: [{ type: "cover", title: "密集文字".repeat(200) }] }, join(root, "dense.pptx")),
    /too dense/
  );
});

test("backend detection checks the actual Python validator and honors configured executables", async () => {
  const missing = resolve("does-not-exist-atria-backend");
  const result = await checkBackend({
    ...process.env,
    COWORK_PYTHON_PATH: missing,
    COWORK_SOFFICE_PATH: missing,
    COWORK_PDFTOPPM_PATH: missing
  });
  assert.equal(result.create, true);
  assert.equal(result.validate, false);
  assert.equal(result.render, false);
  assert.equal(result.renderPdf, false);
});

test("real PDF rendering produces page PNGs, a contact sheet and hashes without ImageMagick", async (t) => {
  const backend = await checkBackend();
  if (!backend.renderPdf) return t.skip("Python and Poppler are required");
  const root = await mkdtemp(join(tmpdir(), "atria-pdf-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "fixture.pdf");
  // A real minimal PDF with a cross-reference table; no Office or Python packages needed.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Contents 4 0 R >>",
    "<< /Length 26 >>\nstream\n0.1 0.5 0.7 rg 0 0 720 405 re f\nendstream"
  ];
  objects[3] = objects[3].replace("/Length 26", "/Length 30");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((value, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${value}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n ")
    .join("\n")}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(input, pdf);
  const options = { input, outputDir: join(root, "preview"), dpi: 72, columns: 3 };
  const rendered = await renderSlides(options);
  assert.equal(rendered.slides.length, 1);
  const sheet = await readFile(rendered.contactSheet);
  assert.equal(sheet.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(sheet.readUInt32BE(16) > 480);
  const manifest = JSON.parse(await readFile(rendered.manifest, "utf8"));
  assert.equal(
    manifest.inputHash,
    createHash("sha256")
      .update(await readFile(input))
      .digest("hex")
  );
  assert.equal(
    manifest.slides[0].imageHash,
    createHash("sha256")
      .update(await readFile(rendered.slides[0]))
      .digest("hex")
  );
  await assert.rejects(
    renderSlides(options, { ...process.env, COWORK_PDFTOPPM_PATH: join(root, "missing") }),
    /ENOENT/
  );
  await assert.rejects(readFile(rendered.manifest), { code: "ENOENT" });
});
