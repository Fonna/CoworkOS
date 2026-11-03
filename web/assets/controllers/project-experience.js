import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../workbench/html.js";

const states = { candidate: "待复核", active: "已启用", disabled: "已停用", rejected: "已拒绝" };
const normalize = (value) => ({
  ...value,
  settings: value.settings ?? {
    enabled: value.enabled,
    learningEnabled: value.learningEnabled,
    autoActivate: value.autoActivate,
    ...value.learningOptions
  },
  items: value.items ?? [...(value.entries ?? []), ...(value.candidates ?? [])]
});

/** Project-scoped drafts survive dialog closure; late requests only update their source project. */
export function createProjectExperienceController({ api, showToast = () => {} }) {
  const projects = new Map();
  let panel,
    modal,
    active,
    epoch = 0,
    loadController;
  const $ = (selector) => panel.querySelector(selector);
  const current = () => projects.get(active);
  const endpoint = (id) => `/api/projects/${encodeURIComponent(id)}/experience`;
  const visible = (record) => !panel.hidden && current() === record;
  const dirty = (draft) => draft && JSON.stringify(draft.fields) !== JSON.stringify(draft.baseline);

  function install() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "modal-backdrop settings-backdrop project-experience-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card settings-card project-experience-card" role="dialog" aria-modal="true" aria-labelledby="project-experience-title">
      <header class="settings-heading"><div><h2 id="project-experience-title">项目经验</h2><p data-project-name></p></div><button type="button" class="settings-nav-button" data-close aria-label="关闭项目经验">${icon("close")}</button></header>
      <div class="settings-scroll project-experience-scroll">
        <form data-settings class="project-experience-settings">
          <label class="project-experience-toggle"><span><strong>使用项目经验</strong></span><span class="settings-toggle"><input type="checkbox" aria-label="使用项目经验" name="enabled"></span></label>
          <label class="project-experience-toggle"><span><strong>自动沉淀</strong><small>经复核后启用，可能产生额外模型用量。</small></span><span class="settings-toggle"><input type="checkbox" aria-label="自动沉淀" name="learningEnabled"></span></label>
          <label class="project-experience-toggle"><span><strong>自动启用已验证经验与技能</strong><small>至少 3 个独立任务提供验证证据后，才可自动启用。</small></span><span class="settings-toggle"><input type="checkbox" aria-label="自动启用已验证经验与技能" name="autoActivate"></span></label>
          <details><summary>后台整理设置</summary><div class="project-experience-options">
            <label class="settings-field">后台模型<input name="model" aria-label="项目后台模型" maxlength="160" placeholder="留空使用当前连接的模型"></label>
            <label class="settings-field">每小时请求上限<input type="number" name="maxRequestsPerHour" aria-label="项目每小时请求上限" min="2" max="24" value="6"></label>
            <label class="settings-field">单次输出上限（tokens）<input type="number" name="maxTokens" aria-label="项目单次输出上限" min="256" max="4096" value="2048"></label>
          </div></details>
          <div class="project-experience-actions"><button type="submit" class="app-button is-secondary" data-save-settings disabled>保存项目经验设置</button></div>
        </form>
        <div class="project-experience-toolbar"><h3>经验与技能</h3><div class="project-experience-actions"><button type="button" class="app-button is-secondary" data-refresh>刷新列表</button><button type="button" class="app-button is-secondary" data-new="experience">新增经验</button><button type="button" class="app-button is-secondary" data-new="skill">新增技能</button></div></div>
        <p role="status" data-status></p><p role="alert" data-error></p>
        <form class="project-experience-editor" data-editor hidden>
          <h3 data-editor-title></h3>
          <label class="settings-field">名称<input name="title" aria-label="经验或技能名称" maxlength="120" required></label>
          <label class="settings-field">适用情形<input name="description" aria-label="适用情形" maxlength="500" placeholder="何时应该使用这条经验或技能"></label>
          <label class="settings-field">内容<textarea name="content" aria-label="经验或技能内容" rows="8" maxlength="1000" required placeholder="记录可复用的结论、步骤与验证方法"></textarea></label>
          <p class="settings-help" data-draft-note></p>
          <div class="project-experience-actions"><button type="button" class="app-button is-secondary" data-reset>放弃本次修改</button><button type="button" class="app-button is-secondary" data-hide-editor>收起编辑</button><button type="submit" class="app-button is-primary" data-save-item>保存内容</button></div>
        </form>
        <div class="project-experience-list" data-list></div>
      </div>
    </section>`;
    document.body.append(panel);
    window.addEventListener("beforeunload", (event) => {
      if (
        ![...projects.values()].some(
          (record) => record.settingsDirty || [...record.drafts.values()].some(dirty)
        )
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    });
    modal = createModal(panel, $("[data-close]"), {
      onClose() {
        epoch++;
        loadController?.abort();
        if (current()) current().removing = undefined;
      }
    });
    $("[data-settings]").addEventListener("input", () => {
      const record = current();
      if (!record || record.busy) return;
      record.options = readSettings();
      record.settingsDirty = true;
      $("[data-save-settings]").disabled = false;
    });
    $("[data-settings]").addEventListener("submit", (event) => {
      event.preventDefault();
      const record = current();
      if (!record?.snapshot || record.busy || !record.settingsDirty) return;
      const settings = readSettings();
      if (
        !Number.isInteger(settings.maxTokens) ||
        settings.maxTokens < 256 ||
        settings.maxTokens > 4096 ||
        !Number.isInteger(settings.maxRequestsPerHour) ||
        settings.maxRequestsPerHour < 2 ||
        settings.maxRequestsPerHour > 24 ||
        (settings.model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(settings.model))
      ) {
        record.error = "请检查后台模型和用量上限。";
        renderStatus(record);
        return;
      }
      void mutate(record, { action: "configure", settings }, () => {
        record.settingsDirty = false;
      });
    });
    $("[data-editor]").addEventListener("input", () => {
      const record = current(),
        draft = record?.drafts.get(record.editing);
      if (!draft || record.busy) return;
      for (const name of ["title", "description", "content"])
        draft.fields[name] = $(`[data-editor] [name="${name}"]`).value;
      updateEditorButtons(record, draft);
    });
    $("[data-editor]").addEventListener("submit", (event) => {
      event.preventDefault();
      const record = current(),
        key = record?.editing,
        draft = record?.drafts.get(key);
      if (!draft || record.busy || !dirty(draft)) return;
      const item = {
        ...draft.fields,
        title: draft.fields.title.trim(),
        content: draft.fields.content.trim(),
        ...(draft.id ? { id: draft.id, revision: draft.revision } : {})
      };
      if (!item.title || !item.content) return;
      if (item.content.length > (item.kind === "skill" ? 6000 : 1000)) {
        record.error = `${item.kind === "skill" ? "技能最多 6000" : "经验最多 1000"} 个字符，请精简后保存。`;
        renderStatus(record);
        return;
      }
      void mutate(record, { action: "save", item }, () => {
        if (record.drafts.get(key) === draft) record.drafts.delete(key);
        if (record.editing === key) record.editing = undefined;
      });
    });
    panel.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || !panel.contains(button)) return;
      const record = current();
      if (!record || record.busy) return;
      if (button.hasAttribute("data-refresh")) void load(record);
      if (button.dataset.new) edit(record, `new:${button.dataset.new}`, undefined, button.dataset.new);
      if (button.hasAttribute("data-hide-editor")) {
        record.editing = undefined;
        renderEditor(record);
      }
      if (button.hasAttribute("data-reset")) {
        const key = record.editing,
          item = record.snapshot?.items.find((entry) => entry.id === key);
        record.drafts.delete(key);
        if (item) edit(record, key, item);
        else {
          record.editing = undefined;
          renderEditor(record);
        }
      }
      const id = button.dataset.item,
        item = record.snapshot?.items.find((entry) => entry.id === id);
      if (!item) return;
      if (button.dataset.action === "remove" || button.dataset.action === "cancel-remove") {
        const confirming = button.dataset.action === "remove";
        record.removing = confirming ? id : undefined;
        render(record);
        [...panel.querySelectorAll("[data-item]")]
          .find(
            (node) =>
              node.dataset.item === id && node.dataset.action === (confirming ? "cancel-remove" : "remove")
          )
          ?.focus();
        return;
      }
      if (button.dataset.action === "confirm-remove" && record.removing !== id) return;
      if (button.dataset.action === "edit") {
        edit(record, id, item);
        return;
      }
      const change = {
        action: button.dataset.action === "confirm-remove" ? "remove" : button.dataset.action,
        id,
        revision: item.revision
      };
      if (change.action === "set_state") change.state = button.dataset.state;
      if (change.action === "pin") change.pinned = !item.pinned;
      if (change.action === "rollback") change.version = Number(button.dataset.version);
      void mutate(record, change, () => {
        if (change.action === "remove") {
          record.removing = undefined;
          record.drafts.delete(id);
          if (record.editing === id) record.editing = undefined;
        }
      });
    });
  }

  function readSettings() {
    const form = $("[data-settings]");
    const field = (name) => form.querySelector(`[name="${name}"]`);
    return {
      enabled: field("enabled").checked,
      learningEnabled: field("learningEnabled").checked,
      autoActivate: field("autoActivate").checked,
      model: field("model").value.trim(),
      maxRequestsPerHour: Number(field("maxRequestsPerHour").value),
      maxTokens: Number(field("maxTokens").value)
    };
  }
  function edit(record, key, item, kind = "experience") {
    if (!record.snapshot) return;
    if (!record.drafts.has(key)) {
      const fields = {
        kind: item?.kind ?? kind,
        title: item?.title ?? "",
        description: item?.description ?? "",
        content: item?.content ?? ""
      };
      record.drafts.set(key, {
        id: item?.id,
        revision: item?.revision,
        admission: item?.state === "candidate",
        fields,
        baseline: { ...fields }
      });
    }
    record.editing = key;
    renderEditor(record);
    $("[data-editor] [name=title]").focus();
  }
  function renderEditor(record) {
    const draft = record.drafts.get(record.editing);
    $("[data-editor]").hidden = !draft;
    if (!draft) return;
    $("[data-editor-title]").textContent =
      `${draft.admission ? "编辑并接纳" : draft.id ? "编辑" : "新增"}${draft.fields.kind === "skill" ? "技能" : "经验"}`;
    $("[data-save-item]").textContent = draft.admission ? "保存并启用" : "保存内容";
    for (const name of ["title", "description", "content"])
      $(`[data-editor] [name="${name}"]`).value = draft.fields[name];
    $('[data-editor] [name="content"]').maxLength = draft.fields.kind === "skill" ? 6000 : 1000;
    updateEditorButtons(record, draft);
  }
  function updateEditorButtons(record, draft) {
    $("[data-save-item]").disabled =
      record.busy || !dirty(draft) || !draft.fields.title.trim() || !draft.fields.content.trim();
    const count = `${draft.fields.content.length} / ${draft.fields.kind === "skill" ? 6000 : 1000}`;
    $("[data-draft-note]").textContent = dirty(draft) ? `${count} · 草稿已保留` : count;
  }
  function renderStatus(record) {
    $("[data-status]").textContent = record.status || "";
    $("[data-error]").textContent = record.error || "";
  }
  function render(record) {
    if (!visible(record)) return;
    $("[data-project-name]").textContent = record.name;
    renderStatus(record);
    const settings = record.settingsDirty ? record.options : (record.snapshot?.settings ?? {});
    for (const name of ["enabled", "learningEnabled", "autoActivate"])
      $(`[data-settings] [name="${name}"]`).checked = !!settings[name];
    for (const [name, fallback] of [
      ["model", ""],
      ["maxTokens", 2048],
      ["maxRequestsPerHour", 6]
    ])
      $(`[data-settings] [name="${name}"]`).value = String(settings[name] ?? fallback);
    const items = record.snapshot?.items ?? [];
    $("[data-list]").innerHTML = items.length
      ? items
          .map((item) => {
            const action = (label, name, attributes = "") =>
              `<button type="button" class="app-button ${name === "confirm-remove" ? "is-danger" : "is-secondary"}" data-item="${esc(item.id)}" data-action="${name}" ${attributes}>${label}</button>`;
            const sources = (item.sources ?? [])
              .map(
                (source) =>
                  `<li><strong>Task ${esc(source.taskId)} · Run ${esc(source.runId)}</strong><blockquote>${esc(source.quote ?? "")}</blockquote>${source.validationQuote ? `<p>验证证据：${esc(source.validationQuote)}</p>` : ""}</li>`
              )
              .join("");
            const versions = (item.state === "candidate" ? [] : (item.versions ?? []))
              .filter((version) => version.version !== item.version)
              .map(
                (version) =>
                  `<li><span>版本 ${version.version}</span>${action("回滚到此版本", "rollback", `data-version="${Number(version.version)}"`)}</li>`
              )
              .join("");
            return `<article class="project-experience-item" data-experience-id="${esc(item.id)}"><div class="project-experience-item-heading"><h4>${esc(item.title)}</h4><span class="project-experience-badge">${item.kind === "skill" ? "技能" : "经验"} · ${states[item.state] ?? "待复核"}</span></div>
        ${item.description ? `<p>${esc(item.description)}</p>` : ""}<p class="settings-help">版本 ${Number(item.version) || 1} · ${item.origin === "automatic" ? "后台沉淀" : "手动维护"}${item.pinned ? " · 已固定" : ""} · ${Number(item.supportCount) || 0} 个任务支持</p>
        <details><summary>查看内容</summary><pre>${esc(item.content ?? "")}</pre></details>
        ${sources ? `<details><summary>来源与验证证据</summary><ul class="project-experience-sources">${sources}</ul></details>` : ""}
        ${versions ? `<details><summary>历史版本</summary><ul class="project-experience-versions">${versions}</ul></details>` : ""}
        <div class="project-experience-actions">${action(item.state === "candidate" ? "编辑并接纳" : "编辑", "edit")}${item.state === "active" ? action("停用", "set_state", 'data-state="disabled"') : action(item.state === "candidate" ? "复核并启用" : "启用", "set_state", 'data-state="active"')}${item.state === "candidate" ? action("拒绝", "set_state", 'data-state="rejected"') : action(item.pinned ? "取消固定" : "固定版本", "pin")}${action("删除", "remove")}</div>${record.removing === item.id ? `<div class="project-experience-confirm" role="group" aria-label="删除确认"><p>确定删除“${esc(item.title)}”吗？删除后无法恢复。</p><div class="project-experience-actions">${action("取消", "cancel-remove")}${action("确认删除", "confirm-remove")}</div></div>` : ""}</article>`;
          })
          .join("")
      : `<p class="project-experience-empty">暂无经验或技能</p>`;
    renderEditor(record);
    for (const node of panel.querySelectorAll("input,textarea,button:not([data-close])"))
      node.disabled = !!record.busy || !record.snapshot;
    $("[data-refresh]").disabled = !!record.busy;
    $("[data-save-settings]").disabled = record.busy || !record.snapshot || !record.settingsDirty;
    const draft = record.drafts.get(record.editing);
    if (draft) updateEditorButtons(record, draft);
  }
  async function load(record) {
    loadController?.abort();
    loadController = new AbortController();
    const request = ++epoch;
    record.status = "正在读取项目经验…";
    record.error = "";
    render(record);
    try {
      const value = normalize(
        await api(endpoint(record.id), { cache: "no-store", signal: loadController.signal })
      );
      if (request !== epoch || !visible(record)) return;
      record.snapshot = value;
      record.status = "";
    } catch (error) {
      if (request !== epoch || !visible(record)) return;
      record.status = "";
      record.error = error.message || "项目经验读取失败，请重试。";
    }
    if (request === epoch) render(record);
  }
  async function mutate(record, change, accepted) {
    if (record.busy || !record.snapshot) return;
    epoch++;
    loadController?.abort();
    record.busy = true;
    record.error = "";
    record.status = "正在保存…";
    render(record);
    try {
      const value = normalize(
        await api(endpoint(record.id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...change, snapshotRevision: record.snapshot.revision })
        })
      );
      record.snapshot = value;
      accepted?.();
      record.status = "已保存";
    } catch (error) {
      record.status = "";
      record.error =
        error.status === 409
          ? "项目经验已变化，草稿已保留。请刷新列表核对；放弃本次修改后可编辑最新版本。"
          : `${error.message || "保存失败"}，草稿已保留，请重试。`;
      if (visible(record)) showToast(record.error);
    } finally {
      record.busy = false;
      render(record);
    }
  }
  return {
    open(project) {
      install();
      const id = project.projectId ?? project.id;
      if (!id) return;
      epoch++;
      loadController?.abort();
      if (current()) current().removing = undefined;
      active = id;
      if (!projects.has(id)) projects.set(id, { id, drafts: new Map(), busy: false });
      const record = current();
      record.name = project.projectName ?? project.name ?? "当前项目";
      modal.open();
      render(record);
      if (!record.busy) void load(record);
    },
    close() {
      modal?.close();
    }
  };
}
