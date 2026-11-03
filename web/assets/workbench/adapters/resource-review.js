import { createModal } from "../../ui/modal.js";
import { escapeHtml as esc } from "../html.js";

const MAX_PREVIEW = 100_000;
function changedLines(before, after) {
  const old = before.split("\n"),
    next = after.split("\n");
  let head = 0,
    tail = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  while (tail < old.length - head && tail < next.length - head && old.at(-tail - 1) === next.at(-tail - 1))
    tail++;
  return { head, removed: old.length - head - tail, added: next.length - head - tail };
}
/** Read-only comparison. Existing undo always remains an explicit versioned edit. */
export async function openResourceReview({ api, taskId, resourceId, onUndo, canUndo = () => true }) {
  const review = await api.reviewResource(taskId, resourceId);
  const panel = document.createElement("div");
  panel.className = "modal-backdrop app-dialog-backdrop";
  panel.hidden = true;
  const changes = review.available ? changedLines(review.before, review.after) : null;
  panel.innerHTML = `<section class="modal-card app-dialog resource-review" role="dialog" aria-modal="true" aria-labelledby="resource-review-title"><h2 id="resource-review-title">修改对比 · r${esc(review.revision)}</h2>${review.summary || review.reason ? `<p class="dialog-description">${esc(review.summary || review.reason)}</p>` : ""}${changes ? `<p class="review-summary dialog-help">从第 ${changes.head + 1} 行开始 · 删除 ${changes.removed} 行 · 新增 ${changes.added} 行</p><div class="review-columns"><section><h3>修改前 · r${esc(review.baseRevision)}</h3><pre data-review-before></pre></section><section><h3>修改后 · r${esc(review.revision)}</h3><pre data-review-after></pre></section></div>` : ""}<p class="dialog-error" data-review-error role="alert"></p><div class="modal-actions dialog-actions"><button class="app-button is-secondary" type="button" data-review-close>关闭</button>${review.available && onUndo ? '<button class="app-button is-primary" type="button" data-review-undo>撤销这次修改</button>' : ""}</div></section>`;
  if (review.available) {
    panel.querySelector("[data-review-before]").textContent = review.before.slice(0, MAX_PREVIEW);
    panel.querySelector("[data-review-after]").textContent = review.after.slice(0, MAX_PREVIEW);
    if (review.before.length > MAX_PREVIEW || review.after.length > MAX_PREVIEW)
      panel.querySelector(".review-summary").append(" · 内容预览限前 100,000 字符，原文件保持完整");
  }
  document.body.append(panel);
  const dialog = createModal(panel, panel.querySelector("[data-review-close]"));
  panel.querySelector("[data-review-undo]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (!canUndo()) throw new Error("请先保存或放弃编辑器中的草稿，再撤销");
      const current = await api.readResource(taskId, resourceId, { limit: 1 });
      if (current.resource.revision !== review.revision) throw new Error("文档已更新，请关闭后重新查看对比");
      await api.undo(taskId, resourceId, undefined, {
        baseRevision: review.revision,
        eventId: review.eventId
      });
      await onUndo(review.revision);
      dialog.close();
      panel.remove();
    } catch (error) {
      panel.querySelector("[data-review-error]").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  dialog.open();
}
