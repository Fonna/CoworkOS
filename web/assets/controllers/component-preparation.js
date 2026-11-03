import { icon } from "../ui/icons.js";

const names = { cadquery: "CAD 精确内核", blender: "Blender", pptist: "PPT 编辑器" };

/** Observe host-owned preparation without starting downloads or interrupting the current task. */
export function installComponentPreparation({
  open,
  showToast = () => {},
  host = document.querySelector(".sidebar-bottom"),
  pollMs = 2000
}) {
  if (!host) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "account-row component-preparation";
  button.dataset.componentPreparation = "";
  button.hidden = true;
  button.innerHTML = `${icon("download")}<span role="status" aria-live="polite"></span>`;
  host.prepend(button);
  const label = button.querySelector("span");
  const controller = new AbortController();
  const previous = new Map();
  let disposed = false,
    busy = false,
    preparing = false,
    selectedId;

  function reflect(components) {
    const active = components.filter((state) => state.installing);
    const failed = components.filter((state) => state.enabled && state.phase === "failed");
    const cancelled = components.filter((state) => state.enabled && state.phase === "cancelled");
    const selected = active[0] || failed[0] || cancelled[0];
    selectedId = selected?.id;
    button.hidden = !selected;
    if (selected) {
      const name = names[selected.id] || selected.id;
      const percent = Number.isFinite(selected.progress)
        ? ` · ${Math.round(Math.min(100, Math.max(0, selected.progress)))}%`
        : "";
      label.textContent = active.length
        ? `正在准备 ${name}${percent}${active.length > 1 ? ` 等 ${active.length} 个组件` : ""}`
        : failed.length
          ? `${name} 安装失败 · 重试`
          : `${name} 准备已取消 · 继续安装`;
      button.title = active.length
        ? "正在后台下载与安装，普通聊天可继续使用。点击查看进度。"
        : `${selected.message || "组件尚未准备完成"}，点击管理应用组件。`;
    }
    if (active.length && !preparing) showToast("正在后台准备应用组件，普通聊天可继续使用");
    if (!active.length && preparing && !failed.length && !cancelled.length) showToast("应用组件已准备好");
    preparing = active.length > 0;

    let completed = false;
    for (const state of components) {
      const before = previous.get(state.id);
      if (before?.installing && !state.installing && state.available) completed = true;
      previous.set(state.id, { installing: state.installing });
    }
    if (completed) document.dispatchEvent(new CustomEvent("atria:components-changed"));
  }

  async function refresh() {
    if (disposed || busy) return;
    busy = true;
    try {
      const response = await fetch("/api/components", { signal: controller.signal });
      const payload = await response.json();
      if (!disposed && response.ok && Array.isArray(payload.components)) reflect(payload.components);
    } catch {
      // Settings owns actionable state errors; a transient poll must not interrupt the user.
    } finally {
      busy = false;
    }
  }
  button.addEventListener("click", () => open(selectedId));
  const changed = () => void refresh();
  document.addEventListener("atria:components-changed", changed);
  window.addEventListener("focus", changed);
  const timer = setInterval(changed, pollMs);
  void refresh();

  function dispose() {
    disposed = true;
    controller.abort();
    clearInterval(timer);
    document.removeEventListener("atria:components-changed", changed);
    window.removeEventListener("focus", changed);
    window.removeEventListener("pagehide", dispose);
    button.remove();
  }
  window.addEventListener("pagehide", dispose, { once: true });
  return { dispose };
}
