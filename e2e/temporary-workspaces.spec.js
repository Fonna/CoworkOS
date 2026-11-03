import { useApplicationInConversation } from "./workbench-menu-helper.js";
import { openSaveCopy } from "./application-file-helper.js";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

async function dropFile(page, selector, name, text, type = "text/plain") {
  // Browser-generated DataTransfer exercises routing/import; this is not native OS file drag.
  await page.locator(selector).evaluate(
    (target, { name, text, type }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([text], name, { type }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
    },
    { name, text, type }
  );
}

test("an independent editor imports copies immediately, isolates tabs, restores after restart and retains closed documents for reopening", async ({
  page
}) => {
  const d = await startDashboard({ defaultProject: false });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const directory = join(d.root, "chosen-export");
    await mkdir(directory);
    const original = join(d.root, "original.txt");
    await writeFile(original, "Original content\n");
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await expect(page.getByRole("dialog", { name: /^新建.*实例$/ })).toHaveCount(0);
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await page.locator("[data-local-file]").setInputFiles(original);
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("Original content\n");
    await expect(page.locator("[data-app-task-status]")).toContainText("临时工作区");
    await expect(page.locator("#attachment-strip")).toBeEmpty();
    // The existing original has exactly the imported bytes. Similarity never
    // gives the managed copy ownership of that user's file.
    const saveOverOriginal = async () => {
      await openSaveCopy(page);
      await page.locator("[data-save-directory]").fill(d.root);
      await page.locator("[data-save-format]").selectOption("text");
      await page.getByRole("dialog", { name: "保存到目录或项目" }).locator('[type="submit"]').click();
      await expect(page.locator("[data-save-error]")).toContainText("目标文件已存在，未覆盖");
      expect(await readFile(original, "utf8")).toBe("Original content\n");
      await page.locator("[data-save-cancel]").click();
    };
    await saveOverOriginal();
    await page.locator("[data-editor-input]:visible").fill("Edited managed copy\n");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(d.base + "/api/workbench/temporary-resources")).json()).resources[0]
            ?.revision
      )
      .toBe(1);
    await saveOverOriginal();
    await dropFile(page, ".workbench-app:not([hidden])", "unsupported.pdf", "%PDF-test", "application/pdf");
    await expect(page.locator(".workbench-app:not([hidden]) [role=alert]")).toContainText("导入失败");
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("Edited managed copy\n");
    await expect(page.locator("#attachment-strip")).toBeEmpty();
    await openSaveCopy(page);
    await page.locator("[data-save-cancel]").click();
    expect(await readdir(directory)).toEqual([]);
    await openSaveCopy(page);
    await page.locator("[data-save-directory]").fill(directory);
    await page.locator("[data-save-format]").selectOption("text");
    await page.getByRole("dialog", { name: "保存到目录或项目" }).locator('[type="submit"]').click();
    await expect(page.getByRole("dialog", { name: "保存到目录或项目" })).toHaveCount(0);
    expect(await readFile(join(directory, "original.txt"), "utf8")).toBe("Edited managed copy\n");
    expect(await readFile(original, "utf8")).toBe("Original content\n");
    await openSaveCopy(page);
    await page.locator("[data-save-directory]").fill(directory);
    await page.locator("[data-save-format]").selectOption("text");
    await page.getByRole("dialog", { name: "保存到目录或项目" }).locator('[type="submit"]').click();
    await expect(page.getByRole("dialog", { name: "保存到目录或项目" })).toHaveCount(0);
    expect(await readdir(directory)).toEqual(["original.txt"]);
    await dropFile(page, ".workbench-app:not([hidden])", "second.md", "# Second\n", "text/markdown");
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("# Second\n");
    const retained = (await (await page.request.get(d.base + "/api/workbench/temporary-resources")).json())
      .resources;
    expect(retained).toHaveLength(2);
    expect(retained.every((resource) => resource.project === null)).toBe(true);
    const first = retained.find((resource) => resource.title === "original.txt");
    const firstTab = (await (await page.request.get(d.base + "/api/workbench/tabs")).json()).tabs.find(
      (tab) => tab.resourceId === first.resourceId
    );
    await page.locator(`[data-tab-rail] [data-tab="${firstTab.tabId}"]`).click();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("Edited managed copy\n");
    await d.restart({ newPort: true });
    await page.goto(d.base);
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("Edited managed copy\n");
    await page.locator(`[data-tab-rail] [data-close-tab="${firstTab.tabId}"]`).click();
    await page.keyboard.press("Escape");
    await page.locator("#apps-nav").click();
    await page.locator(`[data-open-resource="${first.resourceId}"]`).click();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("Edited managed copy\n");
    expect((await (await page.request.get(d.base + "/api/tasks")).json()).projects).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await d.stop();
  }
});

