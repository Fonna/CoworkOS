import { ui } from "../ui/language.js";
import { conversationMarkdown, conversationUrl, safeFilename } from "../conversation-actions.js";

/** Menu operations retain the chosen conversation even when navigation changes. */
export function createConversationOperations({
  api,
  readState,
  onReadChange,
  titleFor,
  rename,
  update,
  remove,
  stop,
  showToast,
  confirmDelete = (task) => window.confirm(ui`确定删除“${titleFor(task)}”吗？删除后无法恢复。`),
  clipboard = navigator.clipboard,
  open = (url) => window.open(url, "_blank", "noopener,noreferrer"),
  baseUrl = () => location.href,
  download = (text, filename) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}) {
  return async (action, taskId, task) => {
    if (!task || task.taskId !== taskId) return;
    try {
      if (action === "rename") return rename(task);
      if (action === "stop") return await stop(taskId);
      if (action === "delete") {
        if (!confirmDelete(task)) return;
        await remove(taskId);
        showToast(ui("会话已删除"));
        return;
      }
      if (action === "pin" || action === "archive")
        return await update(
          action === "pin" ? { pinned: !task.pinned } : { archived: !task.archived },
          taskId
        );
      if (action === "unread") {
        const unread = !readState.isUnread(taskId);
        readState.setUnread(taskId, unread);
        onReadChange();
        showToast(unread ? ui("已标记为未读") : ui("已标记为已读"));
        return;
      }
      if (action === "open") {
        open(conversationUrl(baseUrl(), taskId));
        return;
      }
      const title = titleFor(task);
      let text, message;
      if (action === "copy") {
        text = taskId;
        message = ui("会话 ID 已复制");
      } else if (action === "copy-title") {
        text = title;
        message = ui("会话标题已复制");
      } else if (action === "copy-link") {
        text = conversationUrl(baseUrl(), taskId);
        message = ui("会话链接已复制");
      } else if (action === "copy-content" || action === "export") {
        const detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
        text = conversationMarkdown(detail, { title });
        if (action === "export") {
          download(text, safeFilename(title));
          showToast(ui("对话已导出为 Markdown"));
          return;
        }
        message = ui("对话内容已复制");
      } else return;
      if (!clipboard?.writeText) throw new Error(ui("复制失败，请检查浏览器的剪贴板权限"));
      try {
        await clipboard.writeText(text);
      } catch {
        throw new Error(ui("复制失败，请检查浏览器的剪贴板权限"));
      }
      showToast(message);
    } catch (error) {
      showToast(error.message || ui("操作未完成，请重试"));
    }
  };
}
