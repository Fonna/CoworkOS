import { openCadProgram, openCadResource, openCadExport, openCadProperties } from "./cad-editor-helper.js";
import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
const rocket = await readFile("test/fixtures/cad-rocket.jscad", "utf8");
for (const supportsImages of [false, true])
  test(`source CAD completes Pi collaboration, saved errors and exports (vision: ${supportsImages})`, async ({
    page
  }) => {
    test.setTimeout(180_000);
    let step = 0,
      phase = "create";
    const failures = [];
    const errors = [];
    let receivedImage = false;
    const provider = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.end('{"data":[]}');
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      receivedImage ||= JSON.stringify(request.messages).includes("data:image/png;base64,");
      const current = ++step;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "source-cad", object: "chat.completion.chunk", created: 1, model: "browser-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
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
        const previous = request.messages.findLast((m) => m.role === "tool");
        const result = previous && JSON.parse(previous.content);
        let name,
          args = {};
        if (phase === "create" && current === 1) {
          name = "create_resource";
          args = { kind: "model/atria-jscad+json", title: "源码火箭.cad.json" };
        } else {
          assert.ok(request.tools.some((t) => t.function.name === "cad_write_program"));
          if (previous) assert.notEqual(result.ok, false, JSON.stringify(result));
          if ((phase === "create" && current === 2) || (phase === "continue" && current === 1)) {
            name = "cad_read_model";
          } else if ((phase === "create" && current === 3) || (phase === "continue" && current === 2)) {
            assert.equal(result.result.model.version, 2);
            if (phase === "continue") assert.equal(result.result.model.parameters.radius, 23);
            name = "cad_write_program";
            args = {
              source:
                phase === "create"
                  ? rocket
                  : result.result.model.source +
                    "\n// AI preserves the manually edited radius and improves source organization.\n"
            };
          } else if ((phase === "create" && current === 4) || (phase === "continue" && current === 3)) {
            assert.equal(result.result.sourceSaved, true);
            name = "cad_preview";
          } else if ((phase === "create" && current === 5) || (phase === "continue" && current === 4)) {
            assert.equal(result.result.status, "ready");
            assert.equal(result.visualFeedback.delivered, supportsImages);
            name = "cad_read_model";
          } else {
            assert.equal(result.result.model.parameters.radius, phase === "continue" ? 23 : undefined);
            assert.equal(result.result.geometry.objects.length, 14);
            send({
              content: phase === "create" ? "已完成轮廓旋转和拉伸火箭。" : "源码已完善，保留人工半径 23。"
            });
            send({}, "stop");
          }
        }
        if (name) {
          send({
            tool_calls: [
              {
                index: 0,
                id: `source-${phase}-${current}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          });
          send({}, "tool_calls");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "接入验证失败。" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    let dashboard;
    try {
      dashboard = await startDashboard({
        modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1`,
        supportsImages
      });
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
      await page.goto(dashboard.base);
      await page.locator("#new-conversation").click();
      await page.locator("#composer-input").fill("请用源码建立一个复杂火箭模型");
      await page.locator("#send-button").click();
      const editor = page.locator("[data-app-mount]:not([hidden])");
      await expect(page.locator("#conversation")).toContainText("已完成轮廓旋转和拉伸火箭。", {
        timeout: 40_000
      });
      await expect(editor.locator("[data-program-count]")).toHaveText("14");
      await expect(editor.locator("[data-cad-viewport]")).toHaveAttribute("data-ready", "true");
      await openCadProperties(editor);
      await editor.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true }).fill("23");
      // Saving via keyboard while the field remains focused must use the typed value.
      await editor.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true }).press("ControlOrMeta+s");
      await expect(editor.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
      const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
      const original = tabs.tabs.find((t) => t.resourceId);
      const before = await (
        await page.request.get(
          `${dashboard.base}/api/tasks/${original.accessTaskId}/resources/${original.resourceId}`
        )
      ).json();
      expect(before.snapshot.content.parameters.radius).toBe(23);
      phase = "continue";
      step = 0;
      await page.locator("#composer-input").fill("请在这份源码继续优化，保留我的参数");
      await page.locator("#send-button").click();
      await expect(page.locator("#conversation")).toContainText("源码已完善，保留人工半径 23。", {
        timeout: 40_000
      });
      await expect(editor.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true })).toHaveValue("23");
      await editor.locator("[data-program-source-toggle]").click();
      const code = editor.getByRole("textbox", { name: "CAD 建模源码" });
      await expect(code).toHaveValue(/extrudeRotate/);
      await code.fill('module.exports.main = () => { throw new Error("错误源码测试"); };');
      await editor.locator("[data-program-save]").click();
      await editor.locator("[data-program-preview-details]").click({ timeout: 30_000 });
      await expect(editor.locator("[data-program-preview-error-text]")).toContainText("错误源码测试");
      const savedError = await (
        await page.request.get(
          `${dashboard.base}/api/tasks/${original.accessTaskId}/resources/${original.resourceId}`
        )
      ).json();
      expect(savedError.snapshot.content.source).toContain("错误源码测试");
      expect(savedError.snapshot.content.parameters.radius).toBe(23);
      await expect(editor.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
      await expect(editor.locator("[data-program-preview-notice]")).toContainText("上次的模型");
      await expect(editor.locator('[data-program-select="solid_0"]')).toBeDisabled();
      // Broken source survives refresh and can still be downloaded and undone.
      await page.reload();
      await editor.locator("[data-program-preview-details]").click({ timeout: 30_000 });
      await expect(editor.locator("[data-program-preview-error-text]")).toContainText("错误源码测试");
      await openCadExport(editor);
      let failedDownload = page.waitForEvent("download");
      await editor.locator('[data-program-export="jscad"]').click();
      expect(await readFile(await (await failedDownload).path(), "utf8")).toContain("错误源码测试");
      await editor.locator("[data-program-undo]").click();
      await expect(editor.locator("[data-program-count]")).toHaveText("14");
      await expect(editor.locator("[data-program-preview-error]")).toBeHidden();
      await editor.locator("[data-program-inspector-close]").click();
      await editor.locator("[data-program-source-toggle]").click();
      await code.fill(before.snapshot.content.source + "\n// Recovered after compile error.\n");
      await editor.locator("[data-program-save]").click();
      await expect(editor.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
      await expect(editor.locator("[data-program-count]")).toHaveText("14");
      await editor.getByRole("combobox", { name: "观察方向" }).selectOption("right");
      await editor.getByRole("combobox", { name: "生成时限" }).selectOption("60000");
      await editor.locator("[data-program-preview]").click();
      await expect(editor.locator("[data-program-preview-notice]")).toBeHidden();
      await openCadExport(editor);
      let downloadPromise = page.waitForEvent("download");
      await editor.locator('[data-program-export="jscad"]').click();
      let file = await downloadPromise;
      expect(await readFile(await file.path(), "utf8")).toContain("savedParameters");
      await openCadExport(editor);
      downloadPromise = page.waitForEvent("download");
      await editor.locator('[data-program-export="stl"]').click();
      file = await downloadPromise;
      const bytes = await readFile(await file.path());
      expect(bytes.length).toBe(84 + 50 * bytes.readUInt32LE(80));
      await openCadExport(editor);
      downloadPromise = page.waitForEvent("download");
      await editor.locator('[data-program-export="png"]').click();
      const png = await readFile(await (await downloadPromise).path());
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(768);
      // Interactive software-rendering limits must not lower the exported view's resolution.
      const viewport = editor.locator("[data-cad-viewport]");
      const dimensions = await viewport.evaluate((host) => ({
        width: Math.floor(host.clientWidth * Math.min(devicePixelRatio || 1, 2)),
        height: Math.floor(host.clientHeight * Math.min(devicePixelRatio || 1, 2)),
        interactiveWidth: host.querySelector("canvas").width
      }));
      await openCadExport(editor);
      downloadPromise = page.waitForEvent("download");
      await editor.locator('[data-program-export="view-png"]').click();
      const viewPng = await readFile(await (await downloadPromise).path());
      expect(viewPng.readUInt32BE(16)).toBe(dimensions.width);
      expect(viewPng.readUInt32BE(20)).toBe(dimensions.height);
      await expect
        .poll(() => viewport.locator("canvas").evaluate((canvas) => canvas.width))
        .toBe(dimensions.interactiveWidth);
      const downloadBase = `${dashboard.base}/api/tasks/${original.accessTaskId}/resources/${original.resourceId}/download?format=png`;
      expect((await page.request.get(downloadBase + "&options=" + encodeURIComponent("[]"))).status()).toBe(
        422
      );
      expect(
        (
          await page.request.get(
            downloadBase + "&options=" + encodeURIComponent(JSON.stringify({ timeoutMs: 999999 }))
          )
        ).status()
      ).toBe(422);
      await expect(editor.locator("[data-program-save]")).toBeEnabled();
      await page.reload();
      // Source parameters are populated by the asynchronous geometry result after a reload.
      await expect(editor.locator("[data-cad-viewport]")).toHaveAttribute("data-ready", "true", {
        timeout: 30_000
      });
      await openCadProperties(editor);
      await expect(editor.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true })).toHaveValue("23");
      const final = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
      expect(final.tabs.filter((t) => t.resourceId === original.resourceId)).toHaveLength(1);
      for (const width of [1280, 1100, 960, 474, 320]) {
        await page.setViewportSize({ width, height: 900 });
        if (width < 1100 && !(await editor.isVisible())) {
          await page.locator('[data-tab-kind="file"]').click();
        }
        await expect(editor.locator("[data-program-save]")).toBeVisible();
        await editor.getByRole("button", { name: "模型部件", exact: true }).click();
        await editor.locator('[data-program-select="solid_13"]').click();
        await expect(editor.locator('[data-program-select="solid_13"]')).toHaveAttribute(
          "aria-pressed",
          "true"
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      expect(failures).toEqual([]);
      expect(receivedImage).toBe(supportsImages);
      expect(errors).toEqual([]);
    } finally {
      await dashboard?.stop();
      await new Promise((done) => provider.close(done));
    }
  });

