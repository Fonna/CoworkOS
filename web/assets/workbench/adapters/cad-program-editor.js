import { escapeHtml as esc } from "../html.js";
import {
  normalizeProgram,
  defaultComputeBudget,
  CAD_COMPUTE_LIMITS,
  CAD_TIMEOUT_STEPS
} from "../../cad/generated/program.js";
import { CadDocumentSession } from "../../cad/document-session.js";
import { CadKernelClient } from "../../cad/kernel-client.js";
import { createMenu } from "../../ui/menu.js";
import { createVisiblePoll } from "../../ui/visible-poll.js";
import { nameDocument } from "./document-name-dialog.js";
import { icon } from "../../ui/icons.js";
import { createCadInspectionPanel } from "./cad-inspection-panel.js";
import { openComponentSettings } from "../component-entry.js";
const isComputeTimeout = (message) => /超时/.test(message) && !/排队|队列/.test(message);
const download = (blob, name) => {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export const cadProgramEditor = {
  async mount(host, { instance, taskId, api, onDirtyChange, onChanged, onContextChange }) {
    host.innerHTML = `<section class="cad-editor cad-program-editor" aria-label="CAD 源码工作台" data-inspector-open="false" data-has-model="false">
      <header class="cad-toolbar"><div class="cad-identity"><div><button class="cad-document-title" data-program-rename type="button" aria-label="重命名模型"><span data-program-title></span>${icon("pencil", "cad-title-pencil")}</button></div></div><div class="cad-actions">
        <div class="ui-menu-anchor"><button class="app-button" data-program-file-menu aria-expanded="false">文件 ${icon("chevron-down")}</button><div class="ui-menu" data-program-file-panel hidden><button type="button" data-program-import>导入代码…</button><div class="cad-export-anchor"><button class="app-button" type="button" data-program-export-menu aria-haspopup="menu" aria-expanded="false">导出… ${icon("chevron-right")}</button><div class="ui-menu cad-export-menu" data-program-export-panel role="menu" aria-label="导出模型" hidden><div class="cad-menu-group" role="group" aria-label="模型"><span class="cad-menu-label">模型</span><button type="button" data-program-export="step" hidden>STEP</button><button type="button" data-program-export="stl">STL</button></div><div class="cad-menu-group" role="group" aria-label="图像"><span class="cad-menu-label">图像</span><button type="button" data-program-export="png">四视图</button><button type="button" data-program-export="view-png">当前视图</button></div><div class="cad-menu-group" role="group" aria-label="工程与源码"><span class="cad-menu-label">工程与源码</span><button type="button" data-program-export="json">完整工程</button><button type="button" data-program-export="jscad">JSCAD 代码</button><button type="button" data-program-export="python" hidden>Python 代码</button></div></div></div><hr><button type="button" data-program-open-checks>模型检查</button></div></div>
        <button class="app-button" data-program-source-toggle aria-pressed="false" aria-expanded="false" aria-label="建模代码" title="编辑建模代码与高级设置">${icon("code")}<span>代码</span></button><button class="app-button" data-program-undo aria-label="撤销" title="撤销上次保存">${icon("undo")}</button><button class="app-button is-primary" data-program-save>${icon("save")}保存</button>
      </div></header>
      <div class="cad-workspace">
        <div class="cad-program-stage"><div class="cad-stage">
          <div class="cad-view-controls"><div class="cad-camera-controls"><select class="cad-view-select" data-program-view aria-label="观察方向"><option value="iso">立体视图</option><option value="front">正视图</option><option value="right">右视图</option><option value="top">俯视图</option></select><button class="app-button cad-icon-button" data-program-fit aria-label="显示完整模型" title="显示完整模型">${icon("fit")}</button></div>
            <div class="cad-panel-controls"><button class="app-button" data-program-view-menu aria-haspopup="dialog" aria-expanded="false" hidden>${icon("eye")}<span>视图</span></button><button class="app-button" data-program-parts-toggle aria-expanded="false" aria-label="模型部件" hidden>${icon("cube")}<span>部件 <span data-program-count>0</span></span></button><button class="app-button" data-program-inspector-toggle aria-expanded="false" aria-label="属性与检查" hidden>${icon("sliders")}<span>属性</span></button></div>
          </div>
          <section class="cad-view-panel" data-program-view-panel role="dialog" aria-label="视图设置" hidden>
            <header class="cad-panel-heading"><strong>视图</strong><button class="app-button is-icon" data-program-view-close aria-label="关闭视图设置">${icon("close")}</button></header>
            <div class="cad-view-zoom" data-program-view-zoom></div><div class="cad-view-navigation" data-program-view-navigation aria-label="画布操作"></div>
            <div class="cad-display-options"><label class="cad-program-param">显示方式<select data-program-style><option value="solid">实体</option><option value="transparent">透明</option><option value="wireframe">线框</option></select></label><label class="cad-program-param">爆炸图<input type="range" data-program-explode aria-label="爆炸比例" min="0" max="100" value="0"></label><label class="cad-program-param">剖切方向<select data-program-section><option value="off">关闭</option><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label><label class="cad-program-param" data-program-section-label hidden>剖切位置 (mm)<input type="number" data-program-section-offset value="0" step="any"></label><button class="app-button" data-program-reset-view>恢复默认视图</button></div>
          </section>
          <aside class="cad-features cad-parts-panel" data-program-parts-panel aria-label="模型部件" hidden><input class="cad-part-search" type="search" data-program-filter aria-label="搜索零件" placeholder="搜索零件"><div data-program-objects></div></aside>
          <div class="cad-viewport" data-cad-viewport></div><div class="cad-motion-controls" data-program-motion hidden><button class="app-button" data-program-play aria-label="播放机构运动">播放</button><input type="range" data-program-time aria-label="运动时间" min="0" max="1" step="0.001" value="0"><output data-program-time-label></output><select class="cad-view-select" data-program-speed aria-label="播放速度"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></div>
          <div class="cad-preview-notice" data-program-preview-notice role="status" hidden><span data-program-preview-message></span><button class="app-button" data-program-empty-code hidden>${icon("code")}编写代码</button><button class="app-button" data-program-preview-details hidden>查看原因</button><button class="app-button" data-program-retry hidden>重试</button></div>
        </div><div class="cad-source-panel" data-program-source-panel hidden><div class="cad-source-heading"><span data-program-source-label>代码</span><div><select class="cad-view-select" data-program-budget aria-label="生成时限" title="复杂模型可延长生成时限">${CAD_TIMEOUT_STEPS.map((budget) => `<option value="${budget}">${budget / 1000} 秒</option>`).join("")}</select><button class="app-button" data-program-preview>更新模型</button></div></div><textarea data-program-source aria-label="CAD 建模源码" spellcheck="false"></textarea></div></div>
        <aside class="cad-inspector" aria-label="模型属性与检查" hidden>
          <header class="cad-inspector-heading"><div class="cad-inspector-tabs" role="tablist" aria-label="模型面板"><button type="button" role="tab" data-program-inspector-tab="properties" aria-selected="true">属性</button><button type="button" role="tab" data-program-inspector-tab="checks" aria-selected="false" tabindex="-1">检查</button></div><button class="app-button is-icon" data-program-inspector-close aria-label="关闭属性面板">${icon("close")}</button></header>
          <div data-program-properties role="tabpanel" aria-label="属性"><section data-program-selected-properties aria-label="选中对象" hidden><div class="cad-part-info" data-program-part-info hidden></div><div data-program-selection-actions></div></section><section data-program-parameter-section aria-label="模型参数" hidden><div data-program-parameters></div></section><p class="cad-panel-hint" data-program-properties-empty hidden>未选中零件</p></div>
          <div data-program-check-panel role="tabpanel" aria-label="检查" hidden><div data-program-quality></div><details class="cad-model-info" data-program-preview-error open hidden><summary>计算失败</summary><pre data-program-preview-error-text></pre><button class="app-button" data-program-check-retry>重试计算</button></details><details class="cad-model-info" data-program-diagnostics hidden><summary>计算日志</summary><pre data-program-diagnostics-text></pre></details><details class="cad-model-info"><summary>模型信息</summary><span data-program-engine></span><span data-program-details></span></details></div>
        </aside>
      </div><div class="cad-program-error" data-program-error role="alert" hidden></div><footer class="cad-statusbar"><span data-program-status role="status"></span><span data-program-metrics></span><button class="app-button" data-program-component-settings hidden>在设置中安装</button><button class="app-button" data-program-reload hidden>重新载入（放弃草稿）</button></footer><input data-program-file type="file" accept=".jscad,.js,.py" hidden>
    </section>`;
    const q = (selector) => host.querySelector(selector);
    let disposed = false,
      visible = !host.hidden,
      viewport,
      inspection,
      geometry,
      selected,
      selectedPath,
      previewTimer,
      previewSignature = "",
      previewedSource = "",
      geometrySignature = "",
      previewError = "",
      editing = false,
      busy = false,
      previewing = false,
      previewRequest = 0,
      selectionQueue = Promise.resolve(),
      inspectorPreference = "auto",
      inspectorTab = "properties",
      lastInspectorSelection;
    const kernel = new CadKernelClient({
      preview: (model, options, signal) =>
        api.previewResource(taskId, instance.resourceIds[0], model, options, signal)
    });
    const session = new CadDocumentSession({
      api,
      taskId,
      resourceId: instance.resourceIds[0],
      normalize: normalizeProgram,
      operationType: "cad.program.replace",
      payloadKey: "program",
      changed: () => paint()
    });
    const fileMenu = createMenu(q("[data-program-file-menu]"), q("[data-program-file-panel]"), {
      onClose: () => exportMenu.close()
    });
    const exportMenu = createMenu(q("[data-program-export-menu]"), q("[data-program-export-panel]"));
    q("[data-program-export-menu]").addEventListener("click", (event) => event.stopPropagation());
    q("[data-program-export-menu]").addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        exportMenu.open();
      }
    });
    q("[data-program-export-panel]").addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        exportMenu.close(true);
      }
    });
    const viewPanel = q("[data-program-view-panel]");
    const viewMenu = createMenu(q("[data-program-view-menu]"), viewPanel, {
      closeOnSelect: false,
      onOpen() {
        if (q(".cad-program-editor").clientWidth <= 760) {
          inspectorPreference = "closed";
          syncInspector();
        }
      }
    });
    // Form fields retain their native arrows and Tab order inside the view popover.
    viewPanel.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Tab" || (event.target.matches("input,select,textarea") && event.key !== "Escape"))
          event.stopPropagation();
      },
      true
    );
    viewPanel.addEventListener("focusout", (event) => {
      if (
        event.relatedTarget &&
        !viewPanel.contains(event.relatedTarget) &&
        event.relatedTarget !== q("[data-program-view-menu]")
      )
        viewMenu.close();
    });
    const inspectorResize = new ResizeObserver(syncInspector);
    inspectorResize.observe(q(".cad-program-editor"));
    const hiddenParts = new Set();
    let playing = false;
    const members = (key) =>
      geometry?.features.filter((f) =>
        key?.startsWith("assembly:")
          ? f.path === key.slice(9) || f.path?.startsWith(key.slice(9) + "/")
          : f.id === key
      ) ?? [];
    const selection = () => {
      if (!selected?.startsWith("assembly:")) return geometry?.features.find((part) => part.id === selected);
      const node = geometry?.assembly?.find((n) => n.path === selected.slice(9));
      if (!node) return undefined;
      const parts = members(selected),
        bounds = parts.filter((f) => f.bounds).map((f) => f.bounds);
      return {
        id: selected,
        name: node.name,
        path: node.path,
        bounds: bounds.length
          ? [0, 1].map((side) =>
              [0, 1, 2].map((axis) => Math[side ? "max" : "min"](...bounds.map((b) => b[side][axis])))
            )
          : undefined,
        brep:
          parts.length && parts.every((f) => f.brep)
            ? {
                solids: parts.reduce((sum, f) => sum + f.brep.solids, 0),
                volume: parts.reduce((sum, f) => sum + f.brep.volume, 0)
              }
            : undefined
      };
    };
    function setHidden(key, value) {
      for (const part of members(key)) {
        if (value) hiddenParts.add(part.id);
        else hiddenParts.delete(part.id);
      }
      viewport?.setHidden(key, value);
      paintGeometry(false);
    }
    function syncInspector() {
      const hasModel = Boolean(geometry?.features.length),
        hasParameters = hasModel && Boolean(geometry.definitions.length),
        hasSelection = hasModel && Boolean(selection());
      if (selected && selected !== lastInspectorSelection && hasSelection) {
        const pinnedTree = !q("[data-program-parts-panel]").hidden && q("[data-program-tree-pin]")?.checked;
        inspectorPreference = pinnedTree && q(".cad-program-editor").clientWidth <= 760 ? "closed" : "open";
        inspectorTab = "properties";
      }
      lastInspectorSelection = selected;
      q("[data-program-parameter-section]").hidden = !hasParameters;
      q("[data-program-selected-properties]").hidden = !hasSelection;
      q("[data-program-properties-empty]").hidden = hasParameters || hasSelection;
      const visible =
        inspectorPreference === "open" ||
        (inspectorPreference === "auto" &&
          q(".cad-program-editor").clientWidth > 760 &&
          (hasParameters || hasSelection));
      const panel = q(".cad-inspector");
      panel.hidden = !visible;
      q(".cad-program-editor").dataset.inspectorOpen = String(visible);
      q(".cad-program-editor").dataset.hasModel = String(hasModel);
      q("[data-program-inspector-toggle]").hidden = !hasModel;
      q("[data-program-inspector-toggle]").setAttribute("aria-expanded", String(visible));
      q("[data-program-parts-toggle]").hidden = !hasModel;
      q("[data-program-view-menu]").hidden = !hasModel;
      if (!hasModel) viewMenu.close();
      q("[data-program-properties]").hidden = inspectorTab !== "properties";
      q("[data-program-check-panel]").hidden = inspectorTab !== "checks";
      for (const tab of host.querySelectorAll("[data-program-inspector-tab]")) {
        const active = tab.dataset.programInspectorTab === inspectorTab;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      }
    }
    function openInspector(tab = "properties") {
      viewMenu.close();
      if (q(".cad-program-editor").clientWidth <= 760) {
        q("[data-program-parts-panel]").hidden = true;
        q("[data-program-parts-toggle]").setAttribute("aria-expanded", "false");
      }
      inspectorPreference = "open";
      inspectorTab = tab;
      syncInspector();
      q(`[data-program-inspector-tab="${tab}"]`).focus();
    }
    function closeInspector() {
      inspectorPreference = "closed";
      syncInspector();
      const trigger = q("[data-program-inspector-toggle]");
      (trigger.hidden ? q("[data-program-file-menu]") : trigger).focus();
    }
    function paint() {
      if (disposed || !session.model) return;
      q("[data-program-title]").textContent = session.resource.title;
      const native = session.model.engine === "cadquery";
      q("[data-program-engine]").textContent = native ? "CadQuery · OpenCascade · mm" : "JSCAD 源码工程 · mm";
      q("[data-program-source-label]").textContent = native ? "Python / CadQuery" : "JSCAD 2";
      for (const format of ["python", "step", "jscad"])
        q(`[data-program-export="${format}"]`).hidden = format === "jscad" ? native : !native;
      q("[data-program-file]").accept = native ? ".py" : ".jscad,.js";
      const error = session.error;
      const current = JSON.stringify(session.model) === geometrySignature;
      const empty = current && geometry?.features.length === 0;
      const adjustedPreview = current && geometry?.tessellation?.adjusted;
      inspection?.update(geometry, selected, current && !previewError);
      if (!current || previewError || previewing) viewport?.pause();
      q('[data-program-export="view-png"]').disabled =
        !current || !!previewError || !geometry?.features.length;
      for (const input of host.querySelectorAll(
        ".cad-display-options input,.cad-display-options select,[data-program-motion] input,[data-program-motion] button,[data-program-motion] select"
      ))
        input.disabled = !current || !!previewError;
      syncInspector();
      const sourcePending =
        !!session.resource.sourceFile &&
        session.resource.sourceFile.savedRevision !== session.resource.revision;
      q("[data-program-status]").textContent = session.busy
        ? "正在保存…"
        : session.error
          ? "保存或读取失败"
          : session.dirty
            ? "有未保存修改"
            : sourcePending
              ? "原文件尚未保存，请重试保存"
              : session.resource.sourceFile
                ? "已保存到原文件"
                : "已保存";
      q("[data-program-save]").title = session.resource.sourceFile
        ? `保存到原文件：${session.resource.sourceFile.path}`
        : "保存";
      q("[data-program-save]").classList.toggle("is-primary", Boolean(session.dirty || sourcePending));
      q("[data-program-status]").dataset.revision = String(session.revision);
      q("[data-program-status]").title = `保存版本 r${session.revision}`;
      q("[data-program-status]").dataset.state = session.error
        ? "error"
        : session.busy
          ? "saving"
          : session.dirty || sourcePending
            ? "dirty"
            : "saved";
      q("[data-program-error]").hidden = !error;
      q("[data-program-error]").textContent = error;
      q("[data-program-component-settings]").hidden =
        !native || !/CadQuery.*(?:未安装|已停用|运行时缺失)/i.test(error || previewError);
      q("[data-program-preview-error]").hidden = !previewError;
      q("[data-program-preview-error-text]").textContent = previewError;
      q("[data-program-preview-details]").hidden = !previewError;
      const previewNotice = q("[data-program-preview-notice]");
      previewNotice.classList.toggle("is-error", Boolean(previewError));
      // Recovery actions must remain reachable beside a floating properties panel.
      const noticeParent = previewError ? q(".cad-program-editor") : q(".cad-stage");
      if (previewNotice.parentElement !== noticeParent) {
        if (previewError) noticeParent.insertBefore(previewNotice, q("[data-program-error]"));
        else noticeParent.append(previewNotice);
      }
      q("[data-program-preview-notice]").hidden =
        current && !empty && !previewing && !previewError && !adjustedPreview;
      q("[data-program-preview-message]").textContent = previewing
        ? "正在更新模型…"
        : previewError
          ? geometry
            ? "更新失败，暂时显示上次的模型。你的修改已保留。"
            : "模型生成失败，你的修改已保留。可重试或在代码中修复。"
          : empty
            ? "暂无模型"
            : adjustedPreview
              ? "已调整预览精度，仅影响显示；精确实体与 STEP 导出不变。"
              : geometry
                ? "模型待更新"
                : "正在准备模型…";
      q("[data-program-empty-code]").hidden = !empty || previewing || !!previewError;
      q("[data-program-retry]").hidden = !previewError || previewing || busy;
      q("[data-program-check-retry]").disabled = previewing || busy;
      q("[data-program-retry]").textContent =
        isComputeTimeout(previewError) &&
        Number(q("[data-program-budget]").value) < CAD_COMPUTE_LIMITS.maxTimeoutMs
          ? "延长时限并重试"
          : "重试";
      q("[data-program-objects]")
        .querySelectorAll("button,input")
        .forEach((button) => {
          button.disabled = !current || !!previewError;
        });
      if (current && !previewing && !previewError)
        q("[data-program-metrics]").textContent = empty
          ? "尚未生成模型"
          : `${geometry.dimensions.map((n) => n.toFixed(1)).join(" × ")} mm`;
      else if (!previewing) q("[data-program-metrics]").textContent = "";
      q("[data-program-metrics]").hidden = Boolean(empty);
      q("[data-program-reload]").hidden = !session.error;
      onDirtyChange?.(session.dirty || !!session.pending || sourcePending);
      onContextChange?.({
        title: session.resource.title,
        selection: current && !previewError ? selection()?.name : undefined,
        dirty: session.dirty
      });
      if (!editing && document.activeElement !== q("[data-program-source]"))
        q("[data-program-source]").value = session.model.source;
      q("[data-program-save]").disabled = session.busy || busy;
      q("[data-program-preview]").disabled = previewing || busy;
      q("[data-program-preview]").textContent = previewing ? "更新中…" : "更新模型";
      for (const format of ["step", "stl", "png"])
        q(`[data-program-export="${format}"]`).disabled = Boolean(empty);
      if (!session.busy && !busy && !editing) {
        const signature = JSON.stringify(session.model);
        if (signature !== previewSignature) {
          clearTimeout(previewTimer);
          previewTimer = setTimeout(() => void preview(), 200);
        }
      }
    }
    function paintGeometry(updateViewport = true) {
      const openBranches = new Map(
        [...q("[data-program-objects]").querySelectorAll("[data-program-branch]")].map((element) => [
          element.dataset.programBranch,
          element.open
        ])
      );
      q("[data-program-count]").textContent = String(geometry.features.length);
      q("[data-program-metrics]").textContent =
        `${geometry.dimensions.map((n) => n.toFixed(1)).join(" × ")} mm`;
      q("[data-program-details]").textContent =
        `${geometry.features.length} 个部件 · ${geometry.volume.toFixed(1)} mm³${geometry.brep ? ` · BRep 已验证 · ${geometry.brep.solids} 个实体` : ""}${geometry.tessellation?.adjusted ? " · 已调整预览精度" : ""}`;
      const partRow = (part, label = part.name) =>
        `<div class="cad-part-row" data-part-name="${esc(part.name.toLowerCase())}"><input type="checkbox" data-program-visible="${esc(part.id)}" aria-label="显示零件 ${esc(part.name)}" ${hiddenParts.has(part.id) ? "" : "checked"}><button class="cad-part ${part.id === selected ? "active" : ""}" type="button" data-program-select="${esc(part.id)}" aria-pressed="${part.id === selected}" title="${esc(part.path || part.name)}">${icon("cube")}<span>${esc(label)}</span></button></div>`;
      if (geometry.assembly?.length) {
        const children = new Map(),
          partsByPath = new Map();
        for (const n of geometry.assembly) {
          if (!children.has(n.parent)) children.set(n.parent, []);
          children.get(n.parent).push(n);
        }
        for (const f of geometry.features) {
          if (!partsByPath.has(f.path)) partsByPath.set(f.path, []);
          partsByPath.get(f.path).push(f);
        }
        const branch = (n) => {
          const rows = (partsByPath.get(n.path) ?? []).map((f) => partRow(f, n.name)).join("");
          const descendants = (children.get(n.path) ?? []).map(branch).join("");
          const key = "assembly:" + n.path,
            parts = members(key);
          return descendants
            ? `<details class="cad-assembly-branch" data-program-branch="${esc(n.path)}" ${openBranches.get(n.path) === false ? "" : "open"}><summary title="${esc(n.path)}"><span class="cad-group-row"><input type="checkbox" data-program-group-visible="${esc(key)}" aria-label="显示子装配 ${esc(n.name)}" ${parts.every((f) => !hiddenParts.has(f.id)) ? "checked" : ""}><button type="button" class="cad-part ${selected === key ? "active" : ""}" data-program-select-group="${esc(key)}" aria-pressed="${selected === key}">${icon("cube")}<span>${esc(n.name)}</span><small>${parts.length}</small></button></span></summary>${rows}${descendants}</details>`
            : rows;
        };
        q("[data-program-objects]").innerHTML = (children.get(undefined) ?? []).map(branch).join("");
      } else q("[data-program-objects]").innerHTML = geometry.features.map((f) => partRow(f)).join("");
      for (const input of q("[data-program-objects]").querySelectorAll("[data-program-group-visible]")) {
        const parts = members(input.dataset.programGroupVisible),
          shown = parts.filter((f) => !hiddenParts.has(f.id)).length;
        input.indeterminate = shown > 0 && shown < parts.length;
      }
      filterParts();
      q("[data-program-motion]").hidden = !geometry.motion;
      q("[data-program-time]").max = String(geometry.motion?.duration ?? 1);
      q("[data-program-diagnostics]").hidden = !geometry.diagnostics;
      q("[data-program-diagnostics-text]").textContent = geometry.diagnostics || "";
      if (!q("[data-program-parameters]").contains(document.activeElement))
        q("[data-program-parameters]").innerHTML =
          geometry.definitions
            .map((d) => {
              const value = session.model.parameters[d.name] ?? geometry.parameters[d.name];
              const input =
                d.type === "choice"
                  ? `<select data-program-param="${esc(d.name)}">${(d.values ?? []).map((v, i) => `<option value="${i}" ${v === value ? "selected" : ""}>${esc(d.captions?.[i] ?? v)}</option>`).join("")}</select>`
                  : d.type === "checkbox"
                    ? `<input type="checkbox" data-program-param="${esc(d.name)}" ${value ? "checked" : ""}>`
                    : `<input type="${d.type === "text" ? "text" : "number"}" data-program-param="${esc(d.name)}" value="${esc(value)}" ${d.min != null ? `min="${d.min}"` : ""} ${d.max != null ? `max="${d.max}"` : ""} step="${d.type === "int" ? 1 : (d.step ?? "any")}" ${d.type === "text" ? "" : "required"}>`;
              return `<label class="cad-program-param">${esc(d.caption || d.name)}${input}</label>`;
            })
            .join("") || "";
      const part = selection();
      const selectedPart = part ? { id: part.id, position: [0, 0, 0], rotation: [0, 0, 0] } : undefined;
      if (updateViewport) viewport?.update(geometry, selectedPart);
      else viewport?.select(selectedPart);
      q("[data-program-part-info]").hidden = !part;
      q("[data-program-part-info]").textContent = part
        ? `${part.name} · ${part.bounds ? part.bounds[1].map((n, a) => (n - part.bounds[0][a]).toFixed(1)).join(" × ") + " mm" : ""}${part.brep ? ` · ${part.brep.volume.toFixed(1)} mm³ · ${part.brep.solids} 个有效实体` : ""}`
        : "";
      syncInspector();
      q("[data-cad-viewport]").dataset.ready = "true";
      inspection?.update(
        geometry,
        selected,
        JSON.stringify(session.model) === geometrySignature && !previewError
      );
      onContextChange?.({ title: session.resource.title, selection: part?.name, dirty: session.dirty });
    }
    async function preview() {
      if (disposed || !session.model || busy) return false;
      clearTimeout(previewTimer);
      const model = structuredClone(session.model),
        signature = JSON.stringify(model);
      previewSignature = signature;
      const request = ++previewRequest;
      previewing = true;
      paint();
      q("[data-program-metrics]").textContent = "";
      try {
        const result = await kernel.request("mesh", model, undefined, {
          timeoutMs: Number(q("[data-program-budget]").value)
        });
        if (!result || disposed || JSON.stringify(session.model) !== signature) return false;
        previewError = "";
        const hiddenPaths = new Set(
          [...hiddenParts].map((id) => geometry?.features.find((f) => f.id === id)?.path ?? id)
        );
        hiddenParts.clear();
        for (const f of result.features) if (hiddenPaths.has(f.path ?? f.id)) hiddenParts.add(f.id);
        const previousSelection = selected;
        geometry = result;
        geometrySignature = signature;
        if (selectedPath && !selected?.startsWith("assembly:"))
          selected = geometry.features.find((part) => part.path === selectedPath)?.id;
        const removedSelection = (selected || selectedPath) && !selection();
        if (removedSelection) selectedPath = undefined;
        if (removedSelection) selected = undefined;
        paintGeometry();
        if (removedSelection) void guard(() => persistSelection(undefined));
        else if (selected && selected !== previousSelection) void guard(() => persistSelection(selected));
        if (previewedSource !== model.source) viewport?.fit(q("[data-program-view]").value);
        previewedSource = model.source;
        return true;
      } catch (error) {
        if (!disposed && JSON.stringify(session.model) === signature) {
          previewError = error.message;
          q("[data-program-metrics]").textContent = "";
          paint();
        }
        return false;
      } finally {
        if (request === previewRequest) {
          previewing = false;
          paint();
        }
      }
    }
    const guard = async (action) => {
      if (disposed) return;
      try {
        await action();
      } catch (error) {
        if (!disposed) {
          session.error = error.message;
          paint();
        }
      }
    };
    const save = async () => {
      if (busy) return false;
      const invalid = [...q("[data-program-parameters]").querySelectorAll("input,select")].find(
        (input) => !input.checkValidity()
      );
      if (invalid) {
        session.error = "请填写有效的设计参数，当前草稿已保留";
        invalid.reportValidity();
        paint();
        return false;
      }
      return session.save();
    };
    function filterParts() {
      const text = q("[data-program-filter]").value.trim().toLowerCase();
      for (const row of q("[data-program-objects]").querySelectorAll("[data-part-name]"))
        row.hidden = !row.dataset.partName.includes(text);
      for (const branch of [...q("[data-program-objects]").querySelectorAll("details")].reverse()) {
        branch.hidden = ![...branch.querySelectorAll("[data-part-name]")].some((row) => !row.hidden);
        if (text) branch.open = true;
      }
    }
    const change = (event) =>
      void guard(async () => {
        if (event.target.matches("[data-program-view]")) {
          viewport?.fit(event.target.value);
          return;
        }
        if (event.target.matches("[data-program-filter]")) {
          filterParts();
          return;
        }
        if (event.target.matches("[data-program-visible]")) {
          const id = event.target.dataset.programVisible;
          setHidden(id, !event.target.checked);
          return;
        }
        if (event.target.matches("[data-program-group-visible]")) {
          setHidden(event.target.dataset.programGroupVisible, !event.target.checked);
          return;
        }
        if (event.target.matches("[data-program-style]")) {
          viewport?.setStyle(event.target.value);
          return;
        }
        if (event.target.matches("[data-program-explode]")) {
          viewport?.setExplode(Number(event.target.value) / 100);
          return;
        }
        if (event.target.matches("[data-program-section],[data-program-section-offset]")) {
          inspection?.clearSections();
          const axis = q("[data-program-section]").value;
          q("[data-program-section-label]").hidden = axis === "off";
          const offset = q("[data-program-section-offset]");
          if (offset.value !== "" && offset.checkValidity())
            viewport?.setSection(axis === "off" ? undefined : { axis, offset: Number(offset.value) });
          return;
        }
        if (event.target.matches("[data-program-time]")) {
          const time = Number(event.target.value);
          viewport?.pause();
          viewport?.setTime(time);
          return;
        }
        if (event.target.matches("[data-program-speed]")) {
          viewport?.setSpeed(Number(event.target.value));
          return;
        }
        const input = event.target.closest("[data-program-param]");
        if (!input) return;
        const definition = geometry?.definitions.find((d) => d.name === input.dataset.programParam);
        if (!definition) return;
        if (!["choice", "checkbox", "text"].includes(definition.type) && input.value === "") return;
        const value =
          definition.type === "choice"
            ? definition.values[Number(input.value)]
            : definition.type === "checkbox"
              ? input.checked
              : definition.type === "text"
                ? input.value
                : Number(input.value);
        if (session.model.parameters[definition.name] === value) return;
        session.edit({
          ...session.model,
          parameters: { ...session.model.parameters, [definition.name]: value }
        });
        // paint schedules a cancellable preview after typing settles.
      });
    host.addEventListener("input", change);
    host.addEventListener("change", change);
    q("[data-program-source-panel]").addEventListener("focusin", () => {
      if (q(".cad-program-editor").clientWidth > 760) return;
      viewMenu.close();
      q("[data-program-parts-panel]").hidden = true;
      q("[data-program-parts-toggle]").setAttribute("aria-expanded", "false");
      inspectorPreference = "closed";
      syncInspector();
    });
    q("[data-program-source]").addEventListener(
      "input",
      () =>
        void guard(async () => {
          editing = true;
          session.edit({ ...session.model, source: q("[data-program-source]").value });
        })
    );
    q("[data-program-source]").addEventListener("blur", () => {
      editing = false;
      paint();
    });
    const click = (event) =>
      void guard(async () => {
        const target = event.target.closest("button");
        if (!target) return;
        if (target.hasAttribute("data-program-component-settings")) openComponentSettings("cadquery");
        if (target.hasAttribute("data-program-view-close")) viewMenu.close(true);
        if (target.hasAttribute("data-program-inspector-close")) closeInspector();
        if (target.hasAttribute("data-program-inspector-toggle")) {
          if (q(".cad-inspector").hidden)
            openInspector(geometry?.definitions.length || selection() ? "properties" : "checks");
          else closeInspector();
        }
        if (
          target.hasAttribute("data-program-open-checks") ||
          target.hasAttribute("data-program-preview-details")
        )
          openInspector("checks");
        if (target.dataset.programInspectorTab) {
          inspectorTab = target.dataset.programInspectorTab;
          syncInspector();
        }
        if (
          target.hasAttribute("data-program-source-toggle") ||
          target.hasAttribute("data-program-empty-code")
        ) {
          const panel = q("[data-program-source-panel]");
          panel.hidden = target.hasAttribute("data-program-empty-code") ? false : !panel.hidden;
          q("[data-program-source-toggle]").setAttribute("aria-pressed", String(!panel.hidden));
          q("[data-program-source-toggle]").setAttribute("aria-expanded", String(!panel.hidden));
          if (!panel.hidden) q("[data-program-source]").focus();
        }
        if (target.hasAttribute("data-program-play")) {
          if (playing) viewport?.pause();
          else viewport?.play();
        }
        if (target.hasAttribute("data-program-reset-view")) {
          hiddenParts.clear();
          inspection?.reset();
          q("[data-program-style]").value = "solid";
          q("[data-program-explode]").value = "0";
          q("[data-program-section]").value = "off";
          q("[data-program-section-label]").hidden = true;
          viewport?.resetView();
          q("[data-program-objects]")
            .querySelectorAll("[data-program-visible]")
            .forEach((input) => {
              input.checked = true;
            });
          viewport?.fit();
        }
        if (target.hasAttribute("data-program-preview")) {
          editing = false;
          await preview();
        }
        if (target.hasAttribute("data-program-retry") || target.hasAttribute("data-program-check-retry")) {
          if (isComputeTimeout(previewError)) {
            const current = Number(q("[data-program-budget]").value);
            const next = CAD_TIMEOUT_STEPS.find((budget) => budget > current);
            if (next !== undefined) q("[data-program-budget]").value = String(next);
          }
          await preview();
          if (target.hasAttribute("data-program-check-retry"))
            q('[data-program-inspector-tab="checks"]').focus();
          else
            (q("[data-program-view-menu]").hidden
              ? q("[data-program-fit]")
              : q("[data-program-view-menu]")
            ).focus();
        }
        if (target.hasAttribute("data-program-parts-toggle")) {
          const panel = q("[data-program-parts-panel]");
          panel.hidden = !panel.hidden;
          target.setAttribute("aria-expanded", String(!panel.hidden));
          if (!panel.hidden && q(".cad-program-editor").clientWidth <= 760) {
            inspectorPreference = "closed";
            syncInspector();
          }
        }
        if (target.hasAttribute("data-program-save")) {
          editing = false;
          await save();
        }
        if (target.hasAttribute("data-program-fit")) viewport?.fit(q("[data-program-view]").value);
        if (target.dataset.programSelect) await select(target.dataset.programSelect);
        if (target.dataset.programSelectGroup) {
          event.preventDefault();
          await select(target.dataset.programSelectGroup);
        }
        if (target.hasAttribute("data-program-undo")) await session.undo();
        if (target.hasAttribute("data-program-reload")) {
          editing = false;
          previewError = "";
          await session.reload();
        }
        if (target.hasAttribute("data-program-rename"))
          nameDocument(host, {
            title: "重命名模型",
            value: session.resource.title,
            submitLabel: "保存名称",
            async onSubmit(title) {
              if (!(await save())) throw new Error(session.error);
              await api.renameResource(taskId, session.resource.resourceId, title);
              await session.refresh();
              onChanged?.();
            }
          });
        if (target.hasAttribute("data-program-import")) q("[data-program-file]").click();
        if (target.dataset.programExport) {
          const type = target.dataset.programExport;
          if (type === "view-png") {
            const blob = await viewport?.capture();
            if (!blob) throw new Error("当前视图截图失败，请重试");
            download(blob, session.resource.title.replace(/\.cad\.json$/i, "") + "-view.png");
            return;
          }
          if (type === "json") {
            download(
              new Blob([JSON.stringify(session.model, null, 2)], { type: "application/json" }),
              session.resource.title
            );
            return;
          }
          if (!(await save())) return;
          busy = true;
          // Preview and export share a cancellable worker; don't cancel an export with a timer.
          clearTimeout(previewTimer);
          paint();
          try {
            if (type === "stl" && session.model.engine !== "cadquery") {
              const result = await kernel.request("stl", session.model, undefined, {
                timeoutMs: Number(q("[data-program-budget]").value)
              });
              if (result) download(result.blob, session.resource.title.replace(/\.cad\.json$/i, "") + ".stl");
            } else {
              const link = document.createElement("a");
              if (type === "png") {
                const url = new URL(
                  api.downloadUrl(taskId, session.resource.resourceId, "png"),
                  location.href
                );
                url.searchParams.set(
                  "options",
                  JSON.stringify({ timeoutMs: Number(q("[data-program-budget]").value) })
                );
                q("[data-program-metrics]").textContent = "正在生成四视图…";
                const response = await fetch(url);
                if (!response.ok) {
                  const failure = await response.json().catch(() => ({}));
                  throw new Error(failure.error?.message || "四视图计算失败；源码已保存");
                }
                download(
                  await response.blob(),
                  session.resource.title.replace(/\.cad\.json$/i, "") + "-views.png"
                );
              } else if (type === "step" || type === "stl") {
                q("[data-program-metrics]").textContent = "正在导出精确设计…";
                const url = new URL(
                  api.downloadUrl(taskId, session.resource.resourceId, type),
                  location.href
                );
                url.searchParams.set(
                  "options",
                  JSON.stringify({ timeoutMs: Number(q("[data-program-budget]").value) })
                );
                const response = await fetch(url);
                if (!response.ok) {
                  const failure = await response.json().catch(() => ({}));
                  throw new Error(failure.error?.message || "导出失败；源码已保留");
                }
                download(
                  await response.blob(),
                  session.resource.title.replace(/\.cad\.json$/i, "") + "." + type
                );
              } else {
                link.href = api.downloadUrl(taskId, session.resource.resourceId, type);
                link.download =
                  session.resource.title.replace(/\.cad\.json$/i, "") +
                  (type === "python" ? ".py" : ".jscad");
                link.click();
              }
            }
          } finally {
            busy = false;
            previewSignature = "";
            paint();
          }
        }
      });
    host.addEventListener("click", click);
    const key = (event) => {
      if (
        event.target.matches("[data-program-inspector-tab]") &&
        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      ) {
        event.preventDefault();
        openInspector(
          event.key === "Home"
            ? "properties"
            : event.key === "End"
              ? "checks"
              : inspectorTab === "properties"
                ? "checks"
                : "properties"
        );
      }
      if (event.key === "Escape" && q(".cad-inspector").contains(event.target)) {
        event.preventDefault();
        closeInspector();
        return;
      }
      if (event.key === "Escape" && !q("[data-program-parts-panel]").hidden) {
        q("[data-program-parts-panel]").hidden = true;
        q("[data-program-parts-toggle]").setAttribute("aria-expanded", "false");
        q("[data-program-parts-toggle]").focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        editing = false;
        void guard(save);
      }
    };
    host.addEventListener("keydown", key);
    q("[data-program-file]").addEventListener(
      "change",
      (event) =>
        void guard(async () => {
          const file = event.target.files?.[0];
          if (!file) return;
          if (
            session.model.engine === "cadquery"
              ? !file.name.endsWith(".py")
              : !/\.(js|jscad)$/i.test(file.name)
          )
            throw new Error("请导入与当前引擎一致的源码文件");
          if (file.size > CAD_COMPUTE_LIMITS.maxSourceBytes)
            throw new Error(`源码超过 ${CAD_COMPUTE_LIMITS.maxSourceBytes / (1024 * 1024)} MiB`);
          session.edit({ ...session.model, source: await file.text(), parameters: {} });
          q("[data-program-source]").value = session.model.source;
          editing = false;
          await preview();
          event.target.value = "";
        })
    );
    async function select(id, keepPanel = false) {
      if (JSON.stringify(session.model) !== geometrySignature || previewError) return;
      selected = id;
      selectedPath = selection()?.path;
      paintGeometry(false);
      if (!keepPanel && !q("[data-program-tree-pin]")?.checked) {
        q("[data-program-parts-panel]").hidden = true;
        q("[data-program-parts-toggle]").setAttribute("aria-expanded", "false");
      }
      await persistSelection(id);
    }
    function persistSelection(id) {
      const resourceId = session.resource.resourceId,
        selection = {
          appInstanceId: instance.appInstanceId,
          schema: id?.startsWith("assembly:") ? "cad.assembly-node/v1" : "cad.program-solid/v1",
          data: id?.startsWith("assembly:")
            ? { path: id.slice(9) }
            : id
              ? { id, ...(selectedPath ? { path: selectedPath } : {}) }
              : {}
        };
      selectionQueue = selectionQueue
        .catch(() => {})
        .then(() => api.saveSelection(taskId, resourceId, selection));
      return selectionQueue;
    }
    await session.load();
    q("[data-program-budget]").value = String(defaultComputeBudget(session.model));
    if (session.selection?.schema === "cad.program-solid/v1") {
      selected = session.selection.data?.id;
      selectedPath = session.selection.data?.path;
    }
    if (session.selection?.schema === "cad.assembly-node/v1") {
      selectedPath = session.selection.data?.path;
      if (selectedPath) selected = "assembly:" + selectedPath;
    }
    try {
      const { createCadViewport } = await import("../../cad/generated/viewport.js");
      viewport = createCadViewport(q("[data-cad-viewport]"), {
        onContextMenu: (value) => inspection?.context(value),
        onCamera: (value) => inspection?.camera(value),
        onMeasure: (value) => inspection?.measure(value),
        onTime: ({ time, playing: active, duration }) => {
          if (disposed) return;
          playing = active;
          q("[data-program-time]").value = String(time);
          q("[data-program-time-label]").textContent = `${time.toFixed(2)} / ${duration.toFixed(2)} s`;
          q("[data-program-play]").textContent = active ? "暂停" : "播放";
          q("[data-program-play]").setAttribute("aria-label", active ? "暂停机构运动" : "播放机构运动");
        },
        onSelect: (id) => {
          void guard(() => select(id));
        }
      });
      viewport.setEditable(false);
      inspection = createCadInspectionPanel(host, {
        viewport,
        select: (id, keepPanel) => guard(() => select(id, keepPanel)),
        members,
        selection,
        setHidden,
        hideOthers: (key) => {
          const keep = new Set(members(key).map((p) => p.id));
          hiddenParts.clear();
          for (const part of geometry.features) if (!keep.has(part.id)) hiddenParts.add(part.id);
          viewport.hideOthers(key);
          paintGeometry(false);
        },
        showAll: () => {
          hiddenParts.clear();
          viewport.showAll();
          paintGeometry(false);
        },
        download,
        title: () => session.resource.title,
        resourceId: () => session.resource.resourceId,
        revision: () => session.revision,
        closeView: () => viewMenu.close(true),
        focusView: () => q("[data-program-view-menu]").focus(),
        openInspector
      });
      // Mount immediately; long geometry jobs must not keep the workspace hidden.
      void preview();
    } catch (error) {
      previewError = `三维视图不可用：${error.message}`;
      paint();
    }
    const poll = createVisiblePoll({ run: () => session.refresh(), intervalMs: 3000, active: visible });
    return {
      setVisible(value) {
        visible = Boolean(value);
        poll.setActive(visible);
      },
      focus: () => q("[data-cad-viewport]").focus(),
      captureUiState: () => ({ selected, selectedPath }),
      restoreUiState: (state) => {
        if (state && Object.hasOwn(state, "selected")) {
          selected = state.selected;
          selectedPath = state.selectedPath;
        }
        if (geometry) paintGeometry(false);
      },
      getSelection: () =>
        selected && !previewError && JSON.stringify(session.model) === geometrySignature
          ? {
              schema: selected.startsWith("assembly:") ? "cad.assembly-node/v1" : "cad.program-solid/v1",
              data: selected.startsWith("assembly:")
                ? { path: selected.slice(9) }
                : { id: selected, ...(selectedPath ? { path: selectedPath } : {}) }
            }
          : undefined,
      canClose: async () => !busy && (await save()),
      flush: save,
      handleResourceEvent: (event) =>
        event.type === "resource.selection_changed" ||
        event.revision <= session.revision ||
        !visible ||
        document.hidden
          ? true
          : session.refresh(),
      async unmount() {
        disposed = true;
        clearTimeout(previewTimer);
        poll.dispose();
        session.persist();
        kernel.dispose();
        inspection?.dispose();
        viewport?.dispose();
        fileMenu.dispose();
        exportMenu.dispose();
        viewMenu.dispose();
        inspectorResize.disconnect();
        host.removeEventListener("input", change);
        host.removeEventListener("change", change);
        host.removeEventListener("click", click);
        host.removeEventListener("keydown", key);
        host.innerHTML = "";
      }
    };
  }
};
