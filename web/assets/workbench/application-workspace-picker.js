import { ui } from "../ui/language.js";
import { createModal } from "../ui/modal.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );

/** Choosing a workspace is required before an independent instance exists. */
export function createApplicationWorkspacePicker({ displayName, api, workspaceRoot, workspaces = [] }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop app-dialog-backdrop";
  overlay.hidden = true;
  overlay.innerHTML = ui`<section class="modal-card app-dialog application-workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="application-workspace-title">
    <h2 id="application-workspace-title">新建${esc(displayName)}实例</h2>
    <div class="dialog-field"><label for="app-workspace-select">工作文件夹</label><select id="app-workspace-select" data-app-workspace aria-label="新实例工作区"></select><button type="button" class="app-button is-secondary dialog-browse" data-app-choose-workspace>选择文件夹…</button></div>
    <p class="dialog-error" data-app-workspace-error role="alert"></p>
    <div class="modal-actions dialog-actions"><button type="button" class="app-button is-secondary" data-app-workspace-cancel>取消</button><button type="button" class="app-button is-primary" data-app-workspace-create disabled>创建实例</button></div>
  </section>`;
  document.body.append(overlay);
  const select = overlay.querySelector("[data-app-workspace]");
  const choose = overlay.querySelector("[data-app-choose-workspace]");
  const confirm = overlay.querySelector("[data-app-workspace-create]");
  const error = overlay.querySelector("[data-app-workspace-error]");
  let roots = [...new Set([workspaceRoot, ...workspaces].filter(Boolean))];
  let selected;
  let closed = false;
  let resolve;
  const result = new Promise((finish) => {
    resolve = finish;
  });
  const paint = (value = "") => {
    select.innerHTML =
      ui`<option value="" ${!value ? "selected" : ""}>请选择工作区</option>` +
      roots
        .map(
          (root) =>
            `<option value="${esc(root)}" title="${esc(root)}" ${root === value ? "selected" : ""}>${esc(root)}</option>`
        )
        .join("");
    select.title = value || ui("选择工作区");
    confirm.disabled = !value;
  };
  paint();
  const modal = createModal(overlay, overlay.querySelector("[data-app-workspace-cancel]"), {
    onClose: () => {
      closed = true;
      overlay.remove();
      resolve(selected);
    }
  });
  select.addEventListener("change", () => {
    select.title = select.value || ui("选择工作区");
    confirm.disabled = !select.value;
  });
  confirm.addEventListener("click", () => {
    if (confirm.disabled || !select.value) return;
    selected = select.value;
    modal.close();
  });
  choose.addEventListener("click", async () => {
    choose.disabled = true;
    select.disabled = true;
    confirm.disabled = true;
    error.textContent = "";
    try {
      const local = window.bookmanDesktop ? await window.bookmanDesktop.chooseProject() : undefined;
      if (closed || (window.bookmanDesktop && !local)) return;
      const chosen = await api.chooseWorkspace(local);
      if (closed || chosen.cancelled) return;
      roots = [...new Set([...roots, ...(chosen.workspaces ?? []), chosen.workspaceRoot].filter(Boolean))];
      paint(chosen.workspaceRoot);
    } catch (cause) {
      if (!closed) error.textContent = ui`选择工作区失败：${cause.message}`;
    } finally {
      if (!closed) {
        choose.disabled = false;
        select.disabled = false;
        confirm.disabled = !select.value;
      }
    }
  });
  modal.open();
  return { result, close: modal.close };
}
