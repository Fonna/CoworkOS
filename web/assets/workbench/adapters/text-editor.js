import { renderDocumentMarkdown } from "../../document-markdown.js";
import { ui } from "../../ui/language.js";
import { mountLocalFileOpener, readLocalText } from "./local-file-opener.js";
import { openResourceReview } from "./resource-review.js";
import { escapeHtml as esc } from "../html.js";
import { TextDocumentSession } from "./text-document-session.js";
import { nameDocument, documentKind } from "./document-name-dialog.js";
import { icon } from "../../ui/icons.js";
import { createMenu } from "../../ui/menu.js";
export { minimalReplace, operationId, shouldKeepDraft } from "./text-edit.js";

/** Present operation provenance in the history list. */
function describeActor(actor) {
  if (!actor) return ui("未知");
  return actor.type === "agent" ? "CoworkOS" : actor.type === "system" ? ui("系统") : ui("你");
}

function renderHistory(operations = []) {
  if (!operations.length) return ui('<div class="editor-history-empty">还没有修改记录</div>');
  return [...operations]
    .reverse()
    .map(
      (event) => `<div class="editor-history-row ${event.actor?.type === "agent" ? "by-agent" : "by-user"}">
    <span class="editor-history-revision">r${esc(event.revision)}</span>
    <span class="editor-history-copy"><strong>${esc(describeActor(event.actor))}</strong><small>${esc(event.summary || event.operationType)}</small></span>
  </div>`
    )
    .join("");
}

const definition = {
  appType: "text-editor",
  icon: "i-text",
  displayName: ui("文本编辑器"),
  version: "1",
  resourceKinds: ["text/plain", "text/markdown"],
  capabilities: ["view", "edit", "select", "history", "export", "agent-commands"]
};

/**
 * The browser-side text editor.
 *
 * This adapter owns DOM, caret/selection and debounce timers. Document state,
 * serialized writes and conflict handling belong to TextDocumentSession, which
 * can be tested independently of an editor component or the workbench host.
 *
 * ADR-08: a plain textarea. The content and selection loop has to be exactly
 * right before an editor component is worth introducing, and swapping in
 * CodeMirror later changes nothing outside this file.
 */
async function readImportedFile(file) {
  if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new Error(ui("请选择 TXT 或 Markdown 文件"));
  return {
    title: file.name,
    kind: /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : "text/plain",
    initialContent: await readLocalText(file)
  };
}

