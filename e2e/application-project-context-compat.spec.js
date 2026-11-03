import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { ResourceFiles } from "../dist/src/applications/resource-files.js";
import { ApplicationService } from "../dist/src/applications/application-service.js";

const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const result = (body) => JSON.parse(text(body.messages.findLast((message) => message.role === "tool")));
const api = async (dashboard, path, body) => {
  const response = await fetch(dashboard.base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
};

test("a first PPT inherits its named project without creating an internal sidebar project", async ({
  page
}) => {
  const evidence = test.info().outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  let step = 0,
    created,
    projectDirectory,
    releaseFinal;
  const finalGate = new Promise((done) => {
    releaseFinal = done;
  });
  const failures = [],
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const provider = await modelProtocolFixture("openai-completions", async (body) => {
    try {
      const names = body.tools.map((tool) => tool.function.name);
      if (++step === 1) {
        assert.ok(
          JSON.stringify(body.messages).includes(projectDirectory),
          "Main knows the selected project directory"
        );
        return { name: "enable_tools", arguments: { groups: ["applications"] } };
      }
      if (step === 2) {
        assert.ok(names.includes("create_resource"));
        return {
          name: "create_resource",
          arguments: {
            kind: "presentation/pptist+json",
            title: "自我介绍",
            initialContent: {
              slides: [
                {
                  id: "intro",
                  elements: [
                    {
                      id: "title",
                      type: "text",
                      left: 100,
                      top: 100,
                      width: 800,
                      height: 100,
                      rotate: 0,
                      content: '<p style="font-size:48px">自我介绍</p>',
                      defaultFontName: "Arial",
                      defaultColor: "#333333"
                    }
                  ]
                }
              ]
            }
          }
        };
      }
      if (step === 3) {
        created = result(body);
        assert.notEqual(created.ok, false);
        assert.ok(created.resource?.resourceId);
        assert.equal(created.editorOpened, true);
        assert.equal(created.bound, true);
        assert.equal(created.nextAction.tool, "pptist_read_presentation");
        return { name: created.nextAction.tool, arguments: {} };
      }
      assert.equal(step, 4);
      assert.notEqual(result(body).ok, false);
      await finalGate;
      return { text: "隔离复现：已创建并核对自我介绍 PPT。" };
    } catch (error) {
      failures.push(error.stack ?? error.message);
      await writeFile(
        join(evidence, "fixture-error.json"),
        JSON.stringify({ step, created, failures }, null, 2)
      );
      releaseFinal();
      return { text: "隔离夹具失败。" };
    }
  });
  const dashboard = await startDashboard({
    defaultProject: false,
    modelEndpoint: provider.baseUrl,
    model: "protocol-fixture"
  });
  try {
    projectDirectory = join(dashboard.root, "project-inputs");
    await mkdir(projectDirectory);
    const { project } = await api(dashboard, "/api/projects", { projectName: "测试", projectDirectory });
    await api(dashboard, "/api/tasks", {
      taskId: "ppt-from-project",
      goal: "在测试项目创建自我介绍 PPT",
      projectId: project.projectId
    });
    const before = await api(dashboard, "/api/tasks");
    expect(before.projects.map((item) => item.projectName)).toEqual(["测试"]);
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="ppt-from-project"]').click();
    await page.locator("#composer-input").fill("帮我创建一份自我介绍 PPT。");
    await page.locator("#send-button").click();
    await expect.poll(() => step).toBe(4);
    expect(failures).toEqual([]);
    const status = page.locator("[data-app-task-status]").first();
    await expect(status).toHaveText("正在处理 · 项目：测试");
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(
      page.locator(`.project-group[data-project="${project.projectId}"] [data-task="ppt-from-project"]`)
    ).toBeVisible();
    const detail = await api(dashboard, "/api/tasks/ppt-from-project");
    const { tabs } = await api(dashboard, "/api/workbench/tabs");
    const tab = tabs.find((item) => item.resourceId === created.resource.resourceId);
    expect(detail.projectId).toBe(project.projectId);
    expect(detail.projectDirectory).toBe(projectDirectory);
    expect(tab.workspaceRoot).toBe(projectDirectory);
    expect(tab.projectId).toBe(project.projectId);
    expect(tab.workspaceRoot).not.toBe(dashboard.workspaceRoot);
    expect(tab.loadedConversations.map((item) => item.taskId)).toContain("ppt-from-project");
    const filePath = new ResourceFiles(tab.workspaceRoot).absolutePath(created.resource);
    const content = JSON.parse(await readFile(filePath, "utf8"));
    expect(content.slides[0].id).toBe("intro");
    await page.screenshot({ path: join(evidence, "ppt-session.png"), fullPage: true });
    releaseFinal();
    await expect(page.locator("#stop-button")).toBeHidden();
    const after = await api(dashboard, "/api/tasks");
    const internal = after.projects.find((item) => item.projectDirectory === dashboard.workspaceRoot);
    expect(internal).toBeUndefined();
    expect(after.projects.map((item) => item.projectName)).toEqual(["测试"]);
    await page.reload();
    await expect(page.locator(".project-name")).toHaveText(["测试"]);
    await dashboard.restart();
    await page.reload();
    await expect(page.locator(".project-name")).toHaveText(["测试"]);
    expect(errors).toEqual([]);
    await writeFile(
      join(evidence, "ppt-session.json"),
      JSON.stringify(
        {
          mode: "real Pi, scripted local provider, real Dashboard and Chromium",
          before,
          after,
          project,
          task: {
            projectId: detail.projectId,
            projectDirectory: detail.projectDirectory,
            storageRoot: detail.storageRoot
          },
          resource: created.resource,
          tab,
          filePath,
          createdInProject: filePath.startsWith(projectDirectory + "/"),
          status: "CoworkOS 正在处理，内容会自动更新 · 测试",
          persistedAfterRestart: true,
          errors,
          failures
        },
        null,
        2
      )
    );
  } finally {
    releaseFinal();
    await dashboard.stop();
    await provider.close();
  }
});

