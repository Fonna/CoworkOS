import { openCadProgram, openCadExport, openCadProperties } from "./cad-editor-helper.js";
import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { DEFAULT_CADQUERY_SOURCE } from "../dist/src/software/cad/program.js";
const rocket = await readFile("test/fixtures/cad-rocket.py", "utf8");
test.skip(process.platform !== "darwin", "Native CAD currently requires macOS OS isolation");
test("native CAD chat creation, manual edit, AI refinement, errors, history and exports share one file", async ({
  page
}) => {
  test.setTimeout(180000);
  const failures = [],
    errors = [];
  let phase = "create",
    imageReceived = false,
    recoveryReceived = false,
    resourceId;
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
        `data: ${JSON.stringify({ id: "native-cad", object: "chat.completion.chunk", created: 1, model: "browser-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
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
      const start = request.messages.findLastIndex(
        (m) =>
          m.role === "user" &&
          JSON.stringify(m.content).includes(
            phase === "create" ? "创建精确实体火箭" : "继续优化当前设计，保留我的参数"
          )
      );
      const offered = request.tools.map((t) => t.function.name);
      if (offered.includes("cad_read_model")) {
        for (const stale of [
          "cad_upsert_part",
          "cad_edit_parts",
          "cad_remove_part",
          "cad_write_program",
          "cad_set_parameters"
        ])
          assert.equal(offered.includes(stale), false, `irrelevant native CAD tool: ${stale}`);
        assert.ok(offered.includes("cad_run_program"));
      }
      const calls = request.messages.slice(start + 1).flatMap((m) => m.tool_calls ?? []);
      const previous = request.messages.slice(start + 1).findLast((m) => m.role === "tool");
      const result = previous && JSON.parse(previous.content);
      const last = calls.at(-1)?.function.name;
      if (previous && !(phase === "create" && last === "cad_run_program" && !recoveryReceived))
        assert.notEqual(result.ok, false, JSON.stringify(result));
      let name,
        args = {};
      if (!last || last === "enable_tools") {
        name = phase === "create" ? "create_resource" : "cad_read_model";
        if (phase === "create") args = { kind: "model/atria-cadquery+json", title: "精确火箭.cad.json" };
      } else if (last === "create_resource") {
        resourceId = result.resource.resourceId;
        name = "cad_read_model";
      } else if (last === "cad_read_model" && !calls.some((c) => c.function.name === "cad_run_program")) {
        assert.equal(result.result.model.engine, "cadquery");
        if (phase === "continue") assert.equal(result.result.model.parameters.radius, 26);
        name = "cad_get_api_reference";
        args = { module: "Workplane", member: "revolve" };
      } else if (last === "cad_get_api_reference") {
        assert.equal(result.result.engine, "cadquery");
        assert.ok(result.result.installedApi.revolve.signature.includes("angleDegrees"));
        name = "cad_run_program";
        args = {
          source:
            phase === "create"
              ? "def main(p):\n    raise ValueError('candidate fixture failure')"
              : rocket + "\n# AI refinement retains human parameters\n",
          timeoutSeconds: 60
        };
      } else if (last === "cad_run_program") {
        if (result.ok === false) {
          assert.equal(result.details.sourceSaved, false);
          assert.match(result.error, /candidate fixture failure/);
          recoveryReceived = true;
          name = "cad_run_program";
          args = { source: rocket, timeoutSeconds: 60 };
        } else {
          assert.equal(result.result.engine, "cadquery");
          assert.equal(result.result.brep.valid, true);
          assert.equal(result.result.brep.solids, 11);
          name = "export_resource";
          args = { resourceId, format: "step", options: { timeoutMs: 60000 } };
        }
      } else if (last === "export_resource") {
        assert.match(await readFile(result.path, "utf8"), /^ISO-10303-21;/);
        name = "cad_read_model";
      } else {
        assert.equal(result.result.geometry.brep.solids, 11);
        if (phase === "continue") assert.equal(result.result.model.parameters.radius, 26);
        send({ content: phase === "create" ? "精确实体火箭已验证。" : "保留人工半径 26，已重新验证。" });
        send({}, "stop");
      }
      if (name) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `native-${phase}-${calls.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        });
        send({}, "tool_calls");
      }
    } catch (e) {
      failures.push(e.message);
      send({ content: "native fixture failed" });
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
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("创建精确实体火箭");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("精确实体火箭已验证。", { timeout: 60000 });
    const editor = page.locator("[data-app-mount]:not([hidden])");
    await expect(editor.locator("[data-program-engine]")).toContainText("OpenCascade");
    await expect(editor.locator("[data-program-count]")).toHaveText("11", { timeout: 20000 });
    await expect(editor.locator("[data-program-details]")).toContainText("BRep 已验证");
    await openCadProperties(editor);
    const radius = editor.getByRole("spinbutton", { name: "机身半径 (mm)", exact: true });
    await radius.fill("26");
    await radius.press("ControlOrMeta+s");
    await expect(editor.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
    const before = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const tab = before.tabs.find((t) => t.resourceId);
    phase = "continue";
    await page.locator("#composer-input").fill("继续优化当前设计，保留我的参数");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("保留人工半径 26，已重新验证。", {
      timeout: 60000
    });
    await expect(radius).toHaveValue("26");
    await editor.locator("[data-program-source-toggle]").click();
    const source = editor.getByRole("textbox", { name: "CAD 建模源码" });
    await source.fill("def main(p):\n    raise ValueError('saved Python failure')");
    await editor.locator("[data-program-save]").click();
    await expect(editor.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await editor.locator("[data-program-preview-details]").click({ timeout: 30_000 });
    await expect(editor.locator("[data-program-preview-error-text]")).toContainText("第 2 行", {
      timeout: 20000
    });
    await page.reload();
    await editor.locator("[data-program-source-toggle]").click();
    await expect(source).toHaveValue(/saved Python failure/);
    await openCadExport(editor);
    await expect(editor.locator('[data-program-export="jscad"]')).toBeHidden();
    const failedDownload = page.waitForEvent("download");
    await editor.locator('[data-program-export="python"]').click();
    expect(await readFile(await (await failedDownload).path(), "utf8")).toContain("saved Python failure");
    await editor.locator("[data-program-undo]").click();
    await expect(editor.locator("[data-program-preview-error]")).toBeHidden({ timeout: 20000 });
    // Undo restores the source before the native geometry preview finishes.
    // Allow its configured 20-second generation budget, plus UI scheduling.
    await expect(editor.locator("[data-program-count]")).toHaveText("11", { timeout: 30000 });
    await openCadProperties(editor);
    await expect(radius).toHaveValue("26");
    for (const format of ["step", "stl", "python", "png"]) {
      await openCadExport(editor);
      const pending = page.waitForEvent("download");
      await editor.locator(`[data-program-export="${format}"]`).click();
      const file = await pending;
      const bytes = await readFile(await file.path());
      if (format === "step") expect(bytes.toString()).toMatch(/^ISO-10303-21;/);
      if (format === "python") {
        expect(bytes.toString()).toContain('\\"radius\\":26');
        expect(file.suggestedFilename()).toMatch(/\.py$/);
      }
      if (format === "png") expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      if (format === "stl") expect(bytes.length).toBeGreaterThan(84);
    }
    for (const width of [1440, 960, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width < 1100 && !(await editor.isVisible())) await page.locator('[data-tab-kind="file"]').click();
      await expect(editor.locator("[data-program-save]")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const after = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    expect(after.tabs.filter((t) => t.resourceId)).toHaveLength(1);
    expect(after.tabs.find((t) => t.resourceId).resourceId).toBe(tab.resourceId);
    expect(imageReceived).toBe(true);
    expect(recoveryReceived).toBe(true);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  }
});
test("an existing empty CadQuery document remains editable", async ({ page }) => {
  // Three native evaluations each retain their real 60-second wall deadline.
  test.setTimeout(150_000);
  const dashboard = await startDashboard();
  try {
    await openCadProgram(page, dashboard, "精确支架.cad.json");
    await expect(page.locator("[data-program-engine]")).toContainText("OpenCascade");
    await expect(page.locator("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 65_000 });
    await expect(page.locator("[data-program-count]")).toHaveText("0");
    await expect(page.locator("[data-program-parameters] input")).toHaveCount(0);
    await expect(page.locator("[data-program-details]")).not.toContainText("BRep 已验证");
    await expect(page.locator("[data-program-preview-message]")).toContainText("在对话中描述设计");
    // A sample appears only when the person explicitly supplies its source.
    await page.getByRole("button", { name: "建模代码", exact: true }).click();
    await page.getByRole("textbox", { name: "CAD 建模源码" }).fill(DEFAULT_CADQUERY_SOURCE);
    await page.getByRole("button", { name: "显示完整模型", exact: true }).click();
    await openCadProperties(page.locator("[data-app-mount]:not([hidden])"));
    await expect(page.getByRole("spinbutton", { name: "宽度 (mm)", exact: true })).toHaveValue("60", {
      timeout: 65_000
    });
    await page.getByRole("button", { name: "建模代码", exact: true }).click();
    await expect(page.locator("[data-program-details]")).toContainText("BRep 已验证");
    const editor = page.locator("[data-app-mount]:not([hidden])");
    await expect(editor.locator("[data-program-source-panel]")).toBeHidden();
    await expect(editor.locator("[data-program-parts-panel]")).toBeHidden();
    await expect(editor.getByRole("combobox", { name: "生成时限" })).toBeHidden();
    await expect(editor.locator("[data-program-preview]")).toBeHidden();
    await expect(editor.getByRole("button", { name: "显示完整模型", exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "模型部件", exact: true }).click();
    await expect(editor.locator("[data-program-parts-panel]")).toBeVisible();
    const part = editor.locator("[data-program-select]");
    await expect(part).toHaveAttribute("aria-pressed", "false");
    await part.click();
    await expect(part).toHaveAttribute("aria-pressed", "true");
    // Stay inside the canvas, beyond the sidebar divider's resize hit area.
    await editor.locator("[data-cad-viewport]").click({ position: { x: 12, y: 12 } });
    await expect(part).toHaveAttribute("aria-pressed", "false");
    await editor.getByRole("button", { name: "模型部件", exact: true }).click();
    await editor.getByRole("button", { name: "模型部件", exact: true }).press("Escape");
    await expect(editor.locator("[data-program-parts-panel]")).toBeHidden();
    await openCadProperties(editor);
    const width = editor.getByRole("spinbutton", { name: "宽度 (mm)", exact: true });
    await width.fill("80");
    await editor.getByRole("button", { name: "显示完整模型", exact: true }).click();
    await expect(editor.locator("[data-program-metrics]")).toContainText("80.0", { timeout: 65_000 });
    await expect(editor.locator("[data-program-status]")).toHaveAttribute("data-state", "dirty");
    await editor.getByRole("button", { name: "建模代码", exact: true }).click();
    await editor
      .getByRole("textbox", { name: "CAD 建模源码" })
      .fill(
        'import cadquery as cq\ndef get_parameter_definitions():\n    return [{"name":"width","type":"float","initial":60,"caption":"宽度 (mm)"}]\ndef main(p):\n    return cq.Workplane("XY").box(p["width"],40,12)\n'
      );
    // Leaving the code field must update geometry without an explicit calculate command.
    await editor.getByRole("button", { name: "显示完整模型", exact: true }).click();
    await expect(editor.locator("[data-program-metrics]")).toContainText("80.0 × 40.0 × 12.0", {
      timeout: 65_000
    });
    await editor.locator("[data-program-save]").click();
    await expect(editor.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
  } finally {
    await dashboard.stop();
  }
});
