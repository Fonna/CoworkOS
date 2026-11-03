import { ui } from "../ui/language.js";
import { sameWorkspace, taskWorkspace, workspaceLabel } from "./workspace-scope.js";
import { createMenu } from "../ui/menu.js";

/** Choose explicitly without hiding the application behind a modal. */
export function chooseConversation({
  anchor,
  title,
  tasks = [],
  projects = [],
  workspaceRoot,
  instanceWorkspaceRoot,
  relatedConversations = [],
  loadedConversations = []
}) {
  return new Promise((resolve) => {
    const panel = document.createElement("div");
    panel.className = "ui-menu collaboration-picker";
    panel.hidden = true;
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", ui("与 AI 协作"));
    const heading = (text) => {
      const label = document.createElement("div");
      label.className = "ui-menu-label";
      label.textContent = text;
      panel.append(label);
    };
    let choice = null;
    let menu;
    const option = (text, attribute, taskId, projectRoot) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "app-button";
      button.setAttribute("role", "menuitem");
      button.setAttribute(attribute, taskId ?? "");
      button.textContent = text;
      button.title = text;
      button.onclick = () => {
        choice = taskId ? { taskId } : { create: true, workspaceRoot: projectRoot };
        menu.close(true);
      };
      panel.append(button);
    };
    heading(title || ui("当前应用"));
    const root = instanceWorkspaceRoot || workspaceRoot;
    const owner = document.createElement("div");
    owner.className = "collaboration-project";
    owner.dataset.collaborationWorkspace = root || "";
    const project = projects.find((entry) => sameWorkspace(entry.workspaceRoot, root));
    owner.textContent = ui`工作区：${project?.projectName || workspaceLabel(root)}`;
    owner.title = root || ui("默认 workspace");
    panel.append(owner);
    const conversations = tasks.filter(
      (task) =>
        task.kind !== "workspace" &&
        task.taskId !== "workspace" &&
        !task.archived &&
        sameWorkspace(taskWorkspace(task), root)
    );
    const relatedIds = new Set([...relatedConversations, ...loadedConversations].map((task) => task.taskId));
    const section = (name, related, attribute) => {
      heading(name);
      const entries = conversations.filter((task) => relatedIds.has(task.taskId) === related);
      for (const task of entries) option(task.goal || task.taskId, attribute, task.taskId);
      if (!entries.length) heading(related ? ui("暂无关联过的会话") : ui("暂无其他会话"));
    };
    section(ui("已关联过的会话"), true, "data-collaboration-loaded-task");
    section(ui("关联其他已有会话"), false, "data-collaboration-existing");
    heading(ui("新建会话"));
    option(ui("＋ 在此工作区新建会话"), "data-collaboration-new", undefined, root);
    document.body.append(panel);
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 16);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const down = below >= Math.min(panel.scrollHeight, 360) || below >= above;
      panel.style.maxHeight = `${Math.max(80, Math.min(400, down ? below : above))}px`;
      panel.style.top = down ? `${rect.bottom + 6}px` : "auto";
      panel.style.bottom = down ? "auto" : `${window.innerHeight - rect.top + 6}px`;
    };
    menu = createMenu(anchor, panel, {
      onOpen: place,
      onClose() {
        menu.dispose();
        window.removeEventListener("resize", place);
        panel.remove();
        resolve(choice);
      }
    });
    anchor.setAttribute("aria-haspopup", "menu");
    window.addEventListener("resize", place);
    menu.open();
  });
}
