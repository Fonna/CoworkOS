import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { createSettingsModal } from "./settings-modal.js";

/** Local-user management is separate from the model's restricted planning queries. */
export function installPersonalContextSettings({ overview, showToast }) {
  const row = document.createElement("div");
  row.className = "profile-setting";
  row.innerHTML = ui`<span class="settings-row-copy"><span class="settings-row-icon">${icon("history")}</span><strong>情境与安排</strong></span><button type="button" class="app-button is-secondary" aria-label="管理情境与安排">管理${icon("chevron-right")}</button>`;
  document.querySelector("#profile-settings-general").append(row);
  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="personal-context-title">
    <header class="settings-heading"><button type="button" class="settings-nav-button" data-settings-back aria-label="返回设置">${icon("chevron-left")}</button><h2 id="personal-context-title">情境与安排</h2><button type="button" class="settings-nav-button" data-close aria-label="关闭情境与安排">${icon("close")}</button></header>
    <div class="settings-scroll"><div data-options></div><p role="status" data-status></p><div data-records></div></div>
  </section>`;
  document.body.append(panel);
  let state,
    sequence = 0,
    busy = false,
    loading;
  const options = panel.querySelector("[data-options]");
  const records = panel.querySelector("[data-records]");
  const status = panel.querySelector("[data-status]");
  const open = row.querySelector("button");
  const dialog = createSettingsModal(panel, panel.querySelector("[data-close]"), {
    overview,
    returnFocus: () => open.focus(),
    onClose: () => {
      sequence++;
      loading?.abort();
    }
  });
  const labels = {
    current: "有效",
    inactive: "已取消或结束",
    expired: "已过期",
    not_yet_valid: "尚未生效",
    needs_review: "待核实"
  };
  function date(value, timeZone) {
    if (!value) return "";
    return new Intl.DateTimeFormat(document.documentElement.lang || "zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
      timeZoneName: "short"
    }).format(new Date(value));
  }
  function render() {
    options.replaceChildren();
    records.replaceChildren();
    if (!state) return;
    for (const [key, title, hint] of [
      ["enabled", "使用情境与安排", "关闭后保留记录，后续请求不再自动读取。"],
      [
        "registrationEnabled",
        "从对话登记",
        "允许从明确的本人陈述登记；关闭时仍可明确要求保存。登记校验会使用当前模型。"
      ],
      ["sensitiveEnabled", "处理敏感情境", "允许为个人安排处理健康等敏感信息；默认关闭。"]
    ]) {
      const label = document.createElement("label");
      label.className = "settings-toggle";
      label.title = ui(hint);
      const text = document.createElement("strong");
      text.textContent = ui(title);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-label", ui(title));
      input.checked = state.settings[key];
      input.disabled = busy;
      input.addEventListener(
        "change",
        () => void change({ action: "settings", settings: { [key]: input.checked } })
      );
      label.append(text, input);
      options.append(label);
    }
    if (!state.records.length) {
      const empty = document.createElement("p");
      empty.textContent = ui("暂无情境与安排");
      records.append(empty);
    }
    for (const record of state.records) {
      const section = document.createElement("section");
      section.className = "user-memory-editor";
      const title = document.createElement("h3");
      title.textContent = record.title;
      const body = document.createElement("p");
      body.textContent = record.content;
      const details = document.createElement("p");
      details.textContent = [
        ui(labels[record.validity]),
        date(record.startsAt, record.timeZone),
        date(record.endsAt, record.timeZone),
        date(record.validUntil || record.reviewAt, record.timeZone)
      ]
        .filter(Boolean)
        .join(" · ");
      const actions = document.createElement("div");
      actions.className = "user-memory-compose-actions";
      const button = (name, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "app-button is-secondary";
        button.textContent = ui(name);
        button.setAttribute("aria-label", `${ui(name)} ${record.title}`);
        button.disabled = busy;
        if (action === "cancel") button.title = ui("仅更新个人情境，不取消外部预订或会议。");
        button.addEventListener("click", () => {
          if (
            action === "forget" &&
            !window.confirm(ui("删除此情境？本情境库中的正文将清除；原聊天、备份及已发送内容仍保留。"))
          )
            return;
          void change({ action, id: record.id, revision: record.revision });
        });
        actions.append(button);
      };
      if (!["cancelled", "ended"].includes(record.status))
        button(
          record.kind === "arrangement" ? "取消安排" : "结束状态",
          record.kind === "arrangement" ? "cancel" : "end"
        );
      button("删除", "forget");
      section.append(title, body, details, actions);
      records.append(section);
    }
  }
  async function request(change) {
    const response = await fetch("/api/personal-context", {
      cache: "no-store",
      ...(change
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ basis: state.basis, snapshotRevision: state.snapshotRevision, change })
          }
        : { signal: loading.signal })
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || ui("情境暂不可用"));
    return value;
  }
  async function load() {
    const identity = ++sequence;
    loading?.abort();
    loading = new AbortController();
    busy = true;
    state = undefined;
    render();
    status.textContent = ui("正在读取…");
    try {
      const value = await request();
      if (identity === sequence) {
        state = value;
        status.textContent = "";
      }
    } catch (error) {
      if (identity === sequence) status.textContent = error.message;
    } finally {
      if (identity === sequence) {
        busy = false;
        render();
      }
    }
  }
  async function change(change) {
    if (busy || !state) return;
    const identity = sequence;
    busy = true;
    render();
    status.textContent = "";
    try {
      const value = await request(change);
      if (identity === sequence) state = value;
    } catch (error) {
      if (identity === sequence) {
        status.textContent = error.message;
        showToast(error.message);
      }
    } finally {
      if (identity === sequence) {
        busy = false;
        render();
      }
    }
  }
  open.addEventListener("click", () => {
    if (dialog.open() !== false) void load();
  });
}
