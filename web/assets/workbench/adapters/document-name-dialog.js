import { ui } from "../../ui/language.js";
import { escapeHtml as esc } from "../html.js";
import { focusedControl } from "../../ui/focus.js";

// Embedded browsers can disable window.prompt. Keep naming in the document
// so creating and renaming work in the desktop shell as well as a browser.
export function nameDocument(host, { title, value, submitLabel, onSubmit }) {
  host.querySelector("[data-name-dialog]")?.remove();
  const previousFocus = focusedControl();
  const overlay = document.createElement("div");
  overlay.className = "editor-name-overlay";
  overlay.dataset.nameDialog = "";
  overlay.innerHTML = ui`<form class="editor-name-form app-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
    <h2>${esc(title)}</h2>
    <label class="dialog-field">文件名<input data-document-name aria-label="文件名" value="${esc(value)}" autocomplete="off"></label>
    <p class="dialog-error" data-name-error role="alert"></p>
    <div class="editor-name-actions dialog-actions"><button class="app-button is-secondary" type="button" data-name-cancel>取消</button><button class="app-button is-primary" type="submit" data-name-submit>${esc(submitLabel)}</button></div>
  </form>`;
  host.appendChild(overlay);
  const form = overlay.querySelector("form");
  const input = overlay.querySelector("[data-document-name]");
  const submit = overlay.querySelector("[data-name-submit]");
  const cancel = overlay.querySelector("[data-name-cancel]");
  let busy = false;
  const close = () => {
    overlay.remove();
    previousFocus?.focus?.();
  };
  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !busy) close();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === "Tab") {
      const options = [...form.querySelectorAll("input:not(:disabled), button:not(:disabled)")];
      const first = options[0] || form,
        last = options.at(-1) || form;
      if (!options.includes(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const name = input.value.trim();
    const error = overlay.querySelector("[data-name-error]");
    if (!name) {
      error.textContent = ui("文件名不能为空");
      input.focus();
      return;
    }
    busy = true;
    submit.disabled = cancel.disabled = input.disabled = true;
    form.setAttribute("aria-busy", "true");
    form.focus({ preventScroll: true });
    error.textContent = "";
    try {
      await onSubmit(name);
      close();
    } catch (cause) {
      error.textContent = cause.message;
    } finally {
      busy = false;
      submit.disabled = cancel.disabled = input.disabled = false;
      form.removeAttribute("aria-busy");
      if (overlay.isConnected && document.activeElement === form) input.focus({ preventScroll: true });
    }
  });
  input.focus();
  input.select?.();
}

export function documentKind(title, fallback = "text/markdown") {
  if (/\.txt$/i.test(title)) return "text/plain";
  if (/\.(md|markdown)$/i.test(title)) return "text/markdown";
  return fallback;
}
