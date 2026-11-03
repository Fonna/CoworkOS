import { presentationSave, presentationStatus, presentationCommand } from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("chat discovers PPTist tools, edits real editor content and preserves human changes", async ({
  page
}, testInfo) => {
  test.setTimeout(90000);
  let phase = "create",
    step = 0,
    slideId;
  const failures = [],
    calls = [],
    errors = [];
  let finishCreate;
  const createFinished = new Promise((resolve) => {
    finishCreate = resolve;
  });
  const provider = await modelProtocolFixture("openai-completions", async (request) => {
    try {
      const names = request.tools.map((t) => t.function.name);
      if (!names.includes("create_resource"))
        return { name: "enable_tools", arguments: { groups: ["applications"] } };
      const last = request.messages.findLast((m) => m.role === "tool");
      const result = last && JSON.parse(last.content);
      const n = ++step;
      let name,
        args = {};
      if (phase === "create" && n === 1) {
        name = "create_resource";
        args = { kind: "presentation/pptist+json", title: "对话演示" };
      } else if (phase === "continue" && n === 1) {
        name = "pptist_edit_presentation";
        args = { changes: [] };
      } else if (n === 2) {
        if (phase === "create") {
          assert.equal(result.bound, true);
          assert.equal(result.editorOpened, true);
        } else {
          assert.equal(result.code, "operation_precondition_failed");
        }
        name = "pptist_read_presentation";
      } else if (n === 3) {
        slideId = result.result.outline[0].id;
        name = "pptist_read_presentation";
        args = { slideId };
      } else if (n === 4) {
        if (phase === "continue") assert.match(result.result.slide.remark, /人工备注/);
        name = "pptist_edit_presentation";
        args = {
          changes: [
            {
              type: "upsert_element",
              slideId,
              element: {
                id: "title",
                type: "text",
                left: 60,
                top: 60,
                width: 860,
                height: 100,
                rotate: 0,
                content: `<p style="font-size:44px">${phase === "create" ? "模型创建的标题" : "模型更新的标题"}</p>`
              }
            }
          ]
        };
      } else if (n === 5) {
        assert.ok(!result.error && result.ok !== false, JSON.stringify(result));
        name = "pptist_read_presentation";
        args = { slideId };
      } else {
        assert.match(result.result.slide.elements[0].content, /标题/);
        if (phase === "continue") assert.match(result.result.slide.remark, /人工备注/);
        if (phase === "create") await createFinished;
        return { text: phase === "create" ? "演示创建完成。" : "更新完成，保留人工备注。" };
      }
      calls.push(name);
      return { name, arguments: args };
    } catch (e) {
      failures.push(e.message);
      return { text: "fixture failed" };
    }
  });
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl, model: "protocol-fixture" });
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("创建 PPTist 演示文稿");
    await page.locator("#send-button").click();
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.locator(".canvas")).toContainText("模型创建的标题", { timeout: 30000 });
    await expect(page.locator("#stop-button")).toBeVisible();
    await expect(page.locator("#conversation")).not.toContainText("演示创建完成。");
    finishCreate();
    await expect(page.locator("#conversation")).toContainText("演示创建完成。");
    await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
    await expect(page.locator("#conversation-pane")).toBeVisible();
    const chatBox = await page.locator("#conversation-pane").boundingBox();
    const appBox = await page.locator("#workbench").boundingBox();
    expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(appBox.x);
    await page.screenshot({ path: testInfo.outputPath("pptist-chat-split.png") });
    await page.locator("#composer-input").fill("保留左侧输入草稿");
    await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await page.getByRole("button", { name: "恢复并排协作", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("保留左侧输入草稿");
    await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);

    await frame.locator(".remark .ProseMirror").fill("人工备注必须保留");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    phase = "continue";
    step = 0;
    await page.locator("#composer-input").fill("更新标题，保留我的备注");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("更新完成，保留人工备注。", { timeout: 30000 });
    await expect(frame.locator(".canvas")).toContainText("模型更新的标题");
    await expect(frame.locator(".remark")).toContainText("人工备注必须保留");
    await presentationCommand(page, "undo-save");
    await expect(frame.locator(".canvas")).toContainText("模型创建的标题");
    await expect(frame.locator(".remark")).toContainText("人工备注必须保留");
    await page.locator("#new-conversation").click();
    await expect(page.locator('iframe[title="PPT 演示文稿编辑器"]')).toBeHidden();
    await expect(page.locator("#app-bind-select")).not.toContainText("对话演示");
    expect(calls).toContain("pptist_edit_presentation");
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    finishCreate();
    await dashboard.stop();
    await provider.close();
  }
});
