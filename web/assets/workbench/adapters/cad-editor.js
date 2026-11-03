import { mountLocalFileOpener, readLocalText } from "./local-file-opener.js";
import { cadProgramEditor } from "./cad-program-editor.js";
import { CAD_PROGRAM_KIND, CADQUERY_PROGRAM_KIND, isCadProgram } from "../../cad/generated/program.js";
import { programFromModel } from "../../cad/generated/migration.js";
import { escapeHtml as esc } from "../html.js";
import { nameDocument } from "./document-name-dialog.js";
import { CAD_APP, CAD_KIND, MAX_PARTS, normalizeModel } from "../../cad/generated/model.js";
import { createPlacedPart, duplicatePart } from "../../cad/generated/interaction.js";
import { CadDocumentSession } from "../../cad/document-session.js";
import { CadKernelClient } from "../../cad/kernel-client.js";
import { icon } from "../../ui/icons.js";
import { createMenu } from "../../ui/menu.js";
import { createVisiblePoll } from "../../ui/visible-poll.js";
import { openComponentSettings } from "../component-entry.js";
const label = { box: "长方体", cylinder: "圆柱体", sphere: "球体" };
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readImportedFile(file) {
  const text = await readLocalText(file);
  let initialContent;
  if (/\.json$/i.test(file.name)) initialContent = JSON.parse(text);
  else if (/\.(py|js|jscad)$/i.test(file.name))
    initialContent = {
      version: 2,
      engine: /\.py$/i.test(file.name) ? "cadquery" : "jscad",
      units: "mm",
      source: text,
      parameters: {}
    };
  else throw new Error("请选择 CAD JSON、Python 或 JSCAD 文件");
  const kind = isCadProgram(initialContent)
    ? initialContent.engine === "cadquery"
      ? CADQUERY_PROGRAM_KIND
      : CAD_PROGRAM_KIND
    : CAD_KIND;
  return { kind, title: file.name, initialContent };
}