test("orphaned legacy projects stay hidden after restart while explicit empty projects remain", async ({
  page
}) => {
  const evidence = test.info().outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const explicitDirectory = join(dashboard.root, "legitimate-empty");
    const oldDirectory = join(dashboard.root, "atria-reasoning-launcher-repro");
    await mkdir(explicitDirectory);
    await mkdir(oldDirectory);
    const { project: explicit } = await api(dashboard, "/api/projects", {
      projectName: "用户创建的空项目",
      projectDirectory: explicitDirectory
    });
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    await store.createTask("isolated-old-task", {
      goal: "隔离模拟旧测试历史",
      projectDirectory: oldDirectory
    });
    const registered = await api(dashboard, "/api/tasks");
    const old = registered.projects.find((project) => project.projectDirectory === oldDirectory);
    expect(old.legacy).toBe(true);
    expect(old.tasks).toHaveLength(1);
    await store.updateTask("isolated-old-task", { archived: true });
    await page.goto(dashboard.base);
    await expect(page.locator(`.project-group[data-project="${old.projectId}"]`)).toHaveCount(0);
    await expect(page.locator(`.project-group[data-project="${explicit.projectId}"]`)).toContainText(
      "还没有对话"
    );
    // Remove only the task created in this test's mkdtemp directory.
    await rm(join(dashboard.workspaceRoot, "isolated-old-task"), { recursive: true, force: true });
    const orphaned = await api(dashboard, "/api/tasks");
    expect(orphaned.tasks).toHaveLength(0);
    expect(orphaned.projects.some((project) => project.projectId === old.projectId)).toBe(false);
    const catalog = JSON.parse(await readFile(join(dashboard.root, "projects.json"), "utf8"));
    expect(catalog.projects.some((project) => project.projectId === old.projectId)).toBe(true);
    await page.reload();
    await expect(page.locator(`.project-group[data-project="${old.projectId}"]`)).toHaveCount(0);
    await dashboard.restart();
    await page.reload();
    await expect(page.locator(`.project-group[data-project="${old.projectId}"]`)).toHaveCount(0);
    await expect(page.locator(`.project-group[data-project="${explicit.projectId}"]`)).toContainText(
      "用户创建的空项目"
    );
    await page.screenshot({ path: join(evidence, "legacy-empty-project.png"), fullPage: true });
    await writeFile(
      join(evidence, "legacy-empty-project.json"),
      JSON.stringify(
        {
          scenario:
            "orphaned legacy records are hidden without removing their indexes or explicit empty projects",
          registered,
          orphaned,
          persistedAfterRestart: true,
          explicitEmptyProjectPreserved: true,
          limitation:
            "This reproduces the migration/display mechanism, not the origin of the real user screenshot data."
        },
        null,
        2
      )
    );
  } finally {
    await dashboard.stop();
  }
});

