import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import pptxgen from "pptxgenjs";
import { buildDeck } from "../.pi/skills/presentations/scripts/build_deck.mjs";
import {
  assertSlidesInBounds,
  coverRect,
  inspectSlideGeometry
} from "../.pi/skills/presentations/scripts/pptx_helpers.mjs";
import { discoverAssets } from "../.pi/skills/presentations/scripts/discover_assets.mjs";

const exec = promisify(execFile);
const python = process.env.COWORK_PYTHON_PATH || "python3";
const audit = resolve(".pi/skills/presentations/scripts/audit_slides.py");
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("cover and closing copy remains visible on both supported surfaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-cover-surfaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "deck.pptx");
  await buildDeck(
    {
      slides: ["cover", "closing"].flatMap((type) =>
        ["light", "dark"].map((surface) => ({
          type,
          surface,
          title: "Title",
          kicker: "Kicker",
          subtitle: "Subtitle",
          takeaway: "Takeaway"
        }))
      )
    },
    output
  );
  const { stdout } = await exec(python, [
    "-c",
    `import json,sys,zipfile,xml.etree.ElementTree as E
ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
z=zipfile.ZipFile(sys.argv[1]);slides=[]
for i in range(1,5):
 s=E.fromstring(z.read('ppt/slides/slide%d.xml'%i));bg=s.find('p:cSld/p:bg/p:bgPr/a:solidFill/a:srgbClr',ns).get('val');colors={}
 for shape in s.findall('p:cSld/p:spTree/p:sp',ns):
  text=shape.find('.//a:t',ns);color=shape.find('.//a:rPr/a:solidFill/a:srgbClr',ns)
  if text is not None and color is not None:colors[text.text]=color.get('val')
 slides.append({'background':bg,'colors':colors})
print(json.dumps(slides))`,
    output
  ]);
  for (const [index, slide] of JSON.parse(stdout).entries()) {
    for (const name of ["Title", "Kicker", "Subtitle", "Takeaway"]) {
      assert.notEqual(slide.colors[name], slide.background, `${name} is invisible on slide ${index + 1}`);
    }
    if (index % 2 === 0) {
      assert.equal(slide.colors.Takeaway, "173B45");
      assert.equal(slide.colors.Subtitle, "526570");
    }
  }
});

test("geometry inspection normalizes native table EMUs and still rejects an outside table", () => {
  const p = new pptxgen();
  p.layout = "LAYOUT_WIDE";
  const inside = p.addSlide();
  inside.addTable([["Within bounds"]], { x: 1, y: 1, w: 3, h: 1 });
  assert.doesNotThrow(() => assertSlidesInBounds(p));
  const result = inspectSlideGeometry(inside);
  assert.equal(result.objects, 1);
  assert.deepEqual(result.outOfBounds, []);
  const outside = p.addSlide();
  outside.addTable([["Outside"]], { x: 14, y: 1, w: 3, h: 1 });
  assert.equal(inspectSlideGeometry(outside).outOfBounds.length, 1);
  assert.throws(() => assertSlidesInBounds(p), /outside canvas/);
});

test("strict font audit includes native table cell fonts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-table-fonts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = new pptxgen();
  p.layout = "LAYOUT_WIDE";
  p.addSlide().addTable([["Missing font inside a table"]], {
    x: 1,
    y: 1,
    w: 8,
    h: 1,
    fontSize: 20,
    fontFace: "AtriaMissingTableFontRegression"
  });
  const output = join(root, "table.pptx");
  await p.writeFile({ fileName: output });
  const normal = JSON.parse((await exec(python, [audit, output])).stdout);
  assert.equal(normal.valid, true);
  assert.ok(normal.fonts.some((font) => font.requested === "AtriaMissingTableFontRegression"));
  assert.ok(normal.warnings.some((issue) => issue.code === "font_unavailable"));
  await assert.rejects(exec(python, [audit, output, "--strict-fonts"]), (error) => {
    assert.equal(JSON.parse(error.stdout).valid, false);
    return true;
  });
});

