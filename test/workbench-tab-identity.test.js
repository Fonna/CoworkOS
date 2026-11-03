import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { buildTabs, renderTabStrip } from "../web/assets/workbench/host.js";

test("same-titled conversation and file tabs expose distinct view types", () => {
  const title = "火箭.cad.json";
  const model = buildTabs({
    tabs: [
      { tabId: "conversation:rocket", taskId: "rocket", kind: "conversation", title },
      {
        tabId: "resource:rocket-model",
        resourceId: "rocket-model",
        kind: "application",
        appType: "cad",
        hasResource: true,
        title,
        conversations: [{ taskId: "rocket", goal: title }],
        groupTaskId: "rocket"
      }
    ],
    activeTabId: "resource:rocket-model"
  });
  const { document } = parseHTML(`<div>${renderTabStrip(model)}</div>`);
  const chat = document.querySelector('[data-tab-kind="conversation"]');
  const file = document.querySelector('[data-tab-kind="file"]');
  assert.equal(document.querySelectorAll('[data-tab-kind="file"]').length, 1);
  assert.equal(file.getAttribute("data-tab"), "resource:rocket-model");
  assert.equal(file.getAttribute("aria-selected"), "true");
  assert.equal(chat.querySelector(".tab-kind-label").textContent, "对话");
  assert.equal(chat.getAttribute("aria-label"), `对话：${title}`);
  assert.equal(file.getAttribute("aria-label"), `文件：${title}`);
  assert.notEqual(chat.getAttribute("title"), file.getAttribute("title"));
});

test("grouped file tabs do not repeat their neighbouring conversation title", () => {
  const model = buildTabs({
    tabs: [
      { tabId: "conversation:a", taskId: "a", kind: "conversation", title: "火箭设计" },
      {
        tabId: "resource:model",
        resourceId: "model",
        kind: "application",
        appType: "cad",
        hasResource: true,
        title: "火箭.cad.json",
        taskGoal: "火箭设计",
        groupTaskId: "a",
        conversations: [{ taskId: "a" }]
      },
      { tabId: "conversation:b", taskId: "b", kind: "conversation", title: "另一个对话" }
    ]
  });
  const { document } = parseHTML(`<div>${renderTabStrip(model)}</div>`);
  const file = document.querySelector('[data-tab-kind="file"]');
  assert.equal(file.querySelector(".tab-task"), null);
  assert.equal(file.querySelector(".tab-title").textContent, "火箭.cad.json");
  assert.match(file.getAttribute("title"), /关联对话：火箭设计/);
});
