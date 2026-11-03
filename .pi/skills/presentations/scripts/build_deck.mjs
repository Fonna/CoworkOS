#!/usr/bin/env node
// Native editable components. Deliberately small: custom decks may still use PptxGenJS directly.
import pptxgen from "pptxgenjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { containRect, coverRect } from "./pptx_helpers.mjs";

// Support the callable image-size v1 dependency and the v2 named export.
const require = createRequire(import.meta.url);
const imageSizeModule = createRequire(require.resolve("pptxgenjs"))("image-size");
const imageSize = typeof imageSizeModule === "function" ? imageSizeModule : imageSizeModule.imageSize;

export const themes = {
  teal: { ink: "173B45", accent: "087F8C", pale: "EAF4F4", paper: "FFFFFF", muted: "526570" },
  navy: { ink: "182B49", accent: "3468B2", pale: "EEF2F8", paper: "FFFFFF", muted: "54657D" },
  terracotta: { ink: "402B28", accent: "AD4F37", pale: "FAF0EB", paper: "FFFFFF", muted: "745E57" },
  arena: { ink: "101C2C", accent: "A87924", pale: "F2EBDD", paper: "FAF9F5", muted: "586575" },
  court: { ink: "201C29", accent: "C34A17", pale: "FAEDE5", paper: "FFFCF7", muted: "665D6B" }
};
const W = 13.333333,
  H = 7.5;
