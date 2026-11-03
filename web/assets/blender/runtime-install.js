import { openComponentSettings } from "../workbench/component-entry.js";

/** Editors show runtime state; component installation belongs to settings. */
export function mountBlenderInstaller(host, { onReady = () => {} } = {}) {
  host.classList.add("blender-install");
  host.innerHTML =
    '<span data-install-status role="status">正在检查 Blender…</span><progress data-install-progress hidden max="100"></progress><button type="button" class="app-button" data-install-button hidden>在设置中安装</button>';
  const status = host.querySelector("[data-install-status]");
  const button = host.querySelector("[data-install-button]");
  const progress = host.querySelector("[data-install-progress]");
  let disposed = false,
    timer,
    wasAvailable,
    refreshId = 0;
  const controller = new AbortController();
  const request = async () => {
    const response = await fetch("/api/applications/blender/runtime", {
      signal: controller.signal
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "无法读取安装状态，请重试");
    return body;
  };
  function paint(state) {
    host.dataset.ready = String(!!state.available);
    host.hidden = !!state.available;
    status.textContent = state.message;
    button.hidden = state.available;
    button.disabled = false;
    button.textContent = state.installing ? "在设置中查看" : "在设置中安装";
    progress.hidden = !state.installing;
    if (Number.isFinite(state.progress)) progress.value = state.progress;
    else progress.removeAttribute("value");
    if (state.available && wasAvailable === false) onReady();
    wasAvailable = state.available;
  }
  async function refresh() {
    const requestId = ++refreshId;
    clearTimeout(timer);
    try {
      const state = await request();
      if (disposed || requestId !== refreshId) return;
      paint(state);
      if (state.installing) timer = setTimeout(refresh, 1000);
    } catch (error) {
      if (disposed || requestId !== refreshId) return;
      host.dataset.ready = "false";
      host.hidden = false;
      status.textContent = error.message;
      // A failed status check must remain recoverable without starting an installation.
      button.hidden = false;
      button.disabled = false;
      button.textContent = "重新检查";
      progress.hidden = true;
      wasAvailable = undefined;
    }
  }
  button.addEventListener("click", () => {
    if (wasAvailable === undefined) return refresh();
    openComponentSettings("blender");
  });
  document.addEventListener("atria:components-changed", refresh);
  window.addEventListener("focus", refresh);
  void refresh();
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener("atria:components-changed", refresh);
      window.removeEventListener("focus", refresh);
    }
  };
}
