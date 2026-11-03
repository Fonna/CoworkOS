import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  rm,
  access,
  cp,
  writeFile,
  readdir,
  mkdir,
  stat,
  realpath
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { startNativeApplicationMonitor } from "./native-application-monitor.mjs";
import { desktopSmokeEnvironment, prepareDesktopSmokeComponents } from "./desktop-smoke-env.mjs";
import { signAsync } from "@electron/osx-sign";
import { confirmApplicationWorkspace } from "../e2e/application-workspace-helper.js";
import { loadCurrentApplication } from "../e2e/application-context-helper.js";
import { newPresentation, presentationSave, presentationStatus } from "../e2e/pptist-helper.js";
import { openCadExport, openCadProperties } from "../e2e/cad-editor-helper.js";

import { HumanRequestStore } from "../dist/src/runtime/human.js";
const appPath = resolve(process.env.ATRIA_DESKTOP_APP || ".tmp/release/mac-arm64/CoworkOS.app");
const executablePath = join(appPath, "Contents/MacOS/CoworkOS");
const packagedMetadata = JSON.parse(
  await readFile(join(appPath, "Contents/Resources/app/package.json"), "utf8")
);
const originalVersion = packagedMetadata.version;
await access(executablePath);
const plist = await readFile(join(appPath, "Contents/Info.plist"), "utf8");
const iconFile = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
expect(iconFile).toBeTruthy();
// Verify the actual Finder icon bytes in the package, not just the builder setting.
expect(await readFile(join(appPath, "Contents/Resources", basename(iconFile)))).toEqual(
  await readFile(resolve("build/atria.icns"))
);
const root = await realpath(await mkdtemp(join(tmpdir(), "atria-packaged-smoke-")));
const data = join(root, "user-data");
const projectDirectory = join(root, "project");
await mkdir(projectDirectory);
const scope = await prepareDesktopSmokeComponents({ data, metadata: packagedMetadata });
console.log(`Desktop smoke package mode: ${scope.mode}`);
if (!scope.nativeComponents)
  console.log(
    "Desktop smoke: CAD/Blender downloads disabled only in the disposable smoke data; component delivery has a separate acceptance test."
  );