test("a shared document retains its project after rename, folder change and reuse of the original folder", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const projects = [];
    for (const [directoryName, projectName] of [
      ["source-folder", "源项目名称"],
      ["target-folder", "目标项目名称"]
    ]) {
      const projectDirectory = join(dashboard.root, directoryName);
      await mkdir(projectDirectory);
      const { project } = await api(dashboard, "/api/projects", { projectName, projectDirectory });
      projects.push(project);
    }
    await api(dashboard, "/api/tasks", {
      taskId: "source",
      goal: "源会话",
      projectId: projects[0].projectId
    });
    await api(dashboard, "/api/tasks", {
      taskId: "target",
      goal: "目标会话",
      projectId: projects[1].projectId
    });
    const created = await api(dashboard, "/api/tasks/source/resources", {
      kind: "text/plain",
      title: "共享文档",
      initialContent: "原内容不移动"
    });
    expect(created.resource.projectId).toBe(projects[0].projectId);
    const service = new ApplicationService(projects[0].projectDirectory, undefined, dashboard.workspaceRoot);
    await service.referenceResource({
      taskId: "target",
      resourceId: created.resource.resourceId,
      appType: "text-editor"
    });
    await api(dashboard, "/api/workbench/load-instance", {
      taskId: "target",
      appInstanceId: created.appInstance.appInstanceId
    });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="target"]').click();
    await page.locator("[data-composer-context]").click();
    await expect(page.locator("[data-app-task-status]")).toHaveText("项目：源项目名称");
    await page.locator("#apps-nav").click();
    await page.locator('[data-toggle-instances="text-editor"]').click();
    await expect(
      page.locator(
        `[data-open-instance="window:${created.appInstance.appInstanceId}"] .app-instance-workspace`
      )
    ).toHaveText("项目：源项目名称");
    const newSourceFolder = join(dashboard.root, "renamed-source-folder");
    await mkdir(newSourceFolder);
    const response = await fetch(dashboard.base + "/api/projects/" + projects[0].projectId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectName: "源项目重命名", projectDirectory: newSourceFolder })
    });
    expect(response.ok).toBe(true);
    const retainedTabs = (await api(dashboard, "/api/workbench/tabs")).tabs;
    expect(retainedTabs.find((item) => item.resourceId === created.resource.resourceId)?.workspaceRoot).toBe(
      projects[0].projectDirectory
    );
    await api(dashboard, "/api/projects", {
      projectName: "原目录的新项目",
      projectDirectory: projects[0].projectDirectory
    });
    await page.reload();
    await page.locator("[data-composer-context]").click();
    await expect(page.locator("[data-app-task-status]")).toHaveText("项目：源项目重命名");
    const detail = await api(dashboard, "/api/tasks/target");
    expect(detail.projectId).toBe(projects[1].projectId);
    expect(detail.projectDirectory).toBe(projects[1].projectDirectory);
    expect(detail.applications.workspaceRoot).toBe(projects[0].projectDirectory);
    const { tabs } = await api(dashboard, "/api/workbench/tabs");
    const tab = tabs.find((item) => item.resourceId === created.resource.resourceId);
    expect(tab.projectId).toBe(projects[0].projectId);
    expect(tab.workspaceRoot).toBe(projects[0].projectDirectory);
    const continued = await api(dashboard, "/api/tasks/target/resources", {
      kind: "text/plain",
      title: "在目标会话项目创建新文件",
      initialContent: "继承目标项目"
    });
    expect(continued.resource.projectId).toBe(projects[1].projectId);
    expect(continued.resource.project.projectDirectory).toBe(projects[1].projectDirectory);
    expect(
      await readFile(new ResourceFiles(projects[1].projectDirectory).absolutePath(continued.resource), "utf8")
    ).toBe("继承目标项目");
    expect(
      await readFile(new ResourceFiles(projects[0].projectDirectory).absolutePath(created.resource), "utf8")
    ).toBe("原内容不移动");
    // Creating in this chat uses its project. Reloading the existing shared
    // window still restores its original affiliation and physical file root.
    await api(dashboard, "/api/workbench/load-instance", {
      taskId: "target",
      appInstanceId: created.appInstance.appInstanceId
    });
    await dashboard.restart();
    await page.reload();
    await page.locator("[data-composer-context]").click();
    await expect(page.locator("[data-app-task-status]")).toHaveText("项目：源项目重命名");
  } finally {
    await dashboard.stop();
  }
});