test("joining a project starts real collaboration in that project and restores the edited temporary resource", async ({
  page
}) => {
  test.setTimeout(90_000);
  let step = 0;
  const failures = [];
  const model = await modelProtocolFixture("openai-completions", (request) => {
    try {
      if (step++ === 0) return { name: "read_document", arguments: {} };
      const result = JSON.parse(request.messages.findLast((message) => message.role === "tool").content);
      expect(result.ok).not.toBe(false);
      if (step === 2) {
        expect(result.result.content).toBe("Project original\n");
        return { name: "write_document", arguments: { content: "Edited through chosen project\n" } };
      }
      if (step === 3) return { name: "read_document", arguments: {} };
      expect(result.result.content).toBe("Edited through chosen project\n");
      return { text: "Verified the project document." };
    } catch (error) {
      failures.push(error.message);
      return { text: "Fixture assertion failed." };
    }
  });
  const d = await startDashboard({
    defaultProject: false,
    modelEndpoint: model.baseUrl,
    model: "protocol-fixture"
  });
  const get = async (path) => await (await page.request.get(d.base + path)).json();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    // APIs only create fixture project data; every save/bind/run action below
    // goes through the same visible controls used by a person.
    const chosenDirectory = join(d.root, "chosen-project");
    await mkdir(chosenDirectory);
    const response = await page.request.post(d.base + "/api/projects", {
      data: { projectName: "Chosen project", projectDirectory: chosenDirectory }
    });
    expect(response.status()).toBe(201);
    const { project } = await response.json();
    const original = join(d.root, "project-original.txt");
    await writeFile(original, "Project original\n");
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await page.locator("[data-local-file]").setInputFiles(original);
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("Project original\n");
    const initialTab = (await get("/api/workbench/tabs")).tabs.find((tab) => tab.resourceId);
    expect(initialTab.project).toBeNull();
    expect(initialTab.workspaceRoot).not.toBe(project.projectDirectory);
    await openSaveCopy(page);
    await page.locator("[data-save-project]").selectOption(project.projectId);
    await page.locator("[data-save-format]").selectOption("text");
    await page.getByRole("dialog", { name: "保存到目录或项目" }).locator('[type="submit"]').click();
    await expect(page.getByRole("dialog", { name: "保存到目录或项目" })).toHaveCount(0);
    expect(await readFile(join(chosenDirectory, "project-original.txt"), "utf8")).toBe("Project original\n");
    await useApplicationInConversation(page);
    await expect.poll(async () => (await get("/api/tasks")).tasks.length).toBe(1);
    const listing = await get("/api/tasks");
    expect(listing.projects.map((entry) => entry.projectId)).toEqual([project.projectId]);
    const task = listing.tasks[0];
    expect(task.projectId).toBe(project.projectId);
    expect(task.projectDirectory).toBe(project.projectDirectory);
    await expect(page.locator("#app-bind-select")).toHaveClass(/is-bound/);
    await expect(page.locator("#project-context")).toHaveAttribute("title", project.projectDirectory);
    const context = (await get(`/api/tasks/${task.taskId}/active-app-context`)).context;
    expect(context.resource.resourceId).toBe(initialTab.resourceId);
    await page.locator("#composer-input").fill("Read the document, edit it and verify the result.");
    await page.locator("#send-button").click();
    await expect
      .poll(async () => (await get("/api/tasks")).tasks[0]?.status, { timeout: 30_000 })
      .toBe("completed");
    expect(failures).toEqual([]);
    expect(step).toBe(4);
    const edited = await get(`/api/tasks/${task.taskId}/resources/${initialTab.resourceId}`);
    expect(edited.snapshot.content).toBe("Edited through chosen project\n");
    expect(await readFile(original, "utf8")).toBe("Project original\n");
    await d.restart({ newPort: true });
    await page.goto(d.base);
    await page.locator(`#project-list button[data-task="${task.taskId}"]`).click();
    await expect(page.locator("#app-bind-select")).toHaveClass(/is-bound/);
    await expect(page.locator("#project-context")).toHaveAttribute("title", project.projectDirectory);
    const restored = (await get(`/api/tasks/${task.taskId}/active-app-context`)).context;
    expect(restored.resource.resourceId).toBe(initialTab.resourceId);
    expect(restored.resource.project.projectId).toBe(project.projectId);
    const restoredTab = (await get("/api/workbench/tabs")).tabs.find(
      (tab) => tab.resourceId === initialTab.resourceId
    );
    expect(restoredTab.workspaceRoot).toBe(initialTab.workspaceRoot);
    expect(restoredTab.project.projectId).toBe(project.projectId);
    expect((await get("/api/tasks")).projects.map((entry) => entry.projectId)).toEqual([project.projectId]);
    await page.locator("#apps-nav").click();
    await page.locator(`#apps-panel button[data-open-resource="${initialTab.resourceId}"]`).click();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("Edited through chosen project\n");
    expect(await readFile(original, "utf8")).toBe("Project original\n");
    expect(errors).toEqual([]);
  } finally {
    await d.stop();
    await model.close();
  }
});

