import { openComponentSettings } from "../workbench/component-entry.js";

if (window.parent !== window)
  window.parent.postMessage(
    {
      protocol: "atria-pptist-v1",
      channel: new URLSearchParams(window.location.hash.slice(1)).get("channel"),
      type: "component-unavailable"
    },
    window.location.origin
  );

document.querySelector("[data-component-settings]").addEventListener("click", () => {
  openComponentSettings("pptist", window.parent.document);
  if (window.parent === window)
    document.querySelector("[data-component-status]").textContent =
      "请返回 CoworkOS，打开设置中的应用组件。当前版本内置全部应用，缺失时请重新安装完整 CoworkOS。";
});
