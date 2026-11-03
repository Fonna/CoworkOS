import {
  newPresentation,
  presentationSave,
  presentationStatus,
  presentationCommand,
  openPresentationFileMenu
} from "./pptist-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("native PPTist survives app restart and supports slideshow/exports", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS native acceptance");
  test.setTimeout(180000);
  const root = await mkdtemp(join(tmpdir(), "atria-pptist-desktop-"));
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "ready" }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COWORK_")) delete env[k];
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  delete env.ELECTRON_RUN_AS_NODE;
  let native;
  const errors = [];
  // Optional acceptance path exercises the exact npm script, including build.
  const viaNpm = process.env.ATRIA_PPTIST_NPM_DESKTOP === "1";
  const npmLauncher = join(root, "npm-desktop.sh");
  if (viaNpm) await writeFile(npmLauncher, '#!/bin/sh\nexec npm run desktop -- "$@"\n', { mode: 0o700 });
  const executablePath = viaNpm ? npmLauncher : await developmentExecutable();
  const launch = async () => {
    native = await electron.launch({
      executablePath,
      args: viaNpm ? ["--use-mock-keychain"] : ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 60000
    });
    const page = await native.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  };
  try {
    let page = await launch();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="model"]').fill("protocol-fixture");
    await dialog.locator('[name="apiKey"]').fill("local-fixture");
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    const oldUrl = page.url();
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect.poll(() => page.url()).not.toBe(oldUrl);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("桌面持久化");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    let frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible();
    await expect(page.locator("[data-app-mount]:not([hidden]) [data-pptist-loading]")).toBeHidden();
    await frame.locator(".remark .ProseMirror").fill("退出后仍应保留的备注");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    const tabs = await (await page.request.get(new URL("/api/workbench/tabs", page.url()).href)).json();
    const tab = tabs.tabs.find((t) => t.resourceId);
    const read = await (
      await page.request.get(
        new URL(`/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`, page.url()).href
      )
    ).json();
    expect(read.snapshot.content.slides[0].remark).toContain("退出后仍应保留的备注");
    await page.screenshot({ path: testInfo.outputPath("pptist-desktop.png") });
    await native.close();
    native = null;
    page = await launch();
    frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.locator(".remark")).toContainText("退出后仍应保留的备注", { timeout: 30000 });
    await presentationCommand(page, "rename");
    await page.getByRole("textbox", { name: "文件名" }).fill("桌面重命名");
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await openPresentationFileMenu(page);
    await expect(frame.locator("[data-pptist-title]")).toHaveText("桌面重命名");
    await frame.getByRole("button", { name: "文件操作", exact: true }).click();
    await frame.getByRole("button", { name: "放映选项", exact: true }).click();
    await frame.getByRole("button", { name: "当前页放映", exact: true }).click();
    await expect(frame.locator(".pptist-screen")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = document.querySelector("[data-app-mount]:not([hidden]) iframe");
          return {
            parent: document.fullscreenElement?.tagName,
            child: frame?.contentDocument?.fullscreenElement?.tagName
          };
        })
      )
      .toEqual({ parent: undefined, child: undefined });
    await presentationCommand(page, "export");
    await expect(frame.getByRole("button", { name: "导出 PPTX", exact: true })).toBeVisible();
    const destination = join(root, "native-export.pptx");
    await native.evaluate(({ session }, path) => {
      session.defaultSession.once("will-download", (_event, item) => item.setSavePath(path));
    }, destination);
    await frame.getByRole("button", { name: "导出 PPTX", exact: true }).click();
    await expect
      .poll(
        async () =>
          readFile(destination).then(
            (b) => b.subarray(0, 2).toString(),
            () => ""
          ),
        { timeout: 15000 }
      )
      .toBe("PK");
    expect(errors).toEqual([]);
  } finally {
    await native?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
