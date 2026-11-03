import { parseDocument } from "htmlparser2";
import pptxgen from "pptxgenjs";
import { type Presentation, object, plainText, invalid } from "./model.js";

type PptxSlide = ReturnType<InstanceType<typeof pptxgen.default>["addSlide"]>;
type TextOptions = NonNullable<Parameters<PptxSlide["addText"]>[1]>;
type TextRun = { text: string; options?: TextOptions };
type AnyNode = ReturnType<typeof parseDocument>["children"][number];

const color = (value: unknown, fallback = "333333") => {
  const text = String(value ?? "").replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(text)) return text;
  if (/^[0-9a-f]{3}$/i.test(text)) return [...text].map((c) => c + c).join("");
  const rgb = /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i.exec(text);
  return rgb
    ? rgb
        .slice(1)
        .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
        .join("")
    : fallback;
};
const xml = (value: unknown) =>
  String(value ?? "").replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!
  );
/** CSS may quote a family or list fallbacks; Office expects one XML-safe name. */
function fontFace(value: unknown): string {
  const family = String(value ?? "").trim();
  const first = /^(["'])(.*?)\1\s*(?:,|$)/.exec(family)?.[2] ?? family.split(",")[0];
  return xml(first.trim() || "Arial");
}
function imageData(value: unknown): string {
  if (typeof value !== "string" || !/^data:image\/(png|jpeg|jpg|gif|svg\+xml|webp);base64,/i.test(value))
    invalid("服务端 PPTX 导出需要内嵌图片；请在编辑器中上传图片，或使用编辑器的导出功能处理远程图片");
  return value;
}
/** Keep mixed runs editable, including per-span fonts, emphasis and links. */
function textRuns(html: string, inch: number): TextRun[] {
  const runs: TextRun[] = [];
  function walk(node: AnyNode, inherited: TextOptions = {}) {
    if (node.type === "text") {
      if (node.data) runs.push({ text: node.data, options: { ...inherited } });
      return;
    }
    if (!("children" in node)) return;
    const options = { ...inherited };
    if ("name" in node) {
      const tag = node.name;
      if (["strong", "b"].includes(tag)) options.bold = true;
      if (["em", "i"].includes(tag)) options.italic = true;
      if (tag === "u") options.underline = { style: "sng" };
      if (["s", "strike"].includes(tag)) options.strike = true;
      if (tag === "sub") options.subscript = true;
      if (tag === "sup") options.superscript = true;
      if (tag === "br") {
        runs.push({ text: "", options: { ...options, breakLine: true } });
        return;
      }
      if (tag === "a" && /^https?:\/\//i.test(node.attribs.href || ""))
        options.hyperlink = { url: node.attribs.href };
      for (const declaration of (node.attribs.style || "").split(";")) {
        const at = declaration.indexOf(":"),
          key = declaration.slice(0, at).trim(),
          value = declaration.slice(at + 1).trim();
        if (key === "font-size" && /^\d+(\.\d+)?(px|pt)$/.test(value))
          options.fontSize = parseFloat(value) * (value.endsWith("px") ? inch * 72 : 1);
        if (key === "font-family") options.fontFace = fontFace(value);
        if (key === "color") options.color = color(value);
        if (key === "font-weight") options.bold = value === "bold" || Number(value) >= 600;
        if (key === "font-style") options.italic = value === "italic";
        if (key === "text-align" && ["left", "right", "center", "justify"].includes(value))
          options.align = value as "left";
      }
      for (const child of node.children) walk(child, options);
      if (["p", "div", "li"].includes(tag) && runs.length)
        runs[runs.length - 1].options = { ...runs[runs.length - 1].options, breakLine: true };
    } else for (const child of node.children) walk(child, options);
  }
  walk(parseDocument(html));
  if (runs.length) runs[runs.length - 1].options = { ...runs[runs.length - 1].options, breakLine: false };
  return runs.length ? runs : [{ text: "" }];
}
/** Produces editable Office text, charts and tables without making network requests. */
export async function exportPptx(
  doc: Presentation,
  title: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const Constructor = pptxgen as unknown as typeof pptxgen.default;
  const deck = new Constructor();
  deck.defineLayout({ name: "PPTIST", width: 10, height: 10 * doc.viewportRatio });
  deck.layout = "PPTIST";
  deck.title = title;
  deck.author = "CoworkOS";
  const inch = 10 / doc.viewportSize;
  for (const source of doc.slides) {
    if (signal?.aborted) throw signal.reason;
    const slide = deck.addSlide();
    const bg = source.background ? object(source.background) : {};
    slide.background = { color: color(bg.color ?? doc.theme.backgroundColor, "FFFFFF") };
    if (bg.type === "image")
      slide.addImage({ data: imageData(object(bg.image).src), x: 0, y: 0, w: 10, h: 10 * doc.viewportRatio });
    if (source.remark) slide.addNotes(plainText(source.remark));
    for (const el of source.elements) {
      const box = {
        x: el.left * inch,
        y: el.top * inch,
        w: Math.max(0.001, el.width * inch),
        h: Math.max(0.001, el.height * inch),
        rotate: ((el.rotate % 360) + 360) % 360
      };
      if (el.type === "text") {
        const inset = (el.inset as number[] | undefined) ?? [10, 10, 10, 10];
        slide.addText(textRuns(String(el.content), inch), {
          ...box,
          fontFace: fontFace(el.defaultFontName || doc.theme.fontName || "Arial"),
          fontSize: 24 * inch * 72,
          color: color(el.defaultColor),
          margin: [inset[3], inset[1], inset[2], inset[0]].map((n) => n * inch * 72) as [
            number,
            number,
            number,
            number
          ],
          valign: String(el.vAlign || "top") as "top",
          transparency: el.opacity === undefined ? 0 : (1 - Number(el.opacity)) * 100,
          ...(el.fill ? { fill: { color: color(el.fill) } } : {})
        });
      } else if (el.type === "image") {
        slide.addImage({ ...box, data: imageData(el.src), flipH: !!el.flipH, flipV: !!el.flipV });
      } else if (el.type === "shape" || el.type === "latex") {
        const [w, h] = el.viewBox as number[];
        const outline = el.outline ? object(el.outline) : {};
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${el.width}" height="${el.height}" viewBox="0 0 ${w} ${h}"><path d="${xml(el.path)}" fill="${xml(el.fill || el.color || "transparent")}" stroke="${xml(outline.color || "none")}" stroke-width="${Number(outline.width || 0)}"/></svg>`;
        slide.addImage({ ...box, data: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` });
        if (el.text) {
          const text = object(el.text);
          slide.addText(textRuns(String(text.content || ""), inch), {
            ...box,
            fontSize: 18,
            color: color(text.defaultColor),
            align: "center",
            valign: "middle",
            margin: 0
          });
        }
      } else if (el.type === "line") {
        const start = el.start as number[],
          end = el.end as number[];
        slide.addShape(deck.ShapeType.line, {
          x: (el.left + Math.min(start[0], end[0])) * inch,
          y: (el.top + Math.min(start[1], end[1])) * inch,
          w: Math.abs(end[0] - start[0]) * inch,
          h: Math.abs(end[1] - start[1]) * inch,
          flipV: (end[0] - start[0]) * (end[1] - start[1]) < 0,
          line: { color: color(el.color), width: Number(el.width || 2) * inch * 72 }
        });
      } else if (el.type === "table") {
        const rows = el.data as Array<Array<Record<string, unknown>>>;
        const theme = el.theme ? object(el.theme) : undefined;
        const outline = el.outline ? object(el.outline) : {};
        const covered = new Set<string>();
        const tableRows = rows
          .map((row, r) =>
            row.flatMap((cell, c) => {
              if (covered.has(`${r}:${c}`)) return [];
              const colspan = Number(cell.colspan || 1),
                rowspan = Number(cell.rowspan || 1);
              for (let y = r; y < r + rowspan; y++)
                for (let x = c; x < c + colspan; x++) if (y !== r || x !== c) covered.add(`${y}:${x}`);
              const style = cell.style ? object(cell.style) : {};
              const header =
                theme &&
                ((theme.rowHeader && r === 0) ||
                  (theme.rowFooter && r === rows.length - 1) ||
                  (theme.colHeader && c === 0) ||
                  (theme.colFooter && c === row.length - 1));
              const background = style.backcolor || theme?.color;
              const size = String(style.fontsize || "14px");
              return [
                {
                  text: textRuns(String(cell.text), inch),
                  options: {
                    colspan,
                    rowspan,
                    bold: !!style.bold,
                    italic: !!style.em,
                    strike: !!style.strikethrough,
                    underline: { style: style.underline ? ("sng" as const) : ("none" as const) },
                    fontFace: fontFace(style.fontname || doc.theme.fontName || "Arial"),
                    fontSize: parseFloat(size) * (size.endsWith("pt") ? 1 : inch * 72),
                    color: color(style.color, "000000"),
                    align: String(style.align || "left") as "left",
                    valign: String(style.vAlign || "top") as "top",
                    ...(background
                      ? {
                          fill: {
                            color: color(background),
                            transparency: !style.backcolor && theme && !header ? (r % 2 ? 70 : 90) : 0
                          }
                        }
                      : {})
                  }
                }
              ];
            })
          )
          .filter((row) => row.length);
        slide.addTable(tableRows, {
          ...box,
          border: {
            type: outline.style === "solid" ? "solid" : "dash",
            pt: Number(outline.width ?? 1) * inch * 72,
            color: color(outline.color, "CCCCCC")
          },
          colW: (el.colWidths as number[]).map((w) => w * box.w),
          rowH: rows.map(
            (_, i) =>
              Math.max(
                Number((el.rowHeights as number[] | undefined)?.[i] || el.cellMinHeight || 36),
                Number(el.cellMinHeight || 36)
              ) * inch
          ),
          margin: 2 * inch * 72,
          autoPage: false
        });
      } else if (el.type === "chart") {
        const data = object(el.data);
        const options = el.options ? object(el.options) : {};
        const textColor = color(el.textColor ?? doc.theme.fontColor);
        const circular = el.chartType === "pie" || el.chartType === "ring";
        const chartType = (
          {
            bar: deck.ChartType.bar,
            column: deck.ChartType.bar,
            ring: deck.ChartType.doughnut,
            line: deck.ChartType.line,
            pie: deck.ChartType.pie,
            doughnut: deck.ChartType.doughnut,
            area: deck.ChartType.area,
            radar: deck.ChartType.radar,
            scatter: deck.ChartType.scatter
          } as const
        )[String(el.chartType) as "bar"];
        if (!chartType) invalid(`服务端暂不支持导出 ${el.chartType} 图表，请使用编辑器导出`);
        slide.addChart(
          chartType,
          (data.series as number[][]).map((values, i) => ({
            name: String((data.legends as string[])[i] ?? `系列 ${i + 1}`),
            labels: (data.labels as string[]).map(String),
            values
          })),
          {
            ...box,
            showLegend:
              typeof options.showLegend === "boolean"
                ? options.showLegend
                : circular || ((data.series as unknown[]).length > 1 && el.chartType !== "scatter"),
            legendPos: "b",
            legendColor: textColor,
            legendFontSize: 14 * inch * 72,
            catAxisLabelColor: textColor,
            valAxisLabelColor: textColor,
            catAxisLabelFontSize: 14 * inch * 72,
            valAxisLabelFontSize: 14 * inch * 72,
            dataLabelColor: textColor,
            dataLabelFormatCode: "0.##",
            dataLabelPosition: circular ? "bestFit" : "ctr",
            ...(options.stack ? { barGrouping: "stacked" as const } : {}),
            ...(options.lineSmooth ? { lineSmooth: true } : {}),
            showTitle: false,
            barDir: el.chartType === "column" ? "bar" : "col",
            chartColors: ((el.themeColors as string[]) || (doc.theme.themeColors as string[])).map((c) =>
              color(c)
            ),
            showValue:
              typeof options.showLabel === "boolean"
                ? options.showLabel
                : ["bar", "column", "line", "area", "pie", "ring"].includes(String(el.chartType))
          }
        );
      } else if (el.type === "audio" || el.type === "video") {
        const src = String(el.src);
        if (!src.startsWith("data:")) invalid("服务端媒体导出需要内嵌音视频，请使用编辑器导出远程媒体");
        slide.addMedia({
          ...box,
          type: el.type,
          data: src,
          extn: String(el.ext || (el.type === "video" ? "mp4" : "mp3"))
        });
      }
    }
  }
  const bytes = await deck.write({ outputType: "nodebuffer" });
  if (signal?.aborted) throw signal.reason;
  return new Uint8Array(bytes as Buffer);
}
