/** Compare storage ownership, never a conversation's display/project directory. */
export const taskWorkspace = (task) => task?.storageRoot || task?.workspaceRoot;
const normalizedRoot = (root) => (root ? String(root).replace(/[\\/]+$/, "") || "/" : "");
export const sameWorkspace = (left, right) => normalizedRoot(left) === normalizedRoot(right);
/** Persisted ownership wins over whichever project currently reuses the physical root. */
export const applicationProjectLabel = (entry, projects = []) => {
  if (entry?.project !== undefined) {
    if (!entry.project)
      return entry.accessTaskId?.startsWith("temporary-")
        ? entry.appType === "pptist"
          ? "临时工作区 · 草稿自动保留"
          : "临时工作区 · 自动保存"
        : "无项目归属";
    const project = projects.find((project) => project.projectId === entry.project.projectId);
    return `项目：${project?.projectName || entry.project.projectName}`;
  }
  const project = entry?.projectId
    ? projects.find((project) => project.projectId === entry.projectId)
    : projects.find(
        (project) => project.projectDirectory && sameWorkspace(project.projectDirectory, entry?.workspaceRoot)
      );
  return project ? `项目：${project.projectName}` : "无项目归属";
};
export const workspaceLabel = (root) =>
  String(root || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || "默认 workspace";
