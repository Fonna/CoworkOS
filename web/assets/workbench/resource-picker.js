import { ui } from "../ui/language.js";
import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "./html.js";

/** Browse preserved documents without turning the sidebar into an archive. */
export function openResourcePicker({ resources, appLabels, appIcons = {}, onOpen, onClose = () => {} }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop app-dialog-backdrop";
  overlay.hidden = true;
  overlay.innerHTML = ui`<section class="modal-card app-dialog app-file-picker" role="dialog" aria-modal="true" aria-labelledby="app-file-picker-title"><header><h2 id="app-file-picker-title">全部文件</h2><button class="app-button is-icon" type="button" data-picker-close aria-label="关闭文件列表">${icon("close")}</button></header><div class="dialog-field"><input type="search" data-picker-search aria-label="搜索文件" placeholder="搜索文件名或应用" autocomplete="off"></div><div class="app-file-results" data-picker-results></div><p class="app-file-count" data-picker-count role="status"></p></section>`;
  document.body.append(overlay);
  const input = overlay.querySelector("[data-picker-search]"),
    results = overlay.querySelector("[data-picker-results]"),
    count = overlay.querySelector("[data-picker-count]");
  let restoreOnClose = true;
  const modal = createModal(overlay, overlay.querySelector("[data-picker-close]"), {
    onClose() {
      overlay.remove();
      onClose({ restoreFocus: restoreOnClose });
    }
  });
  function paint() {
    const query = input.value.trim().toLocaleLowerCase();
    const matches = resources.filter((entry) =>
      `${entry.title} ${appLabels[entry.appType] || entry.appType}`.toLocaleLowerCase().includes(query)
    );
    results.innerHTML = matches.length
      ? matches
          .map(
            (entry) =>
              `<button type="button" class="app-file-result" data-picker-resource="${esc(entry.resourceId)}" aria-label="${esc(entry.title || ui("未命名文档"))}，${esc(appLabels[entry.appType] || entry.appType)}${entry.alreadyOpen ? ui("，已打开") : ""}">${appIcons[entry.appType] || icon("file")}<span><strong>${esc(entry.title || ui("未命名文档"))}</strong></span>${entry.alreadyOpen ? ui('<small class="app-file-open">已打开</small>') : ""}</button>`
          )
          .join("")
      : ui('<p class="app-file-empty">没有匹配的文件</p>');
    count.hidden = !query;
    count.textContent = query ? ui`${matches.length} 个结果` : "";
  }
  input.addEventListener("input", paint);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      results.querySelector("button")?.focus();
    }
  });
  results.addEventListener("click", (event) => {
    const id = event.target.closest("[data-picker-resource]")?.dataset.pickerResource;
    const entry = resources.find((candidate) => candidate.resourceId === id);
    if (!entry) return;
    modal.close();
    onOpen(entry);
  });
  results.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...results.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) input.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  });
  paint();
  modal.open();
  input.focus();
  return {
    close({ restoreFocus = true } = {}) {
      restoreOnClose = restoreFocus;
      modal.close({ restoreFocus });
    }
  };
}
