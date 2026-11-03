import { openComponentSettings } from "../component-entry.js";
import { mountLocalFileOpener } from "./local-file-opener.js";
import { importPresentationFile } from "../../pptist/file-import.js";
import { PresentationSession } from "../../pptist/document-session.js";
import { escapeHtml as esc } from "../html.js";
import { nameDocument } from "./document-name-dialog.js";
import { openResourceReview } from "./resource-review.js";
import { createVisiblePoll } from "../../ui/visible-poll.js";
import { icon } from "../../ui/icons.js";
const KIND = "presentation/pptist+json";
function download(body, name) {
  const url = URL.createObjectURL(
    body instanceof Blob ? body : new Blob([body], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readImportedFile(file) {
  if (/\.pptx$/i.test(file.name)) {
    const imported = await importPresentationFile(file);
    return { kind: KIND, title: imported.title, initialContent: imported.content };
  }
  if (!/\.json$/i.test(file.name)) throw new Error("请选择 PPTX 或演示文稿 JSON 文件");
  if (file.size > 32 * 1024 * 1024) throw new Error("文件不能超过 32 MiB");
  return {
    kind: KIND,
    title: file.name.replace(/\.json$/i, ""),
    initialContent: JSON.parse(await file.text())
  };
}

export const pptistEditorAdapter = {
  readFile: readImportedFile,
  definition: {
    appType: "pptist",
    displayName: "PPT 演示文稿",
    icon: "i-slides",
    version: "1",
    resourceKinds: [KIND]
  },
  importFile: importPresentationFile,
  canOpen: (resource) => resource?.kind === KIND,
  async mount(host, { instance, taskId, api, onDirtyChange, onChanged, onContextChange }) {
    const response = await fetch("/api/components?id=pptist");
    if (response.ok) {
      const state = (await response.json()).components?.find((component) => component.id === "pptist");
      if (state && !state.available) {
        host.innerHTML =
          '<section class="pptist-empty"><h2>PPT 编辑器暂不可用</h2><p>请在设置中检查或修复内置组件，完成后重新打开编辑器。</p><button class="app-button is-primary" data-component-settings>在设置中安装</button><button class="app-button" data-component-reopen>重新打开编辑器</button></section>';
        host.querySelector("[data-component-settings]").onclick = () => openComponentSettings("pptist");
        host.querySelector("[data-component-reopen]").onclick = () => {
          window.location.reload();
        };
        return {
          captureUiState: () => ({}),
          unmount: async () => {
            host.innerHTML = "";
          }
        };
      }
    }

    const create = () =>
      nameDocument(host, {
        title: "新建演示文稿",
        value: "未命名演示文稿",
        submitLabel: "创建",
        async onSubmit(title) {
          if (instance.resourceIds[0]) await api.createAndOpen(taskId, title, KIND);
          else {
            await api.createInApplication(taskId, instance.appInstanceId, { kind: KIND, title });
            await api.onDocumentCreated?.();
          }
        }
      });
    if (!instance.resourceIds[0]) {
      host.innerHTML = `<section class="pptist-empty application-home" aria-label="PPT 演示文稿">${icon("slides", "application-home-icon")}<h2>演示文稿</h2><div class="application-home-actions"><button class="app-button is-primary" data-pptist-new>新建演示文稿</button></div><div class="application-home-files" data-pptist-existing></div></section>`;
      host.querySelector("[data-pptist-new]").onclick = create;
      const opener = mountLocalFileOpener(host.querySelector(".pptist-empty"), {
        accept: ".pptx,.json",
        api,
        taskId,
        instance,
        read: readImportedFile
      });
      host.querySelector(".application-home-actions").append(host.querySelector(".local-file-opener"));
      const { resources } = await api.listResources(taskId);
      host.querySelector("[data-pptist-existing]").innerHTML = resources
        .filter((r) => r.kind === KIND)
        .map(
          (r) => `<button class="app-button" data-pptist-open="${esc(r.resourceId)}">${esc(r.title)}</button>`
        )
        .join("");
      for (const button of host.querySelectorAll("[data-pptist-open]"))
        button.onclick = () => api.openResourceInTab?.(taskId, button.dataset.pptistOpen);
      return {
        captureUiState: () => ({}),
        unmount: async () => {
          opener.dispose();
          host.innerHTML = "";
        }
      };
    }
    const resourceId = instance.resourceIds[0],
      channel = crypto.randomUUID();
    host.innerHTML = `<section class="pptist-workbench" aria-label="演示文稿工作台"><header class="pptist-toolbar"><button class="app-button pptist-title" data-pptist-rename aria-label="重命名演示文稿"></button><div class="pptist-actions"><button class="app-button" data-pptist-new>新建</button><button class="app-button pptist-icon-action" data-pptist-review aria-label="修改对比" title="修改对比">${icon("history")}</button><button class="app-button pptist-icon-action" data-pptist-undo aria-label="撤销保存" title="撤销上一次保存">${icon("undo")}</button><button class="app-button" data-pptist-export>导出</button><button class="app-button is-primary" data-pptist-save>保存</button></div></header><div class="pptist-frame-wrap"><iframe title="PPT 演示文稿编辑器" data-pptist-frame sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-popups" allow="fullscreen; clipboard-read; clipboard-write"></iframe><div class="pptist-loading" data-pptist-loading role="status">正在加载演示文稿…</div></div><footer class="pptist-status"><span data-pptist-status role="status"></span><button class="app-button" data-pptist-backup hidden>备份草稿</button><button class="app-button" data-pptist-reload hidden>放弃草稿并重新载入</button><button class="app-button" data-pptist-retry hidden>重试加载</button></footer></section>`;
    const q = (selector) => host.querySelector(selector),
      frame = q("[data-pptist-frame]");
    const openInput = document.createElement("input");
    openInput.type = "file";
    openInput.hidden = true;
    host.append(openInput);
    let disposed = false,
      visible = !host.hidden,
      ready = false,
      initialized = false,
      integratedControls = false,
      componentUnavailable = false,
      selection,
      renderedVersion,
      sentDocument,
      saveTimer,
      saveFeedbackTimer,
      manualSaving = false,
      manualSaved = false,
      openingFile = false,
      loadTimer,
      restoring = false;
    let selectionQueue = Promise.resolve();
    // On macOS, Electron's HTML fullscreen promise can resolve before the
    // native window transition. Use the existing preload window-state signal
    // before requesting exit; otherwise Chromium can strand the iframe.
    let fullscreenExitPending = false;
    let fullscreenExitTimer;
    const finishFullscreenExit = () => {
      if (!fullscreenExitPending) return;
      fullscreenExitPending = false;
      clearTimeout(fullscreenExitTimer);
      if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => {});
    };
    const windowState = new MutationObserver(() => {
      if (document.documentElement.dataset.desktopFullscreen === "true") finishFullscreenExit();
    });
    const requests = new Map();
    const session = new PresentationSession({ api, taskId, resourceId, changed: paint });
    const post = (type, payload = {}) =>
      frame.contentWindow?.postMessage(
        { protocol: "atria-pptist-v1", channel, type, ...payload },
        location.origin
      );
    const syncAppearance = () => {
      if (ready)
        post("appearance", { theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" });
    };
    const appearance = new MutationObserver(syncAppearance);
    function loadFrame(preserveHistory = false) {
      if (!ready || !session.document) return;
      restoring = true;
      renderedVersion = session.viewVersion;
      sentDocument = JSON.stringify(session.document);
      post("load", {
        document: session.document,
        title: session.resource.title,
        slideId: selection?.slideId,
        preserveHistory
      });
    }
    function paint() {
      if (disposed || !session.document) return;
      const error = componentUnavailable ? "PPT 内置组件暂不可用，请在设置中启用或修复安装" : session.error;
      const sourcePending =
        !!session.resource.sourceFile &&
        session.resource.sourceFile.savedRevision !== session.resource.revision;
      q("[data-pptist-rename]").textContent = session.resource.title;
      q("[data-pptist-status]").textContent =
        error ||
        (openingFile
          ? "正在打开文件…"
          : session.busy
            ? manualSaving
              ? "正在保存…"
              : "正在保留草稿…"
            : session.dirty
              ? "未保存的修改"
              : sourcePending
                ? "草稿已保留 · 待保存到原文件"
                : session.resource.sourceFile
                  ? "已保存到原文件"
                  : "已保存");
      q("[data-pptist-status]").title = `r${session.revision} · ${session.document.slides.length} 页`;
      q("[data-pptist-status]").dataset.state = error
        ? "error"
        : session.dirty || sourcePending
          ? "dirty"
          : "saved";
      for (const b of host.querySelectorAll(".pptist-actions button, [data-pptist-rename]"))
        b.disabled = session.busy || manualSaving || openingFile || restoring || !initialized;
      q("[data-pptist-save]").textContent = manualSaving
        ? "保存中…"
        : manualSaved && !session.dirty && !sourcePending
          ? "已保存"
          : "保存";
      q("[data-pptist-save]").title = session.resource.sourceFile
        ? `保存到原文件：${session.resource.sourceFile.path}`
        : "保存到 CoworkOS 工作区；下载文件请使用“导出”";
      q("[data-pptist-rename]").title = session.resource.sourceFile?.path || session.resource.title;
      // Only retire the fallback controls after this editor confirms that its
      // single command bar can invoke the host's document lifecycle actions.
      q(".pptist-toolbar").hidden = integratedControls && initialized && !componentUnavailable;
      q(".pptist-status").hidden = integratedControls && initialized && !error;
      q("[data-pptist-backup]").hidden = !error;
      q("[data-pptist-reload]").hidden = !error;
      post("locked", { locked: !!session.pending && !session.busy });
      post("title", { title: session.resource.title });
      post("host-state", {
        title: session.resource.title,
        disabled: session.busy || manualSaving || openingFile || restoring || !initialized,
        saveLabel: q("[data-pptist-save]").textContent,
        saveTitle: q("[data-pptist-save]").title,
        status: q("[data-pptist-status]").textContent,
        statusState: q("[data-pptist-status]").dataset.state
      });
      // A retained recovery draft is safe to close without overwriting its source.
      onDirtyChange?.(session.dirty || !!session.pending);
      onContextChange?.({
        title: session.resource.title,
        selection: selection?.slideId
          ? `第 ${session.document.slides.findIndex((s) => s.id === selection.slideId) + 1} 页`
          : "",
        dirty: session.dirty || sourcePending
      });
      if (ready && !restoring && !session.dirty && !session.busy) {
        if (session.viewVersion !== renderedVersion) loadFrame();
        else if (JSON.stringify(session.document) !== sentDocument) loadFrame(true);
      }
    }
    async function capture() {
      if (!initialized || restoring) throw new Error("编辑器正在加载，请稍后再试");
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(new Error("编辑器响应超时，草稿仍保留"));
        }, 5000);
        requests.set(id, { resolve, reject, timer });
        post("snapshot", { requestId: id });
      });
    }
    async function save({ writeSource = false } = {}) {
      const sourcePending =
        !!session.resource.sourceFile &&
        session.resource.sourceFile.savedRevision !== session.resource.revision;
      if (componentUnavailable && !session.dirty && !session.pending && !sourcePending) return true;
      clearTimeout(saveTimer);
      try {
        await capture();
        const result = await session.save();
        if (result) {
          if (writeSource && session.resource.sourceFile && api.saveSourceFile) {
            session.resource = (await api.saveSourceFile(taskId, resourceId, session.revision)).resource;
            paint();
          }
          if (selection) selected(selection);
          onChanged?.();
          if (session.dirty && !session.error) scheduleSave();
        }
        return result && !session.dirty;
      } catch (e) {
        session.error = e.message;
        paint();
        return false;
      }
    }
    async function manualSave() {
      if (manualSaving) return;
      clearTimeout(saveFeedbackTimer);
      manualSaving = true;
      manualSaved = false;
      paint();
      try {
        manualSaved = await save({ writeSource: true });
      } finally {
        manualSaving = false;
        paint();
        saveFeedbackTimer = setTimeout(() => {
          manualSaved = false;
          paint();
        }, 2500);
      }
    }
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void save(), 650);
    }
    function selected(value) {
      if (!value?.slideId) return;
      selection = value;
      // Wait for the current draft to commit before persisting new element IDs.
      if (!session.dirty && !session.busy && !session.pending) {
        selectionQueue = selectionQueue
          .catch(() => {})
          .then(() =>
            api.saveSelection(taskId, resourceId, {
              schema: "pptist.selection/v1",
              data: value,
              appInstanceId: instance.appInstanceId
            })
          )
          .catch(() => {});
      }
      onContextChange?.({
        title: session.resource?.title,
        selection: `第 ${session.document.slides.findIndex((s) => s.id === value.slideId) + 1} 页`,
        dirty:
          session.dirty ||
          (!!session.resource.sourceFile &&
            session.resource.sourceFile.savedRevision !== session.resource.revision)
      });
    }
    function receive(event) {
      const message = event.data;
      if (
        disposed ||
        event.source !== frame.contentWindow ||
        event.origin !== location.origin ||
        message?.protocol !== "atria-pptist-v1" ||
        message.channel !== channel
      )
        return;
      if (message.type === "component-unavailable") {
        componentUnavailable = true;
        restoring = false;
        clearTimeout(loadTimer);
        q("[data-pptist-loading]").hidden = true;
        q("[data-pptist-retry]").hidden = false;
        paint();
      } else if (message.type === "ready") {
        ready = true;
        integratedControls =
          Array.isArray(message.capabilities) && message.capabilities.includes("host-commands-v1");
        syncAppearance();
        loadFrame();
      } else if (message.type === "loaded") {
        restoring = false;
        initialized = true;
        clearTimeout(loadTimer);
        q("[data-pptist-loading]").hidden = true;
        selected(message.selection);
        paint();
      } else if (message.type === "change" || message.type === "snapshot") {
        if (message.document?.version !== 1 || !Array.isArray(message.document.slides)) return;
        sentDocument = JSON.stringify(message.document);
        session.edit(message.document);
        if (message.selection) selected(message.selection);
        if (message.type === "change") scheduleSave();
        const request = requests.get(message.requestId);
        if (request) {
          clearTimeout(request.timer);
          requests.delete(message.requestId);
          request.resolve();
        }
      } else if (message.type === "selection") selected(message.selection);
      else if (message.type === "open-file") {
        if (openingFile || ![".pptx", ".json"].includes(message.accept)) return;
        openInput.accept = message.accept;
        openInput.click();
      } else if (message.type === "host-command") {
        if (!integratedControls || !initialized || session.busy || manualSaving || openingFile || restoring)
          return;
        const commands = {
          new: "[data-pptist-new]",
          rename: "[data-pptist-rename]",
          review: "[data-pptist-review]",
          "undo-save": "[data-pptist-undo]",
          export: "[data-pptist-export]",
          save: "[data-pptist-save]",
          "save-copy": "[data-application-save-copy]"
        };
        if (typeof message.command !== "string" || !Object.hasOwn(commands, message.command)) return;
        const button = q(commands[message.command]);
        if (button && !button.disabled) button.click();
      } else if (message.type === "save") void manualSave();
      else if (message.type === "exit-fullscreen") {
        fullscreenExitPending = true;
        if (
          document.documentElement.dataset.desktopPlatform === "darwin" &&
          document.documentElement.dataset.desktopFullscreen !== "true"
        ) {
          // Also recover if no native transition event arrives (e.g. entry was denied).
          clearTimeout(fullscreenExitTimer);
          fullscreenExitTimer = setTimeout(finishFullscreenExit, 2000);
        } else finishFullscreenExit();
      } else if (message.type === "error") {
        session.error = message.message;
        paint();
      }
    }
    await session.load();
    windowState.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-desktop-fullscreen"]
    });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("message", receive);
    function start() {
      ready = initialized = false;
      integratedControls = false;
      componentUnavailable = false;
      q(".pptist-toolbar").hidden = false;
      q(".pptist-status").hidden = false;
      q("[data-pptist-loading]").hidden = false;
      frame.src = `/assets/pptist/generated/index.html#channel=${channel}`;
      loadTimer = setTimeout(() => {
        if (!initialized) {
          q("[data-pptist-loading]").textContent = "演示文稿加载失败，请重试";
          q("[data-pptist-retry]").hidden = false;
        }
      }, 20000);
    }
    start();
    const guard = (action) => async () => {
      try {
        await action();
      } catch (e) {
        session.error = e.message;
        paint();
      }
    };
    openInput.onchange = guard(async () => {
      const file = openInput.files?.[0];
      openInput.value = "";
      if (!file || openingFile) return;
      const navigation = api.captureNavigation?.();
      openingFile = true;
      paint();
      try {
        if (!(await save()) || disposed || (navigation && !navigation.current())) return;
        await api.openLocalFile(file);
      } finally {
        openingFile = false;
        paint();
      }
    });
    q("[data-pptist-save]").onclick = manualSave;
    q("[data-pptist-retry]").onclick = () => {
      clearTimeout(loadTimer);
      q("[data-pptist-retry]").hidden = true;
      frame.src = "about:blank";
      setTimeout(start, 0);
    };
    q("[data-pptist-new]").onclick = guard(async () => {
      if (await save()) create();
    });
    q("[data-pptist-rename]").onclick = () =>
      nameDocument(host, {
        title: "重命名演示文稿",
        value: session.resource.title,
        submitLabel: "保存",
        async onSubmit(title) {
          if (!(await save())) throw new Error(session.error || "请先保存");
          await api.renameResource(taskId, resourceId, title);
          await session.refresh();
          onChanged?.();
        }
      });
    q("[data-pptist-review]").onclick = guard(() =>
      openResourceReview({
        api,
        taskId,
        resourceId,
        canUndo: () => !session.dirty && !session.busy,
        onUndo: () => session.reload()
      })
    );
    q("[data-pptist-undo]").onclick = guard(async () => {
      if (!(await save())) return;
      await api.undo(taskId, resourceId, instance.appInstanceId, { baseRevision: session.revision });
      await session.reload();
    });
    q("[data-pptist-export]").onclick = guard(async () => {
      if (!(await save())) return;
      post("export");
    });
    q("[data-pptist-backup]").onclick = () =>
      download(
        JSON.stringify({ title: session.resource.title, ...session.document }, null, 2),
        `${session.resource.title}-草稿.json`
      );
    q("[data-pptist-reload]").onclick = guard(async () => {
      await session.reload();
    });
    const poll = createVisiblePoll({ run: () => session.refresh(), intervalMs: 2500, active: visible });
    const persist = () => session.persist();
    window.addEventListener("pagehide", persist);
    return {
      setVisible(value) {
        visible = Boolean(value);
        poll.setActive(visible);
      },
      captureUiState: () => ({ selection }),
      restoreUiState: (state) => {
        if (state?.selection) selection = state.selection;
      },
      getSelection: () => selection && { schema: "pptist.selection/v1", data: selection },
      focus: () => frame.focus(),
      flush: save,
      canClose: save,
      handleResourceEvent: (event) =>
        event.type === "resource.selection_changed" ||
        event.revision <= session.revision ||
        !visible ||
        document.hidden
          ? true
          : session.refresh(),
      async unmount() {
        disposed = true;
        windowState.disconnect();
        appearance.disconnect();
        clearTimeout(fullscreenExitTimer);
        clearTimeout(saveTimer);
        clearTimeout(saveFeedbackTimer);
        clearTimeout(loadTimer);
        poll.dispose();
        session.persist();
        window.removeEventListener("message", receive);
        window.removeEventListener("pagehide", persist);
        for (const r of requests.values()) {
          clearTimeout(r.timer);
          r.reject(new Error("编辑器已关闭"));
        }
        requests.clear();
        host.innerHTML = "";
      }
    };
  }
};
