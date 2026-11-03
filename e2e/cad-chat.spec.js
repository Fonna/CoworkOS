import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

// Exercise the actual browser -> Dashboard -> Pi -> application -> browser path.
// Only the external model is replaced, so this catches UI/binding seams that
// an extension API mock or a manually created CAD window cannot cover.
test("chat creates CAD, reports progress, preserves human edits and isolates conversations", async ({
  page
}) => {
  test.setTimeout(120_000);
  const failures = [],
    errors = [],
    calls = [];
  let step = 0,
    phase = "create",
    title = "对话火箭.cad.json",
    releaseRead;
  const holdRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end('{"data":[]}');
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const current = ++step;
    if (phase === "fail") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "本地模型测试：请求暂时不可用" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "cad-chat",
          object: "chat.completion.chunk",
          created: 1,
          model: "browser-fixture",
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`
      );
    send({ role: "assistant" });
    // The model explicitly discovers optional application tools before creating a resource.
    if (!request.tools.some((tool) => tool.function.name === "create_resource")) {
      step -= 1;
      send({
        tool_calls: [
          {
            index: 0,
            id: "enable-applications",
            type: "function",
            function: { name: "enable_tools", arguments: JSON.stringify({ groups: ["applications"] }) }
          }
        ]
      });
      send({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    try {
      const names = request.tools.map((tool) => tool.function.name);
      const previous = request.messages.findLast((message) => message.role === "tool");
      const result = previous && JSON.parse(previous.content);
      let name,
        args = {};
      if (phase === "create" && current === 1) {
        assert.ok(!names.includes("cad_read_model"), "new conversations must start unbound");
        name = "create_resource";
        args = { kind: "model/atria-cad+json", title };
      } else {
        assert.ok(names.includes("cad_read_model"), "CAD tools must reach the next provider request");
        if (current > 1 && !(phase === "continue" && current === 2)) {
          assert.ok(result && result.ok !== false && !result.error, JSON.stringify(result));
        }
        if (phase === "create" && current === 2) {
          assert.equal(result.bound, true);
          assert.equal(result.editorOpened, true);
          assert.deepEqual(result.nextAction, { tool: "cad_read_model", arguments: {} });
          await holdRead;
          name = "cad_read_model";
        } else if (phase === "continue" && current === 2) {
          assert.equal(result.ok, false);
          assert.equal(result.code, "operation_precondition_failed");
          assert.deepEqual(result.nextAction, { tool: "cad_read_model", arguments: {} });
          name = "cad_read_model";
        } else if (current === 3) {
          const parts = result.result.model.parts;
          if (phase === "create") {
            assert.deepEqual(parts, []);
            args = {
              upsert: [
                { id: "body", name: "箭体", shape: "cylinder", radius: 10, height: 60 },
                { id: "nose", name: "头部", shape: "sphere", radius: 10, position: [0, 0, 30] }
              ]
            };
          } else {
            assert.ok(parts.length === 3 || parts.length === 6);
            assert.equal(parts.find((part) => part.name === "人工球体").radius, 7);
            args = {
              upsert: [
                { ...parts.find((part) => part.id === "body"), radius: 12 },
                {
                  id: "engine",
                  name: "发动机",
                  shape: "cylinder",
                  radius: 7,
                  height: 12,
                  position: [0, 0, -34]
                },
                {
                  id: "booster-left",
                  name: "左助推器",
                  shape: "cylinder",
                  radius: 5,
                  height: 40,
                  position: [-16, 0, -10]
                },
                {
                  id: "booster-right",
                  name: "右助推器",
                  shape: "cylinder",
                  radius: 5,
                  height: 40,
                  position: [16, 0, -10]
                }
              ]
            };
          }
          name = "cad_edit_parts";
        } else if (current === 4) {
          name = "cad_read_model";
        } else if (phase === "continue" && current === 1) {
          name = "cad_edit_parts";
          args = { upsert: [{ id: "body", shape: "sphere", radius: 99 }] };
        } else {
          assert.equal(current, 5);
          assert.equal(result.result.model.parts.length, phase === "create" ? 2 : 6);
          send({ content: phase === "create" ? "已创建火箭模型。" : "已增加发动机和助推器，保留人工球体。" });
          send({}, "stop");
        }
      }
      if (name) {
        calls.push(name);
        send({
          tool_calls: [
            {
              index: 0,
              id: `cad-chat-${phase}-${current}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        });
        send({}, "tool_calls");
      }
    } catch (error) {
      failures.push(error.message);
      send({ content: "测试模型发现接入错误。" });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard;
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await expect(page.locator("#app-bind-select")).toContainText(/未加载应用|没有打开的应用/);
    await page.locator("#composer-input").fill("创建一个火箭 CAD");
    await page.locator("#send-button").click();
    const focusChat = async () => {
      if (!(await page.locator("#composer-input").isVisible()))
        await page.getByRole("button", { name: "收起工作区", exact: true }).click();
      await page.locator("#composer-input").focus();
    };
    const editor = page.locator("[data-app-mount]:not([hidden])");
    await expect(editor.locator("[data-cad-count]")).toHaveText("0/64", { timeout: 30_000 });
    await expect(page.locator("[data-app-task-status]")).toContainText("正在处理");
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(page.getByRole("button", { name: "查看对话", exact: true })).toBeHidden();
    releaseRead();
    await expect(editor.locator("[data-cad-count]")).toHaveText("2/64", { timeout: 30_000 });
    await expect(editor.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
    await expect(page.locator("[data-workbench-header]")).toHaveAttribute("data-state", "idle", {
      timeout: 30_000
    });
    const createdTabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const original = createdTabs.tabs.find((tab) => tab.resourceId);
    expect(createdTabs.tabs.filter((tab) => tab.resourceId)).toHaveLength(1);
    const assertSingleFile = async () => {
      const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
      expect(tabs.tabs.filter((tab) => tab.resourceId).map((tab) => tab.tabId)).toEqual([original.tabId]);
      await expect(page.locator(`[data-tab-rail] [data-tab="${original.tabId}"]`)).toHaveCount(1);
      await expect(page.locator('[data-tab-kind="file"]')).toHaveCount(1);
      const resources = await (
        await page.request.get(`${dashboard.base}/api/tasks/${original.conversations[0].taskId}/resources`)
      ).json();
      expect(resources.resources.map((resource) => resource.resourceId)).toEqual([original.resourceId]);
    };
    await editor.locator('[data-cad-add="sphere"]').click();
    await page.getByRole("textbox", { name: "特征名称", exact: true }).fill("人工球体");
    await page.getByRole("spinbutton", { name: "半径", exact: true }).fill("7");
    await editor.locator("[data-cad-save]").click();
    await expect(editor.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
    await focusChat();
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("#composer-input")).toBeFocused();
    await expect(page.locator("[data-workbench-header]")).toBeVisible();
    await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
    await expect(page.locator("[data-composer-context]")).toContainText("人工球体");
    await expect(page.locator("#app-bind-select")).toContainText(title);
    await expect(page.locator("#conversation")).toContainText("已创建火箭模型。");
    phase = "continue";
    step = 0;
    await page.locator("#composer-input").fill("能否做得复杂一点，更真实一些？");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("已增加发动机和助推器，保留人工球体。", {
      timeout: 30_000
    });
    await expect(page.locator("#conversation .tool-step.is-failed .activity-status")).toHaveText("调用失败");
    await page.locator(`[data-tab-rail] [data-tab="${original.tabId}"]`).click();
    await expect(editor.locator("[data-cad-count]")).toHaveText("6/64");
    await assertSingleFile();
    await editor.locator("[data-cad-select]").filter({ hasText: "箭体" }).click();
    await expect(page.getByRole("spinbutton", { name: "半径", exact: true })).toHaveValue("12");
    const download = page.waitForEvent("download");
    await editor.locator("[data-cad-file-menu]").click();
    await editor.locator("[data-cad-json]").click();
    const model = JSON.parse(await readFile(await (await download).path(), "utf8"));
    expect(model.parts).toHaveLength(6);
    expect(model.parts.find((part) => part.name === "人工球体").radius).toBe(7);
    await page.reload();
    await expect(editor.locator("[data-cad-count]")).toHaveText("6/64");
    await assertSingleFile();
    for (const width of [474, 320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("button", { name: "查看对话", exact: true })).toBeHidden();
      if (width < 1100) {
        await expect(page.locator("[data-tab-strip]")).toBeHidden();
        if (!(await editor.isVisible()))
          await page.getByRole("button", { name: "展开工作区", exact: true }).click();
        await page.getByRole("button", { name: "收起工作区", exact: true }).click();
        await expect(page.locator("#composer-input")).toBeVisible();
        await page.getByRole("button", { name: "展开工作区", exact: true }).click();
        await expect(editor).toBeVisible();
      }
      await expect(editor.locator("[data-cad-save]")).toBeInViewport();
      await expect(editor.locator("[data-cad-viewport]")).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await focusChat();
    phase = "fail";
    step = 0;
    const finalAnswersBeforeFailure = await page.locator('#conversation [data-answer-kind="final"]').count();
    await page.locator("#composer-input").fill("模拟一次模型服务失败");
    await page.locator("#send-button").click();
    const failure = page.locator("#conversation").getByRole("alert");
    await expect(failure).toContainText("模型请求未完成", { timeout: 30_000 });
    await expect(failure).toContainText("HTTP 400");
    await expect(failure.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await expect(failure.getByRole("button", { name: "检查模型连接", exact: true })).toBeVisible();
    await expect(page.locator("#conversation")).not.toContainText("本地模型测试");
    await expect(page.locator('#conversation [data-answer-kind="final"]')).toHaveCount(
      finalAnswersBeforeFailure
    );
    await page.locator(`[data-tab-rail] [data-tab="${original.tabId}"]`).click();
    await expect(page.locator("[data-app-task-status]")).toContainText("任务未完成");
    await expect(editor.locator("[data-cad-count]")).toHaveText("6/64");
    await focusChat();
    phase = "continue";
    step = 0;
    await page.locator("#composer-input").fill("恢复连接，继续修改原来的模型");
    await page.locator("#send-button").click();
    await expect.poll(() => step, { timeout: 30_000 }).toBe(5);
    await page.locator(`[data-tab-rail] [data-tab="${original.tabId}"]`).click();
    await expect(page.locator("[data-workbench-header]")).toHaveAttribute("data-state", "idle", {
      timeout: 30_000
    });
    await expect(editor.locator("[data-cad-count]")).toHaveText("6/64");
    await assertSingleFile();
    if (!(await page.locator("#new-conversation").isVisible()))
      await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    await page.locator("#new-conversation").click();
    await expect(page.locator("#app-bind-select")).toContainText("未加载应用");
    await expect(page.locator("[data-workbench-header]")).toBeHidden();
    phase = "create";
    step = 0;
    title = "另一对话.cad.json";
    await page.locator("#composer-input").fill("创建另一个 CAD");
    await page.locator("#send-button").click();
    await expect(editor.locator("[data-cad-title]")).toHaveText(title, { timeout: 30_000 });
    await expect(editor.locator("[data-cad-count]")).toHaveText("2/64", { timeout: 30_000 });
    await expect(page.locator("[data-workbench-header]")).toHaveAttribute("data-state", "idle", {
      timeout: 30_000
    });
    const after = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    expect(after.tabs.filter((tab) => tab.resourceId)).toHaveLength(2);
    const saved = await (
      await page.request.get(
        `${dashboard.base}/api/tasks/${original.conversations[0].taskId}/resources/${original.resourceId}`
      )
    ).json();
    expect(saved.snapshot.content.parts).toEqual(model.parts);
    expect(calls.filter((name) => name === "create_resource")).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    releaseRead();
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
