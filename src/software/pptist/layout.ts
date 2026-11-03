import { plainText, type Presentation } from "./model.js";

/** Conservative structural checks, not a substitute for rendered inspection. */
export function layoutWarnings(doc: Presentation, slideId?: string) {
  const warnings: Array<{ slideId: string; elementId: string; code: string; message: string }> = [];
  for (const slide of doc.slides) {
    if (slideId && slide.id !== slideId) continue;
    for (const el of slide.elements) {
      const warn = (code: string, message: string) =>
        warnings.push({ slideId: slide.id, elementId: el.id, code, message });
      if (
        el.type !== "line" &&
        (el.left < 0 ||
          el.top < 0 ||
          el.left + el.width > doc.viewportSize ||
          el.top + el.height > doc.viewportSize * doc.viewportRatio)
      )
        warn("outside_slide", "元素超出页面边界，请调整位置或尺寸。");
      if (el.type !== "text" || !el.fixedHeight || el.vertical) continue;
      const html = String(el.content);
      const text = plainText(html).trim();
      if (!text) continue;
      const sizes = [...html.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)(px|pt)/gi)].map(
        (m) => Number(m[1]) * (m[2].toLowerCase() === "pt" ? 4 / 3 : 1)
      );
      const fontSize = sizes.length ? Math.max(...sizes) : 16;
      const inset = (el.inset as number[] | undefined) || [10, 10, 10, 10];
      const lineHeight = typeof el.lineHeight === "number" ? el.lineHeight : 1.5;
      if (el.height - inset[0] - inset[2] < fontSize * lineHeight)
        warn(
          "text_height",
          `固定文本框扣除内边距后不足一行高度（约 ${Math.ceil(fontSize * lineHeight)}px）；请加高或明确设置 inset。`
        );
      if (/^\d+\s*\/\s*\d+$/.test(text)) {
        const estimatedWidth = [...text].reduce((sum, c) => sum + (/\d/.test(c) ? 0.62 : 0.35) * fontSize, 0);
        if (el.width - inset[1] - inset[3] < estimatedWidth)
          warn(
            "page_number_wrap",
            `页码可用宽度不足，可能换行；建议宽度至少 ${Math.ceil(estimatedWidth + inset[1] + inset[3])}px，或使用 inset: [0,0,0,0]。`
          );
      }
    }
  }
  return warnings;
}
