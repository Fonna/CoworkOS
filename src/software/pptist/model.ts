import { randomUUID } from "node:crypto";
import { decodeHTML } from "entities";
import sanitizeHtml from "sanitize-html";
import { ApplicationError } from "../../applications/types.js";

export const PPTIST_KIND = "presentation/pptist+json";
export const PPTIST_LIMIT = 32 * 1024 * 1024;
export interface SlideElement extends Record<string, unknown> {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
}
export interface Slide extends Record<string, unknown> {
  id: string;
  elements: SlideElement[];
  remark?: string;
}
export interface Presentation {
  version: 1;
  viewportSize: number;
  viewportRatio: number;
  theme: Record<string, unknown>;
  slides: Slide[];
}
export const defaultTheme = {
  themeColors: ["#5b9bd5", "#ed7d31", "#a5a5a5", "#ffc000", "#4472c4", "#70ad47"],
  fontColor: "#333333",
  fontName: "Arial",
  backgroundColor: "#ffffff",
  shadow: { h: 3, v: 3, blur: 2, color: "#808080" },
  outline: { width: 2, color: "#525252", style: "solid" }
};
export const freshId = () => randomUUID().replaceAll("-", "").slice(0, 16);
export function invalid(message: string): never {
  throw new ApplicationError("invalid_operation", message);
}
export function object(value: unknown, label = "对象"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
export function plainText(value: unknown): string {
  return decodeHTML(
    sanitizeHtml(
      String(value ?? "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li)>/gi, "\n"),
      { allowedTags: [], allowedAttributes: {} }
    )
  );
}
export function richText(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: [
      "p",
      "div",
      "span",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "strike",
      "sub",
      "sup",
      "ul",
      "ol",
      "li",
      "a",
      "blockquote",
      "code"
    ],
    allowedAttributes: { "*": ["style"], a: ["href", "target"] },
    allowedSchemes: ["https", "http", "mailto"],
    allowedStyles: {
      "*": {
        color: [/^[#\w(),.%\s-]+$/],
        "background-color": [/^[#\w(),.%\s-]+$/],
        "font-size": [/^\d+(\.\d+)?(px|pt|em|%)$/],
        "font-family": [/^[\w\s,'"\u4e00-\u9fff-]+$/],
        "font-weight": [/^(normal|bold|[1-9]00)$/],
        "font-style": [/^(normal|italic)$/],
        "text-align": [/^(left|right|center|justify)$/],
        "text-decoration": [/^[a-z -]+$/],
        "line-height": [/^[\d.]+(px|em|%)?$/],
        "text-indent": [/^-?[\d.]+(px|em)$/],
        "list-style-type": [
          /^(disc|circle|square|decimal|lower-roman|upper-roman|lower-alpha|upper-alpha|lower-greek)$/
        ],
        "letter-spacing": [/^-?[\d.]+(px|em)$/],
        "margin-left": [/^[\d.]+px$/],
        "padding-left": [/^[\d.]+px$/]
      }
    }
  });
}
function finite(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
    invalid(`${name}须为 ${min}–${max} 范围内的数字`);
  return n;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,100}$/.test(value)) invalid("幻灯片和元素需要有效且唯一的 id");
  return value;
}
function clean(value: unknown, key = "", depth = 0): unknown {
  if (depth > 30) invalid("演示文稿嵌套过深");
  if (typeof value === "number" && !Number.isFinite(value)) invalid("演示文稿包含无效数字");
  if (typeof value === "string") {
    if (["content", "remark"].includes(key)) return richText(value);
    if (
      ["src", "poster"].includes(key) &&
      value &&
      !/^(https?:\/\/|data:(image|audio|video)\/[a-z0-9.+-]+;base64,)/i.test(value)
    )
      invalid("媒体须使用 HTTP(S) 地址或内嵌 base64 数据");
    if (key === "target" && /^(javascript|data|file|vbscript):/i.test(value.trim()))
      invalid("不支持该链接协议");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => clean(v, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (["__proto__", "constructor", "prototype"].includes(k)) invalid("演示文稿包含无效字段");
        return [k, clean(v, k, depth + 1)];
      })
    );
  }
  return value;
}
export function normalizePresentation(value: unknown): Presentation {
  const raw = object(value, "演示文稿");
  if (Buffer.byteLength(JSON.stringify(raw)) > PPTIST_LIMIT)
    throw new ApplicationError("resource_too_large", "演示文稿超过 32 MiB，请压缩媒体后重试");
  const doc = object(clean(raw));
  if (doc.version !== undefined && doc.version !== 1) invalid("不支持此演示文稿版本");
  const viewportSize = finite(doc.viewportSize ?? doc.width, "页面宽度", 100, 4000, 1000);
  const viewportRatio = finite(
    doc.viewportRatio ?? (typeof doc.height === "number" ? doc.height / viewportSize : undefined),
    "页面比例",
    0.1,
    4,
    0.5625
  );
  const theme = {
    ...structuredClone(defaultTheme),
    ...(doc.theme === undefined ? {} : object(doc.theme, "主题"))
  };
  if (
    !Array.isArray(theme.themeColors) ||
    !theme.themeColors.length ||
    theme.themeColors.some((v) => typeof v !== "string")
  )
    invalid("主题颜色须为非空颜色数组");
  if (!Array.isArray(doc.slides) || !doc.slides.length || doc.slides.length > 200)
    invalid("演示文稿须包含 1–200 页幻灯片");
  const ids = new Set<string>();
  const slides = doc.slides.map((rawSlide) => {
    const slide = object(rawSlide, "幻灯片");
    const id = identifier(slide.id);
    if (ids.has(id)) invalid("幻灯片 id 重复");
    ids.add(id);
    if (!Array.isArray(slide.elements) || slide.elements.length > 500) invalid("每页最多包含 500 个元素");
    const elementIds = new Set<string>();
    const elements = slide.elements.map((rawElement) => {
      const el = object(rawElement, "元素");
      const eid = identifier(el.id);
      if (elementIds.has(eid)) invalid("同一页的元素 id 重复");
      elementIds.add(eid);
      if (
        !["text", "image", "shape", "line", "chart", "table", "latex", "video", "audio"].includes(
          String(el.type)
        )
      )
        invalid("不支持的幻灯片元素类型");
      for (const [key, min, max] of [
        ["left", -100000, 100000],
        ["top", -100000, 100000],
        ["width", 0, 100000],
        ["height", 0, 100000],
        ["rotate", -36000, 36000]
      ] as const) {
        el[key] = finite(
          el[key],
          key,
          min,
          max,
          key === "rotate" || (key === "height" && el.type === "line") ? 0 : undefined
        );
      }
      if (el.type === "text") {
        if (typeof el.content !== "string") invalid("文本元素需要 content");
        if (
          el.inset !== undefined &&
          (!Array.isArray(el.inset) ||
            el.inset.length !== 4 ||
            el.inset.some((v) => typeof v !== "number" || v < 0 || !Number.isFinite(v)))
        )
          invalid("文本 inset 须为四个非负数字（上、右、下、左）");
        el.defaultFontName ??= theme.fontName;
        el.defaultColor ??= theme.fontColor;
      }
      if (["image", "video", "audio"].includes(String(el.type)) && typeof el.src !== "string")
        invalid("媒体元素需要 src");
      if (el.type === "image") el.fixedRatio ??= true;
      if (el.type === "shape") el.fixedRatio ??= false;
      if (
        ["shape", "latex"].includes(String(el.type)) &&
        (typeof el.path !== "string" ||
          !Array.isArray(el.viewBox) ||
          el.viewBox.length !== 2 ||
          el.viewBox.some((v) => typeof v !== "number" || v <= 0))
      )
        invalid("形状和公式需要 path 及有效 viewBox");
      if (el.type === "line") {
        el.points ??= ["", ""];
        if (
          !Array.isArray(el.points) ||
          el.points.length !== 2 ||
          el.points.some((v) => !["", "arrow", "dot"].includes(String(v)))
        )
          invalid("线条端点无效");
        el.style ??= "solid";
        el.color ??= theme.fontColor;
      }
      if (
        el.type === "line" &&
        ![el.start, el.end].every(
          (v) =>
            Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))
        )
      )
        invalid("线条需要 start/end 坐标");
      if (
        el.type === "table" &&
        (!Array.isArray(el.data) ||
          !el.data.length ||
          el.data.length > 100 ||
          el.data.some((r) => !Array.isArray(r) || !r.length || r.length > 50) ||
          !Array.isArray(el.colWidths))
      )
        invalid("表格数据无效");
      if (el.type === "table") {
        el.cellMinHeight ??= 36;
        const rows = el.data as unknown[][];
        if (
          (el.colWidths as unknown[]).length !== rows[0].length ||
          (el.colWidths as unknown[]).some((w) => typeof w !== "number" || w <= 0) ||
          rows.some(
            (r) =>
              r.length !== rows[0].length ||
              r.some(
                (c) => !c || typeof c !== "object" || typeof (c as Record<string, unknown>).text !== "string"
              )
          )
        )
          invalid("表格单元格或列宽无效");
        for (const row of rows)
          for (const value of row) {
            const cell = value as Record<string, unknown>;
            cell.text = richText(cell.text as string);
          }
      }
      if (el.type === "chart") {
        const data = object(el.data, "图表数据");
        if (
          !["bar", "column", "line", "pie", "ring", "area", "radar", "scatter"].includes(String(el.chartType))
        )
          invalid("不支持的图表类型");
        if (
          !Array.isArray(data.labels) ||
          !data.labels.length ||
          data.labels.some((v) => typeof v !== "string") ||
          !Array.isArray(data.series) ||
          !data.series.length ||
          data.series.some(
            (row) =>
              !Array.isArray(row) ||
              row.length !== (data.labels as unknown[]).length ||
              row.some((n) => typeof n !== "number")
          ) ||
          !Array.isArray(data.legends) ||
          data.legends.some((v) => typeof v !== "string")
        )
          invalid("图表需要有效的 labels、series 和 legends");
        el.themeColors ??= theme.themeColors;
        el.textColor ??= theme.fontColor;
        el.options ??= {};
      }
      return el as SlideElement;
    });
    return { ...slide, id, elements } as Slide;
  });
  return { version: 1, viewportSize, viewportRatio, theme, slides };
}
export function emptyPresentation(): Presentation {
  return normalizePresentation({ slides: [{ id: freshId(), elements: [] }] });
}
export function outline(doc: Presentation) {
  return doc.slides.map((s, i) => ({
    id: s.id,
    page: i + 1,
    elements: s.elements.length,
    text: s.elements
      .filter((e) => e.type === "text")
      .map((e) => plainText(e.content))
      .join(" / ")
      .slice(0, 500),
    notes: plainText(s.remark).slice(0, 300)
  }));
}