const legacyCadEditorAdapter = {
  readFile: readImportedFile,
  definition: {
    appType: CAD_APP,
    displayName: "参数化 CAD",
    icon: "i-cad",
    version: "1",
    resourceKinds: [CADQUERY_PROGRAM_KIND, CAD_PROGRAM_KIND, CAD_KIND]
  },
  canOpen: (resource) => [CADQUERY_PROGRAM_KIND, CAD_PROGRAM_KIND, CAD_KIND].includes(resource?.kind),
  async mount(host, { instance, taskId, api, onDirtyChange, onChanged, onContextChange }) {
    if (!instance.resourceIds[0]) {
      host.innerHTML = `<section class="cad-empty application-home" aria-label="参数化 CAD"><div class="cad-empty-symbol application-home-icon">${icon("cad")}</div><h2>参数化 CAD</h2><div class="application-home-actions"><button class="app-button is-primary" data-cad-new type="button">${icon("plus")}新建 CAD 模型</button></div><div data-cad-component-entry hidden><p>精确建模组件不可用</p><button class="app-button" data-cad-component-settings type="button">检查组件</button></div><div class="application-home-files" data-cad-existing></div><details class="cad-home-more" data-cad-more><summary>更多</summary><button class="app-button" data-cad-new-basic type="button">新建基础形体模型</button></details></section>`;
      host.querySelector("[data-cad-component-settings]").onclick = () => openComponentSettings("cadquery");
      const componentStatus = fetch("/api/components")
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined);
      const createDocument = (kind) => () =>
        nameDocument(host, {
          title: "新建 CAD 模型",
          value: "未命名.cad.json",
          submitLabel: "创建",
          async onSubmit(title) {
            await api.createInApplication(taskId, instance.appInstanceId, {
              kind,
              title: title.endsWith(".cad.json") ? title : `${title}.cad.json`
            });
            await api.onDocumentCreated?.();
          }
        });
      host.querySelector("[data-cad-new]").onclick = createDocument(CADQUERY_PROGRAM_KIND);
      host.querySelector("[data-cad-new-basic]").onclick = createDocument(CAD_KIND);
      const opener = mountLocalFileOpener(host.querySelector(".application-home-actions"), {
        accept: ".cad.json,.json,.py,.jscad,.js",
        api,
        taskId,
        instance,
        read: readImportedFile
      });
      const [{ resources }, components] = await Promise.all([api.listResources(taskId), componentStatus]);
      const native = components?.components?.find((component) => component.id === "cadquery");
      host.querySelector("[data-cad-component-entry]").hidden = !native || native.available;
      const list = host.querySelector("[data-cad-existing]");
      list.innerHTML = resources
        .filter((r) => [CAD_KIND, CAD_PROGRAM_KIND, CADQUERY_PROGRAM_KIND].includes(r.kind))
        .map(
          (r) =>
            `<button class="app-button" data-cad-open="${esc(r.resourceId)}">${icon("file")}${esc(r.title)}</button>`
        )
        .join("");
      list.querySelectorAll("[data-cad-open]").forEach((button) => {
        button.onclick = () => api.openResourceInTab?.(taskId, button.dataset.cadOpen);
      });
      return {
        canClose: () => true,
        async unmount() {
          opener.dispose();
          host.innerHTML = "";
        },
        captureUiState() {
          return {};
        }
      };
    }
    host.innerHTML = `<section class="cad-editor" aria-label="参数化 CAD">
      <header class="cad-toolbar"><div class="cad-identity"><span class="app-icon-badge">${icon("cad")}</span><div><button class="cad-document-title" data-cad-rename type="button" title="重命名模型" aria-label="重命名模型"><span data-cad-title></span>${icon("pencil", "cad-title-pencil")}</button></div></div><div class="cad-actions"><button class="app-button is-icon" data-cad-code aria-label="升级为源码建模" title="保留现有设计，升级为完整 JSCAD 源码">${icon("code")}</button>
        <div class="ui-menu-anchor"><button class="app-button" type="button" data-cad-file-menu aria-haspopup="menu" aria-expanded="false">文件${icon("chevron-down")}</button><div class="ui-menu" data-cad-file-actions role="menu" aria-label="模型文件操作" hidden><button class="app-button" role="menuitem" data-cad-import>${icon("upload")}导入 JSON</button><button class="app-button" role="menuitem" data-cad-json>${icon("download")}下载 JSON</button><div class="ui-menu-divider" role="separator"></div><button class="app-button" role="menuitem" data-cad-stl>${icon("cube")}导出 STL</button></div></div>
        <button class="app-button is-icon" data-cad-undo title="撤销上一次修改" aria-label="撤销">${icon("undo")}</button><button class="app-button is-primary" data-cad-save title="保存（⌘/Ctrl+S）">${icon("save")}保存</button>
      </div></header>
      <div class="cad-workspace"><aside class="cad-features"><div class="cad-panel-label">模型特征 <span data-cad-count></span></div><div class="cad-add"><button class="app-button" data-cad-add="box" title="添加长方体">${icon("cube")}<span>方体</span></button><button class="app-button" data-cad-add="cylinder" title="添加圆柱">${icon("cylinder")}<span>圆柱</span></button><button class="app-button" data-cad-add="sphere" title="添加球体">${icon("sphere")}<span>球体</span></button></div><p class="cad-panel-hint" data-cad-add-hint role="status" hidden></p><div data-cad-parts></div><details class="cad-history"><summary>修改历史</summary><div data-cad-history></div></details></aside>
        <div class="cad-stage"><div class="cad-view-controls"><div><button class="app-button" data-cad-mode="select" aria-pressed="true" aria-label="点选" title="点选（V）">${icon("select")}<span class="cad-control-label">点选</span></button><button class="app-button" data-cad-mode="translate" aria-pressed="false" aria-label="移动" title="移动（G）">${icon("move")}<span class="cad-control-label">移动</span></button><button class="app-button" data-cad-mode="rotate" aria-pressed="false" aria-label="旋转" title="旋转（R）">${icon("rotate")}<span class="cad-control-label">旋转</span></button><label class="cad-snap"><input data-cad-snap type="checkbox">吸附</label></div><div><button class="app-button" data-cad-view="iso" aria-label="等轴" title="等轴">${icon("cube")}<span class="cad-control-label">等轴</span></button><button class="app-button" data-cad-view="front" aria-label="正视" title="正视">${icon("front")}<span class="cad-control-label">正视</span></button><button class="app-button" data-cad-view="top" aria-label="俯视" title="俯视">${icon("top")}<span class="cad-control-label">俯视</span></button><button class="app-button" data-cad-view="fit" aria-label="适应" title="适应">${icon("fit")}<span class="cad-control-label">适应</span></button><button class="app-button" data-cad-view="selected" aria-label="定位选中" title="定位选中（F）">${icon("focus")}<span class="cad-control-label">定位选中</span></button></div></div><div class="cad-viewport" data-cad-viewport></div><details class="cad-stage-help"><summary aria-label="视图操作帮助" title="视图操作帮助">${icon("info")}</summary><div data-cad-hint>点击形体选择 · 空白处拖动旋转 · 滚轮缩放</div></details><div class="cad-model-empty" data-cad-empty>添加实体，开始建模</div></div>
        <aside class="cad-inspector"><div class="cad-panel-label">特征参数</div><form data-cad-form></form></aside>
      </div><footer class="cad-statusbar"><span class="ui-status" data-cad-status role="status"></span><span data-cad-metrics></span><button class="app-button" data-cad-reload hidden>重新载入保存版本（放弃草稿）</button></footer>
      <input data-cad-file type="file" accept=".json,.cad.json,application/json" hidden>
    </section>`;
    const q = (selector) => host.querySelector(selector);
    const fileMenu = createMenu(q("[data-cad-file-menu]"), q("[data-cad-file-actions]"));
    const kernel = new CadKernelClient();
    let viewport,
      selected,
      disposed = false,
      visible = !host.hidden,
      previewTimer,
      lastPreview = "",
      exportBusy = false,
      mode = "select",
      fitPending = false,
      dragDraft;
    const session = new CadDocumentSession({
      api,
      taskId,
      resourceId: instance.resourceIds[0],
      changed: paint
    });
    function report(error) {
      session.error = error.message;
      paint();
    }
    async function guard(action) {
      try {
        await action();
      } catch (error) {
        report(error);
      }
    }
    function field(key, title, value, min, max) {
      return `<label>${title}<input data-cad-field="${key}" aria-label="${title}" type="number" step="0.1" min="${min}" max="${max}" value="${esc(value ?? "")}"></label>`;
    }
    function paintForm(force = false) {
      if (!force && q("[data-cad-form]").contains(document.activeElement)) return;
      const part = session.model?.parts.find((p) => p.id === selected);
      q("[data-cad-form]").innerHTML = part
        ? `<div class="cad-feature-kind" title="${esc(part.id)}">${label[part.shape]}</div>
        <label>名称<input data-cad-field="name" aria-label="特征名称" value="${esc(part.name)}" maxlength="80"></label>
        <label>作用<select data-cad-field="mode" aria-label="特征作用"><option value="add" ${part.mode === "add" ? "selected" : ""}>合并实体</option><option value="cut" ${part.mode === "cut" ? "selected" : ""}>切除材料</option></select></label>
        <fieldset><legend>尺寸 · mm</legend>${part.shape === "box" ? ["宽度 X", "深度 Y", "高度 Z"].map((name, i) => field(`size.${i}`, name, part.size[i], 0.1, 1000)).join("") : field("radius", "半径", part.radius, 0.1, 500) + (part.shape === "cylinder" ? field("height", "高度", part.height, 0.1, 1000) : "")}</fieldset>
        <fieldset><legend>中心位置 · mm</legend>${["X", "Y", "Z"].map((name, i) => field(`position.${i}`, `位置 ${name}`, part.position[i], -2000, 2000)).join("")}</fieldset>
        <fieldset><legend>旋转 · °</legend>${["X", "Y", "Z"].map((name, i) => field(`rotation.${i}`, `旋转 ${name}`, part.rotation[i], -360, 360)).join("")}</fieldset>
        <div class="cad-feature-actions"><button data-cad-duplicate type="button" class="app-button is-secondary">${icon("copy")}复制特征</button><button data-cad-delete type="button" class="app-button is-danger cad-delete">${icon("trash")}删除特征</button></div>`
        : '<p class="cad-panel-hint">未选中特征</p>';
      for (const control of q("[data-cad-form]").querySelectorAll("input, select, button"))
        control.disabled = session.busy || !!session.pending || exportBusy || !!viewport?.isDragging;
      const duplicate = q("[data-cad-duplicate]");
      if (duplicate && session.model.parts.length >= MAX_PARTS) duplicate.disabled = true;
    }
    function paint() {
      if (disposed || !session.model) return;
      const parts = session.model.parts;
      if (selected !== null && !parts.some((p) => p.id === selected)) selected = parts[0]?.id;
      q("[data-cad-title]").textContent = session.resource.title;
      q("[data-cad-rename]").title = `${session.resource.title} · 重命名模型`;
      q("[data-cad-count]").textContent = `${parts.length}/${MAX_PARTS}`;
      q("[data-cad-add-hint]").hidden = parts.length < MAX_PARTS;
      q(".cad-add").title = "新形体放在模型旁，选中后可拖动手柄移动。";
      q("[data-cad-add-hint]").textContent =
        parts.length >= MAX_PARTS
          ? `已达到 ${MAX_PARTS} 个特征上限。可继续编辑，删除不需要的特征后再添加。`
          : "新形体放在模型旁，选中后可拖动手柄移动。";
      q("[data-cad-empty]").hidden = !!parts.length;
      q("[data-cad-parts]").innerHTML = parts
        .map(
          (p) =>
            `<button class="cad-part ${selected === p.id ? "is-selected" : ""}" data-cad-select="${esc(p.id)}" aria-pressed="${selected === p.id}" title="${esc(p.name)} · ${p.mode === "cut" ? "切除" : label[p.shape]}"><span class="cad-part-symbol">${icon(p.shape === "box" ? "cube" : p.shape)}</span><div><strong>${esc(p.name)}</strong></div></button>`
        )
        .join("");
      q("[data-cad-history]").innerHTML =
        [...(session.operations ?? [])]
          .reverse()
          .slice(0, 20)
          .map(
            (event) =>
              `<div><b>r${event.revision}</b> ${esc(event.actor?.type === "agent" ? "CoworkOS" : "你")} · ${esc(event.summary)}</div>`
          )
          .join("") || "还没有修改记录";
      paintForm();
      const status = q("[data-cad-status]");
      const sourcePending =
        !!session.resource.sourceFile &&
        session.resource.sourceFile.savedRevision !== session.resource.revision;
      status.dataset.state = session.error
        ? "error"
        : session.busy
          ? "saving"
          : session.dirty || sourcePending
            ? "dirty"
            : "saved";
      status.textContent =
        session.error ||
        (session.busy
          ? "正在保存…"
          : session.dirty
            ? "未保存的修改"
            : sourcePending
              ? "原文件尚未保存，请重试保存"
              : `${session.resource.sourceFile ? "已保存到原文件" : "已保存"} · r${session.revision}`);
      q("[data-cad-save]").title = session.resource.sourceFile
        ? `保存到原文件：${session.resource.sourceFile.path}`
        : "保存";
      q("[data-cad-reload]").hidden = !session.error;
      const dragging = !!viewport?.isDragging;
      const locked = session.busy || !!session.pending || exportBusy;
      for (const button of host.querySelectorAll(".cad-actions button, [data-cad-delete]"))
        button.disabled = session.busy || exportBusy || dragging;
      for (const button of host.querySelectorAll("[data-cad-add], [data-cad-duplicate]"))
        button.disabled = locked || dragging || parts.length >= MAX_PARTS;
      for (const button of host.querySelectorAll("[data-cad-mode]")) {
        button.disabled = locked || !!viewport?.isDragging;
        button.setAttribute("aria-pressed", String(button.dataset.cadMode === mode));
      }
      for (const button of host.querySelectorAll("[data-cad-view]")) button.disabled = dragging;
      q('[data-cad-view="selected"]').disabled = dragging || !selected;
      viewport?.setEditable(!locked);
      viewport?.select(parts.find((p) => p.id === selected));
      q("[data-cad-hint]").textContent =
        mode === "select"
          ? "点击形体选择 · 空白处拖动旋转 · 滚轮缩放"
          : `${mode === "translate" ? "拖动箭头或平面移动" : "拖动圆环旋转"} · 松手保存 · Esc 取消${q("[data-cad-snap]").checked ? " · 吸附 1 mm / 15°" : ""}`;
      for (const field of host.querySelectorAll("[data-cad-field]"))
        field.disabled = session.busy || !!session.pending || dragging;
      onContextChange?.({
        title: session.resource.title,
        selection: parts.find((p) => p.id === selected)?.name,
        dirty: session.dirty
      });
      onDirtyChange?.(session.dirty || !!session.pending || sourcePending);
      if (!exportBusy) {
        if (JSON.stringify(session.model) !== lastPreview) q("[data-cad-viewport]").dataset.ready = "false";
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => void preview(), 180);
      }
    }
    async function preview() {
      if (!viewport || disposed || exportBusy || viewport.isDragging) return;
      const key = JSON.stringify(session.model);
      if (key === lastPreview) return;
      lastPreview = key;
      q("[data-cad-metrics]").textContent = "计算模型…";
      try {
        const result = await kernel.request("preview", session.model, selected);
        if (!result || disposed) return;
        // A typing/dragging change can precede the next worker request. Discard that older result.
        if (key !== JSON.stringify(session.model) || viewport.isDragging) {
          lastPreview = "";
          return;
        }
        viewport.update(
          result,
          session.model.parts.find((p) => p.id === selected)
        );
        if (fitPending) {
          viewport.fit();
          fitPending = false;
        }
        q("[data-cad-metrics]").textContent =
          `${result.dimensions.map((v) => v.toFixed(1)).join(" × ")} mm · ${result.volume.toFixed(1)} mm³`;
        q("[data-cad-viewport]").dataset.ready = "true";
      } catch (error) {
        if (!disposed) {
          q("[data-cad-metrics]").textContent = `预览：${error.message}`;
          q("[data-cad-viewport]").dataset.ready = "false";
        }
      }
    }
    const save = async () => {
      viewport?.cancelTransform();
      const ok = await session.save();
      if (ok) onChanged?.();
      return ok;
    };
    async function select(id) {
      viewport?.cancelTransform();
      selected = id ?? null;
      paintForm(true);
      paint();
      const button = [...host.querySelectorAll("[data-cad-select]")].find((b) => b.dataset.cadSelect === id);
      button?.scrollIntoView({ block: "nearest" });
      await api.saveSelection(taskId, session.resource.resourceId, {
        schema: "cad.feature/v1",
        data: id ? { id } : {},
        appInstanceId: instance.appInstanceId
      });
    }
    function setMode(value) {
      mode = value;
      viewport?.setMode(mode);
      paint();
    }
    async function insert(part) {
      selected = part.id;
      fitPending = true;
      session.edit(normalizeModel({ ...session.model, parts: [...session.model.parts, part] }));
      paintForm(true);
      setMode("translate");
      if (await save()) await select(part.id);
    }
    const click = (event) => {
      const target = event.target.closest("button");
      if (!target || disposed) return;
      void guard(async () => {
        if (target.dataset.cadSelect) return select(target.dataset.cadSelect);
        if (target.dataset.cadMode) return setMode(target.dataset.cadMode);
        if (target.dataset.cadView) return viewport?.fit(target.dataset.cadView);
        if (target.hasAttribute("data-cad-save")) return save();
        if (target.hasAttribute("data-cad-undo")) {
          await session.undo();
          paintForm(true);
          return onChanged?.();
        }
        if (target.dataset.cadAdd) {
          return insert(
            createPlacedPart(
              session.model,
              target.dataset.cadAdd,
              `part_${crypto.randomUUID().slice(0, 8)}`,
              selected
            )
          );
        }
        if (target.hasAttribute("data-cad-duplicate"))
          return insert(duplicatePart(session.model, selected, `part_${crypto.randomUUID().slice(0, 8)}`));
        if (target.hasAttribute("data-cad-delete")) {
          session.edit(
            normalizeModel({ ...session.model, parts: session.model.parts.filter((p) => p.id !== selected) })
          );
          await save();
          paintForm(true);
        }
        if (target.hasAttribute("data-cad-code")) {
          if (!(await save())) return;
          await api.applyOperation(taskId, session.resource.resourceId, {
            operationId: `cad_${crypto.randomUUID().replaceAll("-", "")}`,
            appType: CAD_APP,
            operationType: "cad.program.replace",
            baseRevision: session.revision,
            payload: { program: programFromModel(session.model) }
          });
          onChanged?.();
          return;
        }
        if (target.hasAttribute("data-cad-rename"))
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
        if (target.hasAttribute("data-cad-json"))
          download(
            new Blob([JSON.stringify(session.model, null, 2)], { type: "application/json" }),
            session.resource.title
          );
        if (target.hasAttribute("data-cad-stl")) {
          if (!(await save())) return;
          exportBusy = true;
          paint();
          try {
            const result = await kernel.request("stl", session.model);
            if (result && !disposed)
              download(result.blob, session.resource.title.replace(/(?:\.cad)?\.json$/i, "") + ".stl");
          } finally {
            exportBusy = false;
            lastPreview = "";
            paint();
          }
        }
        if (target.hasAttribute("data-cad-import")) q("[data-cad-file]").click();
        if (target.hasAttribute("data-cad-reload")) {
          await session.reload();
          paintForm(true);
        }
      });
    };
    host.addEventListener("click", click);
    q("[data-cad-snap]").onchange = () => {
      viewport?.setSnap(q("[data-cad-snap]").checked);
      paint();
    };
    q("[data-cad-form]").onsubmit = (event) => {
      event.preventDefault();
      void guard(save);
    };
    q("[data-cad-form]").oninput = (event) => {
      const key = event.target.dataset.cadField;
      if (!key) return;
      try {
        const model = structuredClone(session.model),
          part = model.parts.find((p) => p.id === selected);
        const [field, index] = key.split(".");
        const value = event.target.type === "number" ? event.target.valueAsNumber : event.target.value;
        if (index !== undefined) part[field][Number(index)] = value;
        else part[field] = value;
        session.edit(model);
      } catch (error) {
        report(error);
      }
    };
    q("[data-cad-file]").onchange = () =>
      void guard(async () => {
        const file = q("[data-cad-file]").files[0];
        if (!file) return;
        try {
          if (file.size > 256 * 1024) throw new Error("模型 JSON 最多 256 KiB");
          session.edit(normalizeModel(JSON.parse(await file.text())));
          paintForm(true);
          await save();
        } finally {
          q("[data-cad-file]").value = "";
        }
      });
    const shortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void guard(save);
      }
      if (event.key === "Escape" && viewport?.cancelTransform()) {
        event.preventDefault();
        return;
      }
      if (
        event.target.closest("input, select, textarea") ||
        event.ctrlKey ||
        event.metaKey ||
        session.busy ||
        session.pending ||
        viewport?.isDragging
      )
        return;
      const key = event.key.toLowerCase();
      if (["v", "g", "r"].includes(key)) {
        event.preventDefault();
        setMode({ v: "select", g: "translate", r: "rotate" }[key]);
      }
      if (key === "f" && selected) {
        event.preventDefault();
        viewport?.fit("selected");
      }
    };
    host.addEventListener("keydown", shortcut);
    const flushDraft = () => {
      viewport?.cancelTransform();
      session.persist();
    };
    window.addEventListener("pagehide", flushDraft);
    try {
      await session.load();
    } catch (error) {
      disposed = true;
      clearTimeout(previewTimer);
      window.removeEventListener("pagehide", flushDraft);
      fileMenu.dispose();
      kernel.dispose();
      throw error;
    }
    if (session.selection?.schema === "cad.feature/v1") selected = session.selection.data?.id ?? null;
    try {
      const { createCadViewport } = await import("../../cad/generated/viewport.js");
      viewport = createCadViewport(q("[data-cad-viewport]"), {
        onSelect: (id) => void guard(() => select(id)),
        onTransformStart() {
          session.pauseRefresh();
          dragDraft = session.captureDraft();
          paint();
        },
        onTransform(value) {
          void guard(async () => {
            const model = structuredClone(session.model);
            Object.assign(
              model.parts.find((p) => p.id === selected),
              value
            );
            session.edit(normalizeModel(model));
            paintForm(true);
          });
        },
        onTransformEnd() {
          void guard(async () => {
            try {
              if (dragDraft && JSON.stringify(dragDraft.model) !== JSON.stringify(session.model))
                await save();
            } finally {
              dragDraft = null;
              session.resumeRefresh();
              paint();
            }
          });
        },
        onTransformCancel() {
          try {
            if (dragDraft) session.restoreDraft(dragDraft);
          } finally {
            dragDraft = null;
            session.resumeRefresh();
            paintForm(true);
            paint();
          }
        }
      });
      viewport.setMode(mode);
      await preview();
    } catch (error) {
      q("[data-cad-viewport]").textContent = `三维视图不可用：${error.message}。参数仍可编辑和保存。`;
    }
    const refreshPoll = createVisiblePoll({
      run: () => (viewport?.isDragging ? undefined : session.refresh()),
      intervalMs: 3000,
      active: visible
    });
    return {
      setVisible(value) {
        visible = Boolean(value);
        refreshPoll.setActive(visible);
      },
      focus() {
        q("[data-cad-viewport]").focus();
      },
      captureUiState() {
        return { selected };
      },
      restoreUiState(state) {
        if (state && Object.hasOwn(state, "selected")) selected = state.selected;
        paint();
      },
      getSelection() {
        return selected ? { schema: "cad.feature/v1", data: { id: selected } } : undefined;
      },
      async canClose() {
        return !exportBusy && (await save());
      },
      flush: save,
      handleResourceEvent(event) {
        if (event.type === "resource.selection_changed" || event.revision <= session.revision) return true;
        // Receiving the event is enough while hidden: visibility catch-up reads
        // the latest revision without keeping event retry timers awake.
        if (!visible || document.hidden) return true;
        return viewport?.isDragging ? false : session.refresh();
      },
      async unmount() {
        viewport?.cancelTransform();
        disposed = true;
        clearTimeout(previewTimer);
        refreshPoll.dispose();
        window.removeEventListener("pagehide", flushDraft);
        host.removeEventListener("click", click);
        host.removeEventListener("keydown", shortcut);
        session.persist();
        fileMenu.dispose();
        kernel.dispose();
        viewport?.dispose();
        host.innerHTML = "";
      }
    };
  }
};

