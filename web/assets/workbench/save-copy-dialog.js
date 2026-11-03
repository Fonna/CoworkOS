import { ui } from "../ui/language.js";
import { createModal } from "../ui/modal.js";
import { escapeHtml as esc } from "./html.js";

/** A chosen export never replaces the managed resource, its revisions or chat references. */
export async function openSaveCopyDialog({
  api,
  taskId,
  resourceId,
  appType,
  flush,
  onSaved,
  isCurrent = () => true
}) {
  if ((flush && (await flush()) === false) || !isCurrent()) return;
  const [{ resource }, { projects = [] }, { applications }] = await Promise.all([
    api.readResource(taskId, resourceId),
    api.listProjects(),
    api.listApplications()
  ]);
  if (!isCurrent()) return;
  const application = applications.find((entry) => entry.appType === appType);
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop app-dialog-backdrop";
  overlay.hidden = true;
  overlay.innerHTML = ui`<section class="modal-card app-dialog save-copy-dialog" role="dialog" aria-modal="true" aria-label="保存到目录或项目"><h2>保存副本</h2><form><label class="dialog-field">保存位置<select data-save-project><option value="">文件夹</option>${projects.map((project) => `<option value="${esc(project.projectId)}">${esc(project.projectName)}</option>`).join("")}</select></label><div class="dialog-field" data-save-directory-label><label for="save-copy-directory">文件夹</label><div class="dialog-input-action"><input id="save-copy-directory" data-save-directory placeholder="已有文件夹的绝对路径"><button class="app-button is-secondary" type="button" data-save-choose aria-label="选择文件夹">选择…</button></div></div><label class="dialog-field">格式<select data-save-format>${(application?.exportFormats ?? []).map((format) => `<option>${esc(format)}</option>`).join("")}</select></label><p class="dialog-error" role="alert" data-save-error></p><div class="modal-actions dialog-actions"><button class="app-button is-secondary" type="button" data-save-cancel>取消</button><button class="app-button is-primary" type="submit">保存</button></div></form></section>`;
  document.body.append(overlay);
  let closed = false;
  const modal = createModal(overlay, overlay.querySelector("[data-save-cancel]"), {
    onClose: () => {
      closed = true;
      overlay.remove();
    }
  });
  const project = overlay.querySelector("[data-save-project]");
  const directory = overlay.querySelector("[data-save-directory]");
  project.onchange = () => {
    overlay.querySelector("[data-save-directory-label]").hidden = !!project.value;
  };
  overlay.querySelector("[data-save-choose]").onclick = async () => {
    try {
      const selected = window.bookmanDesktop ? await window.bookmanDesktop.chooseProject() : undefined;
      if (window.bookmanDesktop && !selected) return;
      if (closed) return;
      if (selected) directory.value = selected;
      else overlay.querySelector("[data-save-error]").textContent = ui("请输入已有文件夹的绝对路径。");
    } catch (error) {
      if (!closed) overlay.querySelector("[data-save-error]").textContent = error.message;
    }
  };
  overlay.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    const button = overlay.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const saved = await api.saveCopy(taskId, resourceId, {
        revision: resource.revision,
        format: overlay.querySelector("[data-save-format]").value,
        ...(project.value ? { projectId: project.value } : { directory: directory.value })
      });
      if (!closed) {
        modal.close();
        await onSaved?.(saved);
      }
    } catch (error) {
      if (!closed)
        overlay.querySelector("[data-save-error]").textContent =
          ui`保存失败，当前文档已保留：${error.message}`;
    } finally {
      if (!closed) button.disabled = false;
    }
  };
  modal.open();
}
