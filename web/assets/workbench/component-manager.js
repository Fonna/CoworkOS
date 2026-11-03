import { mountComponentAuth } from "./component-auth.js";
const names = { cadquery: "CAD 精确内核", blender: "Blender", pptist: "PPT 编辑器" };
const phases = {
  missing: "未安装",
  ready: "可用",
  disabled: "已停用",
  checking: "检查中",
  downloading: "下载中",
  installing: "安装中",
  cancelled: "已取消",
  failed: "安装失败"
};
const labels = {
  install: "安装 / 重试",
  upgrade: "升级",
  cancel: "取消安装",
  enable: "启用",
  disable: "停用",
  uninstall: "卸载组件"
};
export function mountComponentManager(host, { allowDownloads = true, allowAuth = false } = {}) {
  host.classList.add("component-manager");
  let disposed = false,
    busy = false,
    downloadsAvailable = allowDownloads;
  const title = document.createElement("h3");
  title.textContent = "应用组件";
  host.append(title);
  const auth = allowDownloads && allowAuth ? mountComponentAuth(host) : undefined;
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent = allowDownloads
    ? "CAD 精确内核和 Blender 会在后台下载并安装，普通聊天可继续使用。已安装的组件会继续复用，下载失败可在此重试。"
    : "CAD 精确内核、Blender 和 PPT 编辑器均随 CoworkOS 提供，组件升级由 CoworkOS 更新统一完成。";
  host.append(note);
  const check = document.createElement("button");
  check.type = "button";
  check.className = "app-button";
  check.textContent = allowDownloads ? "检查版本与下载大小" : "重新检查安装状态";
  host.append(check);
  check.addEventListener("click", () => {
    for (const row of rows.values()) row.dataset.repair = "";
    void refresh(downloadsAvailable, true);
  });
  const content = document.createElement("div");
  content.className = "component-list";
  host.append(content);
  const errorStatus = document.createElement("p");
  errorStatus.setAttribute("role", "alert");
  host.append(errorStatus);
  const controller = new AbortController();
  const rows = new Map();
  let selectedId;
  async function refresh(update = false, probe = false) {
    if (disposed || busy) return;
    busy = true;
    check.disabled = true;
    try {
      const response = await fetch(
        update
          ? `/api/components?refresh=1${probe ? "&probe=1" : ""}`
          : probe
            ? "/api/components?probe=1"
            : "/api/components",
        { signal: controller.signal }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "组件读取失败");
      if (disposed) return;
      errorStatus.textContent = "";
      const allBundled = payload.components.length > 0 && payload.components.every((state) => state.bundled);
      downloadsAvailable = allowDownloads && !allBundled;
      check.textContent = downloadsAvailable ? "检查版本与下载大小" : "重新检查安装状态";
      if (allBundled)
        note.textContent =
          "此安装包包含全部应用组件，内置组件随 CoworkOS 更新。若文件缺失或损坏，请修复完整安装包。";
      for (const state of payload.components) {
        const downloadable = allowDownloads && !state.bundled;
        let row = rows.get(state.id);
        if (!row) {
          row = document.createElement("section");
          row.className = "component-card";
          row.dataset.componentId = state.id;
          row.tabIndex = -1;
          const heading = document.createElement("strong");
          heading.textContent = names[state.id] || state.id;
          const status = document.createElement("p"),
            details = document.createElement("small"),
            progress = document.createElement("progress"),
            actions = document.createElement("div");
          status.className = "component-status";
          const disclosure = document.createElement("details");
          disclosure.className = "component-details";
          const summary = document.createElement("summary");
          disclosure.append(summary, details);
          actions.className = "component-actions";
          progress.className = "component-progress";
          progress.setAttribute("aria-label", `${names[state.id] || state.id} 安装进度`);
          progress.max = 100;
          row.append(heading, status, disclosure, progress, actions);
          content.append(row);
          rows.set(state.id, row);
          row.parts = { status, details, progress, actions, summary };
        }
        row.parts.summary.textContent = downloadable ? "版本、依赖与下载大小" : "版本与依赖";
        if (state.available || !state.enabled) row.dataset.repair = "";
        if (row.dataset.repair !== "true")
          row.parts.status.textContent = `${phases[state.phase] || "状态更新中"} · ${!downloadable && !state.available && state.enabled && !state.installing ? "未检测到可用组件，请修复安装。" : state.message}`;
        row.parts.details.textContent = `${state.version || "待安装"} · ${state.id === "pptist" ? "所有支持平台" : "Apple Silicon Mac"} · ${(state.dependencies || []).join(", ")}${downloadable ? (state.downloadBytes ? ` · 下载 ${(state.downloadBytes / 1048576).toFixed(1)} MB${state.installedBytes ? ` / 安装预算 ${(state.installedBytes / 1048576).toFixed(1)} MB` : ""}` : " · 安装前检查下载大小与磁盘空间") : " · 随 CoworkOS 安装包提供"}`;
        row.parts.progress.hidden = !state.installing;
        if (Number.isFinite(state.progress)) row.parts.progress.value = state.progress;
        else row.parts.progress.removeAttribute("value");
        const operations = state.installing
          ? ["cancel"]
          : !downloadable
            ? !state.enabled
              ? ["enable"]
              : state.available
                ? ["disable"]
                : ["repair"]
            : state.available
              ? state.managed === false
                ? ["disable"]
                : ["upgrade", "disable", "uninstall"]
              : !state.enabled
                ? ["enable", "install", "uninstall"]
                : ["install"];
        const key = operations.join(",") + state.supported;
        if (row.dataset.actions !== key) {
          row.dataset.actions = key;
          row.parts.actions.replaceChildren();
          for (const action of operations) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "app-button";
            button.textContent = action === "repair" ? "修复安装" : labels[action];
            button.disabled = !state.supported && ["install", "upgrade"].includes(action);
            button.addEventListener("click", async () => {
              if (action === "repair") {
                row.parts.status.textContent =
                  state.id === "pptist" && allowDownloads && !allBundled
                    ? "请重新安装 CoworkOS，恢复内置 PPT 编辑器。文档、任务和历史会保留。"
                    : "请重新安装包含全部应用的 CoworkOS 完整安装包。若设置了外部组件路径，请先修复或撤销该覆盖；文档、任务和历史会保留。";
                row.dataset.repair = "true";
                return;
              }
              row.dataset.repair = "";
              button.disabled = true;
              try {
                const result = await fetch(`/api/components/${state.id}/${action}`, {
                  method: "POST"
                });
                const body = await result.json();
                if (!result.ok) throw new Error(body.error || "组件操作失败");
                document.dispatchEvent(new CustomEvent("atria:components-changed"));
                if (disposed) return;
                row.dataset.actions = "";
              } catch (error) {
                if (!disposed) row.parts.status.textContent = error.message;
              } finally {
                if (!disposed) {
                  button.disabled = false;
                  void refresh();
                }
              }
            });
            row.parts.actions.append(button);
          }
        }
      }
      if (selectedId) focus();
    } catch (error) {
      if (!disposed) errorStatus.textContent = `组件状态读取失败：${error.message}`;
    } finally {
      busy = false;
      if (!disposed) check.disabled = false;
    }
  }
  void refresh();
  const timer = setInterval(() => void refresh(), 1000);
  function focus(id) {
    if (id) selectedId = id;
    const row = rows.get(selectedId);
    if (row) {
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
      selectedId = undefined;
    }
  }
  return {
    focus,
    dispose() {
      disposed = true;
      controller.abort();
      auth?.dispose();
      clearInterval(timer);
    }
  };
}
