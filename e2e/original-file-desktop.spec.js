import { presentationSave, presentationFrame, openPresentationFileMenu } from "./pptist-helper.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { defaultPart } from "../dist/src/software/cad/model.js";
import { quotedFontTablePptx } from "../test/fixtures/pptx-quoted-fonts.mjs";

test("native independent file selection opens original PPTX, Markdown and CAD files and saves there", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS native acceptance");
  test.setTimeout(180000);
  const root = await mkdtemp(join(tmpdir(), "atria-original-desktop-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:COWORK_|PI_|ATRIA_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|CEREBRAS_|OPENROUTER_|TOGETHER_|DEEPSEEK_|SERPER_)/.test(
          name
        ) &&
        !/_API_KEY$/.test(name) &&
        name !== "NODE_OPTIONS"
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: join(root, "profile"),
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = await developmentExecutable();
  let native;
  let restoreOriginal;
  const errors = [];
  const launch = async () => {
    native = await electron.launch({
      executablePath,
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 60000
    });
    const page = await native.firstWindow();
    await native.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("dialog", { name: "连接模型" }).locator("[data-model-close]").click();
    return page;
  };
  try {
    let page = await launch();
    const open = async (appType, path) => {
      await page.locator("#apps-nav").click();
      await page.locator(`[data-create-app="${appType}"]`).click();
      await expect(page.getByRole("dialog", { name: /^新建.*实例$/ })).toHaveCount(0);
      await expect(page.locator("[data-app-task-status]")).toContainText("临时工作区");
      await expect(page.locator("[data-local-open]:visible")).toHaveText("打开已有文件");
      await expect(page.locator("#conversation-pane")).toBeHidden();
      await page.locator("[data-local-file]").setInputFiles(path);
    };
    const pptPath = join(root, "客户方案.pptx");
    const initial = await quotedFontTablePptx({ legacy: true });
    await writeFile(pptPath, initial);
    await open("pptist", pptPath);
    let frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.locator(".canvas")).toContainText("Quoted font table");
    await expect(frame.locator(".canvas")).toContainText("Cell 5:3");
    await expect
      .poll(() => presentationSave(page).getAttribute("title"))
      .toContain(`保存到原文件：${await realpath(pptPath)}`);
    await presentationSave(page).click();
    await expect(presentationSave(page)).toHaveText("已保存");
    expect(await readFile(pptPath)).toEqual(initial);
    await frame.locator(".remark .ProseMirror").fill("真实原生桥接保存的备注");
    // Recovery drafts must never overwrite the selected original implicitly.
    await page.waitForTimeout(1500);
    expect(await readFile(pptPath)).toEqual(initial);
    await presentationSave(page).click();
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("已保存到原文件");
    const zip = await JSZip.loadAsync(await readFile(pptPath));
    expect(await zip.file("ppt/notesSlides/notesSlide1.xml").async("string")).toContain(
      "真实原生桥接保存的备注"
    );

    let title = frame.locator('.canvas .ProseMirror[contenteditable="true"]').first();
    await title.click();
    await title.press("End");
    await title.pressSequentially(" - saved body marker");
    await presentationSave(page).click();
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("已保存到原文件");
    const firstSaved = await readFile(pptPath);
    expect(await (await JSZip.loadAsync(firstSaved)).file("ppt/slides/slide1.xml").async("string")).toContain(
      "saved body marker"
    );
    await expect(frame.locator('[aria-label="撤销（Ctrl + Z）"]')).toBeEnabled();
    await frame.locator('[aria-label="撤销（Ctrl + Z）"]').click();
    await expect(title).not.toContainText("saved body marker");
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("草稿已保留");
    expect(await readFile(pptPath)).toEqual(firstSaved);
    await frame.locator('[aria-label="重做（Ctrl + Y）"]').click();
    await expect(title).toContainText("saved body marker");
    await presentationSave(page).click();
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("已保存到原文件");
    const afterRedo = await readFile(pptPath);

    // Opening another file from inside the editor must not append it to the
    // current presentation while retaining the previous original-file target.
    const secondPath = join(root, "另一份方案.pptx");
    const secondZip = await JSZip.loadAsync(await quotedFontTablePptx());
    const slideXml = await secondZip.file("ppt/slides/slide1.xml").async("string");
    secondZip.file("ppt/slides/slide1.xml", slideXml.replace("Quoted font table", "Second original file"));
    const secondInitial = await secondZip.generateAsync({ type: "nodebuffer" });
    await writeFile(secondPath, secondInitial);
    await openPresentationFileMenu(page);
    const chooser = page.waitForEvent("filechooser");
    await frame.getByRole("button", { name: "打开 PPTX…", exact: true }).click();
    await (await chooser).setFiles(secondPath);
    await expect(presentationSave(page)).toBeEnabled();
    await expect
      .poll(() => presentationSave(page).getAttribute("title"))
      .toContain(`保存到原文件：${await realpath(secondPath)}`);
    await expect(frame.locator(".thumbnail-item")).toHaveCount(1);
    await title.fill("第二份文稿修改保存 second body marker");
    await presentationSave(page).click();
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("已保存到原文件");
    expect(await readFile(pptPath)).toEqual(afterRedo);
    expect(
      await (await JSZip.loadAsync(await readFile(secondPath))).file("ppt/slides/slide1.xml").async("string")
    ).toContain("second body marker");
    await open("pptist", secondPath);
    await expect(frame.locator(".canvas")).toContainText("second body marker");
    const secondSaved = await readFile(secondPath);
    await title.fill("重启恢复的未手动保存正文");
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("草稿已保留");
    expect(await readFile(secondPath)).toEqual(secondSaved);
    await native.close();
    native = undefined;
    page = await launch();
    frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    title = frame.locator('.canvas .ProseMirror[contenteditable="true"]').first();
    await expect(title).toContainText("重启恢复的未手动保存正文", { timeout: 30000 });
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("草稿已保留");
    expect(await readFile(secondPath)).toEqual(secondSaved);
    await title.press("Meta+s");
    await expect(presentationFrame(page).locator("[data-pptist-status]")).toContainText("已保存到原文件");
    expect(
      await (await JSZip.loadAsync(await readFile(secondPath))).file("ppt/slides/slide1.xml").async("string")
    ).toContain("重启恢复的未手动保存正文");

    const textPath = join(root, "原文.md");
    await writeFile(textPath, "# 原文");
    await open("text-editor", textPath);
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("# 原文");
    await page.locator("[data-editor-input]:visible").fill("# 桌面修改原文");
    await page.locator("[data-editor-save]:visible").click();
    await expect(page.locator("[data-editor-status]:visible")).toContainText("已保存到原文件");
    expect(await readFile(textPath, "utf8")).toBe("# 桌面修改原文");

    const cadPath = join(root, "已有模型.cad.json");
    await writeFile(
      cadPath,
      JSON.stringify({ version: 1, units: "mm", parts: [defaultPart("box", "body")] })
    );
    await open("cad", cadPath);
    await expect(page.locator("[data-cad-save]:visible")).toHaveAttribute(
      "title",
      `保存到原文件：${await realpath(cadPath)}`
    );
    await page.getByRole("spinbutton", { name: "宽度 X", exact: true }).fill("68");
    await page.locator("[data-cad-save]:visible").click();
    await expect(page.locator("[data-cad-status]:visible")).toContainText("已保存到原文件");
    expect(JSON.parse(await readFile(cadPath, "utf8")).parts[0].size[0]).toBe(68);
    expect(await page.evaluate(async () => (await (await fetch("/api/tasks")).json()).tasks.length)).toBe(0);
    await native.close();
    native = undefined;
    page = await launch();
    await expect(page.getByRole("spinbutton", { name: "宽度 X", exact: true })).toHaveValue("68", {
      timeout: 30000
    });
    await expect(page.locator("[data-cad-save]:visible")).toHaveAttribute(
      "title",
      `保存到原文件：${await realpath(cadPath)}`
    );
    restoreOriginal = { path: cadPath, bytes: await readFile(cadPath) };
    await writeFile(cadPath, "外部改动必须保留");
    await page.locator("[data-cad-save]:visible").click();
    await expect(page.locator("[data-cad-status]:visible")).toContainText("原文件已被其他软件修改");
    expect(await readFile(cadPath, "utf8")).toBe("外部改动必须保留");
    await page.screenshot({ path: testInfo.outputPath("native-original-save.png") });
    expect(errors).toEqual([]);
  } finally {
    // These files and this profile are disposable. Never leave a native exit prompt
    // on the developer's desktop, including when a test fails with a pending draft.
    if (restoreOriginal) await writeFile(restoreOriginal.path, restoreOriginal.bytes);
    await native?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await native?.close();
    await rm(root, { recursive: true, force: true });
  }
});
