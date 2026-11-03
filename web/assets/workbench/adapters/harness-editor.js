import { applicationIcon } from "../application-icons.js";
import { escapeHtml as esc } from "../html.js";

/** Native GUI harnesses keep their document in the external application. */
export function createHarnessEditorAdapter(appType, { appName, appIcon }) {
  return {
    definition: {
      appType,
      displayName: appName,
      icon: appIcon,
      version: "1",
      resourceKinds: []
    },
    async mount(host) {
      const desktop = window.bookmanDesktop;
      const canLaunch = typeof desktop?.harnessLaunch === "function";
      const softwareName = appName.replace(/\s+Harness$/i, "");
      const openLabel = `打开 ${softwareName}`;
      host.innerHTML = `<section class="application-home" aria-label="${esc(appName)}">
        ${applicationIcon(appType, appIcon)}<h2>${esc(appName)}</h2>
        ${canLaunch ? `<div class="application-home-actions"><button class="app-button is-primary" type="button" data-harness-launch>${esc(openLabel)}</button></div>` : ""}
        <div role="status" aria-atomic="true">${canLaunch ? `在 ${esc(softwareName)} 桌面窗口中编辑。` : "请在 CoworkOS 桌面版中打开此会话。"}</div>
      </section>`;
      const home = host.querySelector(".application-home");
      home.querySelector(".application-icon").classList.add("application-home-icon");
      const status = home.querySelector('[role="status"]');
      const button = home.querySelector("[data-harness-launch]");
      let mounted = true;
      let pending = false;
      const launch = async () => {
        if (!mounted || pending) return;
        pending = true;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = `正在打开 ${softwareName}…`;
        status.textContent = `正在打开 ${softwareName} 桌面窗口…`;
        try {
          const result = await desktop.harnessLaunch(appType);
          if (!mounted) return;
          if (!result?.connected && !result?.launched) throw new Error("应用尚未就绪，请稍后重试。");
          status.textContent = result.connected
            ? `已打开 ${softwareName} 桌面窗口。`
            : `已启动 ${softwareName}。`;
          button.textContent = openLabel;
        } catch (error) {
          if (!mounted) return;
          status.textContent = `无法打开 ${softwareName}：${error?.message || "请重试。"}`;
          button.textContent = `重试打开 ${softwareName}`;
        } finally {
          if (mounted) {
            pending = false;
            button.disabled = false;
            button.removeAttribute("aria-busy");
          }
        }
      };
      button?.addEventListener("click", launch);
      return {
        focus() {
          button?.focus();
        },
        unmount() {
          mounted = false;
          button?.removeEventListener("click", launch);
          home.remove();
        }
      };
    }
  };
}

// Several document tabs share one native view. Only the displayed tab owns it;
// an old observer, status push or startup completion cannot reclaim that view.
const nativeOwners = new WeakMap();

function createEmbeddedHarnessEditorAdapter({
  appType,
  appName,
  displayName = appName,
  icon,
  bridge,
  description,
  taskWorkspace
}) {
  return {
    definition: { appType, displayName, icon, version: "1", resourceKinds: [] },
    async mount(host, initialContext = {}) {
      const native = window.bookmanDesktop?.[bridge];
      if (!native) {
        host.innerHTML = `<div class="workbench-unsupported"><strong>${appName} 不可用</strong><p>${description}需要桌面版 CoworkOS。</p></div>`;
        return {};
      }
      host.innerHTML = "";
      const overlay = document.createElement("div");
      overlay.className = "cad-viewer-overlay";
      host.appendChild(overlay);
      let mounted = true;
      let lease;
      let status = "stopped";
      let lastError = "";
      const ownsView = () => mounted && lease && nativeOwners.get(native) === lease;
      const renderOverlay = () => {
        overlay.replaceChildren();
        overlay.hidden = status === "running";
        if (overlay.hidden) return;
        if (status === "error") {
          const strong = document.createElement("strong");
          strong.textContent = `${appName} 启动失败`;
          const p = document.createElement("p");
          p.textContent = lastError || "未知错误";
          overlay.append(strong, p);
        } else {
          const spinner = document.createElement("div");
          spinner.className = "cad-viewer-spinner";
          const p = document.createElement("p");
          p.textContent = `正在启动 ${appName}…`;
          overlay.append(spinner, p);
        }
      };
      const syncBounds = () => {
        if (!ownsView()) return;
        const rect = host.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && status === "running") {
          lease.attached = true;
          void native
            .attach({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, owner: lease.owner })
            .catch(() => {});
        } else if (lease.attached) {
          lease.attached = false;
          void native.detach(lease.owner).catch(() => {});
        }
      };
      const applyStatus = (info) => {
        if (!ownsView() || !info || typeof info.status !== "string") return;
        status = info.status;
        lastError = info.error || "";
        renderOverlay();
        syncBounds();
      };
      const unsubscribe = native.onStatusChanged?.(applyStatus) ?? (() => {});
      const observer = new ResizeObserver(syncBounds);
      observer.observe(host);
      window.addEventListener("resize", syncBounds);
      renderOverlay();

      const release = () => {
        const previous = lease;
        lease = undefined;
        if (!previous || nativeOwners.get(native) !== previous) return Promise.resolve();
        nativeOwners.delete(native);
        // Send before another tab claims the view. The desktop owner token also
        // protects it if this IPC finishes after the next activation.
        return native.detach(previous.owner).catch(() => {});
      };
      return {
        setVisible(visible, context = initialContext) {
          if (!mounted) return;
          const workspace = context.taskWorkspaceDirectory;
          if (visible && ownsView() && lease.workspace === workspace) {
            syncBounds();
            return;
          }
          void release();
          if (!visible) return;
          if (taskWorkspace && !workspace) {
            status = "error";
            lastError = "无法定位此会话的任务工作区，请刷新后重试。";
            renderOverlay();
            return;
          }
          const current = { owner: crypto.randomUUID(), workspace, attached: false };
          lease = current;
          nativeOwners.set(native, current);
          status = "starting";
          lastError = "";
          renderOverlay();
          // Startup is also activation: returning to a mounted CAD tab must
          // retarget the scanner to that conversation's task storage directory.
          const started = taskWorkspace
            ? native.start(workspace, current.owner)
            : native.start(current.owner);
          void started
            .then((info) => {
              if (lease === current) applyStatus(info);
            })
            .catch((error) => {
              if (lease === current) applyStatus({ status: "error", error: error.message });
            });
        },
        focus() {
          host.focus?.();
        },
        async unmount() {
          mounted = false;
          unsubscribe();
          observer.disconnect();
          window.removeEventListener("resize", syncBounds);
          await release();
          host.innerHTML = "";
        }
      };
    }
  };
}

/** CAD and Office use native views because their hosts cannot be framed. */
export const cadHarnessEditorAdapter = createEmbeddedHarnessEditorAdapter({
  appType: "cad-harness",
  appName: "CAD Viewer",
  displayName: "CAD Harness",
  icon: "i-boxes",
  bridge: "cadViewer",
  description: "内嵌 3D 视图",
  taskWorkspace: true
});

export const officeHarnessEditorAdapter = createEmbeddedHarnessEditorAdapter({
  appType: "office-harness",
  appName: "OfficeHarness",
  icon: "i-slides",
  bridge: "officeHarness",
  description: "内嵌 Impress 工作区",
  taskWorkspace: false
});