// Even optional runtime discovery uses the disposable home, never inherited
// ATRIA_HOME/COWORK_BLENDER_EXECUTABLE or the user's private runtime directory.
const blenderModule = pathToFileURL(
  join(appPath, "Contents/Resources/app/dist/src/software/blender/engine.js")
).href;
const blenderRuntime = JSON.parse(
  (
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {blenderStatus}=await import(${JSON.stringify(blenderModule)}); console.log(JSON.stringify(await blenderStatus()));`
      ],
      { env: desktopSmokeEnvironment({ data }) }
    )
  ).stdout
);
if (scope.nativeComponents) {
  expect(blenderRuntime.available, "full App includes a working bundled Blender").toBe(true);
  expect(blenderRuntime.executable).toBe(
    await realpath(join(appPath, "Contents/Resources/blender/Blender.app/Contents/MacOS/Blender"))
  );
}
const requests = [];
const deferred = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const reasoningGates = [deferred(), deferred()];
const reasoningText = ["先检查绑定文档的完整内容。", "继续确认中文与 Emoji 的保存结果。"];
let reasoningStarted = false;
let computerTarget;
let applicationMonitor;
const desktopPids = new Set();
const keychainPids = new Set();
let hold = false;
const held = [];
const model = createServer(async (req, res) => {
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "desktop-fixture" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
  requests.push(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (hold) {
    held.push(res);
    return;
  }
  const send = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: `desktop-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "desktop-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    );
  send({ role: "assistant" });
  if (
    !reasoningStarted &&
    request.tools?.some((tool) => tool.function.name === "read_document") &&
    !request.messages.some((message) => message.role === "tool")
  ) {
    reasoningStarted = true;
    send({ reasoning_content: reasoningText[0] });
    await reasoningGates[0].promise;
    send({ reasoning_content: reasoningText[1] });
    await reasoningGates[1].promise;
  }
  const computerPrompt = JSON.stringify(
    request.messages.findLast((message) => message.role === "user")?.content
  ).includes("检查电脑操作");
  if (computerPrompt) {
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const calls = request.messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? []);
    const previous = request.messages.findLast((message) => message.role === "tool");
    const result = previous && JSON.parse(previous.content);
    if (calls.some((call) => call.function.name === "computer_observe")) {
      if (
        result?.mimeType !== "image/png" ||
        !result?.observationId ||
        result?.visualFeedback?.delivered !== false
      )
        throw new Error("Desktop computer observation failed");
      send({ content: "电脑操作观察验证成功" });
      send({}, "stop");
    } else {
      const name = !calls.some((call) => call.function.name === "computer_status")
        ? "computer_status"
        : !calls.some((call) => call.function.name === "computer_discover")
          ? "computer_discover"
          : !calls.some((call) => call.function.name === "computer_select")
            ? "computer_select"
            : "computer_observe";
      if (name === "computer_select")
        expect(
          result.windows.some(
            (window) => window.pid === computerTarget.pid && window.windowId === computerTarget.windowId
          )
        ).toBe(true);
      const parameters =
        name === "computer_select"
          ? { pid: computerTarget.pid, windowId: computerTarget.windowId, mode: "control" }
          : name === "computer_observe"
            ? { sessionId: result.session.sessionId }
            : {};
      send({
        tool_calls: [
          {
            index: 0,
            id: `desktop-${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(parameters) }
          }
        ]
      });
      send({}, "tool_calls");
    }
    res.end("data: [DONE]\n\n");
    return;
  }
  if (request.tools?.some((tool) => tool.function.name === "cad_read_model")) {
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const recentCalls = request.messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? []);
    const previous = request.messages.findLast((message) => message.role === "tool");
    const result = previous && JSON.parse(previous.content);
    const sourceMode = result?.result?.model?.version === 2;
    const ranSource = recentCalls.some((call) => call.function.name === "cad_run_program");
    const wroteSource = ranSource || recentCalls.some((call) => call.function.name === "cad_write_program");
    if (sourceMode || wroteSource) {
      const previewedSource = ranSource || recentCalls.some((call) => call.function.name === "cad_preview");
      if (wroteSource && !previewedSource) {
        send({
          tool_calls: [
            {
              index: 0,
              id: "desktop-source-preview",
              type: "function",
              function: { name: "cad_preview", arguments: "{}" }
            }
          ]
        });
        send({}, "tool_calls");
      } else if (wroteSource) {
        if (result?.ok === false || result?.result?.status !== "ready")
          throw new Error("Desktop source preview failed");
        send({ content: "CAD 源码验证成功" });
        send({}, "stop");
      } else {
        send({
          tool_calls: [
            {
              index: 0,
              id: "desktop-source",
              type: "function",
              function: {
                name: result.result.model.engine === "cadquery" ? "cad_run_program" : "cad_write_program",
                arguments: JSON.stringify({
                  source:
                    result.result.model.source +
                    (result.result.model.engine === "cadquery"
                      ? "\n# Desktop AI refinement preserves human parameters.\n"
                      : "\n// Desktop AI refinement preserves human parameters.\n")
                })
              }
            }
          ]
        });
        send({}, "tool_calls");
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    const wrote = recentCalls.some((call) => call.function.name === "cad_upsert_part");
    const read = recentCalls.some((call) => call.function.name === "cad_read_model");
    if (wrote) {
      send({ content: "CAD 模型验证成功" });
      send({}, "stop");
    } else {
      const name = read ? "cad_upsert_part" : "cad_read_model";
      const argumentsText = read
        ? JSON.stringify({
            part: {
              id: "agent_body",
              name: "Agent 创建的实体",
              shape: "box",
              size: [48, 24, 12],
              position: [80, 0, 0]
            }
          })
        : "{}";
      send({
        tool_calls: [
          { index: 0, id: `cad-${name}`, type: "function", function: { name, arguments: argumentsText } }
        ]
      });
      send({}, "tool_calls");
    }
  } else if (request.messages.some((message) => message.role === "tool")) {
    send({ content: "桌面模型验证成功" });
    send({}, "stop");
  } else if (request.tools?.some((tool) => tool.function.name === "read_document")) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "desktop-read",
          type: "function",
          function: { name: "read_document", arguments: "{}" }
        }
      ]
    });
    send({}, "tool_calls");
  } else {
    send({ content: "绑定文档工具未加载" });
    send({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const endpoint = `http://127.0.0.1:${model.address().port}/v1`;
let native;
const launch = async (app = executablePath) => {
  // The relocated full App must discover its own bundled Blender, without an
  // executable override pointing back to either the original App or this checkout.
  const env = desktopSmokeEnvironment({ data });
  native = await electron.launch({
    executablePath: app,
    args: ["--use-mock-keychain"],
    env,
    timeout: 30_000
  });
  desktopPids.add(native.process().pid);
  native.process().stderr.on("data", (chunk) => console.error(String(chunk).trim().slice(-2000)));
  const page = await native.firstWindow();
  await expect(page.locator(".app-topbar")).toBeVisible({ timeout: 30_000 });
  // Application recovery may intentionally keep navigation behind the task
  // panel. Wait for initialization without changing the restored sidebar view.
  await expect(page.locator("#apps-nav")).toHaveJSProperty("hidden", false, { timeout: 30_000 });
  // Renderer errors fail the GUI check even if its first paint happened.
  page.on("pageerror", (error) => {
    throw error;
  });
  await recordKeychainWorkers();
  return page;
};
async function recordKeychainWorkers() {
  const workers = await native.evaluate(() =>
    process
      ._getActiveHandles()
      .filter((handle) => handle.spawnargs?.includes("--atria-keychain-worker"))
      .map((child) => child.pid)
  );
  for (const pid of workers) keychainPids.add(pid);
}
function unexpectedApplications() {
  // Known beta limitation: the explicitly identified Keychain process still
  // uses the main Electron bundle and can briefly register a Dock application.
  return applicationMonitor.registrations.filter(
    (app) =>
      !desktopPids.has(app.pid) &&
      !keychainPids.has(app.pid) &&
      app.parents.some((pid) => desktopPids.has(pid))
  );
}
async function verifyBackgroundApplications() {
  await recordKeychainWorkers();
  const applications = await applicationMonitor.snapshot();
  const own = applications.find((app) => app.pid === native.process().pid);
  expect(own?.policy, "the main CoworkOS application keeps its normal Dock identity").toBe(0);
  expect(
    unexpectedApplications(),
    "only the known Keychain worker may register a second application"
  ).toEqual([]);
}
const quit = async () => {
  await recordKeychainWorkers();
  const current = native;
  const process = current.process();
  const page = current.windows()[0];
  const origin = new URL(page.url()).origin;
  const exited = process.exitCode === null ? once(process, "exit") : Promise.resolve();
  await current
    .evaluate(({ app }) => {
      app.quit();
    })
    .catch(() => {});
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Native quit timed out")), 12000).unref())
  ]);
  await current.close();
  native = undefined;
  await expect
    .poll(async () => {
      try {
        await fetch(`${origin}/api/tasks`, { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
};
async function focusFile(page, resourceId) {
  const tab = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/workbench/tabs")).json()).tabs.find((item) => item.resourceId === id),
    resourceId
  );
  expect(tab, "the requested document keeps its actual application window identity").toBeTruthy();
  const mount = page.locator(`[data-app-mount="${tab.tabId}"]`);
  const output = page.locator("#output-pane-toggle");
  if (
    (await output.getAttribute("aria-controls")) === "workbench" &&
    (await output.getAttribute("aria-expanded")) === "false"
  )
    await output.click();
  const shortcut = page.locator(`[data-tab-rail] [data-tab="${tab.tabId}"]`);
  if (await shortcut.isVisible()) await shortcut.click();
  else if (!(await mount.isVisible())) {
    await showNavigation(page);
    await page.locator("#apps-nav").click();
    const group = page.locator(`[data-toggle-instances="${tab.appType}"]`);
    const instance = page.locator(`[data-open-instance="${tab.tabId}"]`);
    if (!(await instance.isVisible())) await group.click();
    await instance.click();
  }
  await expect(mount).toBeVisible();
  if (tab.appType === "text-editor") await expect(mount.locator("[data-editor-input]")).toBeVisible();
}
async function showNavigation(page) {
  if (await page.locator("body").evaluate((node) => node.classList.contains("sidebar-collapsed")))
    await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  const navigation = page.locator('[data-sidebar-view="navigation"]');
  if (await navigation.isVisible()) await navigation.click();
  await expect(page.locator("#conversation-sidebar")).toBeVisible();
}
async function focusConversation(page, taskId) {
  await showNavigation(page);
  const conversation = page.locator(`.conversation-item[data-task="${taskId}"]`);
  const collapsed = conversation.locator(
    "xpath=ancestor::*[contains(@class,'project-group') and contains(@class,'collapsed')]"
  );
  if (await collapsed.count()) await collapsed.locator(".project-row").click();
  await conversation.click();
  // A human request intentionally replaces the composer with its answer form.
  await expect(page.locator("#composer-input:visible, #human-questions:visible")).toHaveCount(1);
  if (await page.locator("#composer-input").isVisible()) await page.locator("#composer-input").focus();
}
async function verifyNativeChrome(page) {
  console.log("Desktop smoke: model icon and integrated native window chrome");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-desktop-platform", "darwin");
  await expect(root).toHaveAttribute("data-desktop-fullscreen", "false");
  await expect(page.locator(".traffic")).toHaveCount(0);
  const refreshedDockIcons = await native.evaluate(({ app, nativeImage, BrowserWindow }) => {
    const calls = [];
    const original = app.dock.setIcon;
    app.dock.setIcon = function (value) {
      const image = typeof value === "string" ? nativeImage.createFromPath(value) : value;
      const size = image.getSize();
      const pixels = image.toBitmap();
      calls.push({
        size,
        outerCornerAlpha: pixels[3],
        tileCornerAlpha: pixels[(100 * size.width + 100) * 4 + 3]
      });
      return original.call(this, value);
    };
    try {
      app.emit("activate");
      BrowserWindow.getAllWindows()[0].emit("focus");
    } finally {
      app.dock.setIcon = original;
    }
    return calls;
  });
  // Exercise the packaged main-process event wiring and the image supplied to Dock.
  expect(refreshedDockIcons.length).toBeGreaterThanOrEqual(2);
  for (const icon of refreshedDockIcons) {
    expect(icon.size).toEqual({ width: 1024, height: 1024 });
    expect(icon.outerCornerAlpha).toBe(0);
    expect(icon.tileCornerAlpha).toBe(0);
  }
  const geometry = await native.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      bounds: win.getBounds(),
      content: win.getContentBounds(),
      lights: win.getWindowButtonPosition()
    };
  });
  // Native controls share the content header; there is no second titlebar above it.
  expect(geometry.content).toEqual(geometry.bounds);
  expect(geometry.lights).toEqual({ x: 18, y: 25 });
  const topbar = page.locator(".app-topbar");
  expect(await topbar.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe(
    "drag"
  );
  const sidebar = page.getByRole("button", { name: "切换侧栏", exact: true });
  expect(await sidebar.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe(
    "no-drag"
  );
  await sidebar.click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await sidebar.click();
  await expect(page.locator("body")).not.toHaveClass(/sidebar-collapsed/);
  const settingsTrigger = page.locator("#user-menu-button");
  await settingsTrigger.click();
  await expect(page.locator("#profile-close")).toBeFocused();
  await page.locator("#profile-close").press("Escape");
  await expect(page.locator("#profile-modal")).toBeHidden();
  await expect(settingsTrigger).toBeFocused();

  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(752, 700));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(752);
  const layout = await page.evaluate(() => {
    const header = document.querySelector(".app-topbar").getBoundingClientRect();
    return {
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll(".app-topbar button")].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom - header.top };
      })
    };
  });
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  for (const button of layout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(104);
    expect(button.right).toBeLessThanOrEqual(layout.width);
    expect(button.bottom).toBeLessThanOrEqual(64);
  }
  await native.evaluate(
    ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
    geometry.bounds
  );
  const desktopState = await page.evaluate(async () => (await fetch("/api/computer/status")).json());
  if (desktopState.controlAvailable === false && /锁定/.test(desktopState.reason || "")) {
    console.log(`Desktop smoke: fullscreen/minimize/restore SKIPPED (${desktopState.reason})`);
    return;
  }
  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  await expect(root).toHaveAttribute("data-desktop-fullscreen", "true", { timeout: 15_000 });
  expect(await topbar.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))).toBeLessThan(104);
  await sidebar.click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await sidebar.click();
  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await expect(root).toHaveAttribute("data-desktop-fullscreen", "false", { timeout: 15_000 });
  expect(await topbar.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("104px");
  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expect
    .poll(() => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    .toBe(true);
  await native.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.restore();
    win.focus();
  });
  await expect
    .poll(() => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    .toBe(false);
}
try {
  applicationMonitor = await startNativeApplicationMonitor(root, {
    moduleCacheDirectory: process.env.ATRIA_SWIFT_MODULE_CACHE || undefined
  });
  expect(applicationMonitor.initial.monitorPolicy).toBe(2);
  console.log("Desktop smoke: first install");
  let page = await launch();
  await expect(page.getByRole("heading", { name: "连接模型" })).toBeVisible();
  expect((await fetch(`${new URL(page.url()).origin}/api/tasks`)).status).toBe(401);
  await page.locator("[data-model-close]").click();
  const setupDraft = "连接模型之前准备的任务草稿 😀";
  await page.locator("#composer-input").fill(setupDraft);
  await page.locator("#model-setup-button").click();
  await page.locator('[name="baseUrl"]').fill(endpoint);
  await page.locator('[name="model"]').fill("desktop-fixture");
  await page.locator('[name="apiKey"]').fill("desktop-fake-key");
  await page.locator('[name="api"]').selectOption("openai-completions");
  const oldUrl = page.url();
  await page.getByRole("button", { name: "保存连接" }).click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toBe(oldUrl);
  await expect(page.locator("#apps-nav")).toBeVisible();
  await expect(page.getByRole("heading", { name: "连接模型" })).not.toBeVisible();
  await expect(page.locator("#composer-input")).toHaveValue(setupDraft);
  const modelStatus = await page.evaluate(() => window.bookmanDesktop.modelStatus());
  const expectedConnection = {
    api: "openai-completions",
    baseUrl: endpoint,
    model: "desktop-fixture",
    configured: true,
    supportsImages: false,
    reasoningEffort: "off",
    supportsReasoningEffort: false,
    supportsPromptCacheKey: false,
    thinkingFormat: "auto",
    contextWindow: 256000,
    mainMaxTokens: 8192,
    subagentMaxTokens: 8192
  };
  expect(modelStatus).toEqual({
    ...expectedConnection,
    activeProfileId: expect.any(String),
    visionProfileId: "",
    profiles: [
      {
        ...expectedConnection,
        id: modelStatus.activeProfileId,
        name: "新配置",
        active: true,
        vision: false
      }
    ]
  });
  await verifyNativeChrome(page);
  // Fresh installs require an explicit project and application destination.
  // Create the project through the UI and register its own application workspace.
  await page.locator("#new-project").click();
  const projectDialog = page.getByRole("dialog", { name: "新建项目", exact: true });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("textbox", { name: "项目名称", exact: true }).fill("桌面验收项目");
  await projectDialog.getByRole("textbox", { name: "工作文件夹", exact: true }).fill(projectDirectory);
  await projectDialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(projectDialog).toBeHidden();
  const registeredWorkspace = await page.evaluate(async (workspaceRoot) => {
    const response = await fetch("/api/workbench/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot })
    });
    return { status: response.status, body: await response.json() };
  }, projectDirectory);
  expect(registeredWorkspace.status).toBe(200);
  expect(registeredWorkspace.body).toMatchObject({ cancelled: false, workspaceRoot: projectDirectory });
  expect(registeredWorkspace.body.workspaces).toContain(projectDirectory);
  await page.locator("#apps-nav").click();
  await page.locator('[data-create-app="text-editor"]').click();
  await confirmApplicationWorkspace(page, projectDirectory);
  await page.locator("[data-empty-new]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("桌面恢复验证.txt");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  let content = "桌面内测内容\n中文与 Emoji 😀\n";
  await page.locator("[data-editor-input]").fill(content);
  await page.locator("[data-editor-save]").click();
  await expect(page.locator("[data-editor-status]")).toHaveAttribute("data-state", "saved");
  await loadCurrentApplication(page);
  await page.locator("#composer-input").fill("请读取绑定文档并确认内容。");
  await page.locator("#send-button").click();
  const reasoning = page.locator(".reasoning-details").filter({ hasText: reasoningText[0] }).first();
  await expect(reasoning).toBeVisible({ timeout: 40_000 });
  if (!(await reasoning.evaluate((element) => element.open))) await reasoning.locator("summary").click();
  await expect(reasoning).toHaveAttribute("open", "");
  reasoningGates[0].release();
  await expect(reasoning).toContainText(reasoningText[1]);
  await expect(reasoning).toHaveAttribute("open", "");
  reasoningGates[1].release();
  await expect(page.getByText("桌面模型验证成功", { exact: true }).first()).toBeVisible({ timeout: 40_000 });
  await verifyBackgroundApplications();
  expect(JSON.stringify(requests)).toContain("桌面内测内容");
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await (await fetch("/api/tasks")).json()).tasks
            .filter((task) => task.taskId !== "workspace")
            .map((task) => task.status)
        ),
      { timeout: 20_000 }
    )
    .toEqual(["completed"]);
  const tasks = await page.evaluate(async () => (await (await fetch("/api/tasks")).json()).tasks);
  const taskId = tasks.find((task) => task.taskId !== "workspace").taskId;
  console.log("Desktop smoke: Computer Use trusted IPC and real Pi observation");
  expect(await page.evaluate(() => typeof window.bookmanDesktop.computerUse)).toBe("function");
  const computerStatus = await page.evaluate(async () => (await fetch("/api/computer/status")).json());
  const ownWindow = computerStatus.windows.find((window) => window.pid === native.process().pid);
  if (
    computerStatus.available &&
    computerStatus.screenRecording &&
    ownWindow &&
    computerStatus.controlAvailable !== false
  ) {
    computerTarget = ownWindow;
    const openWindowSettings = async () => {
      if (await page.locator("#profile-modal").isHidden()) {
        await showNavigation(page);
        await page.locator("#user-menu-button").click();
      }
      await expect(page.locator("#profile-modal")).toBeVisible();
      const access = page.locator("#profile-modal .computer-setting");
      if (!(await access.evaluate((element) => element.open))) await access.locator("summary").click();
    };
    const closeWindowSettings = async () => {
      await page.locator("#profile-close").click();
      await expect(page.locator("#profile-modal")).toBeHidden();
    };
    await openWindowSettings();
    const windowAccess = page.locator("#computer-access-enabled");
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    expect(
      await page.evaluate(async () => (await (await fetch("/api/computer/access")).json()).policy)
    ).toEqual({ enabled: true, mode: "control" });
    await closeWindowSettings();
    await page.locator("#composer-input").fill("检查电脑操作");
    await page.locator("#send-button").click();
    await expect(page.getByText("电脑操作观察验证成功", { exact: true }).first()).toBeVisible({
      timeout: 40_000
    });
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const session = (await (await fetch(`/api/tasks/${id}/computer`)).json()).session;
          return {
            taskId: session?.taskId,
            source: session?.source,
            state: session?.state,
            observed: session?.activity.some(
              (event) => event.operation === "observe" && event.outcome === "completed"
            )
          };
        }, taskId)
      )
      .toEqual({ taskId, source: "global", state: "ended", observed: true });
    const selectOwnWindow = async () => {
      // macOS may replace a window ID across native transitions. Rediscover
      // this fixture's PID rather than reusing the first observation's ID.
      let target;
      await expect
        .poll(
          async () => {
            target = await page.evaluate(
              async (pid) =>
                (await (await fetch("/api/computer/status")).json()).windows.find(
                  (window) => window.pid === pid
                ),
              native.process().pid
            );
            return Boolean(target);
          },
          { timeout: 15000 }
        )
        .toBe(true);
      return page.evaluate(
        async ({ id, target }) => {
          const response = await fetch(`/api/tasks/${id}/computer/select`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pid: target.pid, windowId: target.windowId, mode: "control" })
          });
          if (!response.ok)
            throw new Error(
              `Select own window failed: ${response.status} ${JSON.stringify(await response.json())}`
            );
          return response.json();
        },
        { id: taskId, target }
      );
    };
    await selectOwnWindow();
    await page.locator("[data-computer-pause]").click();
    await expect(page.locator("[data-computer-label]")).toContainText("已暂停");
    await page.locator("[data-computer-bar-resume]").click();
    await expect(page.locator(".computer-control-bar")).toHaveAttribute("data-state", "active");
    await openWindowSettings();
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
    await expect(page.locator(".computer-control-bar")).toBeHidden();
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    await closeWindowSettings();
    await selectOwnWindow();
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const access = await (await fetch("/api/computer/access")).json();
          return { enabled: access.policy.enabled, paused: access.paused, owner: access.owner };
        })
      )
      .toEqual({ enabled: true, paused: false, owner: null });
    await expect(page.locator(".computer-control-bar")).toBeHidden();
    expect((await page.evaluate(() => window.bookmanDesktop.modelStatus())).configured).toBe(true);
    await openWindowSettings();
    await expect(windowAccess).toHaveText("关闭窗口访问");
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
    await closeWindowSettings();
    await expect(page.locator(".computer-control-bar")).toBeHidden();
  } else
    console.log(
      `Desktop smoke: native observation skipped (${computerStatus.reason || "screen permission or own visible window unavailable"})`
    );
  const resource = await page.evaluate(async () =>
    (await (await fetch("/api/workbench/tabs")).json()).tabs.find((tab) => tab.resourceId)
  );
  const conversationDraft = "退出并重新打开后保留的后续要求 😀";
  const draftAttachment = "这份未发送的附件需要在新的本机服务端口恢复。";
  await focusConversation(page, taskId);
  await page.locator("#composer-input").fill(conversationDraft);
  await page.locator("#file-input").setInputFiles({
    name: "未发送的说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(draftAttachment)
  });
  await expect(page.getByRole("button", { name: "移除 未发送的说明.txt", exact: true })).toBeVisible();
  await focusFile(page, resource.resourceId);
  await expect(page.locator("[data-editor-input]")).toHaveValue(content);
  content += "立即退出前的草稿\n";
  await page.locator("[data-editor-input]").fill(content);
  await quit();
  console.log("Desktop smoke: restart");
  page = await launch();
  await expect(page.locator("[data-editor-input]")).toHaveValue(content);
  await expect(page.getByRole("heading", { name: "连接模型" })).not.toBeVisible();
  await focusConversation(page, taskId);
  await expect(page.locator("#composer-input")).toHaveValue(conversationDraft);
  await expect(page.getByRole("button", { name: "移除 未发送的说明.txt", exact: true })).toBeVisible();
  const mirroredDrafts = JSON.parse(await readFile(join(data, "composer-drafts.json"), "utf8"));
  const restoredDraft = JSON.parse(mirroredDrafts.entries[`atria.composer.v1:${taskId}`]);
  expect(restoredDraft).toMatchObject({
    text: conversationDraft,
    attachments: [{ name: "未发送的说明.txt", kind: "text" }]
  });
  const restoredUpload = restoredDraft.attachments[0].uploadId;
  expect(restoredUpload).toMatch(/^upload-[a-f0-9-]{36}$/);
  expect(await page.evaluate(async (id) => (await fetch(`/api/uploads/${id}`)).text(), restoredUpload)).toBe(
    draftAttachment
  );
  // A real pending request is rendered by the packaged UI, then retained by
  // the native close handshake across a changed localhost origin.
  const humanTask = taskId;
  const humanDetail = await page.evaluate(
    async (taskId) => (await fetch(`/api/tasks/${taskId}`)).json(),
    humanTask
  );
  expect(humanDetail.workspaceRoot.startsWith(root)).toBe(true);
  expect(humanDetail.storageRoot.startsWith(root)).toBe(true);
  expect(humanDetail.task.activeRunId).toBeTruthy();
  const humanStore = new HumanRequestStore(humanDetail.storageRoot);
  const humanRequest = await humanStore.create({
    taskId: humanTask,
    runId: humanDetail.task.activeRunId,
    question: "请选择导出格式",
    options: ["Markdown", "PDF"],
    recommended: 0
  });
  await focusConversation(page, humanTask);
  const humanReply = "保留重启后的中文回复 😀 和显式选择";
  await page.getByRole("radio", { name: "PDF", exact: true }).check();
  await page.getByRole("textbox", { name: "其他回答或补充说明" }).fill(humanReply);
  await quit();
  page = await launch();
  await focusConversation(page, humanTask);
  await expect(page.getByRole("textbox", { name: "其他回答或补充说明" })).toHaveValue(humanReply);
  await expect(page.getByRole("radio", { name: "PDF", exact: true })).toBeChecked();
  const humanDraftPath = join(data, "composer-drafts.json");
  expect((await stat(humanDraftPath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(humanDraftPath, "utf8")).version).toBe(3);
  const humanSubmission = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/human/${humanRequest.requestId}/answer`) &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "提交并继续", exact: true }).click();
  const humanResponse = await humanSubmission;
  expect(humanResponse.ok()).toBe(true);
  expect((await humanResponse.json()).resume.status).toBe("running");
  await expect
    .poll(async () => (await humanStore.read(humanTask, humanRequest.requestId)).status)
    .toBe("answered");
  expect((await humanStore.read(humanTask, humanRequest.requestId)).answer).toBe(
    `PDF\n\n补充说明：${humanReply}`
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          async (taskId) => (await (await fetch(`/api/tasks/${taskId}`)).json()).task.status,
          humanTask
        ),
      { timeout: 40_000 }
    )
    .toBe("completed");
  await expect(page.locator("#human-questions")).toBeHidden();
  await expect
    .poll(
      async () =>
        Object.keys(JSON.parse(await readFile(humanDraftPath, "utf8")).entries).filter((key) =>
          key.startsWith("atria.human.v1:")
        ).length
    )
    .toBe(0);
  console.log(
    "Desktop human reply PASS: private draft and explicit choice restored after quit/new origin, accepted answer persisted and draft removed."
  );
  await focusFile(page, resource.resourceId);
  // Simulate a new installed release in a different directory, retaining only user data.
  await quit();
  const next = join(root, "next-release/CoworkOS.app");
  await cp(appPath, next, { recursive: true, verbatimSymlinks: true });
  const packagePath = join(next, "Contents/Resources/app/package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const [major, minor, patch] = originalVersion.split(/[+-]/, 1)[0].split(".").map(Number);
  pkg.version = `${major}.${minor}.${patch + 1}`;
  await writeFile(packagePath, JSON.stringify(pkg));
  const nextInfo = join(next, "Contents/Info.plist");
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"])
    await promisify(execFile)("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${pkg.version}`, nextInfo]);
  // Changing a sealed resource invalidates the original signature. Only this
  // disposable upgraded copy is recursively re-signed; the fixed candidate stays intact.
  await signAsync({
    app: next,
    identity: "-",
    identityValidation: false,
    platform: "darwin",
    type: "distribution",
    strictVerify: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      entitlements: resolve("desktop/entitlements.mac.plist"),
      hardenedRuntime: true
    })
  });
  await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", next]);
  console.log("Desktop smoke: upgraded/recovered launch");
  page = await launch(join(next, "Contents/MacOS/CoworkOS"));
  await expect(page.locator("[data-editor-input]")).toHaveValue(content);
  expect(JSON.parse(await readFile(join(data, "data-version.json"), "utf8"))).toMatchObject({
    createdWith: originalVersion,
    lastOpenedWith: pkg.version
  });
  // Quit while a real Pi model request is active; restart should expose a resumable task.
  hold = true;
  await focusConversation(page, taskId);
  await page.locator("#composer-input").fill("等待退出恢复验证");
  await page.locator("#send-button").click();
  await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const configError = await page.evaluate(async () => {
    try {
      await window.bookmanDesktop.saveModel({ baseUrl: "https://invalid.example", model: "other" });
      return "unexpected success";
    } catch (error) {
      return error.message;
    }
  });
  expect(configError).toContain("正在运行");
  await quit();
  for (const response of held) response.destroy();
  hold = false;
  console.log("Desktop smoke: upgraded/recovered launch");
  page = await launch(join(next, "Contents/MacOS/CoworkOS"));
  const restored = await page.evaluate(
    async (id) => (await (await fetch("/api/tasks")).json()).tasks.find((task) => task.taskId === id),
    taskId
  );
  expect(restored.status).toBe("waiting");
  await focusConversation(page, taskId);
  await page.locator("#composer-input").fill("继续已保存的任务");
  await page.locator("#send-button").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) =>
            (await (await fetch("/api/tasks")).json()).tasks.find((task) => task.taskId === id)?.status,
          taskId
        ),
      { timeout: 40_000 }
    )
    .toBe("completed");
  await focusFile(page, resource.resourceId);
  await expect(page.locator("[data-editor-input]")).toHaveValue(content);
  // Conversation rows expose the current status through their accessible description.
  await focusConversation(page, taskId);
  await expect(page.locator(`.conversation-item[data-task="${taskId}"]`)).toHaveAttribute(
    "aria-description",
    "已完成"
  );
  await focusFile(page, resource.resourceId);
  const proof = process.env.ATRIA_DESKTOP_PROOF;
  if (proof) await page.screenshot({ path: resolve(proof) });
  if (scope.pptist) {
    console.log("Desktop smoke: bundled PPT editing, save and restart after package relocation");
    await showNavigation(page);
    if (!(await page.locator('[data-create-app="pptist"]').isVisible()))
      await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page, projectDirectory);
    const ppt = () => page.locator("[data-app-mount]:not([hidden])");
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("桌面PPT验证");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const frame = () =>
      page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame().getByRole("button", { name: "文件操作", exact: true })).toBeVisible({
      timeout: 30000
    });
    await expect(ppt().locator("[data-pptist-loading]")).toBeHidden();
    const remark = "内置 PPT 编辑、保存与重启验证 😀";
    await frame().locator(".remark .ProseMirror").fill(remark);
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    const pptTab = await page.evaluate(async () =>
      (await (await fetch("/api/workbench/tabs")).json()).tabs.find(
        (tab) => tab.appType === "pptist" && tab.resourceId
      )
    );
    expect(pptTab).toBeTruthy();
    await expect
      .poll(() =>
        page.evaluate(
          async ({ accessTaskId, resourceId }) =>
            (await (await fetch(`/api/tasks/${accessTaskId}/resources/${resourceId}`)).json()).snapshot
              .content.slides[0].remark || "",
          pptTab
        )
      )
      .toContain(remark);
    await quit();
    page = await launch(join(next, "Contents/MacOS/CoworkOS"));
    await focusFile(page, pptTab.resourceId);
    await expect(ppt().locator("[data-pptist-loading]")).toBeHidden();
    await expect(frame().locator(".remark")).toContainText(remark, { timeout: 30000 });
    console.log("Desktop PPT PASS: bundled editor, persisted edits and relocated restart.");
    await focusConversation(page, taskId);
    await focusFile(page, resource.resourceId);
  } else console.log(`Desktop PPT SKIPPED: ${scope.mode} package does not bundle the PPT editor.`);
  // A second real application exercises the same native/Pi paths with structured data.
  await showNavigation(page);
  if (!(await page.locator('[data-create-app="cad"]').isVisible())) await page.locator("#apps-nav").click();
  await page.locator('[data-create-app="cad"]').click();
  await confirmApplicationWorkspace(page, projectDirectory);
  await page.locator("[data-cad-more] summary").click();
  await page.locator("[data-cad-new-basic]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("桌面CAD验证.cad.json");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator('[data-cad-add="box"]').click();
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await page.getByRole("spinbutton", { name: "宽度 X", exact: true }).fill("74");
  await page.locator("[data-cad-save]").click();
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
  const cadTab = await page.evaluate(async () =>
    (await (await fetch("/api/workbench/tabs")).json()).tabs.find((tab) => tab.appType === "cad")
  );
  await loadCurrentApplication(page, { taskId });
  await page.locator("#composer-input").fill("请读取CAD模型，再添加一个实体。");
  await page.locator("#send-button").click();
  await expect(page.getByText("CAD 模型验证成功", { exact: true }).first()).toBeVisible({ timeout: 40_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) =>
            (await (await fetch("/api/tasks")).json()).tasks.find((task) => task.taskId === id)?.status,
          taskId
        ),
      { timeout: 40_000 }
    )
    .toBe("completed");
  const cadRequests = requests.filter((request) =>
    request.tools?.some((tool) => tool.function.name === "cad_read_model")
  );
  expect(cadRequests.length).toBeGreaterThanOrEqual(3);
  expect(cadRequests[0].tools.some((tool) => tool.function.name === "read_document")).toBe(false);
  expect(JSON.stringify(cadRequests)).toContain("Agent 创建的实体");
  await focusFile(page, cadTab.resourceId);
  await expect(page.locator("[data-cad-save]")).toBeVisible();
  await expect(page.locator("[data-cad-count]")).toHaveText("2/64");
  await page.locator('[data-cad-view="fit"]').click();
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  const exportPath = join(root, "desktop-export.stl");
  // Electron owns native downloads; record its completion without touching Downloads.
  await native.evaluate(({ BrowserWindow }, savePath) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.cadDownload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native STL download timed out")), 30_000);
      window.webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(savePath);
        item.once("done", (_event, state) => {
          clearTimeout(timer);
          resolve({ state, name: item.getFilename() });
        });
      });
    });
  }, exportPath);
  await page.locator("[data-cad-file-menu]").click();
  await page.locator("[data-cad-stl]").click();
  const stl = await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].cadDownload);
  const bytes = await readFile(exportPath);
  expect(stl).toEqual({ state: "completed", name: "桌面CAD验证.stl" });
  expect(bytes.readUInt32LE(80)).toBeGreaterThan(0);
  expect(bytes.length).toBe(84 + bytes.readUInt32LE(80) * 50);
  const cadProof = process.env.ATRIA_CAD_PROOF;
  if (cadProof) await page.screenshot({ path: resolve(cadProof) });
  // The native close handshake must save a CAD draft, too.
  await page.getByRole("spinbutton", { name: "宽度 X", exact: true }).fill("77");
  await quit();
  page = await launch(join(next, "Contents/MacOS/CoworkOS"));
  await expect(page.getByRole("spinbutton", { name: "宽度 X", exact: true })).toHaveValue("77", {
    timeout: 30_000
  });
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  // Source CAD exercises the packaged QuickJS WASM worker and full modeling API.
  const sourceEditor = () => page.locator("[data-app-mount]:not([hidden])");
  await page.locator("[data-cad-code]").click();
  await expect(page.locator("[data-program-count]")).toHaveText("1");
  await page.locator("[data-program-source-toggle]").click();
  await page
    .getByRole("textbox", { name: "CAD 建模源码" })
    .fill(await readFile("test/fixtures/cad-rocket.jscad", "utf8"));
  await page.locator("[data-program-save]").click();
  await expect(page.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("[data-program-count]")).toHaveText("14");
  await openCadProperties(sourceEditor());
  await page.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true }).fill("23");
  await page.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true }).press("Tab");
  await page.locator("[data-program-save]").click();
  await expect(page.locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
  await focusConversation(page, taskId);
  await page.locator("#composer-input").fill("继续优化当前源码 CAD，保留人工参数。");
  await page.locator("#send-button").click();
  await expect(page.getByText("CAD 源码验证成功", { exact: true }).first()).toBeVisible({ timeout: 40_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) =>
            (await (await fetch("/api/tasks")).json()).tasks.find((task) => task.taskId === id)?.status,
          taskId
        ),
      { timeout: 40_000 }
    )
    .toBe("completed");
  await focusFile(page, cadTab.resourceId);
  await openCadProperties(sourceEditor());
  await expect(page.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true })).toHaveValue("23");
  const sourceExportPath = join(root, "desktop-source-export.jscad");
  await native.evaluate(({ BrowserWindow }, savePath) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.cadDownload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native source download timed out")), 30_000);
      window.webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(savePath);
        item.once("done", (_event, state) => {
          clearTimeout(timer);
          resolve(state);
        });
      });
    });
  }, sourceExportPath);
  await openCadExport(sourceEditor());
  await page.locator('[data-program-export="jscad"]').click();
  expect(await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].cadDownload)).toBe(
    "completed"
  );
  const exported = await readFile(sourceExportPath, "utf8");
  expect(exported).toContain("savedParameters");
  expect(exported).toContain("Desktop AI refinement");
  await page.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true }).fill("24");
  await page.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true }).press("Tab");
  await quit();
  page = await launch(join(next, "Contents/MacOS/CoworkOS"));
  await openCadProperties(sourceEditor());
  await expect(page.getByRole("spinbutton", { name: "箭体半径 (mm)", exact: true })).toHaveValue("24", {
    timeout: 30_000
  });
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await quit();
  if (scope.nativeComponents) {
    // Native CAD after relocation: no developer Python, uv, or runtime path is available.
    const nativeEditor = () => page.locator("[data-app-mount]:not([hidden])");
    page = await launch(join(next, "Contents/MacOS/CoworkOS"));
    await showNavigation(page);
    await page.locator("#new-conversation").click();
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="cad"]').click();
    await confirmApplicationWorkspace(page, projectDirectory);
    await page.locator("[data-cad-new]").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("桌面精确火箭.cad.json");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(nativeEditor().locator("[data-program-engine]")).toContainText("OpenCascade");
    await expect(nativeEditor().locator("[data-program-metrics]")).toHaveText("尚未生成模型", {
      timeout: 60000
    });
    await expect(nativeEditor().locator("[data-program-count]")).toHaveText("0");
    await nativeEditor().locator("[data-program-source-toggle]").click();
    await page
      .getByRole("textbox", { name: "CAD 建模源码" })
      .fill(await readFile("test/fixtures/cad-rocket.py", "utf8"));
    await nativeEditor().locator("[data-program-save]").click();
    await expect(nativeEditor().locator("[data-program-count]")).toHaveText("11", { timeout: 60000 });
    await page.getByRole("spinbutton", { name: "机身半径 (mm)", exact: true }).fill("26");
    await page.getByRole("spinbutton", { name: "机身半径 (mm)", exact: true }).press("ControlOrMeta+s");
    await expect(nativeEditor().locator("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await expect(nativeEditor().locator("[data-program-details]")).toContainText("BRep 已验证", {
      timeout: 60000
    });
    const nativeTabs = await page.evaluate(
      async () => (await (await fetch("/api/workbench/tabs")).json()).tabs
    );
    const nativeTab = nativeTabs.find((tab) => tab.title === "桌面精确火箭.cad.json");
    expect(nativeTab.accessTaskId).toBeTruthy();
    const nativeRead = await page.evaluate(
      async ({ id, task }) => {
        const response = await fetch(`/api/tasks/${task}/resources/${id}`);
        if (!response.ok) throw new Error(`Read native CAD fixture failed: ${response.status}`);
        return response.json();
      },
      { id: nativeTab.resourceId, task: nativeTab.accessTaskId }
    );
    expect(nativeRead.snapshot.content.engine).toBe("cadquery");
    expect(nativeRead.snapshot.content.parameters.radius).toBe(26);
    // The app's return action creates a conversation in its actual workspace;
    // a generic new conversation can belong to another temporary workspace.
    await loadCurrentApplication(page);
    await page.locator("#composer-input").fill("继续完善当前精确 CAD，保留人工半径。");
    await page.locator("#send-button").click();
    await expect(page.getByText("CAD 源码验证成功", { exact: true }).first()).toBeVisible({ timeout: 60000 });
    const nativeTaskId = await page
      .locator("#project-list .conversation-item.active")
      .getAttribute("data-task");
    expect(nativeTaskId).toBeTruthy();
    await expect
      .poll(
        () =>
          page.evaluate(
            async (id) =>
              (await (await fetch("/api/tasks")).json()).tasks.find((task) => task.taskId === id)?.status,
            nativeTaskId
          ),
        { timeout: 60000 }
      )
      .toBe("completed");
    await focusFile(page, nativeTab.resourceId);
    await expect(page.getByRole("spinbutton", { name: "机身半径 (mm)", exact: true })).toHaveValue("26");
    const stepPath = join(root, "desktop-native.step");
    await native.evaluate(({ BrowserWindow }, savePath) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.cadDownload = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native STEP download timed out")), 120000);
        window.webContents.session.once("will-download", (_event, item) => {
          item.setSavePath(savePath);
          item.once("done", (_event, state) => {
            clearTimeout(timer);
            resolve(state);
          });
        });
      });
    }, stepPath);
    await nativeEditor().locator("[data-program-file-menu]").click();
    await nativeEditor().locator('[data-program-export="step"]').click();
    expect(await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].cadDownload)).toBe(
      "completed"
    );
    expect((await readFile(stepPath, "utf8")).startsWith("ISO-10303-21;")).toBe(true);
    // Re-import with the relocated packaged runtime, independently of display meshes.
    const { execFileSync } = await import("node:child_process");
    const measured = JSON.parse(
      execFileSync(
        join(next, "Contents/Resources/cadquery/bin/python3"),
        [
          "-I",
          "-B",
          "-c",
          'import cadquery as cq,sys,json; s=cq.importers.importStep(sys.argv[1]).val(); print(json.dumps({"valid":s.isValid(),"solids":len(s.Solids())}))',
          stepPath
        ],
        { encoding: "utf8", timeout: 120000 }
      )
    );
    expect(measured).toEqual({ valid: true, solids: 11 });
    await quit();
    page = await launch(join(next, "Contents/MacOS/CoworkOS"));
    await expect(page.getByRole("spinbutton", { name: "机身半径 (mm)", exact: true })).toHaveValue("26", {
      timeout: 60000
    });
    await expect(nativeEditor().locator("[data-program-details]")).toContainText("BRep 已验证", {
      timeout: 60000
    });
    if (blenderRuntime.available) {
      console.log("Desktop smoke: native Blender workbench after package relocation");
      await showNavigation(page);
      await page.locator("#new-conversation").click();
      await page.locator("#apps-nav").click();
      await page.locator('[data-create-app="blender"]').click();
      await confirmApplicationWorkspace(page, projectDirectory);
      await page.locator("[data-blender-new]").click();
      await page.getByRole("textbox", { name: "文件名" }).fill("桌面 Blender 机器人");
      await page.getByRole("button", { name: "创建", exact: true }).click();
      await page.locator("[data-blender-source-toggle]").click();
      await page
        .locator("[data-blender-source]")
        .fill(await readFile("test/fixtures/blender-robot.py", "utf8"));
      await page.locator("[data-blender-run]").click();
      await expect(page.locator("[data-blender-count]")).toHaveText("12", { timeout: 60000 });
      await expect(page.locator("[data-blender-viewport]")).toHaveAttribute("data-ready", "true");
      await page.locator("[data-blender-select]").filter({ hasText: "ArmLeft" }).click();
      await page.getByRole("spinbutton", { name: "位置 X", exact: true }).fill("-3");
      await page.getByRole("spinbutton", { name: "位置 X", exact: true }).press("Tab");
      await page.locator("[data-blender-save]").click();
      await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 60000 });
      const blendPath = join(root, "desktop-native.blend");
      await native.evaluate(({ BrowserWindow }, savePath) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.blenderDownload = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Native Blender download timed out")), 60000);
          window.webContents.session.once("will-download", (_event, item) => {
            item.setSavePath(savePath);
            item.once("done", (_event, state) => {
              clearTimeout(timer);
              resolve(state);
            });
          });
        });
      }, blendPath);
      await page.locator("[data-blender-file-menu]").click();
      await page.locator('[data-blender-export="blend"]').click();
      expect(
        await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blenderDownload)
      ).toBe("completed");
      expect((await readFile(blendPath)).length).toBeGreaterThan(1000);
      await page.locator("[data-blender-file]").setInputFiles(blendPath);
      await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 60000 });
      await quit();
      page = await launch(join(next, "Contents/MacOS/CoworkOS"));
      await expect(page.locator("[data-blender-title]")).toHaveText("桌面 Blender 机器人", {
        timeout: 60000
      });
      await expect(page.locator("[data-blender-count]")).toHaveText("12");
      await page.locator("[data-blender-select]").filter({ hasText: "ArmLeft" }).click();
      await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue("-3");
      console.log(
        "Desktop Blender PASS: native Python, viewport, manual edits, binary download/import, restart after package relocation using bundled Blender runtime."
      );
    } else console.log("Desktop Blender native check SKIPPED: bundled Blender runtime unavailable.");
    await quit();
  } else {
    console.log(
      `Desktop native CAD SKIPPED: ${scope.mode} package does not bundle CadQuery; component download/install is covered by the component acceptance tests.`
    );
    console.log(
      `Desktop Blender native check SKIPPED: ${scope.mode} package does not bundle Blender; component download/install is covered by the component acceptance tests.`
    );
    for (const id of ["cadquery", "blender"]) {
      const files = await readdir(join(data, "components", id));
      expect(files, "host smoke does not download or install native components").toEqual(["current.json"]);
      expect(JSON.parse(await readFile(join(data, "components", id, "current.json"), "utf8"))).toEqual({
        enabled: false
      });
    }
  }
  const log = await readFile(join(data, "logs/dashboard.log"), "utf8");
  // All launches and their descendants remain under observation through TXT,
  // ordinary prompts, Computer Use, CAD, Blender and relocated restarts.
  expect(unexpectedApplications(), "no unexpected background application registrations").toEqual([]);
  console.log(
    "Desktop smoke known limitation: Keychain workers may briefly appear in Dock; registrations:",
    applicationMonitor.registrations.filter((app) => keychainPids.has(app.pid)).length
  );
  expect(log).not.toContain("desktop-fake-key");
  console.log(
    `Packaged Mac smoke PASS (${scope.mode}): model app icon, integrated native chrome, fresh configuration, authenticated API, real Pi + local model fixture, TXT/basic CAD/source CAD editing, isolated WASM, ${scope.pptist ? "bundled PPT editing/save/restart, " : ""}${scope.nativeComponents ? "bundled CadQuery/OpenCascade after relocation, STEP export/import, native Blender editing/export/import, " : ""}source export, real CAD tools, graceful quit, restart, upgrade, interrupted run resume. See explicit SKIPPED lines for native desktop branches. No system Node used.`
  );
} catch (error) {
  console.error("Packaged Mac smoke failed:", (error.stack || error.message).slice(0, 3500));
  if (error.code !== undefined || error.signal !== undefined || error.killed !== undefined)
    console.error("Smoke process failure:", {
      code: error.code,
      signal: error.signal,
      killed: error.killed
    });
  if (native) {
    const page = native.windows()[0];
    console.error(
      "Renderer state:",
      await page
        .evaluate(() => ({
          active: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
          cadStatus: document.querySelector("[data-cad-status]")?.textContent,
          computerState: document.querySelector("[data-computer-state]")?.textContent,
          computerError: document.querySelector("[data-computer-error]")?.textContent,
          mounts: [...document.querySelectorAll("[data-app-mount]")].map((element) => ({
            tab: element.dataset.appMount,
            hidden: element.hidden,
            text: element.textContent.slice(0, 600)
          }))
        }))
        .catch(() => "Renderer unavailable")
    );
    await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
  }
  console.error(
    (await readFile(join(data, "logs/dashboard.log"), "utf8").catch(() => "No backend log")).slice(-4000)
  );
  process.exitCode = 1;
} finally {
  for (const gate of reasoningGates) gate.release();
  if (native) await native.close().catch(() => {});
  await applicationMonitor?.stop().catch(() => {});
  for (const response of held) response.destroy();
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  if (process.env.ATRIA_KEEP_SMOKE_DATA) console.log("Smoke data:", root);
  else {
    // Native launches register relocated test apps even after their bundles are removed.
    await promisify(execFile)(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-u", join(root, "next-release/CoworkOS.app")]
    ).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
