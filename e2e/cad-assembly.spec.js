import { openCadProgram, openCadExport, openCadView } from "./cad-editor-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";

test("inline-four assembly plays independent parts and inspection controls leave the design untouched", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(150000);
  const dashboard = await startDashboard(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = page.locator("[data-app-mount]:not([hidden])"),
    q = (s) => editor.locator(s);
  try {
    await openCadProgram(page, dashboard, "四缸机构.cad.json");
    await expect(q("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 30000 });
    await q("[data-program-file]").setInputFiles("test/fixtures/cad-inline-four.py");
    await expect(q("[data-program-count]")).toHaveText("21", { timeout: 30000 });
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const tab = tabs.tabs.find((t) => t.resourceId);
    const url = `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`;
    const before = await (await page.request.get(url)).json();
    const canvas = q("[data-cad-viewport] canvas");
    await expect(q("[data-program-motion]")).toBeVisible();
    await q("[data-program-view]").selectOption("front");
    const rest = await canvas.screenshot();
    await q("[data-program-time]").evaluate((e) => {
      e.value = "1";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-motion-time", "1.0000");
    expect(rest.equals(await canvas.screenshot())).toBe(false);
    // Selection must follow the pose, and must not restart playback or rebuild geometry.
    await q("[data-program-parts-toggle]").click();
    await expect(q(".cad-assembly-branch").first()).toContainText("engine");
    await q("[data-program-filter]").fill("piston_1");
    await expect(q("[data-program-select]:visible")).toHaveCount(1);
    await q("[data-program-select]:visible").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-motion-time", "1.0000");
    await expect(q("[data-program-part-info]")).toContainText("有效实体");
    await expect
      .poll(async () => (await (await page.request.get(url)).json()).selection?.data.path)
      .toBe("/engine/pistons/piston_1");
    await q("[data-program-play]").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-playing", "true");
    await expect.poll(() => q("[data-cad-viewport]").getAttribute("data-motion-time")).not.toBe("1.0000");
    await q("[data-program-play]").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-playing", "false");
    await openCadView(editor);
    await q('[data-program-inspector-tab="checks"]').click();
    await expect(q("[data-inspect-quality]")).toContainText("声明的部件数量满足");
    await expect(q("[data-inspect-quality]")).toContainText("未建模缸盖");
    await q('[data-program-inspector-tab="properties"]').click();
    const engineering = await canvas.screenshot();
    await q("[data-inspect-appearance]").selectOption("colors");
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-appearance", "colors");
    expect(engineering.equals(await canvas.screenshot())).toBe(false);
    await q("[data-inspect-appearance]").selectOption("materials");
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-appearance", "materials");
    expect(engineering.equals(await canvas.screenshot())).toBe(false);
    await q("[data-inspect-appearance]").selectOption("engineering");
    await q("[data-program-style]").selectOption("wireframe");
    expect(rest.equals(await canvas.screenshot())).toBe(false);
    await q("[data-program-style]").selectOption("solid");
    const beforeExplode = await canvas.screenshot();
    await q("[data-program-explode]").evaluate((e) => {
      e.value = "65";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(beforeExplode.equals(await canvas.screenshot())).toBe(false);
    await q("[data-program-reset-view]").click();
    await q("[data-program-section]").selectOption("x");
    await q("[data-program-section-offset]").fill("0");
    const section = await canvas.screenshot();
    expect(rest.equals(section)).toBe(false);
    await q("[data-program-view-close]").click();
    await q("[data-inspect-actions]").click();
    await editor.getByRole("menuitem", { name: "隔离选中", exact: true }).click();
    await openCadView(editor);
    await q("[data-program-section]").selectOption("off");
    await q("[data-program-reset-view]").click();
    await q("[data-program-parts-toggle]").click();
    await q("[data-program-filter]").fill("");
    const visible = q("[data-program-visible]").first();
    const beforeHide = await canvas.screenshot();
    await visible.uncheck();
    expect(beforeHide.equals(await canvas.screenshot())).toBe(false);
    await visible.check();
    await q("[data-program-parts-toggle]").click();
    await openCadExport(editor);
    const download = page.waitForEvent("download");
    await q('[data-program-export="view-png"]').click();
    const file = await download,
      bytes = await readFile(await file.path());
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const after = await (await page.request.get(url)).json();
    expect(after.resource.revision).toBe(before.resource.revision);
    expect(after.snapshot.content).toEqual(before.snapshot.content);
    // Reordering returned parts must preserve the logical selection and visibility.
    await q("[data-program-parts-toggle]").click();
    await q("[data-program-filter]").fill("shaft");
    await q("[data-program-visible]:visible").uncheck();
    await q("[data-program-parts-toggle]").click();
    const reordered = (await readFile("test/fixtures/cad-inline-four.py", "utf8"))
      .replace("    engine.add(crank)\n", "")
      .replace("    engine.add(cylinders)\n", "    engine.add(cylinders)\n    engine.add(crank)\n");
    await q("[data-program-file]").setInputFiles({
      name: "reordered.py",
      mimeType: "text/x-python",
      buffer: Buffer.from(reordered)
    });
    await expect(q("[data-program-preview-notice]")).toBeHidden({ timeout: 30000 });
    await expect(q("[data-program-part-info]")).toContainText("piston_1");
    await expect
      .poll(async () => (await (await page.request.get(url)).json()).selection?.data.id)
      .toBe("solid_4");
    await q("[data-program-parts-toggle]").click();
    await expect(q("[data-program-visible]:visible")).not.toBeChecked();
    await q("[data-program-filter]").fill("");
    await q("[data-program-parts-toggle]").click();
    await q("[data-program-reset-view]").click();
    for (const width of [1440, 960, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(q("[data-program-play]")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await q("[data-program-explode]").evaluate((e) => {
      e.value = "40";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await q("[data-program-fit]").click();
    await page.screenshot({ path: "test-results/cad-inline-four-viewer.png" });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("Pi receives the motion contract, commits an assembly and inspects a frame through the domain tools", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(120000);
  const source = await readFile("test/fixtures/cad-inline-four.py", "utf8"),
    failures = [];
  let imageReceived = false;
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.end('{"data":[]}');
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    imageReceived ||= JSON.stringify(request.messages).includes("data:image/png;base64,");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "assembly", object: "chat.completion.chunk", created: 1, model: "browser-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant" });
    // The model explicitly discovers optional application tools before creating a resource.
    if (!request.tools.some((tool) => tool.function.name === "create_resource")) {
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
      const calls = request.messages.flatMap((m) => m.tool_calls ?? []),
        last = calls.at(-1)?.function.name;
      const previous = request.messages.findLast((m) => m.role === "tool"),
        result = previous && JSON.parse(previous.content);
      if (previous) assert.notEqual(result.ok, false, JSON.stringify(result));
      let name,
        args = {};
      if (!last || last === "enable_tools") {
        name = "create_resource";
        args = { kind: "model/atria-cadquery+json", title: "模型创建四缸.cad.json" };
      } else if (last === "create_resource") name = "cad_read_model";
      else if (last === "cad_read_model" && !calls.some((c) => c.function.name === "cad_run_program")) {
        const tools = request.tools.map((t) => t.function.name);
        assert.ok(tools.includes("cad_run_program"));
        assert.ok(
          request.tools.find((t) => t.function.name === "cad_preview").function.parameters.properties.view
        );
        name = "cad_get_api_reference";
        args = { module: "Motion" };
      } else if (last === "cad_get_api_reference") {
        if (JSON.parse(calls.at(-1).function.arguments).module === "Motion") {
          assert.equal(result.result.contract, "atria-cad-motion/v1");
          assert.ok(result.result.example.includes("get_motion"));
          name = "cad_get_api_reference";
          args = { module: "Viewer" };
        } else {
          assert.equal(result.result.contract, "atria-cad-view/v1");
          assert.ok(result.result.preview.sections);
          name = "cad_run_program";
          args = { source, timeoutSeconds: 60 };
        }
      } else if (last === "cad_run_program") {
        assert.equal(result.result.motion.trackCount, 13);
        assert.equal(result.result.assembly.length, 26);
        assert.ok(result.result.objects.every((o) => o.path && o.brep.valid));
        name = "cad_preview";
        args = {
          timeoutSeconds: 60,
          view: {
            timeSeconds: 1,
            paths: ["/engine/pistons/piston_1"],
            hiddenPaths: ["/engine/cylinders"],
            explodeMode: "groups",
            sections: [
              { axis: "x", offset: -80 },
              { axis: "z", offset: 40, inverted: true }
            ]
          }
        };
      } else if (last === "cad_preview") {
        assert.equal(result.result.view.objects.length, 1);
        assert.ok(result.result.view.bounds[1][0] <= -80 + 1e-6);
        assert.ok(result.result.view.bounds[0][2] >= 40 - 1e-6);
        assert.equal(result.result.view.options.sections.length, 2);
        assert.equal(result.visualFeedback.delivered, true);
        name = "cad_read_model";
      } else {
        assert.equal(result.result.preview.status, "ready");
        assert.equal(result.result.geometry.objects.length, 21);
        assert.equal(result.result.geometry.view, undefined, "inspection must not replace rest baseline");
        send({ content: "四缸装配及运动帧已验证。" });
        send({}, "stop");
      }
      if (name) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `assembly-${calls.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        });
        send({}, "tool_calls");
      }
    } catch (e) {
      failures.push(e.message);
      send({ content: "装配接入失败。" });
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
      supportsImages: true
    });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("创建可运动的四缸机构并检查内部运动帧");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("四缸装配及运动帧已验证。", { timeout: 60000 });
    await expect(page.locator("[data-program-count]")).toHaveText("21", { timeout: 20000 });
    await expect(page.locator("[data-program-motion]")).toBeVisible();
    expect(failures).toEqual([]);
    expect(imageReceived).toBe(true);
  } finally {
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  }
});
