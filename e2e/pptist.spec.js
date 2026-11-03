import {
  newPresentation,
  presentationSave,
  presentationStatus,
  presentationCommand,
  openPresentationFileMenu,
  openPresentationSlideImport,
  openPresentationInsertMenu,
  insertPresentationElement
} from "./pptist-helper.js";
import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("PPTist standalone editor creates, edits, saves and reopens a presentation", async ({
  page
}, testInfo) => {
  test.setTimeout(90000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await expect(page.locator('[data-create-app="pptist"]')).toContainText("PPT 演示文稿");
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("内测发布说明");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible({
      timeout: 30000
    });
    await expect
      .poll(() => frame.locator("body").evaluate(() => document.title))
      .toBe("CoworkOS PPT 演示文稿");
    await expect(frame.locator("body")).not.toContainText(/pptist/i);
    await openPresentationFileMenu(page);
    await expect(frame.getByRole("link", { name: "开源许可", exact: true })).toHaveAttribute(
      "href",
      "./source.tar.gz"
    );
    await frame.getByRole("button", { name: "文件操作", exact: true }).click();
    await expect(page.locator("[data-pptist-bind]")).toHaveCount(0);
    await expect(presentationStatus(page)).toContainText("已保存");
    await page.screenshot({ path: testInfo.outputPath("pptist-empty.png") });
    // Real pointer drawing and ProseMirror editing, with automatic persistence.
    await insertPresentationElement(page, "文字");
    const canvas = await frame.locator(".viewport-wrapper").boundingBox();
    await page.mouse.move(canvas.x + 60, canvas.y + 60);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 450, canvas.y + 130, { steps: 10 });
    await page.mouse.up();
    const text = frame.locator('.canvas .ProseMirror[contenteditable="true"]');
    await expect(text).toBeVisible();
    await text.fill("CoworkOS 内测发布");
    await text.press("ControlOrMeta+a");
    await text.press("ControlOrMeta+b");
    await text.press("ArrowRight");
    await frame.locator(".remark .ProseMirror").fill("演讲备注：三个工作日一个版本。");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const tab = tabs.tabs.find((t) => t.resourceId);
    await frame.getByText("添加幻灯片", { exact: true }).click();
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    await insertPresentationElement(page, "图表");
    await frame.locator(".chart-content").nth(1).click();
    await expect(frame.locator(".canvas .editable-element-chart")).toHaveCount(1);
    await insertPresentationElement(page, "表格");
    await frame.locator(".table-generator tr").nth(1).locator("td").nth(2).hover();
    await frame.locator(".table-generator tr").nth(1).locator("td").nth(2).click();
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    await page.screenshot({ path: testInfo.outputPath("pptist-edited.png") });
    await page.reload();
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    await frame.locator(".thumbnail-item").first().click();
    await expect(frame.locator(".canvas")).toContainText("CoworkOS 内测发布");
    await expect(frame.locator(".remark")).toContainText("三个工作日");
    await frame.getByRole("button", { name: "从头放映", exact: true }).click();
    await expect(frame.locator(".pptist-screen")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible();
    await presentationCommand(page, "export");
    await expect(frame.locator("body")).not.toContainText(/pptist/i);
    const pptxDownload = page.waitForEvent("download");
    await frame.getByRole("button", { name: "导出 PPTX", exact: true }).click();
    const pptxFile = await pptxDownload;
    const zip = await JSZip.loadAsync(await readFile(await pptxFile.path()));
    expect(await zip.file("docProps/core.xml").async("string")).toContain(
      "<dc:creator>CoworkOS</dc:creator>"
    );
    expect(await zip.file("ppt/slides/slide1.xml").async("string")).toContain("CoworkOS 内测发布");
    expect(zip.file("ppt/slides/slide2.xml")).not.toBeNull();
    await frame.getByText("导出 JSON", { exact: true }).first().click();
    const jsonDownload = page.waitForEvent("download");
    await frame.getByRole("button", { name: "导出 JSON", exact: true }).click();
    const json = JSON.parse(await readFile(await (await jsonDownload).path(), "utf8"));
    expect(json.slides).toHaveLength(2);
    expect(json.slides[1].elements.map((e) => e.type)).toEqual(["chart", "table"]);
    await frame.getByRole("button", { name: "关闭", exact: true }).click();
    // Re-import the real downloaded PowerPoint into a separate resource.
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("PPTX 往返");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(frame.locator(".thumbnail-item")).toHaveCount(1);
    await openPresentationSlideImport(page);
    await frame.locator('input[accept=".pptx"]').setInputFiles({
      name: "roundtrip.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: await readFile(await pptxFile.path())
    });
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    await expect(frame.locator(".canvas")).toContainText("CoworkOS 内测发布");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    await loadCurrentApplication(page, { newConversation: true });
    await expect(page.locator("#app-bind-select")).toContainText("PPTX 往返");
    await page.locator("[data-composer-context]").click();
    await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(frame.locator(".canvas")).toContainText("CoworkOS 内测发布");
    await expect(page.locator("#app-bind-select")).toContainText("PPTX 往返");
    await page.screenshot({ path: testInfo.outputPath("pptist-bound-split.png") });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("PPTist media, shapes, line, imports, image/PPTIST exports and recovery", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const dashboard = await startDashboard(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("媒体验证");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible();
    const importFile = async (accept, file) => {
      await openPresentationSlideImport(page);
      await frame.locator(`input[type="file"][accept="${accept}"]`).setInputFiles(file);
    };
    const seed = {
      title: "导入",
      width: 1000,
      height: 562.5,
      slides: [
        {
          id: "imported",
          elements: [
            {
              id: "heading",
              type: "text",
              left: 50,
              top: 40,
              width: 900,
              height: 80,
              rotate: 0,
              content: '<p style="font-size:40px">导入的演示文稿</p>',
              defaultFontName: "Arial",
              defaultColor: "#222222"
            }
          ]
        }
      ]
    };
    await importFile(".json", {
      name: "source.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(seed))
    });
    await expect(frame.locator(".canvas")).toContainText("导入的演示文稿");
    // Draw a shape and a line using the actual editor tools.
    const draw = async (x1, y1, x2, y2) => {
      const b = await frame.locator(".viewport-wrapper").boundingBox();
      await page.mouse.move(b.x + x1, b.y + y1);
      await page.mouse.down();
      await page.mouse.move(b.x + x2, b.y + y2, { steps: 8 });
      await page.mouse.up();
    };
    await insertPresentationElement(page, "形状");
    await frame.locator(".shape-pool .shape-item").first().click();
    await draw(60, 160, 240, 260);
    await expect(frame.locator(".canvas .editable-element-shape")).toHaveCount(1);
    await insertPresentationElement(page, "线条");
    await frame.locator(".line-pool .line-content").first().click();
    await draw(60, 280, 240, 300);
    await expect(frame.locator(".canvas .editable-element-shape")).toHaveCount(2);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64"
    );
    await openPresentationInsertMenu(page);
    await frame
      .locator('input[accept="image/*"]')
      .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
    await expect(frame.locator(".canvas .editable-element-image")).toHaveCount(1);
    await insertPresentationElement(page, "音视频");
    await frame.getByText("音频", { exact: true }).click();
    const wav = Buffer.alloc(48);
    wav.write("RIFF");
    wav.writeUInt32LE(40, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(4, 40);
    await frame
      .locator('input[accept="audio/*"]')
      .setInputFiles({ name: "sound.wav", mimeType: "audio/wav", buffer: wav });
    await expect(frame.locator(".canvas .editable-element-audio")).toHaveCount(1);
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const tab = tabs.tabs.find((t) => t.resourceId);
    const path = `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`;
    const read = () => page.request.get(path).then((r) => r.json());
    const saved = await read();
    expect(saved.snapshot.content.slides[0].elements.map((e) => e.type)).toEqual([
      "text",
      "shape",
      "line",
      "image",
      "audio"
    ]);
    expect(saved.snapshot.content.slides[0].elements.at(-1).src).toMatch(/^data:audio\/wav;base64,/);
    await page.reload();
    await expect(frame.locator(".canvas .editable-element-audio")).toHaveCount(1);
    await presentationCommand(page, "export");
    await frame.getByText("导出源文件", { exact: true }).click();
    const nativeDownload = page.waitForEvent("download");
    await frame.getByRole("button", { name: "导出源文件", exact: true }).click();
    const nativePath = await (await nativeDownload).path();
    await frame.getByText("导出图片", { exact: true }).first().click();
    await frame.getByText("PNG", { exact: true }).click();
    await frame.getByText("当前页", { exact: true }).click();
    const imageDownload = page.waitForEvent("download");
    await frame.getByRole("button", { name: "导出图片", exact: true }).click();
    const imageFile = await (await imageDownload).path();
    expect((await readFile(imageFile)).subarray(1, 4).toString()).toBe("PNG");
    await frame.getByRole("button", { name: "关闭", exact: true }).click();
    await importFile(".pptist", {
      name: "roundtrip.pptist",
      mimeType: "application/octet-stream",
      buffer: await readFile(nativePath)
    });
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    // Malformed import cannot replace a valid deck or crash the renderer.
    await importFile(".json", {
      name: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"slides":[{}]}')
    });
    await expect(frame.getByText("无法正确读取 / 解析该文件")).toBeVisible();
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    // The real save endpoint fails, then retry recovers the retained draft.
    await page.route("**/resources/*/operations", (route) => route.abort());
    await frame.locator(".remark .ProseMirror").fill("断网草稿");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "error");
    await expect(page.locator("[data-app-mount]:not([hidden]) [data-pptist-backup]")).toBeVisible();
    await expect(frame.locator("body")).toHaveJSProperty("inert", false);
    await expect(frame.locator(".layout-content")).toHaveJSProperty("inert", true);
    await presentationSave(page).focus();
    const recoveryFile = frame.getByRole("button", { name: "文件操作", exact: true });
    for (let step = 0; step < 16; step++) {
      if (await recoveryFile.evaluate((button) => button === button.ownerDocument.activeElement)) break;
      await page.keyboard.press("Shift+Tab");
    }
    await expect(recoveryFile).toBeFocused();
    await recoveryFile.press("Enter");
    await expect(frame.locator('[data-pptist-command="new"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(recoveryFile).toBeFocused();
    await page.unroute("**/resources/*/operations");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    // A second writer wins CAS; local draft remains recoverable instead of overwriting it.
    const current = await read();
    await page.route("**/resources/*/operations", (route) => route.abort());
    await frame.locator(".remark .ProseMirror").fill("冲突时保留我的草稿");
    const response = await page.request.post(`${path}/operations`, {
      data: {
        operationId: "remote-change",
        appType: "pptist",
        operationType: "pptist.edit",
        baseRevision: current.resource.revision,
        payload: {
          changes: [
            {
              type: "update_slide",
              slideId: current.snapshot.content.slides[1].id,
              props: { remark: "另一端的修改" }
            }
          ]
        }
      }
    });
    expect(response.ok()).toBeTruthy();
    await page.unroute("**/resources/*/operations");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toContainText("版本冲突");
    const backupDownload = page.waitForEvent("download");
    await page.locator("[data-app-mount]:not([hidden]) [data-pptist-backup]").click();
    expect(await readFile(await (await backupDownload).path(), "utf8")).toContain("冲突时保留我的草稿");
    await page.locator("[data-app-mount]:not([hidden]) [data-pptist-reload]").click();
    await expect(frame.locator(".remark")).toContainText("另一端的修改");
    await page.setViewportSize({ width: 900, height: 800 });
    await page.screenshot({ path: testInfo.outputPath("pptist-narrow.png") });
    expect(requests.some((u) => /server\.pptist\.cn|fonts\.googleapis\.com/.test(u))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("PPTist page management, themes, presentation windows and PDF print content", async ({
  page
}, testInfo) => {
  test.setTimeout(90000);
  const dashboard = await startDashboard(),
    errors = [],
    printed = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("recordPptistPrint", (data) => printed.push(data));
  await page.addInitScript(() => {
    // document.open() clears listeners injected into an about:blank print frame.
    // Observe its load before the application calls the real window.print().
    const createElement = document.createElement.bind(document);
    document.createElement = (...args) => {
      const element = createElement(...args);
      if (args[0].toLowerCase() === "iframe") {
        element.addEventListener("load", () => {
          const target = element.contentWindow;
          target?.addEventListener("beforeprint", () => {
            const slides = target.document.querySelectorAll("body > .thumbnail").length;
            if (slides) window.recordPptistPrint({ text: target.document.body.innerText, slides });
          });
        });
      }
      return element;
    };
  });
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("演示与打印");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(page.locator("[data-app-mount]:not([hidden]) [data-pptist-loading]")).toBeHidden();
    const slides = ["第一部分", "第二部分"].map((text, i) => ({
      id: `page${i}`,
      elements: [
        {
          id: "title",
          type: "text",
          left: 60,
          top: 60,
          width: 880,
          height: 100,
          rotate: 0,
          content: `<p style="font-size:44px">${text}</p>`,
          defaultFontName: "Arial",
          defaultColor: "#222222"
        }
      ],
      remark: `${text}的演讲备注`
    }));
    await openPresentationSlideImport(page);
    await frame.locator('input[accept=".json"]').setInputFiles({
      name: "pages.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ width: 1000, height: 562.5, slides }))
    });
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    await frame.locator(".thumbnail-item").first().click({ button: "right" });
    await frame.getByText("复制页面", { exact: true }).click();
    await expect(frame.locator(".thumbnail-item")).toHaveCount(3);
    await frame.locator(".thumbnail-item").nth(1).click({ button: "right" });
    await frame.getByText("删除页面", { exact: true }).click();
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    await frame.getByText("设计", { exact: true }).click();
    await frame.getByRole("button", { name: "设置并应用", exact: true }).nth(1).click();
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    await frame.getByRole("button", { name: "从头放映", exact: true }).click();
    await expect(frame.locator(".pptist-screen")).toBeVisible();
    const screenBox = await frame.locator(".pptist-screen").boundingBox();
    await page.mouse.move(screenBox.x + screenBox.width - 20, screenBox.y + screenBox.height - 20);
    await frame.locator('[aria-label="演讲者视图"]').click();
    await expect(frame.locator(".presenter-view")).toContainText("演讲备注");
    const popupEvent = page.waitForEvent("popup");
    await frame.getByText("观众视图", { exact: true }).click();
    const audience = await popupEvent;
    audience.on("pageerror", (e) => errors.push(e.message));
    await expect(audience.locator(".audience-view")).toContainText("第一部分");
    await audience.close();
    await frame.locator(".presenter-view").click({ position: { x: 10, y: 100 } });
    await page.keyboard.press("Escape");
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible();
    await presentationCommand(page, "export");
    await frame.getByText("打印 / 导出 PDF", { exact: true }).first().click();
    await frame.getByRole("button", { name: "打印 / 导出 PDF", exact: true }).click();
    await expect.poll(() => printed.length).toBeGreaterThan(0);
    expect(printed.at(-1).text).toContain("第一部分");
    expect(printed.at(-1).text).toContain("第二部分");
    expect(printed.at(-1).slides).toBe(2);
    await frame.getByRole("button", { name: "关闭", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("pptist-themed.png") });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});