/** A single resource can evolve from legacy shapes to source without opening another tab. */
export const cadEditorAdapter = {
  readFile: readImportedFile,
  ...legacyCadEditorAdapter,
  async mount(host, options) {
    let controller,
      sourceMode = false,
      dirty = false,
      disposed = false,
      visible = !host.hidden,
      checking;
    const wrapped = {
      ...options,
      onDirtyChange(value) {
        dirty = value;
        options.onDirtyChange?.(value);
      }
    };
    const resourceId = options.instance.resourceIds[0];
    const mount = async (mode) => {
      sourceMode = mode;
      controller = await (mode ? cadProgramEditor : legacyCadEditorAdapter).mount(host, wrapped);
      controller.setVisible?.(visible && !disposed);
    };
    if (resourceId)
      sourceMode = isCadProgram(
        (await options.api.readResource(options.taskId, resourceId)).snapshot.content
      );
    await mount(sourceMode);
    const check = async () => {
      if (disposed || !resourceId || dirty || !visible || document.hidden) return;
      if (checking) return checking;
      checking = (async () => {
        try {
          const mode = isCadProgram(
            (await options.api.readResource(options.taskId, resourceId)).snapshot.content
          );
          if ((mode !== sourceMode || !controller) && !dirty && !disposed && visible && !document.hidden) {
            const previous = controller;
            controller = undefined;
            await previous?.unmount?.();
            if (disposed || !visible || document.hidden) return;
            await mount(mode);
            options.onChanged?.();
          }
        } catch {
          /* An unavailable poll retains the existing editor and draft. */
        } finally {
          checking = undefined;
        }
      })();
      return checking;
    };
    const poll = resourceId
      ? createVisiblePoll({ run: check, intervalMs: 2200, active: visible })
      : undefined;
    return {
      setVisible(value) {
        visible = Boolean(value);
        controller?.setVisible?.(visible);
        poll?.setActive(visible);
      },
      focus: () => controller?.focus?.(),
      captureUiState: () => controller?.captureUiState?.(),
      restoreUiState: (state) => controller?.restoreUiState?.(state),
      getSelection: () => controller?.getSelection?.(),
      canClose: () => controller?.canClose?.(),
      flush: () => controller?.flush?.(),
      async handleResourceEvent(event) {
        if (!visible || document.hidden) return true;
        await check();
        return !disposed && controller?.handleResourceEvent?.(event);
      },
      async unmount() {
        disposed = true;
        poll?.dispose();
        await checking;
        await controller?.unmount?.();
      }
    };
  }
};
