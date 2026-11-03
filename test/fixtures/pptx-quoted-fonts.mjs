import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";

/** Reproduce old CSS-font exports without retaining any user's presentation. */
export async function quotedFontTablePptx({ legacy = false } = {}) {
  const deck = new PptxGenJS();
  const slide = deck.addSlide();
  slide.addText("Quoted font table", { x: 0.5, y: 0.2, w: 8, h: 0.5, fontFace: "PingFang SC" });
  slide.addTable(
    Array.from({ length: 5 }, (_, row) =>
      Array.from({ length: 3 }, (_, column) => ({
        text: `Cell ${row + 1}:${column + 1}`,
        options: { bold: row === 0, color: "FFFFFF", fill: { color: "17365A" } }
      }))
    ),
    {
      x: 0.5,
      y: 1,
      w: 9,
      h: 3,
      colW: [1.98, 3.15, 3.87],
      fontFace: "PingFang SC",
      fontSize: 16,
      align: "left",
      valign: "middle",
      margin: 2,
      border: { type: "solid", pt: 0.8, color: "DCE5EF" }
    }
  );
  const body = await deck.write({ outputType: "nodebuffer" });
  if (!legacy) return body;
  const zip = await JSZip.loadAsync(body);
  for (const file of Object.values(zip.files)) {
    if (!file.name.endsWith(".xml")) continue;
    const text = await file.async("string");
    zip.file(file.name, text.replaceAll('typeface="PingFang SC"', 'typeface=""PingFang SC""'));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}
