import { mountLocalFileOpener } from "./local-file-opener.js";
import { mountBlenderInstaller } from "../../blender/runtime-install.js";
import { openResourceReview } from "./resource-review.js";
import { escapeHtml as esc } from "../html.js";
import { icon } from "../../ui/icons.js";
import { nameDocument } from "./document-name-dialog.js";
import { BlenderDocumentSession } from "../../blender/document-session.js";
import { createMenu } from "../../ui/menu.js";
import { createVisiblePoll } from "../../ui/visible-poll.js";

const linearToSrgb = (value) => {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
const srgbToLinear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const KIND = "project/atria-blender+json";
const vectorFields = (name, label, values, drafts) =>
  `<fieldset><legend>${label}</legend><div class="blender-vector">${values.map((v, i) => `<label>${["X", "Y", "Z"][i]}<input type="number" step="any" required aria-label="${label} ${["X", "Y", "Z"][i]}" aria-invalid="${!!drafts[`${name}.${i}`]}" data-blender-field="${name}" data-axis="${i}" value="${esc(drafts[`${name}.${i}`]?.value ?? v)}"></label>`).join("")}</div></fieldset>`;
const download = (body, name) => {
  const url = URL.createObjectURL(
      body instanceof Blob ? body : new Blob([body], { type: "application/json" })
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
async function readImportedFile(file) {
  if (!/\.blend$/i.test(file.name)) throw new Error("请选择 .blend 工程");
  if (!file.size || file.size > 64 * 1024 * 1024) throw new Error("工程不能为空或超过 64 MiB");
  return { kind: KIND, title: file.name.replace(/\.blend$/i, ""), nativeFile: file };
}

export const blenderEditorAdapter = {
  readFile: readImportedFile,
  definition: {
    appType: "blender",
    displayName: "Blender",
    icon: "i-blender",
    version: "1",
    resourceKinds: [KIND]
  },
  canOpen: (resource) => resource?.kind === KIND,
  async mount(host, { instance, taskId, api, onDirtyChange, onChanged, onContextChange }) {
    if (!instance.resourceIds[0]) {
      host.innerHTML = `<section class="cad-empty application-home" aria-label="Blender"><div class="cad-empty-symbol application-home-icon">${icon("blender")}</div><h2>Blender</h2><div class="application-home-actions"><button class="app-button is-primary" data-blender-new>${icon("plus")}新建 Blender 工程</button></div><div data-blender-install></div><div class="application-home-files" data-blender-existing></div></section>`;
      const installer = mountBlenderInstaller(host.querySelector("[data-blender-install]"));
      host.querySelector("[data-blender-new]").onclick = () =>
        nameDocument(host, {
          title: "新建 Blender 工程",
          value: "未命名",
          submitLabel: "创建",
          async onSubmit(title) {
            await api.createInApplication(taskId, instance.appInstanceId, { kind: KIND, title });
            await api.onDocumentCreated?.();
          }
        });
      const opener = mountLocalFileOpener(host.querySelector(".application-home-actions"), {
        accept: ".blend",
        api,
        taskId,
        instance,
        read: readImportedFile
      });
      const { resources } = await api.listResources(taskId);
      const list = host.querySelector("[data-blender-existing]");
      list.innerHTML = resources
        .filter((r) => r.kind === KIND)
        .map(
          (r) =>
            `<button class="app-button" data-blender-open="${esc(r.resourceId)}">${icon("file")}${esc(r.title)}</button>`
        )
        .join("");
      list.querySelectorAll("button").forEach((button) => {
        button.onclick = () => api.openResourceInTab?.(taskId, button.dataset.blenderOpen);
      });
      return {
        captureUiState: () => ({}),
        async unmount() {
          opener.dispose();
          installer.dispose();
          host.innerHTML = "";
        }
      };
    }
    host.innerHTML = `<section class="cad-editor blender-editor" aria-label="Blender 工作台">
      <header class="cad-toolbar"><div class="cad-identity"><span class="app-icon-badge">${icon("blender")}</span><div><button class="cad-document-title" data-blender-rename aria-label="重命名 Blender 工程"><span data-blender-title></span>${icon("pencil")}</button></div></div><div class="cad-actions">
      <div class="ui-menu-anchor"><button class="app-button" data-blender-file-menu aria-expanded="false">文件 ${icon("chevron-down")}</button><div class="ui-menu" data-blender-file-panel hidden><button data-blender-import>导入 .blend 工程</button><button data-blender-export="blend">下载 Blender 工程</button><button data-blender-export="glb">导出 GLB 模型</button><button data-blender-export="png">导出渲染图 PNG</button><button data-blender-export="python">下载 Python 代码</button></div></div><button class="app-button" data-blender-review>修改对比</button><button class="app-button" data-blender-source-toggle aria-pressed="false" aria-expanded="false">${icon("code")}代码</button><button class="app-button" data-blender-undo aria-label="撤销 Blender 修改">${icon("undo")}</button><button class="app-button is-primary" data-blender-save>${icon("save")}保存</button></div></header>
      <input type="file" data-blender-file accept=".blend" hidden><div class="blender-runtime-notice" data-blender-runtime></div>
      <div class="blender-workspace"><div class="blender-stage-column"><div class="blender-stage"><div class="blender-stage-actions"><button class="app-button is-icon" data-blender-fit aria-label="显示完整场景">${icon("fit")}</button><button class="app-button" data-blender-view-toggle aria-pressed="false">渲染图</button><button class="app-button" data-blender-inspector-toggle aria-expanded="false" aria-controls="blender-inspector-${esc(instance.appInstanceId)}">${icon("sliders")}对象</button></div><div class="blender-viewport" data-blender-viewport></div><img class="blender-render" data-blender-image alt="Blender 场景渲染图" hidden><div class="blender-empty-scene" data-blender-empty>暂无场景</div></div>
      <div class="blender-source-panel" data-blender-source-panel hidden><div class="blender-source-heading"><div class="blender-source-label"><strong>Python</strong><details class="blender-source-info"><summary aria-label="代码保存方式" title="代码保存方式">${icon("info")}</summary><div>保存保留源码草稿；运行成功后更新场景。</div></details></div><button class="app-button is-primary" data-blender-run>运行并保存场景</button></div><textarea data-blender-source aria-label="Blender 建模源码" spellcheck="false" placeholder="import bpy&#10;&#10;def main(p):&#10;    # 创建或修改场景"></textarea><div class="blender-code-options"><label>参数（JSON）<textarea data-blender-parameters aria-label="Blender 参数" spellcheck="false"></textarea></label><label>运行时限<select data-blender-budget disabled></select></label><label><input type="checkbox" data-blender-reset>运行前清空场景</label></div></div></div>
      <aside class="blender-inspector" id="blender-inspector-${esc(instance.appInstanceId)}" aria-label="场景对象与属性" hidden><div class="blender-inspector-heading"><strong>对象 <span data-blender-count>0</span></strong><button class="app-button is-icon" data-blender-inspector-close aria-label="关闭对象面板">${icon("close")}</button></div><div class="blender-object-list" data-blender-objects></div><div class="cad-panel-label" data-blender-properties-heading hidden>属性</div><form data-blender-form><p class="cad-panel-hint">未选中对象</p></form><details class="blender-scene-info"><summary>场景信息</summary><pre data-blender-diagnostics></pre></details></aside></div>
      <div class="blender-error" data-blender-error role="alert" hidden></div><footer class="cad-statusbar"><span data-blender-status role="status"></span><span data-blender-metrics></span><button class="app-button" data-blender-cancel hidden>取消任务</button><button class="app-button" data-blender-preview-retry hidden>重试预览</button><button class="app-button" data-blender-backup hidden>备份草稿</button><button class="app-button" data-blender-reload hidden>重新载入（放弃草稿）</button></footer></section>`;
    const q = (selector) => host.querySelector(selector),
      resourceId = instance.resourceIds[0];
    const fileMenu = createMenu(q("[data-blender-file-menu]"), q("[data-blender-file-panel]"));
    const installer = mountBlenderInstaller(host.querySelector("[data-blender-runtime]"));
    let disposed = false,
      visible = !host.hidden,
      viewport,
      report,
      computeLimits,
      selected = null,
      previewSnapshot,
      previewFailed,
      previewing = false,
      previewRevision,
      previewEpoch = 0,
      previewController,
      showRender = false,
      inspectorOpen,
      viewportError = "",
      loadingTimer,
      selectionQueue = Promise.resolve();
    const session = new BlenderDocumentSession({ api, taskId, resourceId, changed: paint });
    const object = () => report?.objects.find((o) => o.id === selected);
    const previewReady = () => !previewing && previewSnapshot === session.saved?.snapshot;
    function paintForm(force = false) {
      const form = q("[data-blender-form]");
      form.querySelectorAll("input").forEach((input) => {
        input.disabled = session.busy || !!session.pending || !previewReady();
      });
      if (!force && form.contains(document.activeElement)) return;
      const original = object(),
        value = original && { ...original, ...session.edits[selected] },
        drafts = session.objectDrafts[selected] ?? {};
      form.innerHTML = value
        ? `<label title="${esc(value.type)} · ${value.triangles} 个三角面">名称<input data-blender-field="name" required maxlength="128" aria-label="对象名称" aria-invalid="${!!drafts.name}" value="${esc(drafts.name?.value ?? value.name)}"></label>${vectorFields("position", "位置", value.position, drafts)}${vectorFields("rotation", "旋转（度）", value.rotation, drafts)}${vectorFields("scale", "缩放", value.scale, drafts)}${
            ["MESH", "CURVE", "SURFACE", "FONT", "META"].includes(value.type)
              ? `<fieldset><legend>基础材质</legend><label>颜色<input type="color" aria-label="对象颜色" data-blender-field="color" value="#${value.color
                  .slice(0, 3)
                  .map((v) =>
                    Math.round(linearToSrgb(v) * 255)
                      .toString(16)
                      .padStart(2, "0")
                  )
                  .join(
                    ""
                  )}"></label><label>金属度<input type="number" required min="0" max="1" step="any" aria-label="金属度" aria-invalid="${!!drafts.metallic}" data-blender-field="metallic" value="${esc(drafts.metallic?.value ?? value.metallic)}"></label><label>粗糙度<input type="number" required min="0" max="1" step="any" aria-label="粗糙度" aria-invalid="${!!drafts.roughness}" data-blender-field="roughness" value="${esc(drafts.roughness?.value ?? value.roughness)}"></label></fieldset>`
              : ""
          }`
        : '<p class="cad-panel-hint">未选中对象</p>';
      q("[data-blender-properties-heading]").hidden = !value;
      form.querySelectorAll("input").forEach((input) => {
        input.disabled = session.busy || !!session.pending || !previewReady();
      });
    }
    function paint() {
      if (disposed || !session.model) return;
      if (previewing && previewRevision !== session.resource.revision) {
        previewController?.abort();
        previewEpoch++;
        previewing = false;
      }
      q("[data-blender-title]").textContent = session.resource.title;
      const sourcePending =
        !!session.resource.sourceFile &&
        session.resource.sourceFile.savedRevision !== session.resource.revision;
      q("[data-blender-status]").textContent = session.busy
        ? "正在执行 Blender 任务…"
        : session.pending
          ? "保存结果待确认，请重试保存"
          : session.dirty
            ? "有未保存修改"
            : sourcePending
              ? "原文件尚未保存，请重试保存"
              : !previewReady()
                ? previewFailed !== undefined
                  ? "预览加载失败 · 工程已保存"
                  : "正在更新场景…"
                : session.resource.sourceFile
                  ? "已保存到原文件"
                  : "已保存";
      q("[data-blender-status]").title = `r${session.revision}`;
      q("[data-blender-save]").title = session.resource.sourceFile
        ? `保存到原文件：${session.resource.sourceFile.path}`
        : "保存";
      q("[data-blender-cancel]").hidden = !session.busy;
      q("[data-blender-error]").hidden = !session.error;
      q("[data-blender-error]").textContent = session.error;
      q("[data-blender-backup]").hidden = !session.dirty && !session.pending;
      q("[data-blender-reload]").hidden = !session.error;
      q("[data-blender-preview-retry]").hidden = previewFailed === undefined;
      for (const selector of [
        "[data-blender-save]",
        "[data-blender-undo]",
        "[data-blender-run]",
        "[data-blender-export]",
        "[data-blender-import]",
        "[data-blender-source]",
        "[data-blender-parameters]",
        "[data-blender-reload]"
      ])
        q(selector).disabled = session.busy;
      q("[data-blender-run]").disabled = session.busy || !computeLimits;
      q("[data-blender-budget]").disabled = session.busy || !computeLimits;
      for (const selector of ["[data-blender-source]", "[data-blender-parameters]"])
        q(selector).disabled = session.busy || !!session.pending;
      host.querySelectorAll("[data-blender-export]").forEach((button) => {
        button.disabled =
          session.busy || (button.dataset.blenderExport !== "python" && !session.saved.snapshot);
      });
      if (document.activeElement !== q("[data-blender-source]"))
        q("[data-blender-source]").value = session.model.source;
      if (document.activeElement !== q("[data-blender-parameters]"))
        q("[data-blender-parameters]").value =
          session.parameterDraft ?? JSON.stringify(session.model.parameters, null, 2);
      q("[data-blender-empty]").hidden = !!session.saved?.snapshot;
      onDirtyChange?.(session.dirty || !!session.pending || sourcePending);
      onContextChange?.({
        title: session.resource.title,
        selection: previewReady() ? object()?.name : undefined,
        dirty: session.dirty
      });
      q("[data-blender-objects]")
        .querySelectorAll("button")
        .forEach((button) => {
          button.disabled = session.busy || !previewReady();
        });
      paintForm();
      if (
        !session.busy &&
        !previewing &&
        previewSnapshot !== session.saved?.snapshot &&
        previewFailed !== session.saved?.snapshot
      ) {
        clearTimeout(loadingTimer);
        loadingTimer = setTimeout(() => void loadPreview(), 30);
      }
    }
    async function loadPreview() {
      if (disposed || !session.saved) return;
      const revision = session.resource.revision,
        doc = structuredClone(session.saved),
        epoch = ++previewEpoch,
        controller = new AbortController(),
        current = () => !disposed && epoch === previewEpoch && session.resource.revision === revision;
      previewController?.abort();
      previewController = controller;
      previewing = true;
      previewRevision = revision;
      paint();
      try {
        const result = await api.previewResource(taskId, resourceId, doc, {}, controller.signal);
        if (!current()) return;
        computeLimits = result.computeLimits;
        const budget = q("[data-blender-budget]");
        if (computeLimits && !budget.options.length) {
          const seconds = [
            ...new Set([
              60,
              computeLimits.runTimeoutSeconds,
              computeLimits.renderTimeoutSeconds,
              computeLimits.maxTimeoutSeconds
            ])
          ].sort((a, b) => a - b);
          budget.innerHTML = seconds.map((value) => `<option value="${value}">${value} 秒</option>`).join("");
          budget.value = String(computeLimits.runTimeoutSeconds);
        }
        if (doc.snapshot && viewport) {
          const response = await fetch(api.attachmentUrl(taskId, resourceId, "preview.glb", revision), {
            signal: controller.signal
          });
          if (!current()) return;
          if (!response.ok) throw new Error("场景预览版本已更新，请重试");
          const bytes = await response.arrayBuffer();
          if (!current()) return;
          if (!(await viewport.load(bytes, controller.signal)) || !current()) return;
        }
        report = result.scene;
        previewSnapshot = doc.snapshot;
        previewFailed = undefined;
        if (selected && !object()) {
          selected = null;
          viewport?.select(null);
          await persistSelection(null);
          if (!current()) return;
        }
        q("[data-blender-count]").textContent = report.objects.length;
        q("[data-blender-objects]").innerHTML = report.objects
          .map(
            (o) =>
              `<button type="button" class="blender-object ${o.id === selected ? "active" : ""}" data-blender-select="${o.id}" aria-pressed="${o.id === selected}" title="${esc(o.name)} · ${esc(o.type)}">${icon("cube")}<span>${esc(o.name)}</span></button>`
          )
          .join("");
        q("[data-blender-metrics]").textContent = report.objects.length
          ? `${report.objects.length} 个对象 · ${report.triangles.toLocaleString()} 个三角面`
          : "尚未生成场景";
        q("[data-blender-diagnostics]").textContent = [
          `Blender ${report.blenderVersion || "未运行"}`,
          ...report.warnings,
          report.diagnostics
        ]
          .filter(Boolean)
          .join("\n");

        if (doc.snapshot) {
          q("[data-blender-image]").src = api.attachmentUrl(taskId, resourceId, "render.png", revision);
          viewport?.select(selected);
        } else {
          viewport?.clear();
          q("[data-blender-image]").removeAttribute("src");
        }
        setView(showRender);
        setInspector(inspectorOpen ?? !!report.objects.length, false);
        paintForm(true);
      } catch (error) {
        if (!disposed && epoch === previewEpoch && error.name !== "AbortError") {
          previewSnapshot = undefined;
          previewFailed = doc.snapshot;
          session.error = `预览加载失败：${error.message}`;
        }
      } finally {
        if (epoch === previewEpoch) {
          previewing = false;
          paint();
        }
      }
    }
    function setView(value) {
      showRender = !!value || !!viewportError;
      const button = q("[data-blender-view-toggle]");
      button.setAttribute("aria-pressed", String(showRender));
      button.textContent = showRender ? "三维视图" : "渲染图";
      button.title = showRender ? "返回三维视图" : "查看渲染图";
      button.disabled = !!viewportError;
      q("[data-blender-image]").hidden = !showRender || !session.saved.snapshot;
      q("[data-blender-viewport]").hidden = showRender;
    }
    function setInspector(open, remember = true) {
      if (remember) inspectorOpen = !!open;
      q(".blender-inspector").hidden = !open;
      q("[data-blender-inspector-toggle]").setAttribute("aria-expanded", String(!!open));
      q(".blender-workspace").classList.toggle("has-inspector", !!open);
    }
    function persistSelection(id) {
      const selection = {
        schema: "blender.object/v1",
        data: { id, name: report?.objects.find((o) => o.id === id)?.name },
        appInstanceId: instance.appInstanceId
      };
      selectionQueue = selectionQueue
        .catch(() => {})
        .then(() => api.saveSelection(taskId, resourceId, selection));
      return selectionQueue;
    }
    async function select(id) {
      if (session.busy || !previewReady()) return;
      selected = id;
      if (id) setInspector(true);
      viewport?.select(id);
      q("[data-blender-objects]")
        .querySelectorAll("button")
        .forEach((button) => {
          const active = button.dataset.blenderSelect === id;
          button.classList.toggle("active", active);
          button.setAttribute("aria-pressed", String(active));
        });
      paintForm(true);
      onContextChange?.({ title: session.resource.title, selection: object()?.name, dirty: session.dirty });
      await persistSelection(id);
    }
    const guard = async (action) => {
      try {
        await action();
      } catch (error) {
        session.error = error.message;
        paint();
      }
    };
    const click = (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      void guard(async () => {
        if (button.hasAttribute("data-blender-review"))
          await openResourceReview({
            api,
            taskId,
            resourceId,
            canUndo: () => !session.dirty && !session.pending && !session.busy,
            onUndo: async () => {
              await session.load();
              await loadPreview();
              onChanged?.();
            }
          });
        else if (button.hasAttribute("data-blender-select")) await select(button.dataset.blenderSelect);
        else if (button.hasAttribute("data-blender-save")) {
          if (await session.save()) await loadPreview();
        } else if (button.hasAttribute("data-blender-run")) {
          if (
            await session.run({
              resetScene: q("[data-blender-reset]").checked,
              timeoutSeconds: Number(q("[data-blender-budget]").value)
            })
          )
            await loadPreview();
        } else if (button.hasAttribute("data-blender-cancel")) session.cancel();
        else if (button.hasAttribute("data-blender-preview-retry")) {
          previewFailed = undefined;
          session.error = "";
          await loadPreview();
        } else if (button.hasAttribute("data-blender-import")) q("[data-blender-file]").click();
        else if (button.hasAttribute("data-blender-undo")) {
          if (await session.undo()) await loadPreview();
        } else if (button.hasAttribute("data-blender-reload")) {
          if (await session.reload()) await loadPreview();
        } else if (button.hasAttribute("data-blender-backup"))
          download(
            JSON.stringify(
              {
                document: session.model,
                parameterDraft: session.parameterDraft,
                edits: session.edits,
                objectDrafts: session.objectDrafts,
                baseRevision: session.revision,
                pending: session.pending
              },
              null,
              2
            ),
            "Blender 草稿备份.json"
          );
        else if (button.hasAttribute("data-blender-source-toggle")) {
          const panel = q("[data-blender-source-panel]");
          panel.hidden = !panel.hidden;
          button.setAttribute("aria-pressed", String(!panel.hidden));
          button.setAttribute("aria-expanded", String(!panel.hidden));
        } else if (button.hasAttribute("data-blender-inspector-toggle")) {
          setInspector(q(".blender-inspector").hidden);
        } else if (button.hasAttribute("data-blender-inspector-close")) {
          setInspector(false);
          q("[data-blender-inspector-toggle]").focus();
        } else if (button.hasAttribute("data-blender-fit")) viewport?.fit();
        else if (button.hasAttribute("data-blender-view-toggle")) {
          setView(!showRender);
        } else if (button.hasAttribute("data-blender-export")) {
          if (!(await session.save())) return;
          const format = button.dataset.blenderExport;
          if (format !== "python" && !session.saved.snapshot) throw new Error("请先生成场景再导出");
          await session.guarded(async (signal) => {
            const result = await api.downloadResource(taskId, resourceId, format, signal);
            download(result.blob, result.fileName);
          });
        } else if (button.hasAttribute("data-blender-rename"))
          nameDocument(host, {
            title: "重命名 Blender 工程",
            value: session.resource.title,
            submitLabel: "重命名",
            async onSubmit(title) {
              if (!(await session.save())) throw new Error(session.error);
              await api.renameResource(taskId, resourceId, title);
              await session.refresh();
              onChanged?.();
            }
          });
      });
    };
    const change = (event) =>
      void guard(async () => {
        if (event.target.hasAttribute("data-blender-file")) {
          const file = event.target.files[0];
          if (file && (await session.importFile(file))) await loadPreview();
          event.target.value = "";
          return;
        }
        editObjectInput(event.target);
      });
    function editObjectInput(input) {
      const field = input.dataset.blenderField,
        original = object();
      if (!field || !original) return;
      const current = { ...original, ...session.edits[selected] },
        value = input.value,
        vector = ["position", "rotation", "scale"].includes(field),
        key = vector ? `${field}.${input.dataset.axis}` : field;
      let update, error;
      if (!input.checkValidity())
        error = field === "name" ? "名称需要 1–128 个字符" : vector ? "请输入有效数值" : "材质参数应为 0–1";
      else if (field === "scale" && Math.abs(Number(value)) < 1e-6) error = "缩放不能为零";
      else if (field === "name" && !value.trim()) error = "名称不能为空";
      else if (vector) {
        update = [...current[field]];
        update[Number(input.dataset.axis)] = Number(value);
      } else if (field === "color")
        update = [1, 3, 5]
          .map((offset) => srgbToLinear(parseInt(value.slice(offset, offset + 2), 16) / 255))
          .concat(current.color[3]);
      else update = field === "name" ? value : Number(value);
      input.setAttribute("aria-invalid", String(!!error));
      session.editObjectInput({
        id: selected,
        key,
        value,
        edit: { [field]: update },
        error,
        unchanged: JSON.stringify(update) === JSON.stringify(original[field])
      });
    }
    const input = (event) => {
      if (event.target.hasAttribute("data-blender-source"))
        void guard(async () => session.editSource(event.target.value));
      if (event.target.hasAttribute("data-blender-parameters"))
        void guard(async () => session.editParameters(event.target.value));
      if (event.target.hasAttribute("data-blender-field"))
        void guard(async () => editObjectInput(event.target));
    };
    const keydown = (event) => {
      if (event.key === "Escape" && q(".blender-inspector").contains(event.target)) {
        event.preventDefault();
        setInspector(false);
        q("[data-blender-inspector-toggle]").focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void guard(() => session.save());
      }
    };
    host.addEventListener("click", click);
    host.addEventListener("change", change);
    host.addEventListener("input", input);
    host.addEventListener("keydown", keydown);
    await session.load();
    selected = session.selection?.data?.id ?? null;
    try {
      const { createBlenderViewport } = await import("../../cad/generated/blender-viewport.js");
      viewport = createBlenderViewport(q("[data-blender-viewport]"), {
        onSelect: (id) => void guard(() => select(id))
      });
    } catch (error) {
      viewportError = error.message;
      showRender = true;
      q("[data-blender-viewport]").hidden = true;
    }
    await loadPreview();
    const poll = createVisiblePoll({ run: () => session.refresh(), intervalMs: 2500, active: visible });
    const persist = () => session.persist();
    window.addEventListener("pagehide", persist);
    return {
      setVisible(value) {
        visible = Boolean(value);
        poll.setActive(visible);
      },
      focus: () => viewport?.focus(),
      captureUiState: () => ({
        selected,
        showRender,
        inspectorOpen: !q(".blender-inspector").hidden,
        sourceOpen: !q("[data-blender-source-panel]").hidden
      }),
      restoreUiState(state) {
        if (!state) return;
        selected = state.selected ?? null;
        viewport?.select(selected);
        setView(state.showRender);
        setInspector(state.inspectorOpen ?? !!selected);
        q("[data-blender-source-panel]").hidden = !state.sourceOpen;
        q("[data-blender-source-toggle]").setAttribute("aria-pressed", String(!!state.sourceOpen));
        q("[data-blender-source-toggle]").setAttribute("aria-expanded", String(!!state.sourceOpen));
        paintForm(true);
      },
      getSelection: () =>
        selected && previewReady()
          ? { schema: "blender.object/v1", data: { id: selected, name: object()?.name } }
          : undefined,
      flush: () => session.save(),
      canClose: () => !session.busy && session.save(),
      handleResourceEvent: (event) =>
        event.type === "resource.selection_changed" ||
        event.revision <= session.revision ||
        !visible ||
        document.hidden
          ? true
          : session.refresh(),
      async unmount() {
        disposed = true;
        installer.dispose();
        previewEpoch++;
        clearTimeout(loadingTimer);
        poll.dispose();
        previewController?.abort();
        session.cancel();
        session.persist();
        window.removeEventListener("pagehide", persist);
        host.removeEventListener("click", click);
        host.removeEventListener("change", change);
        host.removeEventListener("input", input);
        host.removeEventListener("keydown", keydown);
        fileMenu.dispose();
        viewport?.dispose();
        host.innerHTML = "";
      }
    };
  }
};
