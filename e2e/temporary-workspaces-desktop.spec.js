import { openSaveCopy } from "./application-file-helper.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";

test("native independent file drops save to the original and restore edits across app restart", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS native acceptance");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "atria-temporary-desktop-"));
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
  const launch = async () => {
    native = await electron.launch({ executablePath, args: ["--use-mock-keychain", resolve(".")], env });
    const page = await native.firstWindow();
    await native.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    });
    await page.getByRole("dialog", { name: "连接模型" }).locator("[data-model-close]").click();
    return page;
  };
  try {
    let page = await launch();
    const original = join(root, "original.md");
    await writeFile(original, "# Original\n");
    const dropOriginal = async (empty = false) => {
      if (empty) {
        await page.locator("#apps-nav").click();
        await page.locator('[data-create-app="text-editor"]').click();
        await expect(page.getByRole("dialog", { name: /^新建.*实例$/ })).toHaveCount(0);
        await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
      }
      // Use a real OS-backed File so Electron resolves its actual path. The
      // drop event is synthetic; no pathForFile stub or invented path is used.
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.type = "file";
        input.hidden = true;
        input.dataset.nativeDropFile = "";
        document.body.append(input);
      });
      const picker = page.locator("[data-native-drop-file]");
      await picker.setInputFiles(original);
      expect(await picker.evaluate((input) => window.bookmanDesktop.pathForFile(input.files[0]))).toBe(
        original
      );
      await picker.evaluate((input) => {
        const transfer = new DataTransfer();
        transfer.items.add(input.files[0]);
        document
          .querySelector(".workbench-app:not([hidden]) .text-editor")
          .dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
        input.remove();
      });
    };
    await dropOriginal(true);
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("# Original\n");
    await expect(page.locator("[data-editor-save]:visible")).toHaveAttribute(
      "title",
      `保存到原文件：${await realpath(original)}`
    );
    expect(await readFile(original, "utf8")).toBe("# Original\n");
    await page.locator("[data-editor-input]:visible").fill("# Managed edit\n");
    await page.locator("[data-editor-save]:visible").click();
    await expect(page.locator("[data-editor-status]:visible")).toContainText("已保存到原文件");
    expect(await readFile(original, "utf8")).toBe("# Managed edit\n");
    const request = async (path) => (await page.request.get(new URL(path, page.url()).href)).json();
    const tab = (await request("/api/workbench/tabs")).tabs.find((entry) => entry.resourceId);
    expect(tab.accessTaskId).toMatch(/^temporary-/);
    await expect
      .poll(
        async () =>
          (await request(`/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`)).snapshot.content
      )
      .toBe("# Managed edit\n");
    await native.close();
    native = undefined;
    page = await launch();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("# Managed edit\n");
    expect(await readFile(original, "utf8")).toBe("# Managed edit\n");
    expect((await request("/api/tasks")).projects).toEqual([]);
    const directory = join(root, "export");
    await mkdir(directory);
    await openSaveCopy(page);
    await page.locator("[data-save-directory]").fill(directory);
    await page.locator("[data-save-format]").selectOption("markdown");
    await page.getByRole("dialog", { name: "保存到目录或项目" }).locator('[type="submit"]').click();
    await expect(page.getByRole("dialog", { name: "保存到目录或项目" })).toHaveCount(0);
    expect(await readFile(join(directory, "original.md"), "utf8")).toBe("# Managed edit\n");
    expect(await readFile(original, "utf8")).toBe("# Managed edit\n");
    await dropOriginal();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("# Managed edit\n");
    await page.locator("[data-editor-input]:visible").fill("# Saved after reopening\n");
    await page.locator("[data-editor-input]:visible").press("Meta+s");
    await expect.poll(() => readFile(original, "utf8")).toBe("# Saved after reopening\n");
    await page.screenshot({ path: testInfo.outputPath("temporary-desktop.png") });
  } finally {
    await native?.close();
    await rm(root, { recursive: true, force: true });
  }
});
