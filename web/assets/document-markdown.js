import { marked, DOMPurify } from "./markdown/generated/dependencies.js";
import { protectMath } from "./math.js";

/** Document previews support GFM and inert embedded HTML; chat uses its own renderer. */
export function renderDocumentMarkdown(source) {
  const math = protectMath(String(source ?? "").replaceAll("\u0000", ""));
  const prefix = `math-${crypto.randomUUID()}-`;
  // HTML parsing removes NUL characters; use private text placeholders instead.
  // eslint-disable-next-line no-control-regex
  const protectedSource = math.source.replace(/\u0000math(\d+)\u0000/g, `${prefix}$1-end`);
  const html = marked.parse(protectedSource, { gfm: true, breaks: false, async: false });
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "input", "textarea", "select"],
    FORBID_ATTR: ["style", "id", "name"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true
  });
  // Restore trusted KaTeX only in text nodes, never in user-supplied attributes.
  const container = document.createElement("div");
  container.append(clean);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const token = new RegExp(`${prefix}(\\d+)-end`, "g");
  for (const node of nodes) {
    const text = node.textContent;
    if (!text.includes(prefix)) continue;
    const replacement = document.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(token)) {
      replacement.append(document.createTextNode(text.slice(offset, match.index)));
      const template = document.createElement("template");
      template.innerHTML = math.fragments[Number(match[1])] || "";
      replacement.append(template.content);
      offset = match.index + match[0].length;
    }
    replacement.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(replacement);
  }
  return container.innerHTML;
}
