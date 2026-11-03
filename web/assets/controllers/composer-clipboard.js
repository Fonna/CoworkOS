const blocks = new Set([
  "ADDRESS",
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
  "SECTION",
  "TR"
]);
const ignored = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** A template's inert contents never enter the document or load clipboard resources. */
export function clipboardHtmlText(html, document) {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  let text = "";
  const newline = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const visit = (node) => {
    if (node.nodeType === 3) {
      text += node.textContent;
      return;
    }
    if (ignored.has(node.tagName)) return;
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    if (blocks.has(node.tagName)) newline();
    for (const child of node.childNodes) visit(child);
    if (blocks.has(node.tagName)) newline();
  };
  visit(template.content);
  return text.trim() ? text.replace(/\n$/, "") : "";
}

/** Prefer editable text over a rich-text source's image representation. */
export function createComposerClipboard({ input, addFiles }) {
  const paste = (event) => {
    if (event.defaultPrevented || event.clipboardData?.getData("text/plain")) return;
    const text = clipboardHtmlText(event.clipboardData?.getData("text/html"), input.ownerDocument);
    if (text) {
      event.preventDefault();
      input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const images = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    void addFiles(images);
  };
  input.addEventListener("paste", paste);
  return { dispose: () => input.removeEventListener("paste", paste) };
}