test("legacy design upgrades in place and undo restores the basic editor", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await openCadResource(page, dashboard, {
      kind: "model/atria-cad+json",
      title: "升级验证.cad.json",
      initialContent: { version: 1, units: "mm", parts: [] }
    });
    await page.locator('[data-cad-add="box"]').click();
    await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
    await page.locator("[data-cad-code]").click();
    await expect(page.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await expect(page.locator("[data-program-count]")).toHaveText("1");
    await page.locator("[data-program-undo]").click();
    await expect(page.locator("[data-cad-count]")).toHaveText("1/64");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    expect(tabs.tabs.filter((t) => t.resourceId)).toHaveLength(1);
  } finally {
    await dashboard.stop();
  }
});

test("source workspace appears with update feedback before native geometry finishes", async ({ page }) => {
  test.setTimeout(90_000);
  const dashboard = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/resources/*/preview", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await openCadProgram(page, dashboard, "加载反馈.cad.json");
    await expect(page.locator("[data-program-status]")).toBeVisible();
    await expect(page.locator("[data-program-preview-notice]")).toContainText("正在更新模型");
    await expect(page.locator("[data-program-preview]")).toBeHidden();
    release();
    if (process.platform === "darwin")
      // Once released, native preview still owns its normal 60s calculation
      // budget; concurrent packaged-app checks can outlast the default 10s.
      await expect(page.locator("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 65_000 });
    else {
      await page.locator("[data-program-preview-details]").click();
      await expect(page.locator("[data-program-preview-error-text]")).toContainText("目前支持 macOS");
      await expect(page.locator("[data-program-preview-message]")).toContainText("你的修改已保留");
      await expect(page.locator("[data-program-retry]")).toBeVisible();
    }
    await expect(page.locator("[data-program-count]")).toHaveText("0");
    await expect(page.locator("[data-program-preview]")).toBeEnabled();
  } finally {
    release();
    await dashboard.stop();
  }
});

test("CAD queues selection changes and clears a removed solid in the Agent context", async ({ page }) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openCadResource(page, dashboard, {
      kind: "model/atria-cad+json",
      title: "选区同步.cad.json",
      initialContent: { version: 1, units: "mm", parts: [] }
    });
    await page.locator('[data-cad-add="box"]').click();
    await expect(page.locator("[data-cad-count]")).toHaveText("1/64");
    await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
    await page.locator("[data-cad-code]").click();
    await expect(page.locator("[data-program-count]")).toHaveText("1");
    await page.locator("[data-program-source-toggle]").click();
    await page
      .locator("[data-program-source]")
      .fill(
        "const {primitives:{cuboid}, transforms:{translate}}=require('@jscad/modeling'); module.exports.main=()=>[cuboid({size:[2,3,4]}),translate([5,0,0],cuboid({size:[2,3,4]}))];"
      );
    await page.locator("[data-program-save]").click();
    await expect(page.locator("[data-program-count]")).toHaveText("2");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json(),
      tab = tabs.tabs.find((item) => item.resourceId),
      resourceUrl = `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`;
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let selectionRequests = 0;
    await page.route("**/resources/*/selection", async (route) => {
      selectionRequests++;
      if (selectionRequests === 1) await firstGate;
      await route.continue();
    });
    await page.locator("[data-program-parts-toggle]").click();
    await page.locator('[data-program-select="solid_0"]').click();
    await expect.poll(() => selectionRequests).toBe(1);
    await page.locator("[data-program-parts-toggle]").click();
    await page.locator('[data-program-select="solid_1"]').click();
    await expect(page.locator("[data-cad-viewport]")).toHaveAttribute("data-selected", "solid_1");
    releaseFirst();
    await expect
      .poll(async () => (await (await page.request.get(resourceUrl)).json()).selection?.data?.id)
      .toBe("solid_1");
    await page
      .locator("[data-program-source]")
      .fill(
        "const {cuboid}=require('@jscad/modeling').primitives; module.exports.main=()=>cuboid({size:[2,3,4]});"
      );
    await page.locator("[data-program-save]").click();
    await expect(page.locator("[data-program-count]")).toHaveText("1");
    await expect(page.locator("[data-cad-viewport]")).toHaveAttribute("data-selected", "");
    await expect
      .poll(async () => (await (await page.request.get(resourceUrl)).json()).selection?.data)
      .toEqual({});
    expect((await (await page.request.get(resourceUrl)).json()).selection.summary).toBe("未选中模型部件");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});
