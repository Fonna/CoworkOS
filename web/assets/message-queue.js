import { ui } from "./ui/language.js";
import { escapeHtml as esc } from "./workbench/html.js";
import { reconcileMarkup } from "./ui/reconcile.js";
import { splitUploadedFiles } from "./uploaded-files.js";

/** Pending input stays beside the composer until it is delivered or promoted. */
export function renderMessageQueue(
  host,
  { taskId, messages, running, promoting, promote, cancel, disabled = false }
) {
  const pending = [
    ...new Map(
      messages
        .filter((message) => message.id && message.delivery === "followUp" && message.pending)
        .map((message) => [message.id, message])
    ).values()
  ];
  host.hidden = !pending.length;
  reconcileMarkup(
    host,
    pending.length
      ? ui`<div class="queued-heading">排队中 <span>${pending.length}</span><small>${running ? ui("当前任务结束后发送") : ui("等待发送")}</small></div>${pending
          .map((message) => {
            const text =
              typeof message.content === "string"
                ? message.content
                : (message.content || []).map((part) => part.text || "").join("");
            const preview =
              splitUploadedFiles(text).text.split("\n\nAttached files:")[0].trim() || ui("附件消息");
            const busy = promoting.has(`${taskId}:${message.id}`);
            return ui`<div class="queued-message"><span class="queued-message-text" title="${esc(preview.slice(0, 500))}">${esc(preview)}</span><button type="button" data-promote-message="${esc(message.id)}" ${disabled || busy ? "disabled" : ""} aria-label="立即发送：${esc(preview.slice(0, 60))}" title="${running ? ui("插入下一轮模型调用") : ui("启动新一轮对话")}"><svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6" /></svg><span>${busy ? ui("处理中…") : ui("立即发送")}</span></button><button type="button" data-cancel-message="${esc(message.id)}" ${disabled || busy ? "disabled" : ""} aria-label="取消排队：${esc(preview.slice(0, 60))}" title="从队列中移除">取消</button></div>`;
          })
          .join("")}`
      : ""
  );
  host.querySelectorAll("[data-cancel-message]").forEach((button) => {
    button.onclick = () => cancel(taskId, button.dataset.cancelMessage);
  });
  host.querySelectorAll("[data-promote-message]").forEach((button) => {
    button.onclick = () => promote(taskId, button.dataset.promoteMessage);
  });
}
