import { ui } from "../ui/language.js";
import { createSettingsModal } from "./settings-modal.js";
import { icon } from "../ui/icons.js";
import { mountComponentManager } from "../workbench/component-manager.js";

/** One settings surface owns installation, activation and component updates. */
export function installComponentSettings({ overview }) {
  const sections = document.querySelector("#profile-settings-sections");
  if (!sections) return;
  const row = document.createElement("div");
  row.className = "profile-setting";
  row.innerHTML = ui`<span class="settings-row-copy"><span class="settings-row-icon">${icon("grid")}</span><span><strong>应用与组件</strong></span></span><button class="app-button is-secondary" type="button" data-component-settings aria-label="管理应用">管理${icon("chevron-right")}</button>`;
  const updates = sections.querySelector(".desktop-updates");
  const tools = document.querySelector("#profile-settings-tools");
  if (tools) tools.prepend(row);
  else sections.insertBefore(row, updates);
  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card settings-card component-settings-card" role="dialog" aria-modal="true" aria-labelledby="component-settings-title"><header class="settings-heading"><button class="settings-nav-button" type="button" data-settings-back aria-label="返回设置" title="返回设置">${icon("chevron-left")}</button><div><h2 id="component-settings-title">应用与组件</h2></div><button class="settings-nav-button" type="button" data-component-close aria-label="关闭设置" title="关闭设置">${icon("close")}</button></header><div class="settings-scroll"><div data-component-manager></div></div><footer class="modal-actions"><button class="app-button is-secondary" type="button" data-component-updates hidden>检查 CoworkOS 更新</button></footer></section>`;
  document.body.append(panel);
  let manager;
  const dialog = createSettingsModal(panel, panel.querySelector("[data-component-close]"), {
    overview,
    returnFocus: () => button.focus(),
    onClose: () => {
      manager?.dispose();
      manager = undefined;
    }
  });
  const button = row.querySelector("button");
  function open(componentId) {
    if (!dialog.open()) return;
    if (!manager) {
      const host = panel.querySelector("[data-component-manager]");
      host.replaceChildren();
      manager = mountComponentManager(host);
    }
    manager.focus(componentId);
  }
  button.addEventListener("click", () => open());
  const updateButton = panel.querySelector("[data-component-updates]");
  updateButton.hidden = !updates;
  updateButton.addEventListener("click", () => {
    dialog.back();
    // The overview's existing update controller owns checking and applying updates.
    updates?.querySelector("[data-update-check]")?.click();
  });
  const requested = (event) => open(event.detail?.componentId);
  document.addEventListener("atria:component-settings", requested);
  window.addEventListener(
    "pagehide",
    () => {
      manager?.dispose();
      document.removeEventListener("atria:component-settings", requested);
    },
    { once: true }
  );
  return { open };
}