test("composer drop without a project creates a real temporary Main run and restores its attachment and draft ownership", async ({
  page
}) => {
  const model = await modelProtocolFixture("openai-completions");
  const d = await startDashboard({
    modelEndpoint: model.baseUrl,
    model: "protocol-fixture",
    defaultProject: false
  });
  try {
    await page.goto(d.base);
    await dropFile(page, ".composer", "input.txt", "Retained attachment\n");
    await expect(page.locator("#attachment-strip")).toContainText("input.txt");
    await expect(
      page.getByText("请将文件拖入对话输入区或应用编辑区；当前内容已保留。", { exact: true })
    ).toHaveCount(0);
    await page.locator("#composer-input").fill("Process the attached file");
    await page.locator("#send-button").click();
    await expect(page.locator("#project-modal")).toHaveCount(0);
    await expect
      .poll(async () => (await (await page.request.get(d.base + "/api/tasks")).json()).tasks[0]?.status, {
        timeout: 30_000
      })
      .toBe("completed");
    expect(model.requests.length).toBeGreaterThan(0);
    const listing = await (await page.request.get(d.base + "/api/tasks")).json();
    expect(listing.projects).toEqual([]);
    expect(listing.tasks).toHaveLength(1);
    const task = listing.tasks[0];
    expect(task.projectId).toBeNull();
    expect(task.temporaryWorkspaceRoot).toBeTruthy();
    expect(JSON.stringify(model.requests)).toContain("input.txt");
    await page.locator("#composer-input").fill("Unsent follow-up draft");
    // Web drafts are origin scoped; native port changes use the preload mirror.
    await d.restart();
    await page.goto(d.base);
    await page.locator(`#project-list button[data-task="${task.taskId}"]`).click();
    await expect(page.locator("#composer-input")).toHaveValue("Unsent follow-up draft");
    const inputRoot = join(d.workspaceRoot, task.taskId, "inputs");
    const entries = await readdir(inputRoot);
    expect(entries.filter((entry) => entry.startsWith("upload-"))).toHaveLength(1);
    const uploadId = entries.find((entry) => entry.startsWith("upload-"));
    expect(await readFile(join(inputRoot, uploadId, "original.txt"), "utf8")).toBe("Retained attachment\n");
  } finally {
    await d.stop();
    await model.close();
  }
});