export const textEditorAdapter = {
  readFile: readImportedFile,
  definition,

  canOpen(resource) {
    return definition.resourceKinds.includes(resource?.kind);
  },

  async mount(host, { instance, taskId, api, onDirtyChange, onChanged, onContextChange }) {
    // Keep size containment outside the editor's flex layout. Electron can
    // drop its body layout tree when that same container expands to full width.
    host.classList.add("text-editor-host");
    /**
     * The editor with nothing open yet.
     *
     * An application window can exist before a document does — "open the
     * editor" and "create a file" are different acts. This is the state a real
     * editor shows on launch, and it is where naming actually belongs.
     */
    if (!instance.resourceIds[0]) {
      host.innerHTML = ui`<section class="text-editor is-empty application-home" aria-label="文本编辑器">
        <div class="editor-empty-symbol application-home-icon">${icon("text")}</div><h2>文本编辑器</h2>
        <div class="application-home-actions"><button class="app-button is-primary" data-empty-new type="button">${icon("plus")}新建文档</button></div>
        <div class="editor-empty-actions application-home-files" data-empty-list></div>
      </section>`;
      const list = host.querySelector("[data-empty-list]");
      const paintList = async () => {
        try {
          const result = await api.listResources(taskId);
          const resources = result.resources.filter((entry) => definition.resourceKinds.includes(entry.kind));
          list.innerHTML = resources.length
            ? resources
                .map(
                  (entry) =>
                    `<button class="app-button editor-open-row" type="button" data-open="${esc(entry.resourceId)}" title="${esc(entry.title)} · r${esc(entry.revision)}">${icon("file")}<strong>${esc(entry.title)}</strong></button>`
                )
                .join("")
            : "";
          list.querySelectorAll("[data-open]").forEach((node) =>
            node.addEventListener("click", () => {
              api.openResourceInTab?.(taskId, node.dataset.open);
            })
          );
        } catch {
          list.innerHTML = "";
        }
      };
      const createHere = () =>
        nameDocument(host, {
          title: ui("新建文档"),
          value: ui("未命名.md"),
          submitLabel: ui("创建"),
          onSubmit: async (title) => {
            // Fills this window rather than opening another one beside it.
            await api.createInApplication(taskId, instance.appInstanceId, {
              kind: documentKind(title),
              title,
              initialContent: ""
            });
            // The host re-reads the strip, which remounts this window with the
            // document in it — the editor cannot show it on its own, because the
            // empty state and the editing state are different mounts.
            await api.onDocumentCreated?.();
          }
        });
      host.querySelector("[data-empty-new]").addEventListener("click", createHere);
      const opener = mountLocalFileOpener(host.querySelector(".application-home-actions"), {
        accept: ".txt,.md,.markdown",
        api,
        taskId,
        instance,
        read: readImportedFile
      });
      await paintList();
      return {
        focus() {},
        captureUiState() {
          return {};
        },
        restoreUiState() {},
        getSelection() {
          return undefined;
        },
        handleResourceEvent() {},
        flush() {},
        async unmount() {
          opener.dispose();
          host.classList.remove("text-editor-host");
          host.innerHTML = "";
        }
      };
    }
    const resourceId = instance.resourceIds[0];
    let saveTimer;
    let selectionTimer;
    let destroyed = false;

    // The layout of an application, not a panel widget: a menu bar of the
    // actions a text editor is expected to have, the document filling the
    // window, and history tucked away until asked for.
    host.innerHTML = ui`<section class="text-editor" aria-label="文本编辑器">
      <header class="editor-menubar">
        <div class="editor-menu-identity"><span class="app-icon-badge">${icon("text")}</span><div><button class="editor-title" type="button" data-editor-rename title="重命名文档"><span data-editor-title></span>${icon("pencil", "editor-rename-hint")}</button></div></div>
        <div class="editor-menu-actions">
          <button class="app-button" data-editor-open type="button" aria-haspopup="menu" aria-expanded="false" title="打开此工作区的其他文档">打开${icon("chevron-down")}</button>
          <a data-editor-download class="app-button is-icon editor-menu-link" download aria-label="另存" title="下载一份到本机">${icon("download")}</a>
          <button class="app-button" data-editor-preview-toggle type="button" aria-pressed="true" hidden>预览</button>
          <button class="app-button" data-editor-review type="button">修改对比</button><button class="app-button is-icon" data-editor-history-toggle type="button" aria-pressed="false" aria-label="历史" title="显示或隐藏修改历史">${icon("history")}</button>
          <span class="editor-menu-separator"></span>
          <button class="app-button is-icon" data-editor-undo type="button" aria-label="撤销" title="撤销上一次修改">${icon("undo")}</button>
          <button class="app-button is-primary" data-editor-save type="button" title="立即保存（⌘/Ctrl+S）">${icon("save")}保存</button>
        </div>
      </header>
      <div class="editor-conflict" data-editor-conflict hidden></div>
      <div class="editor-body">
        <div class="editor-document" data-editor-document>
        <textarea class="editor-surface" aria-label="文档内容" data-editor-input spellcheck="false" placeholder="开始编辑…"></textarea>
        <article class="editor-preview markdown-body" data-editor-preview aria-label="Markdown 预览" hidden></article>
        </div>
        <aside class="editor-history" data-editor-history-pane aria-label="修改历史" hidden>
          <div class="editor-history-head">${icon("history")}修改历史</div>
          <div data-editor-history></div>
        </aside>
      </div>
      <div class="editor-open-sheet" data-editor-open-sheet role="menu" aria-label="打开文档" hidden></div>
      <footer class="editor-statusbar">
        <div class="editor-file-state"><span class="ui-status editor-status" data-editor-status role="status">正在打开…</span><span data-editor-cursor class="editor-cursor"></span><details class="editor-file-info" data-editor-info><summary aria-label="文档信息" title="文档信息">${icon("info")}</summary><div><span data-editor-revision class="editor-revision">r—</span><span class="editor-file-encoding">UTF-8</span><span data-editor-path class="editor-path"></span></div></details></div>
        <div class="editor-statusbar-actions">
                    <button data-editor-handoff type="button" class="app-button editor-handoff">${icon("chat")}让 CoworkOS 继续</button>
        </div>
      </footer>
    </section>`;

    const input = host.querySelector("[data-editor-input]");
    const preview = host.querySelector("[data-editor-preview]");
    const previewToggle = host.querySelector("[data-editor-preview-toggle]");
    const documentPane = host.querySelector("[data-editor-document]");
    let previewEnabled = true;
    let renderedContent;
    function paintPreview() {
      const markdown = session.state.resource.kind === "text/markdown";
      previewToggle.hidden = !markdown;
      const visible = markdown && previewEnabled;
      preview.hidden = !visible;
      documentPane.classList.toggle("has-preview", visible);
      previewToggle.setAttribute("aria-pressed", String(previewEnabled));
      if (visible && renderedContent !== input.value) {
        preview.innerHTML = renderDocumentMarkdown(input.value);
        renderedContent = input.value;
      }
    }
    previewToggle.addEventListener("click", () => {
      previewEnabled = !previewEnabled;
      paintPreview();
    });
    const fileInfo = host.querySelector("[data-editor-info]");
    const closeFileInfo = (event) => {
      if (!fileInfo.contains(event.target)) fileInfo.open = false;
    };
    host.addEventListener("click", closeFileInfo);
    fileInfo.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !fileInfo.open) return;
      event.preventDefault();
      fileInfo.open = false;
      fileInfo.querySelector("summary").focus();
    });
    function paintCursor() {
      const before = input.value.slice(0, input.selectionStart ?? 0);
      const lines = before.split("\n");
      const selectedText = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
      onContextChange?.({
        title: host.querySelector("[data-editor-title]")?.textContent,
        selection: selectedText ? ui`${Array.from(selectedText).length} 字符` : undefined,
        dirty: session.dirty
      });
      host.querySelector("[data-editor-cursor]").textContent = selectedText
        ? ui`选中 ${Array.from(selectedText).length} 字符`
        : ui`行 ${lines.length} · 列 ${Array.from(lines.at(-1)).length + 1}`;
    }
    /**
     * Caret helpers that degrade instead of throwing.
     *
     * `setSelectionRange` is absent in some embedding contexts, and an editor
     * that throws while restoring a caret loses the content it was loading —
     * the caret is a convenience, the document is not.
     */
    const caretAt = () => (typeof input.selectionStart === "number" ? input.selectionStart : 0);
    const caretEnd = () => (typeof input.selectionEnd === "number" ? input.selectionEnd : caretAt());
    const putCaret = (from, to = from) => {
      if (typeof input.setSelectionRange !== "function") return;
      try {
        input.setSelectionRange(from, to);
      } catch {
        /* caret is cosmetic */
      }
    };
    const statusNode = host.querySelector("[data-editor-status]");
    const revisionNode = host.querySelector("[data-editor-revision]");
    const historyNode = host.querySelector("[data-editor-history]");
    const conflictNode = host.querySelector("[data-editor-conflict]");

    const session = new TextDocumentSession({
      transport: {
        read: () => api.readResource(taskId, resourceId),
        write: (operation) => api.applyOperation(taskId, resourceId, operation),
        saveSource: (revision) => api.saveSourceFile(taskId, resourceId, revision),
        undo: () => api.undo(taskId, resourceId, instance.appInstanceId)
      },
      appInstanceId: instance.appInstanceId,
      onChange: renderSession,
      onCommitted: onChanged
    });
    const dirty = () => session.dirty;
    input.disabled = true;
    function paintStatus(message) {
      const { conflict, saving, undoing, resource, serverRevision, error } = session.state;
      statusNode.textContent =
        message ??
        error ??
        (conflict
          ? ui("有冲突待处理")
          : undoing
            ? ui("正在撤销…")
            : saving
              ? ui("正在保存…")
              : dirty()
                ? ui("未保存")
                : resource.externalChangeAt
                  ? ui("文件已在工作区外被修改")
                  : resource.sourceFile && resource.sourceFile.savedRevision !== resource.revision
                    ? ui("原文件尚未保存，请重试保存")
                    : resource.sourceFile
                      ? ui("已保存到原文件")
                      : ui("已自动保存"));
      statusNode.dataset.state = conflict
        ? "conflict"
        : error
          ? "error"
          : undoing
            ? "undoing"
            : saving
              ? "saving"
              : dirty()
                ? "dirty"
                : resource.externalChangeAt
                  ? "external"
                  : "saved";
      revisionNode.textContent = `r${serverRevision}`;
      onDirtyChange?.(
        dirty() || (!!resource.sourceFile && resource.sourceFile.savedRevision !== resource.revision)
      );
    }

    function renderSession(next, previous) {
      input.disabled = !next.loaded;
      if (input.value !== next.draftContent) {
        const caret = Math.min(caretAt(), next.draftContent.length);
        input.value = next.draftContent;
        putCaret(caret);
      }
      if (next.resource !== previous.resource || next.operations !== previous.operations) paintHistory();
      if (next.conflict !== previous.conflict || next.serverContent !== previous.serverContent)
        renderConflict();
      paintPreview();
      paintStatus();
      paintCursor();
    }

    function paintHistory() {
      const { resource, operations } = session.state;
      historyNode.innerHTML = renderHistory(operations);
      const name = resource.title || instance.title || ui("未命名");
      host.querySelector("[data-editor-title]").textContent = name;
      host.querySelector("[data-editor-rename]").title = ui`${name} · 重命名文档`;
      // Saved, always — there is no publish step that makes this real. The
      // resource already appears in the Task's outputs panel.
      host.querySelector("[data-editor-path]").textContent = resource.sourceFile?.path || resource.path || "";
      host.querySelector("[data-editor-path]").title = resource.sourceFile?.path || resource.path || "";
      host.querySelector("[data-editor-save]").title = resource.sourceFile
        ? ui`保存到原文件：${resource.sourceFile.path}`
        : ui("保存");
      // The composer loads an independent document when the user asks for help.
      const standalone = api.isStandaloneTask?.(taskId) === true;
      const handoff = host.querySelector("[data-editor-handoff]");
      if (handoff) handoff.hidden = standalone;
      const download = host.querySelector("[data-editor-download]");
      if (download) {
        // A plain link, so the browser writes the file wherever the person has
        // it configured to — the page itself never touches the filesystem.
        download.href = api.downloadUrl(
          taskId,
          resourceId,
          resource.kind === "text/plain" ? "text" : "markdown"
        );
        download.setAttribute("download", name);
        download.title = ui`下载一份 ${name} 到本机（不影响产出物）`;
      }
    }

    function renderConflict() {
      const { conflict, serverContent } = session.state;
      conflictNode.hidden = !conflict;
      if (!conflict) {
        conflictNode.innerHTML = "";
        return;
      }
      conflictNode.innerHTML = ui`<strong>内容有冲突</strong><p>${esc(conflict.message)}</p>
        <details><summary>查看最新保存的内容</summary><pre>${esc(serverContent)}</pre></details>
        <div class="editor-conflict-actions">
          <button data-conflict="reload" type="button">载入最新版本（放弃我的草稿）</button>
          <button data-conflict="copy" type="button">复制我的草稿</button>
          <button data-conflict="keep" type="button">保留草稿，稍后手动合并</button>
          <button data-conflict="merge" type="button">保存合并后的内容</button>
        </div>`;
      conflictNode.querySelector('[data-conflict="reload"]').addEventListener("click", () => {
        void load({ discardDraft: true });
      });
      conflictNode.querySelector('[data-conflict="copy"]').addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(session.state.draftContent);
        } catch {
          /* the draft stays in the textarea */
        }
      });
      conflictNode
        .querySelector('[data-conflict="keep"]')
        .addEventListener("click", () => paintStatus(ui("草稿已保留，自动保存已暂停")));
      conflictNode.querySelector('[data-conflict="merge"]').addEventListener("click", () => {
        void session.merge();
      });
    }

    async function load(options) {
      try {
        await session.load(options);
        return true;
      } catch (error) {
        paintStatus(ui`读取失败：${error.message}`);
        return false;
      }
    }

    const save = () => session.save();

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void save(), 750);
    }

    function persistSelection() {
      return api.saveSelection(taskId, resourceId, {
        schema: "text.range/v1",
        appInstanceId: instance.appInstanceId,
        data: { anchor: caretAt(), head: caretEnd() }
      });
    }

    function scheduleSelection() {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (destroyed) return;
        void persistSelection().catch(() => {});
      }, 250);
    }

    const onInput = () => {
      session.edit(input.value);
      scheduleSave();
    };
    const onBlur = () => {
      clearTimeout(saveTimer);
      void save();
      scheduleSelection();
    };
    const onSelect = () => {
      paintCursor();
      scheduleSelection();
    };
    /**
     * Claim Ctrl/Cmd+S for the document.
     *
     * Unclaimed, the browser answers with "save this web page", which offers to
     * write an HTML file and has nothing to do with the resource. The content
     * is already autosaved, so this flushes the pending transaction now and
     * says so — the key does what the user means by it.
     */
    const onKeydown = (event) => {
      if (event.key !== "s" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      clearTimeout(saveTimer);
      if (session.state.conflict) {
        paintStatus(ui("有冲突待处理，请先选择如何合并"));
        return;
      }
      if (!dirty() && !session.state.resource.sourceFile) {
        paintStatus(ui("已是最新，无需保存"));
        return;
      }
      void save();
    };
    input.addEventListener("input", onInput);
    input.addEventListener("blur", onBlur);
    input.addEventListener("select", onSelect);
    input.addEventListener("keyup", onSelect);
    input.addEventListener("mouseup", onSelect);
    input.addEventListener("keydown", onKeydown);

    // Save is explicit as well as automatic. Autosave is what keeps work safe;
    // a save button is what lets someone confirm it landed, which is the whole
    // reason Ctrl+S felt missing.
    host.querySelector("[data-editor-save]").addEventListener("click", () => {
      clearTimeout(saveTimer);
      if (session.state.conflict) {
        paintStatus(ui("有冲突待处理，请先选择如何合并"));
        return;
      }
      if (!dirty() && !session.state.resource.sourceFile) {
        paintStatus(ui("已是最新，无需保存"));
        return;
      }
      void save();
    });

    host.querySelector("[data-editor-review]").addEventListener("click", () => {
      void openResourceReview({
        api,
        taskId,
        resourceId,
        canUndo: () => !session.dirty && !session.state.conflict,
        onUndo: async () => {
          await session.load();
          onChanged?.();
        }
      }).catch((error) => {
        paintStatus(error.message);
      });
    });
    const historyPane = host.querySelector("[data-editor-history-pane]");
    const historyToggle = host.querySelector("[data-editor-history-toggle]");
    historyToggle.addEventListener("click", () => {
      historyPane.hidden = !historyPane.hidden;
      historyToggle.setAttribute("aria-pressed", String(!historyPane.hidden));
    });

    /**
     * Open another text document in this workspace.
     *
     * An editor that can only ever show the one document it was handed is not
     * an editor. The list includes formats this editor supports within the same
     * workspace, independently of which conversation loads the document.
     */
    const openSheet = host.querySelector("[data-editor-open-sheet]");
    const openPicker = createMenu(host.querySelector("[data-editor-open]"), openSheet, {
      toggleOnClick: false,
      onClose: () => {
        openSheet.innerHTML = "";
      }
    });
    const closeSheet = () => openPicker.close(true);
    host.querySelector("[data-editor-open]").addEventListener("click", async () => {
      if (!openSheet.hidden) {
        closeSheet();
        return;
      }
      openSheet.hidden = false;
      host.querySelector("[data-editor-open]").setAttribute("aria-expanded", "true");
      openSheet.innerHTML = ui(
        '<div class="editor-open-title">打开文档</div><div class="editor-open-empty">正在读取…</div>'
      );
      try {
        const { resources } = await api.listResources(taskId);
        if (openSheet.hidden) return;
        const others = resources.filter(
          (entry) => entry.resourceId !== resourceId && definition.resourceKinds.includes(entry.kind)
        );
        openSheet.innerHTML = ui`<div class="editor-open-title">打开文档</div>${
          others.length
            ? others
                .map(
                  (entry) =>
                    `<button class="app-button editor-open-row" type="button" data-open="${esc(entry.resourceId)}" title="${esc(entry.title)} · r${esc(entry.revision)}">${icon("file")}<strong>${esc(entry.title)}</strong></button>`
                )
                .join("")
            : ui('<div class="editor-open-empty">此工作区还没有其他文档</div>')
        }<button class="editor-open-row is-new" type="button" data-open-new>${icon("plus")}新建文档</button>`;
        openSheet.querySelector("button")?.focus();
        openSheet.querySelectorAll("[data-open]").forEach((node) =>
          node.addEventListener("click", () => {
            closeSheet();
            api.openResourceInTab?.(taskId, node.dataset.open);
          })
        );
        openSheet.querySelector("[data-open-new]")?.addEventListener("click", () => {
          closeSheet();
          nameDocument(host, {
            title: ui("新建文档"),
            value: session.state.resource.kind === "text/plain" ? ui("未命名.txt") : ui("未命名.md"),
            submitLabel: ui("创建"),
            onSubmit: (title) =>
              api.createAndOpen(taskId, title, documentKind(title, session.state.resource.kind))
          });
        });
      } catch (error) {
        if (!openSheet.hidden)
          openSheet.innerHTML = ui`<div class="editor-open-empty">读取失败：${esc(error.message)}</div>`;
      }
    });
    host.querySelector("[data-editor-rename]").addEventListener("click", () => {
      const current = session.state.resource.title || instance.title || "";
      nameDocument(host, {
        title: ui("重命名"),
        value: current,
        submitLabel: ui("保存名称"),
        onSubmit: async (next) => {
          if (next === current) return;
          // Renaming is not an edit: no revision, no history entry. It does
          // change the tab name and the exported filename.
          const result = await api.renameResource(taskId, resourceId, next);
          session.rename(result.resource);
          paintStatus(ui`已重命名为 ${session.state.resource.title}`);
          onChanged?.();
        }
      });
    });
    host.querySelector("[data-editor-undo]").addEventListener("click", async () => {
      clearTimeout(saveTimer);
      await session.undo();
    });
    // The link renders whatever the server currently holds, so an unsent
    // transaction has to land first or the person downloads a stale copy.
    let downloading = false;
    host.querySelector("[data-editor-download]").addEventListener("click", async (event) => {
      if (session.state.conflict) {
        event.preventDefault();
        paintStatus(ui("请先处理冲突后再下载"));
        return;
      }
      if (!dirty() || downloading) return;
      event.preventDefault();
      clearTimeout(saveTimer);
      downloading = true;
      try {
        await save();
        // Re-dispatch only once the edit actually landed. Retrying on a failed
        // save re-entered this handler with identical state, which on a 500 was
        // an unbounded request loop against the failing endpoint.
        if (!destroyed && !session.state.conflict && !dirty())
          host.querySelector("[data-editor-download]")?.click();
        else if (dirty()) paintStatus(ui("请先保存成功后再下载"));
      } finally {
        downloading = false;
      }
    });
    host.querySelector("[data-editor-handoff]").addEventListener("click", async () => {
      // Handing off is an ordinary request the user can read and edit before
      // sending — not a hidden channel from an app into the model.
      const saved = await save();
      if (!saved || dirty() || session.state.conflict) {
        paintStatus(ui("请先保存草稿或处理冲突后再继续"));
        return;
      }
      clearTimeout(selectionTimer);
      try {
        await persistSelection();
      } catch (error) {
        paintStatus(ui`选区保存失败：${error.message}`);
        return;
      }
      try {
        await api.handoffToConversation?.({
          taskId,
          resourceId,
          appInstanceId: instance.appInstanceId,
          title: session.state.resource.title || instance.title,
          hasSelection: caretAt() !== caretEnd()
        });
      } catch (error) {
        paintStatus(ui`交接失败：${error.message}`);
      }
    });

    await load();

    return {
      focus() {
        input.focus();
      },
      async canClose() {
        clearTimeout(saveTimer);
        const saved = await save();
        if (saved && !dirty() && !session.state.conflict) return true;
        paintStatus(ui("请先保存草稿或处理冲突后再关闭"));
        return false;
      },
      /**
       * Send a pending edit now, synchronously enough for page unload.
       *
       * `sendBeacon` is the only transport a browser guarantees during unload;
       * a normal fetch is cancelled with the page. The ordinary save path runs
       * too when there is still time, so this is additive rather than a
       * replacement.
       */
      flush() {
        const operation = session.pendingOperation();
        if (!operation) return;
        const url = api.operationsUrl?.(taskId, resourceId);
        if (
          url &&
          navigator.sendBeacon?.(url, new Blob([JSON.stringify(operation)], { type: "application/json" }))
        )
          return;
        void save();
      },
      captureUiState() {
        return {
          scrollTop: input.scrollTop,
          anchor: caretAt(),
          head: caretEnd(),
          previewEnabled,
          previewScrollTop: preview.scrollTop
        };
      },
      restoreUiState(uiState) {
        if (!uiState) return;
        previewEnabled = uiState.previewEnabled !== false;
        paintPreview();
        preview.scrollTop = Number(uiState.previewScrollTop) || 0;
        input.scrollTop = Number(uiState.scrollTop) || 0;
        const anchor = Math.min(Number(uiState.anchor) || 0, input.value.length);
        const head = Math.min(Number(uiState.head) || anchor, input.value.length);
        putCaret(anchor, head);
      },
      getSelection() {
        return { schema: "text.range/v1", data: { anchor: caretAt(), head: caretEnd() } };
      },
      handleResourceEvent(event) {
        if (event.resourceId !== resourceId) return false;
        // A selection is explicitly not a revision, and the event carries none:
        // without this the guard below never fired and every caret move
        // refetched the document, collapsing the selection the user had just
        // made.
        if (event.type === "resource.selection_changed") return true;
        // Our own confirmed write already updated the view; replaying it would
        // fight the caret for no reason.
        if (typeof event.revision === "number" && event.revision <= session.state.serverRevision) return true;
        return load();
      },
      async unmount() {
        // Flush before tearing down. A debounced edit that has not been sent
        // yet is the user's only copy, and switching tabs or closing one is
        // exactly when it would be silently dropped — the `destroyed` flag
        // below is what stops the write, so it must not be set first.
        clearTimeout(saveTimer);
        if (session.state.loaded && !session.state.conflict && dirty()) {
          try {
            await save();
          } catch {
            /* the reload path reports it */
          }
        }
        openPicker.dispose();
        destroyed = true;
        session.dispose();
        clearTimeout(selectionTimer);
        input.removeEventListener("input", onInput);
        input.removeEventListener("blur", onBlur);
        input.removeEventListener("select", onSelect);
        input.removeEventListener("keyup", onSelect);
        input.removeEventListener("mouseup", onSelect);
        input.removeEventListener("keydown", onKeydown);
        host.removeEventListener("click", closeFileInfo);
        host.classList.remove("text-editor-host");
        host.innerHTML = "";
      }
    };
  }
};