test("visual components retain native labels, crop ratios, connectors and chart manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-visual-layouts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const output = join(root, "deck.pptx");
  await buildDeck(
    {
      theme: "arena",
      slides: [
        { type: "hero", title: "Visual identity", image: "pixel.png", subtitle: "Editable text" },
        {
          type: "image",
          title: "Full image",
          image: "pixel.png",
          imageSide: "right",
          items: ["Keep the whole image"]
        },
        {
          type: "annotated-image",
          title: "Annotation",
          image: "pixel.png",
          annotations: [{ x: 0, y: 1, title: "Boundary", body: "A visible label" }]
        },
        {
          type: "gallery",
          title: "Comparison",
          images: [
            { image: "pixel.png", title: "First" },
            { image: "pixel.png", title: "Second" }
          ]
        },
        {
          type: "diagram",
          title: "Data flow",
          surface: "dark",
          nodes: [
            { id: "input", label: "Input", x: 0, y: 0.3, w: 0.22, h: 0.4, kind: "ellipse" },
            { id: "output", label: "Output", x: 0.78, y: 0.3, w: 0.22, h: 0.4, tone: "accent" }
          ],
          edges: [{ from: "input", to: "output", label: "Transform" }],
          takeaway: "Arrows show direction"
        },
        {
          type: "chart",
          title: "Dark chart",
          surface: "dark",
          source: "Illustrative data",
          takeaway: "Example",
          chart: {
            type: "bar",
            unit: "items",
            labels: ["A", "B"],
            series: [{ name: "Example", values: [1, 2] }]
          }
        }
      ]
    },
    output,
    { baseDirectory: root }
  );
  assert.equal(JSON.parse((await exec(python, [audit, output])).stdout).valid, true);
  const layout = JSON.parse(await readFile(join(root, "deck.layout.json"), "utf8"));
  assert.ok(layout.slides[5].elements.some((element) => element.type === "chart"));
  await exec(python, [
    "-c",
    `import zipfile,sys,xml.etree.ElementTree as E
z=zipfile.ZipFile(sys.argv[1]);ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
s=E.fromstring(z.read('ppt/slides/slide1.xml'));crop=s.find('.//a:srcRect',ns)
assert crop is not None and any(int(v)>0 for v in crop.attrib.values())
s=E.fromstring(z.read('ppt/slides/slide2.xml'));extent=s.find('.//p:pic/p:spPr/a:xfrm/a:ext',ns)
assert extent.get('cx')==extent.get('cy')
s=E.fromstring(z.read('ppt/slides/slide5.xml'));texts=[t.text for t in s.findall('.//a:t',ns)]
assert all(t in texts for t in ['Input','Output','Transform'])
assert s.find('.//a:tailEnd[@type="triangle"]',ns) is not None
assert s.find('.//p:pic',ns) is None`,
    output
  ]);
  const custom = new pptxgen();
  custom.layout = "LAYOUT_WIDE";
  custom.addSlide().addImage({ path: join(root, "pixel.png"), ...coverRect(1, 1, 10, 1, 2, 6) });
  assert.doesNotThrow(() => assertSlidesInBounds(custom));
});

test("asset inventory reports dimensions and excludes hidden, generated and linked inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-layout-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["materials/assets", "assets", "materials/.private", "materials/preview"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  for (const path of [
    "materials/assets/one.png",
    "assets/two.png",
    "materials/.private/private.png",
    "materials/preview/generated.png"
  ]) {
    await writeFile(join(root, path), pixel);
  }
  await symlink(
    join(root, "materials/.private"),
    join(root, "materials/linked"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const result = await discoverAssets(root);
  assert.deepEqual(
    result.images.map((image) => image.path.replaceAll("\\", "/")),
    ["materials/assets/one.png", "assets/two.png"]
  );
  assert.ok(result.images.every((image) => image.width === 1 && image.height === 1));
  const limited = await discoverAssets(root, { limit: 1 });
  assert.equal(limited.images.length, 1);
  assert.equal(limited.truncated, true);
});

test("custom image cover helper keeps source ratio and audits the visible viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-cover-"));
  try {
    const path = join(root, "pixel.png");
    await writeFile(
      path,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      )
    );
    const p = new pptxgen();
    p.layout = "LAYOUT_WIDE";
    p.addSlide().addImage({ path, ...coverRect(1, 1, 10, 1, 2, 6) });
    assertSlidesInBounds(p);
    const output = join(root, "cover.pptx");
    await p.writeFile({ fileName: output });
    await exec(python, [
      "-c",
      `import zipfile,sys,xml.etree.ElementTree as E
z=zipfile.ZipFile(sys.argv[1]);ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
s=E.fromstring(z.read('ppt/slides/slide1.xml'));r=s.find('.//a:srcRect',ns)
assert abs(int(r.get('l'))-33333)<=1 and abs(int(r.get('r'))-33333)<=1
`,
      output
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagram builder rejects broken topology and invalid normalized geometry", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-invalid-diagram-"));
  const nodes = [
    { id: "a", label: "A", x: 0, y: 0, w: 0.3, h: 0.5 },
    { id: "b", label: "B", x: 0.7, y: 0, w: 0.3, h: 0.5 }
  ];
  const build = (data) =>
    buildDeck({ slides: [{ type: "diagram", title: "Test", nodes, ...data }] }, join(root, "deck.pptx"));
  try {
    await assert.rejects(() => build({ edges: [{ from: "a", to: "missing" }] }), /existing, distinct/);
    await assert.rejects(
      () => build({ nodes: [nodes[0], { ...nodes[1], id: "a" }], edges: [] }),
      /Duplicate/
    );
    await assert.rejects(
      () => build({ nodes: [nodes[0], { ...nodes[1], x: 0.9 }], edges: [] }),
      /within 0–1/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit distinguishes long small body copy from footer citations without invalidating the package", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-small-text-"));
  try {
    const p = new pptxgen();
    p.layout = "LAYOUT_WIDE";
    const s = p.addSlide();
    const copy = "A full paragraph that requires a presentation-scale readability check.";
    s.addText(copy, { x: 0.7, y: 2, w: 10, h: 1, fontSize: 14, objectName: "body-copy" });
    s.addText(copy, { x: 0.7, y: 6.9, w: 10, h: 0.3, fontSize: 10, objectName: "citation" });
    const file = join(root, "text.pptx");
    await p.writeFile({ fileName: file });
    const { stdout } = await exec(python, [
      resolve(".pi/skills/presentations/scripts/audit_slides.py"),
      file
    ]);
    const audit = JSON.parse(stdout);
    assert.equal(audit.valid, true);
    const small = audit.warnings.filter((x) => x.code === "small_body_text");
    assert.equal(small.length, 1);
    assert.equal(small[0].element, "body-copy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