const fail = (message) => {
  throw new Error(message);
};
function string(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be non-empty text`);
  return value;
}
function list(value, field, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`${field} requires ${min}-${max} items`);
  return value;
}
// Conservative fit guard. CJK and Latin have different widths; rendering remains authoritative.
function estimatedLines(text, width, size) {
  const capacity = (width * 72) / size;
  return text
    .split("\n")
    .reduce(
      (n, line) =>
        n +
        Math.max(
          1,
          Math.ceil([...line].reduce((s, c) => s + (c.codePointAt(0) > 255 ? 1 : 0.55), 0) / capacity)
        ),
      0
    );
}

export async function buildDeck(spec, output, { baseDirectory = process.cwd() } = {}) {
  list(spec.slides, "slides", 1, 80);
  const preset = typeof spec.theme === "string" ? spec.theme : (spec.theme?.preset ?? "teal");
  if (!themes[preset]) fail(`Unknown theme: ${preset}`);
  const theme = { ...themes[preset], ...(typeof spec.theme === "object" ? spec.theme : {}) };
  for (const key of ["ink", "accent", "pale", "paper", "muted"])
    if (!/^[0-9a-f]{6}$/i.test(theme[key])) fail(`Invalid theme color: ${key}`);
  const font = theme.font ?? "Arial";
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "CoworkOS";
  pptx.subject = spec.subject ?? "Editable presentation";
  pptx.title = spec.title ?? spec.slides[0].title;
  pptx.lang = spec.language ?? "zh-CN";
  pptx.theme = { headFontFace: font, bodyFontFace: font, lang: pptx.lang };
  const manifest = { version: 1, theme, slideSize: { width: W, height: H }, slides: [] };
  for (const [index, data] of spec.slides.entries()) {
    const slide = pptx.addSlide();
    const hero = data.type === "hero" || (["cover", "closing"].includes(data.type) && data.image);
    const dark = hero || (data.surface ? data.surface === "dark" : ["cover", "closing"].includes(data.type));
    slide.background = { color: dark ? theme.ink : theme.paper };
    const fg = dark ? "FFFFFF" : theme.ink;
    const muted = dark ? "C7D4DF" : theme.muted;
    const accent = dark ? (data.accent ?? "E9BE70") : theme.accent;
    const pale = dark ? "243549" : theme.pale;
    const elements = [];
    const text = (id, content, x, y, w, h, size = 22, extra = {}) => {
      content = string(content, `slide ${index + 1} ${id}`);
      if (![x, y, w, h, size].every(Number.isFinite) || w <= 0 || h <= 0 || size <= 0)
        fail(`Slide ${index + 1} ${id}: text geometry and font size must be positive and finite`);
      if (((estimatedLines(content, w, size) * size) / 72) * 1.18 > h + 0.04) {
        fail(
          `Slide ${index + 1} ${id}: text is too dense for ${w}x${h} at ${size}pt; shorten or split the content (do not shrink the font).`
        );
      }
      slide.addText(content, {
        x,
        y,
        w,
        h,
        fontFace: font,
        fontSize: size,
        color: fg,
        margin: 0,
        breakLine: false,
        vertAnchor: "top",
        valign: "top",
        paraSpaceAfterPt: 0,
        ...extra,
        objectName: id
      });
      elements.push({ id, type: "text", text: content, x, y, w, h, fontSize: size });
    };
    const shape = (id, x, y, w, h, fill = pale, kind = "rect") => {
      slide.addShape(pptx.ShapeType[kind], {
        x,
        y,
        w,
        h,
        line: { color: fill, transparency: 100 },
        fill: { color: fill },
        objectName: id
      });
      elements.push({ id, type: "shape", x, y, w, h });
    };
    const image = (id, file, x, y, w, h, fit = "contain") => {
      const path = resolve(baseDirectory, string(file, "image"));
      if (!["contain", "crop"].includes(fit)) fail("image fit must be contain or crop");
      const dimensions = imageSize(readFileSync(path));
      const box =
        fit === "crop" ? { x, y, w, h } : containRect(dimensions.width, dimensions.height, x, y, w, h);
      // PptxGenJS uses the supplied w/h as the source ratio. Supplying the
      // viewport as both source and target would silently stretch the picture.
      slide.addImage({
        path,
        ...(fit === "crop" ? coverRect(dimensions.width, dimensions.height, x, y, w, h) : box),
        objectName: id
      });
      elements.push({ id, type: "image", ...box, fit });
      return box;
    };
    const line = (id, x1, y1, x2, y2, arrow = false) => {
      const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      slide.addShape(pptx.ShapeType.line, {
        ...box,
        flipH: x2 < x1,
        flipV: y2 < y1,
        line: { color: accent, width: 2, ...(arrow ? { endArrowType: "triangle" } : {}) },
        objectName: id
      });
      elements.push({ id, type: "connector", ...box });
    };
    const body = (items, x, y, w, h, size = 22) => {
      list(items, "items", 1, 5);
      const gap = 0.22,
        row = (h - gap * (items.length - 1)) / items.length;
      items.forEach((s, i) => text(`body-${x}-${i}`, s, x, y + i * (row + gap), w, row, size));
    };
    if (!hero && !["cover", "closing"].includes(data.type)) {
      text("title", data.title, 0.65, 0.5, 12.03, 0.82, 32, { bold: true });
      if (data.subtitle) text("subtitle", data.subtitle, 0.65, 1.36, 12, 0.34, 15, { color: muted });
    }
    switch (hero ? "hero" : data.type) {
      case "hero": {
        image("hero-image", data.image, 5.6, 0, W - 5.6, H, "crop");
        shape("hero-panel", 0, 0, 5.8, H, theme.ink);
        shape("hero-rule", 0.75, 1.6, 1.0, 0.055, accent);
        if (data.kicker) text("kicker", data.kicker, 0.75, 0.75, 4.4, 0.5, 16, { color: accent });
        text("title", data.title, 0.75, 2.0, 4.4, 2.0, 40, { bold: true });
        if (data.subtitle) text("subtitle", data.subtitle, 0.75, 4.3, 4.35, 1.3, 23, { color: muted });
        if (data.takeaway) text("takeaway", data.takeaway, 0.75, 5.95, 4.35, 0.65, 19, { color: muted });
        break;
      }
      case "cover":
      case "closing": {
        if (data.kicker)
          text("kicker", data.kicker, 0.75, 0.75, 11.8, 0.4, 16, { color: dark ? "B8D8DC" : accent });
        text("title", data.title, 0.75, 2.05, 11.7, 1.65, 42, { bold: true });
        if (data.subtitle)
          text("subtitle", data.subtitle, 0.78, 4.0, 10.7, 1.05, 24, { color: dark ? "DBE6EC" : muted });
        if (data.takeaway) text("takeaway", data.takeaway, 0.78, 5.75, 11.4, 0.55, 22, { color: fg });
        break;
      }
      case "comparison": {
        list(data.columns, "columns", 2, 2).forEach((c, i) => {
          const x = 0.65 + i * 6.22;
          shape(`panel-${i}`, x, 1.95, 5.8, 4.5, i ? pale : dark ? "1D2C3F" : "F4F5F6");
          text(`column-title-${i}`, c.title, x + 0.3, 2.25, 5.2, 0.65, 27, {
            bold: true,
            color: i ? accent : fg
          });
          body(c.items, x + 0.3, 3.15, 5.2, 2.65);
        });
        break;
      }
      case "flow": {
        list(data.steps, "steps", 3, 5);
        const gap = 0.35,
          w = (12.03 - gap * (data.steps.length - 1)) / data.steps.length;
        data.steps.forEach((s, i) => {
          const x = 0.65 + i * (w + gap);
          text(`step-index-${i}`, String(i + 1).padStart(2, "0"), x, 2.15, w, 0.62, 32, {
            color: accent,
            bold: true
          });
          text(`step-title-${i}`, s.title, x, 3.0, w, 1.1, 25, { bold: true });
          text(`step-body-${i}`, s.body, x, 4.35, w, 1.6, 20, { color: muted });
          if (i < data.steps.length - 1)
            text(`arrow-${i}`, "→", x + w + 0.05, 3.2, 0.27, 0.4, 16, { color: accent });
        });
        break;
      }
      case "timeline": {
        list(data.events, "events", 3, 4).forEach((e, i) => {
          const y = 1.95 + i * 1.12;
          text(`date-${i}`, e.label, 0.65, y, 2.35, 0.6, 24, { bold: true, color: accent });
          text(`event-${i}`, e.title, 3.35, y, 9.1, 0.56, 24, { bold: true });
          text(`detail-${i}`, e.body, 3.35, y + 0.59, 9.1, 0.4, 18, { color: muted });
        });
        break;
      }
      case "chart": {
        const chart = data.chart;
        if (!chart || !["bar", "line"].includes(chart.type)) fail("chart.type must be bar or line");
        list(chart.labels, "chart.labels", 2, 8);
        list(chart.series, "chart.series", 1, 3);
        chart.series.forEach((s) => {
          string(s.name, "series.name");
          if (
            !Array.isArray(s.values) ||
            s.values.length !== chart.labels.length ||
            s.values.some((v) => !Number.isFinite(v))
          )
            fail("Chart values must be finite numbers matching labels");
        });
        string(chart.unit, "chart.unit");
        string(data.source, "chart source");
        const opts = {
          x: 0.65,
          y: 2.0,
          w: 8.2,
          h: 4.35,
          catAxisLabelFontFace: font,
          catAxisLabelFontSize: 16,
          valAxisLabelFontFace: font,
          valAxisLabelFontSize: 14,
          showLegend: chart.series.length > 1,
          legendFontFace: font,
          legendFontSize: 14,
          showTitle: false,
          showValue: true,
          dataLabelPosition: chart.type === "bar" ? "outEnd" : "t",
          dataLabelFormatCode: "0.##",
          dataLabelFontFace: font,
          dataLabelFontSize: 16,
          dataLabelBkgrdColor: dark ? theme.ink : theme.paper,
          dataLabelColor: fg,
          dataLabelFormatCodeSourceLinked: false,
          catAxisLabelColor: fg,
          valAxisLabelColor: fg,
          legendColor: fg,
          valAxisTitleColor: fg,
          chartColors: [accent, muted, "BFA47D"],
          showBorder: false,
          chartArea: { fill: { color: dark ? theme.ink : theme.paper } },
          plotArea: { fill: { color: dark ? theme.ink : theme.paper } },
          catAxisLineShow: false,
          valAxisLineShow: false,
          valGridLine: { color: "E4E9ED", width: 1 },
          showValAxisTitle: true,
          valAxisTitle: chart.unit,
          valAxisTitleFontFace: font,
          valAxisTitleFontSize: 14,
          showMarker: true,
          showLine: true,
          showShadow: false,
          fontFace: font,
          objectName: "native-chart"
        };
        if (chart.type === "bar") Object.assign(opts, { barDir: "col", catAxisLabelRotate: 0 });
        slide.addChart(
          chart.type === "bar" ? pptx.ChartType.bar : pptx.ChartType.line,
          chart.series.map((s) => ({ name: s.name, labels: chart.labels, values: s.values })),
          opts
        );
        elements.push({ id: "native-chart", type: "chart", x: 0.65, y: 2.0, w: 8.2, h: 4.35 });
        shape("takeaway-panel", 9.25, 2.0, 3.43, 4.35);
        text("chart-takeaway", data.takeaway, 9.55, 2.5, 2.83, 3.1, 24, { bold: true, color: accent });
        break;
      }
      case "image": {
        const right = data.imageSide === "right";
        image("illustration", data.image, right ? 5.28 : 0.65, 1.95, 7.4, 4.55, data.fit ?? "contain");
        body(data.items, right ? 0.65 : 8.55, 2.1, 4.1, 3.9, 22);
        break;
      }
      case "gallery": {
        list(data.images, "images", 2, 4);
        const gap = 0.25,
          w = (12.03 - gap * (data.images.length - 1)) / data.images.length;
        data.images.forEach((item, i) => {
          const x = 0.65 + i * (w + gap);
          image(`gallery-${i}`, item.image, x, 1.95, w, 3.0, item.fit ?? "crop");
          text(`gallery-label-${i}`, item.title, x, 5.15, w, 0.9, 24, { bold: true });
          if (item.caption) text(`gallery-caption-${i}`, item.caption, x, 6.1, w, 0.55, 18, { color: muted });
        });
        break;
      }
      case "annotated-image": {
        const box = image("annotated-image", data.image, 0.65, 1.9, 7.5, 4.8, "contain");
        list(data.annotations, "annotations", 1, 4).forEach((a, i) => {
          for (const key of ["x", "y"])
            if (!Number.isFinite(a[key]) || a[key] < 0 || a[key] > 1)
              fail("Annotation coordinates must be within 0–1");
          const size = 0.42,
            x = Math.max(0.65, Math.min(8.15 - size, box.x + a.x * box.w - size / 2)),
            y = Math.max(1.9, Math.min(6.7 - size, box.y + a.y * box.h - size / 2));
          shape(`pin-${i}`, x, y, size, size, accent, "ellipse");
          text(`pin-number-${i}`, String(i + 1), x, y + 0.025, size, 0.32, 16, {
            color: dark ? theme.ink : "FFFFFF",
            bold: true,
            align: "center"
          });
          const rowY = 1.95 + i * 1.16;
          text(`annotation-title-${i}`, `${i + 1}  ${a.title}`, 8.65, rowY, 4.0, 0.65, 22, {
            bold: true,
            color: accent
          });
          text(`annotation-body-${i}`, a.body, 8.65, rowY + 0.68, 4.0, 0.45, 18, { color: muted });
        });
        break;
      }
      case "diagram": {
        const nodes = list(data.nodes, "nodes", 2, 24),
          byId = new Map();
        const region = { x: 0.85, y: 2.0, w: 11.6, h: data.takeaway ? 3.8 : 4.45 };
        for (const n of nodes) {
          string(n.id, "node.id");
          string(n.label, "node.label");
          if (byId.has(n.id)) fail("Duplicate diagram node id: " + n.id);
          if (!["box", "ellipse", undefined].includes(n.kind)) fail("node.kind must be box or ellipse");
          if (
            ![n.x, n.y, n.w, n.h].every(Number.isFinite) ||
            n.x < 0 ||
            n.y < 0 ||
            n.w <= 0 ||
            n.h <= 0 ||
            n.x + n.w > 1.00001 ||
            n.y + n.h > 1.00001
          )
            fail("Diagram nodes require normalized x/y/w/h within 0–1");
          byId.set(n.id, {
            ...n,
            x: region.x + n.x * region.w,
            y: region.y + n.y * region.h,
            w: n.w * region.w,
            h: n.h * region.h
          });
        }
        const port = (n, other, side) => {
          const cx = n.x + n.w / 2,
            cy = n.y + n.h / 2;
          if (side) {
            if (!["left", "right", "top", "bottom"].includes(side)) fail("Unknown node port");
            return side === "left"
              ? [n.x, cy]
              : side === "right"
                ? [n.x + n.w, cy]
                : side === "top"
                  ? [cx, n.y]
                  : [cx, n.y + n.h];
          }
          const dx = other.x + other.w / 2 - cx,
            dy = other.y + other.h / 2 - cy;
          if (dx === 0 && dy === 0) fail("Connected nodes cannot share the same center");
          const t =
            n.kind === "ellipse"
              ? 1 / Math.hypot(dx / (n.w / 2), dy / (n.h / 2))
              : 1 / Math.max(Math.abs(dx) / (n.w / 2), Math.abs(dy) / (n.h / 2));
          return [cx + dx * t, cy + dy * t];
        };
        const labels = [];
        list(data.edges ?? [], "edges", 0, 48).forEach((e, i) => {
          const a = byId.get(e.from),
            b = byId.get(e.to);
          if (!a || !b || a === b) fail("Diagram edges must connect two existing, distinct node IDs");
          const start = port(a, b, e.fromPort),
            end = port(b, a, e.toPort);
          line(`edge-${i}`, ...start, ...end, true);
          if (e.label)
            labels.push({
              id: `edge-label-${i}`,
              text: e.label,
              x: (start[0] + end[0]) / 2 - 0.75,
              y: (start[1] + end[1]) / 2 - 0.45
            });
        });
        for (const n of byId.values()) {
          const fill = n.tone === "accent" ? accent : pale,
            color = n.tone === "accent" ? (dark ? theme.ink : "FFFFFF") : fg;
          shape(`node-${n.id}`, n.x, n.y, n.w, n.h, fill, n.kind === "ellipse" ? "ellipse" : "rect");
          text(`node-label-${n.id}`, n.label, n.x + 0.12, n.y + 0.08, n.w - 0.24, n.h - 0.16, 22, {
            bold: true,
            color,
            align: "center",
            valign: "mid"
          });
        }
        for (const l of labels) text(l.id, l.text, l.x, l.y, 1.5, 0.4, 16, { color: muted, align: "center" });
        if (data.takeaway)
          text("diagram-takeaway", data.takeaway, 0.85, 6.15, 11.6, 0.6, 23, { bold: true, color: accent });
        break;
      }
      case "statement": {
        text("statement", data.statement, 0.85, 2.05, 11.6, 1.5, 36, { bold: true, color: accent });
        if (data.items) body(data.items, 0.85, 4.05, 11.4, 2.1, 24);
        break;
      }
      default:
        fail(`Unknown slide type: ${data.type}`);
    }
    if (data.source)
      text("source", data.source, 0.65, hero ? 6.72 : 6.91, hero ? 4.4 : 11.4, 0.35, 10, { color: muted });
    text("page", String(index + 1), hero ? 0.75 : 12.05, hero ? 7.1 : 6.91, 0.63, 0.26, 11, {
      color: muted,
      align: hero ? "left" : "right"
    });
    if (data.notes) slide.addNotes(data.notes);
    const outOfBounds = elements.filter(
      (e) => e.x < 0 || e.y < 0 || e.x + e.w > W + 0.02 || e.y + e.h > H + 0.02
    );
    if (outOfBounds.length) fail(`Slide ${index + 1} contains out-of-bounds components`);
    manifest.slides.push({ page: index + 1, type: data.type, title: data.title, elements });
  }
  await mkdir(dirname(resolve(output)), { recursive: true });
  await pptx.writeFile({ fileName: output });
  await writeFile(output.replace(/\.pptx$/i, "") + ".layout.json", JSON.stringify(manifest, null, 2) + "\n");
  return { output, slideCount: spec.slides.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help") || process.argv.length < 4) {
    console.log("Usage: build_deck.mjs <deck.json> <deck.pptx>");
    process.exit(process.argv.includes("--help") ? 0 : 2);
  }
  const source = resolve(process.argv[2]);
  console.log(
    JSON.stringify(
      await buildDeck(JSON.parse(await readFile(source, "utf8")), resolve(process.argv[3]), {
        baseDirectory: dirname(source)
      })
    )
  );
}
