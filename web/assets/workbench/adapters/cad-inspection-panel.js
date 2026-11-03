import { escapeHtml as esc } from "../html.js";
import { createMenu } from "../../ui/menu.js";
import { icon } from "../../ui/icons.js";

/** Read-only inspection actions. Source edits and shared selection belong to the editor. */
export function createCadInspectionPanel(host, actions) {
  const q = (selector) => host.querySelector(selector),
    viewport = actions.viewport;
  let geometry,
    selected,
    ready = false,
    disposed = false,
    recording = false,
    measuring = false,
    marker,
    menuOrigin;
  const axes = ["x", "y", "z"];
  q("[data-program-view-zoom]").innerHTML =
    `<span>缩放</span><div><button class="app-button" data-inspect-zoom="1.2" aria-label="缩小">−</button><button class="app-button" data-inspect-zoom-reset aria-label="重置缩放"><output data-inspect-zoom-label>100%</output></button><button class="app-button" data-inspect-zoom="0.833333" aria-label="放大">+</button></div>`;
  q("[data-program-view-navigation]").innerHTML =
    `<button class="app-button" data-inspect-nav="orbit" aria-pressed="true">旋转</button><button class="app-button" data-inspect-nav="pan" aria-pressed="false">平移</button><button class="app-button" data-inspect-nav="measure" aria-pressed="false">测量</button>`;
  q("[data-program-view]").insertAdjacentHTML(
    "beforeend",
    '<option value="back">后视图</option><option value="left">左视图</option><option value="bottom">仰视图</option>'
  );
  q("[data-program-filter]").insertAdjacentHTML(
    "beforebegin",
    `<div class="cad-tree-actions"><button class="app-button" data-inspect-expand="true">展开</button><button class="app-button" data-inspect-expand="false">折叠</button><button class="app-button" data-inspect-show-all>显示全部</button><label><input type="checkbox" data-program-tree-pin>固定</label></div>`
  );
  q("[data-program-explode]").parentElement.insertAdjacentHTML(
    "beforeend",
    `<div class="cad-explode-options"><input type="number" data-inspect-explode-number aria-label="爆炸比例数值" min="0" max="100" step="1" value="0"><select data-inspect-explode-mode aria-label="爆炸方式"><option value="parts">按零件</option><option value="groups">按装配</option></select></div>`
  );
  q("[data-program-style]").parentElement.insertAdjacentHTML(
    "afterend",
    `<label class="cad-program-param">外观<select data-inspect-appearance aria-label="CAD 外观"><option value="engineering">工程灰</option><option value="colors">零件色</option><option value="materials">声明材质</option></select></label>`
  );
  q(".cad-display-options").insertAdjacentHTML(
    "beforeend",
    `<details class="cad-multi-section"><summary>多轴剖切</summary>${axes.map((axis) => `<div class="cad-section-row" data-inspect-axis="${axis}"><label><input type="checkbox" data-inspect-section-enabled aria-label="启用 ${axis.toUpperCase()} 剖切">${axis.toUpperCase()}</label><input type="range" data-inspect-section-range aria-label="${axis.toUpperCase()} 剖切滑块" min="-100" max="100" step="0.1" value="0"><input type="number" data-inspect-section-offset aria-label="${axis.toUpperCase()} 剖切位置" step="any" value="0"><label><input type="checkbox" data-inspect-section-invert aria-label="反向 ${axis.toUpperCase()} 剖切">反向</label></div>`).join("")}</details><button class="app-button" data-inspect-simulation hidden>运动仿真</button>`
  );
  q("[data-program-quality]").innerHTML =
    '<div class="cad-quality-summary" data-inspect-quality>暂无检查结果</div>';
  q("[data-program-selection-actions]").innerHTML =
    `<div class="cad-selection-actions"><button class="app-button" data-inspect-fit-selected>聚焦</button><button class="app-button" data-inspect-copy>复制引用</button><button class="app-button is-icon" data-inspect-actions aria-label="选中对象操作" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button></div><details class="cad-reference-panel"><summary>零件引用</summary><textarea data-inspect-reference aria-label="选中零件引用" rows="2" readonly></textarea></details>`;
  q(".cad-stage").insertAdjacentHTML(
    "beforeend",
    `<output class="cad-inspect-notice" data-inspect-notice role="status" hidden></output><section class="cad-measure-panel" data-inspect-measure-panel aria-label="测量" hidden><div><p data-inspect-measure>选择两个表面点</p><output class="cad-measure-result" data-inspect-measure-result hidden></output></div><button class="app-button" data-inspect-measure-clear>清除</button><button class="app-button is-icon" data-inspect-measure-exit aria-label="结束测量">${icon("close")}</button></section>`
  );
  const menu = document.createElement("div");
  menu.className = "cad-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "CAD 零件操作");
  menu.hidden = true;
  host.append(menu);
  const contextMenu = createMenu(q("[data-inspect-actions]"), menu, { toggleOnClick: false });
  const dialog = document.createElement("dialog");
  dialog.className = "cad-simulation-dialog";
  dialog.setAttribute("aria-label", "运动仿真");
  dialog.innerHTML = `<header><strong>运动仿真</strong><span data-inspect-simulation-title></span><button class="app-button" data-inspect-record>下载运动视频</button><button class="app-button" data-inspect-simulation-close aria-label="关闭运动仿真">关闭</button></header><div data-inspect-simulation-stage class="cad-editor cad-program-editor"></div>`;
  host.append(dialog);
  // Put the menu inside the active modal when needed, so native modal focus rules apply.
  const stage = q(".cad-stage");
  const status = (text) => {
    if (disposed) return;
    q("[data-inspect-notice]").hidden = !text;
    q("[data-inspect-notice]").textContent = text;
  };
  const reference = () => {
    const part = actions.selection();
    return part ? `cad://${actions.resourceId()}@r${actions.revision()}#${part.path || part.id}` : "";
  };
  async function copyReference() {
    const text = reference();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      status("已复制零件引用");
    } catch {
      actions.openInspector("properties");
      q(".cad-reference-panel").open = true;
      q("[data-inspect-reference]").focus();
      q("[data-inspect-reference]").select();
      status("引用已选中，可按 Ctrl/Cmd+C 复制");
    }
  }
  function closeMenu(restore = false) {
    contextMenu.close(restore);
  }
  function closeSimulation() {
    if (!marker) return;
    viewport.stopRecording();
    viewport.pause();
    if (marker) {
      marker.replaceWith(stage);
      marker = undefined;
    }
    host.append(menu);
    viewport.setBackground();
    closeMenu();
  }
  dialog.addEventListener("close", closeSimulation);
  dialog.addEventListener("cancel", () => closeMenu());
  async function context({ id, x, y }) {
    if (!ready) return;
    closeMenu();
    menuOrigin = document.activeElement;
    // Local selection happens synchronously; network persistence must not delay the menu.
    const selection = actions.select(id, true);
    if (disposed || !ready) return;
    const groups = [
      id && [
        "选中对象",
        [
          ["copy", "复制引用"],
          ["fit-selected", "聚焦选中"],
          ["deselect", "取消选择"]
        ]
      ],
      [
        "可见性",
        [
          ...(id
            ? [
                ["isolate", "隔离选中"],
                ["focus", "其他零件淡化"],
                ["hide", "隐藏选中"],
                ["hide-others", "隐藏其他零件"]
              ]
            : []),
          ["show-all", "显示全部零件"]
        ]
      ],
      [
        "视图",
        [
          ["zoom-reset", "重置缩放"],
          ["fit", "显示完整模型"]
        ]
      ],
      id?.startsWith("assembly:") && [
        "装配",
        [
          ["expand", "展开选中"],
          ["collapse", "折叠选中"]
        ]
      ]
    ].filter(Boolean);
    menu.innerHTML = groups
      .map(
        ([label, entries]) =>
          `<div class="cad-menu-group" role="group" aria-label="${label}"><span class="cad-menu-label">${label}</span>${entries.map(([key, text]) => `<button type="button" role="menuitem" data-inspect-command="${key}">${text}</button>`).join("")}</div>`
      )
      .join("");
    (dialog.open ? dialog : host).append(menu);
    contextMenu.setTrigger(
      menuOrigin && host.contains(menuOrigin) ? menuOrigin : q("[data-inspect-actions]")
    );
    contextMenu.open();
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
    menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    await selection;
  }
  function clearSections() {
    for (const input of host.querySelectorAll("[data-inspect-section-enabled]")) input.checked = false;
  }
  function setSections(event) {
    const row = event.target.closest("[data-inspect-axis]");
    if (!row) return;
    const range = row.querySelector("[data-inspect-section-range]"),
      offset = row.querySelector("[data-inspect-section-offset]");
    if (event.target === range) offset.value = range.value;
    if (offset.value === "" || !offset.checkValidity()) return;
    range.value = offset.value;
    q("[data-program-section]").value = "off";
    q("[data-program-section-label]").hidden = true;
    viewport.setSections(
      [...host.querySelectorAll("[data-inspect-axis]")]
        .filter((r) => r.querySelector("[data-inspect-section-enabled]").checked)
        .map((r) => ({
          axis: r.dataset.inspectAxis,
          offset: Number(r.querySelector("[data-inspect-section-offset]").value),
          inverted: r.querySelector("[data-inspect-section-invert]").checked
        }))
    );
  }
  function setNavigation(mode) {
    measuring = mode === "measure";
    viewport.setNavigation(mode);
    q("[data-inspect-measure-panel]").hidden = !measuring;
    for (const button of host.querySelectorAll("[data-inspect-nav]"))
      button.setAttribute("aria-pressed", String(button.dataset.inspectNav === mode));
    if (!measuring) viewport.clearMeasure();
  }
  function change(event) {
    if (!ready) return;
    if (event.target.closest("[data-inspect-axis]")) setSections(event);
    if (event.target.matches("[data-program-explode]"))
      q("[data-inspect-explode-number]").value = event.target.value;
    if (
      event.target.matches("[data-inspect-explode-number]") &&
      event.target.value !== "" &&
      event.target.checkValidity()
    ) {
      q("[data-program-explode]").value = event.target.value;
      q("[data-program-explode]").dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (event.target.matches("[data-inspect-explode-mode]")) viewport.setExplodeMode(event.target.value);
    if (event.target.matches("[data-inspect-appearance]")) viewport.setAppearance(event.target.value);
  }
  function expand(value, path) {
    for (const branch of host.querySelectorAll("[data-program-branch]"))
      if (!path || branch.dataset.programBranch === path) branch.open = value;
  }
  async function command(key) {
    if (!ready) return;
    if (key === "copy") await copyReference();
    if (key === "deselect") {
      await actions.select(undefined, true);
      actions.focusView();
    }
    if (key === "isolate") viewport.isolate(selected);
    if (key === "focus") viewport.focus(selected);
    if (key === "hide") actions.setHidden(selected, true);
    if (key === "hide-others") {
      actions.hideOthers(selected);
    }
    if (key === "show-all") actions.showAll();
    if (key === "zoom-reset") viewport.resetZoom();
    if (key === "fit") viewport.fit();
    if (key === "fit-selected") viewport.fit("selected");
    if (key === "expand" || key === "collapse") expand(key === "expand", selected?.slice(9));
    if (key === "expand-all" || key === "collapse-all") expand(key === "expand-all");
  }
  async function click(event) {
    const button = event.target.closest("button");
    if (!button) return;
    const key = button.dataset.inspectCommand;
    closeMenu();
    if (button.hasAttribute("data-inspect-simulation-close")) {
      dialog.close();
      return;
    }
    if (!ready) return;
    try {
      if (button.hasAttribute("data-inspect-actions")) {
        const rect = button.getBoundingClientRect();
        await context({ id: selected, x: rect.left, y: rect.bottom + 4 });
      }
      if (key) await command(key);
      if (button.hasAttribute("data-inspect-copy")) await copyReference();
      if (button.hasAttribute("data-inspect-fit-selected")) viewport.fit("selected");
      if (button.hasAttribute("data-inspect-show-all")) actions.showAll();
      if (button.hasAttribute("data-inspect-focus")) viewport.focus(selected);
      if (button.dataset.inspectExpand) expand(button.dataset.inspectExpand === "true");
      if (button.dataset.inspectZoom) viewport.zoom(Number(button.dataset.inspectZoom));
      if (button.hasAttribute("data-inspect-zoom-reset")) viewport.resetZoom();
      if (button.dataset.inspectNav) {
        setNavigation(button.dataset.inspectNav);
        if (measuring) actions.closeView();
      }
      if (button.hasAttribute("data-inspect-measure-exit")) {
        setNavigation("orbit");
        actions.focusView();
      }
      if (button.hasAttribute("data-inspect-measure-clear")) viewport.clearMeasure();
      if (button.hasAttribute("data-inspect-simulation")) {
        actions.closeView();
        marker = document.createComment("CAD stage");
        stage.replaceWith(marker);
        dialog.querySelector("[data-inspect-simulation-stage]").append(stage);
        dialog.querySelector("[data-inspect-simulation-title]").textContent = actions.title();
        dialog.showModal();
        viewport.setBackground(true);
        viewport.play();
      }
      if (button.hasAttribute("data-inspect-record")) {
        if (recording) {
          viewport.stopRecording();
          return;
        }
        recording = true;
        button.textContent = "停止并下载";
        // Keep playback controls fixed so the recording duration follows the chosen speed.
        setRecordingControls(true);
        try {
          const blob = await viewport.recordCycle();
          if (!disposed && blob.size)
            actions.download(blob, actions.title().replace(/\.cad\.json$/i, "") + "-motion.webm");
        } finally {
          recording = false;
          button.textContent = "下载运动视频";
          setRecordingControls(false);
        }
      }
    } catch (error) {
      status(error.message);
    }
  }
  function setRecordingControls(value) {
    for (const control of stage.querySelectorAll(
      "[data-program-time],[data-program-speed],[data-program-play]"
    ))
      control.disabled = value || !ready;
  }
  function treeContext(event) {
    const row = event.target.closest("[data-program-select],[data-program-select-group]");
    if (!row) return;
    event.preventDefault();
    void context({
      id: row.dataset.programSelect || row.dataset.programSelectGroup,
      x: event.clientX,
      y: event.clientY
    });
  }
  function keydown(event) {
    if (event.key === "Escape" && measuring && q("[data-inspect-measure-panel]").contains(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      setNavigation("orbit");
      actions.focusView();
      return;
    }
    if (menu.hidden && ready && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      const target = event.target.closest(
        "[data-program-select],[data-program-select-group],canvas,[data-inspect-actions]"
      );
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        const rect = target.getBoundingClientRect();
        void context({
          id: target.dataset.programSelect || target.dataset.programSelectGroup || selected,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        });
        return;
      }
    }
  }
  host.addEventListener("input", change);
  host.addEventListener("change", change);
  host.addEventListener("click", click);
  host.addEventListener("contextmenu", treeContext);
  host.addEventListener("keydown", keydown, true);
  return {
    context,
    clearSections,
    update(value, id, current) {
      const changed = geometry !== value;
      const wasReady = ready;
      geometry = value;
      selected = id;
      ready = current && !!geometry?.features.length;
      if (changed || !ready || wasReady !== ready) {
        const a = geometry?.assessment;
        q("[data-inspect-quality]").innerHTML = !ready
          ? "暂无检查结果"
          : !a
            ? "暂无检查结果"
            : `<p>${a.geometry === "brep_valid" ? "精确实体有效" : "仅显示网格验证"} · ${a.completeness === "not_declared" ? "未声明部件清单" : a.completeness === "missing_components" ? "有部件缺失" : "声明的部件数量满足"}</p>${a.warnings.length ? `<ul>${a.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}${a.sourceChecks.length ? `<p>源码声明的检查</p><ul>${a.sourceChecks.map((c) => `<li>${esc(c.label)}：${c.status === "passed" ? "报告通过" : c.status === "failed" ? "报告失败" : "未验证"}${c.evidence ? ` · ${esc(c.evidence)}` : ""}</li>`).join("")}</ul>` : ""}${a.limitations.length ? `<p>简化与限制</p><ul>${a.limitations.map((v) => `<li>${esc(v)}</li>`).join("")}</ul>` : ""}<small>${esc(a.note)}</small>`;
      }
      q("[data-inspect-reference]").value = reference();
      for (const control of host.querySelectorAll(
        "[data-inspect-copy],[data-inspect-fit-selected],[data-inspect-focus]"
      ))
        control.disabled = !ready || !selected;
      for (const control of host.querySelectorAll(
        "[data-inspect-zoom],[data-inspect-zoom-reset],[data-inspect-nav],[data-inspect-actions],.cad-multi-section input,[data-inspect-explode-mode],[data-inspect-explode-number],[data-inspect-appearance]"
      ))
        control.disabled = !ready;
      q("[data-inspect-simulation]").hidden = !ready || !geometry.motion;
      q("[data-inspect-simulation]").disabled = !ready || !geometry.motion;
      if (!ready) {
        if (measuring) setNavigation("orbit");
        closeMenu();
        if (dialog.open) dialog.close();
      }
      if (changed && geometry)
        for (const row of host.querySelectorAll("[data-inspect-axis]")) {
          const a = axes.indexOf(row.dataset.inspectAxis),
            values = geometry.features.filter((f) => f.bounds).map((f) => f.bounds);
          const min = values.length ? Math.min(...values.map((b) => b[0][a])) : -100,
            max = values.length ? Math.max(...values.map((b) => b[1][a])) : 100;
          const range = row.querySelector("[data-inspect-section-range]");
          range.min = String(min);
          range.max = String(max);
          const offset = row.querySelector("[data-inspect-section-offset]");
          if (row.querySelector("[data-inspect-section-enabled]").checked) range.value = offset.value;
          else {
            range.value = String((min + max) / 2);
            offset.value = range.value;
          }
        }
      setRecordingControls(recording);
    },
    camera({ zoom }) {
      if (!disposed) q("[data-inspect-zoom-label]").textContent = `${Math.round(zoom)}%`;
    },
    measure({ points, distance, delta, time }) {
      if (disposed) return;
      const text =
        distance !== undefined
          ? `${distance.toFixed(3)} mm · ΔX ${delta[0].toFixed(3)} / ΔY ${delta[1].toFixed(3)} / ΔZ ${delta[2].toFixed(3)} · t=${time.toFixed(2)} s`
          : points.length
            ? "选择第二个表面点"
            : "选择两个表面点";
      q("[data-inspect-measure]").hidden = Boolean(points.length);
      q("[data-inspect-measure-result]").textContent = text;
      q("[data-inspect-measure-result]").hidden = !points.length;
    },
    reset() {
      clearSections();
      q("[data-inspect-explode-mode]").value = "parts";
      q("[data-inspect-explode-number]").value = "0";
      setNavigation("orbit");
      status("");
    },
    dispose() {
      if (dialog.open) dialog.close();
      closeSimulation();
      disposed = true;
      host.removeEventListener("input", change);
      host.removeEventListener("change", change);
      host.removeEventListener("click", click);
      host.removeEventListener("contextmenu", treeContext);
      host.removeEventListener("keydown", keydown, true);
      contextMenu.dispose();
      menu.remove();
      dialog.remove();
    }
  };
}
