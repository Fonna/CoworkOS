import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { startDashboard } from "../test/dashboard-fixture.mjs";

let server;
let base;
test.beforeAll(async () => {
  const web = resolve("web");
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://fixture").pathname;
      if (pathname === "/") {
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><html><head><style>
          main { display: flex; width: 100%; height: 700px; }
          #conversation { width: 40%; } #workbench { position: relative; flex: 1; }
          .workbench-app { position: absolute; inset: 0; }
          [hidden] { display: none !important; }
        </style></head><body><button id="apps-nav">应用</button><aside id="apps-panel" hidden></aside>
          <main><section id="conversation"></section><section id="workbench"></section></main></body></html>`);
        return;
      }
      const path = resolve(web, `.${pathname}`);
      if (!path.startsWith(web + sep)) throw new Error("outside fixture");
      response.setHeader("content-type", extname(path) === ".js" ? "text/javascript" : "text/plain");
      response.end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  if (server) await new Promise((done) => server.close(done));
});

for (const appType of ["cad-harness", "office-harness"]) {
  test(`${appType} keeps the native view visible across tab returns, resize and hidden-tab close`, async ({
    page
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.evaluate(async (appType) => {
      const { createWorkbenchHost } = await import("/assets/workbench/host.js");
      const { cadHarnessEditorAdapter, officeHarnessEditorAdapter } =
        await import("/assets/workbench/adapters/harness-editor.js");
      const view = { attached: false, workspace: undefined, calls: [] };
      const native = {
        start: async (...args) => {
          view.calls.push({ type: "start", args });
          if (appType === "cad-harness") view.workspace = args[0];
          return { status: "running" };
        },
        status: async () => ({ status: "running" }),
        attach: async (bounds) => {
          view.attached = true;
          view.calls.push({ type: "attach", bounds });
        },
        detach: async (owner) => {
          view.attached = false;
          view.calls.push({ type: "detach", owner });
        },
        onStatusChanged: () => () => {}
      };
      window.bookmanDesktop = { cadViewer: native, officeHarness: native };
      window.harnessView = view;
      window.harnessHost = createWorkbenchHost({
        root: document.querySelector("#workbench"),
        conversationElement: document.querySelector("#conversation"),
        registry: { "cad-harness": cadHarnessEditorAdapter, "office-harness": officeHarnessEditorAdapter },
        api: { activateTab: async () => {}, closeTab: async () => {} }
      });
      await window.harnessHost.update({
        tabs: ["a", "b"].map((id) => ({
          tabId: `resource:${id}`,
          resourceId: id,
          kind: "application",
          appType,
          title: id,
          workspaceRoot: "/documents/project",
          conversations: [{ taskId: `task-${id}`, storageRoot: `/task-storage/${id}` }]
        })),
        activeTabId: null
      });
    }, appType);
    for (const id of ["a", "b", "a"]) {
      await page.evaluate((id) => window.harnessHost.activate(`resource:${id}`), id);
      await expect(page.locator(`[data-app-mount="resource:${id}"]`)).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.harnessView.attached)).toBe(true);
      if (appType === "cad-harness")
        await expect
          .poll(() => page.evaluate(() => window.harnessView.workspace))
          .toBe(`/task-storage/${id}/task-${id}`);
    }
    await page.setViewportSize({ width: 1300, height: 850 });
    await page.evaluate(() => window.harnessHost.close("resource:b"));
    await expect.poll(() => page.evaluate(() => window.harnessView.attached)).toBe(true);
    await page.evaluate(() => window.harnessHost.openDraftConversation());
    await expect.poll(() => page.evaluate(() => window.harnessView.attached)).toBe(false);
    await page.evaluate(() => window.harnessHost.destroy());
    expect(errors).toEqual([]);
  });
}

test("the real registry offers FreeCAD and its launcher invokes the harness conversation flow", async ({
  page
}) => {
  await page.goto(base);
  await page.evaluate(async () => {
    const { createWorkbenchRegistry } = await import("/assets/workbench/registry.js");
    const { createAppsPanel } = await import("/assets/workbench/apps-panel.js");
    const registry = createWorkbenchRegistry();
    const apps = createAppsPanel({
      navButton: document.querySelector("#apps-nav"),
      panel: document.querySelector("#apps-panel"),
      api: {
        listApplications: async () => ({
          applications: [
            {
              appType: "freecad-harness",
              displayName: "FreeCAD Harness",
              capabilities: ["edit"],
              resourceKinds: ["application/freecad-session+json"]
            }
          ]
        })
      },
      getTaskId: () => null,
      supportsApplication: (type) => Boolean(registry[type]),
      getWorkspaceRoot: () => "/documents/project",
      onOpenHarness: async ({ appType, kind, workspaceRoot }) => {
        window.openedHarness = { appType, kind, workspaceRoot };
      }
    });
    await apps.toggle();
  });
  await page.getByRole("button", { name: "新建FreeCAD Harness实例", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.openedHarness))
    .toEqual({
      appType: "freecad-harness",
      kind: "application/freecad-session+json",
      workspaceRoot: "/documents/project"
    });
});

for (const appType of ["cad-harness", "office-harness"]) {
  test(`${appType} reopens a preserved dashboard resource and restores its real task workspace`, async ({
    page
  }) => {
    const root = await mkdtemp(join(tmpdir(), "atria-harness-browser-"));
    let dashboard;
    try {
      dashboard = await startDashboard({
        defaultProject: false,
        env: {
          CAD_HARNESS_PATH: join(root, "missing-cad-plugin"),
          CAD_PYTHON: join(root, "missing-python"),
          OFFICEHARNESS_PLUGIN_ROOT: join(root, "missing-office-plugin"),
          OFFICEHARNESS_PROFILE_DIR: join(root, "office-profile")
        }
      });
      const post = async (path, data) => {
        const response = await page.request.post(dashboard.base + path, { data });
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const { project } = await post("/api/projects", {
        projectName: "兼容应用项目",
        projectDirectory: root
      });
      const { applications } = await (await page.request.get(`${dashboard.base}/api/applications`)).json();
      const application = applications.find((entry) => entry.appType === appType);
      expect(application.catalogVisibility).toBe("compatibility");
      const saved = [];
      for (const id of ["first", "second"]) {
        const taskId = `${appType}-${id}`;
        await post("/api/tasks", { taskId, goal: `已有会话 ${id}`, projectId: project.projectId });
        const created = await post(`/api/tasks/${taskId}/resources`, {
          appType,
          kind: application.resourceKinds[0],
          title: `已有工程 ${id}`
        });
        const opened = await post("/api/workbench/tabs", {
          kind: "application",
          appInstanceId: created.appInstance.appInstanceId,
          activate: false
        });
        saved.push({
          taskId,
          resourceId: created.resource.resourceId,
          tab: opened.tabs.find((entry) => entry.resourceId === created.resource.resourceId)
        });
      }
      await post("/api/workbench/tabs", { kind: "conversation", taskId: saved[0].taskId });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
      let release;
      let ready = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/api/workbench/tabs", async (route) => {
        if (route.request().method() === "GET") await ready;
        await route.continue();
      });
      const inject = () =>
        page.evaluate(() => {
          const state = { attached: false, starts: [], workspace: null };
          window.dashboardHarness = state;
          const native = {
            start: async (...args) => {
              state.starts.push(args);
              if (args.length === 2) state.workspace = args[0];
              return { status: "running" };
            },
            attach: async () => {
              state.attached = true;
            },
            detach: async () => {
              state.attached = false;
            },
            onStatusChanged: () => () => {}
          };
          window.bookmanDesktop = { cadViewer: native, officeHarness: native };
        });
      await page.goto(`${dashboard.base}/?task=${saved[0].taskId}`);
      await inject();
      release();
      await expect(page.locator("#apps-nav")).toBeVisible();
      await page.locator("#apps-nav").click();
      await expect(page.locator(`[data-create-app="${appType}"]`)).toHaveCount(0);
      await page.locator(`[data-open-resource="${saved[0].resourceId}"]`).click();
      await expect.poll(() => page.evaluate(() => window.dashboardHarness.attached)).toBe(true);
      const { tabs } = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
      const tab = tabs.find((entry) => entry.resourceId === saved[0].resourceId);
      expect(tab).toBeTruthy();
      const taskId = tab.conversations[0].taskId;
      expect(tab.conversations[0].storageRoot).toBe(dashboard.workspaceRoot);
      expect(tab.workspaceRoot).not.toBe(dashboard.workspaceRoot);
      if (appType === "cad-harness")
        expect(await page.evaluate(() => window.dashboardHarness.workspace)).toBe(
          join(dashboard.workspaceRoot, taskId)
        );

      // Open the other session through its sidebar file list. The workbench
      // rail exposes only that session's documents, including its close action.
      const starts = await page.evaluate(() => window.dashboardHarness.starts.length);
      const secondTab = saved[1].tab;
      expect(secondTab).toBeTruthy();
      await page.locator(`#project-list [data-task="${saved[1].taskId}"]`).click();
      if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
      await page.locator(`[data-open-resource="${saved[1].resourceId}"]`).click();
      await expect
        .poll(() => page.evaluate(() => window.dashboardHarness.starts.length))
        .toBeGreaterThan(starts);
      if (appType === "cad-harness")
        await expect
          .poll(() => page.evaluate(() => window.dashboardHarness.workspace))
          .toBe(join(dashboard.workspaceRoot, saved[1].taskId));
      await page.locator(`[data-tab-rail] [data-close-tab="${secondTab.tabId}"]`).click();
      await expect(page.locator(`[data-app-mount="${secondTab.tabId}"]`)).toHaveCount(0);
      await page.locator(`#project-list [data-task="${saved[0].taskId}"]`).click();
      if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
      await page.locator(`[data-open-resource="${saved[0].resourceId}"]`).click();
      await expect(page.locator(`[data-app-mount="${tab.tabId}"]`)).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.dashboardHarness.attached)).toBe(true);
      if (appType === "cad-harness")
        await expect
          .poll(() => page.evaluate(() => window.dashboardHarness.workspace))
          .toBe(join(dashboard.workspaceRoot, taskId));
      expect(await page.evaluate(() => window.dashboardHarness.attached)).toBe(true);
      ready = new Promise((resolve) => {
        release = resolve;
      });
      await page.goto(dashboard.base);
      await inject();
      release();
      await expect.poll(() => page.evaluate(() => window.dashboardHarness.attached)).toBe(true);
      if (appType === "cad-harness")
        expect(await page.evaluate(() => window.dashboardHarness.workspace)).toBe(
          join(dashboard.workspaceRoot, taskId)
        );
      expect(errors).toEqual([]);
    } finally {
      await dashboard?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("text editor renders Markdown drafts live and keeps TXT as plain text", async ({ page }) => {
  await page.goto(base);
  await page.evaluate(async () => {
    const { textEditorAdapter } = await import("/assets/workbench/adapters/text-editor.js");
    const mount = async (kind) => {
      document.querySelector("#workbench").innerHTML = "";
      await textEditorAdapter.mount(document.querySelector("#workbench"), {
        instance: { resourceIds: ["note"], appInstanceId: "editor" },
        taskId: "fixture",
        api: {
          downloadUrl: () => "#",
          readResource: async () => ({
            resource: { resourceId: "note", kind, title: "note.md", revision: 0 },
            snapshot: { content: "# Hello\n\n**Bold**" }
          }),
          applyOperation: async () => {
            throw new Error("offline fixture");
          }
        }
      });
    };
    window.mountTextFixture = mount;
    await mount("text/markdown");
  });
  const preview = page.locator("[data-editor-preview]");
  await expect(preview.locator("h1")).toHaveText("Hello");
  await page
    .getByRole("textbox", { name: "文档内容" })
    .fill("## Updated\n\n<script>alert(1)</script>\n\n**Live**");
  await expect(preview.locator("h2")).toHaveText("Updated");
  await expect(preview.locator("strong")).toHaveText("Live");
  await expect(preview.locator("script")).toHaveCount(0);
  await page.locator("[data-editor-preview-toggle]").click();
  await expect(preview).toBeHidden();
  await page.locator("[data-editor-preview-toggle]").click();
  await expect(preview).toBeVisible();
  await page.evaluate(() => window.mountTextFixture("text/plain"));
  await expect(preview).toBeHidden();
  await expect(page.locator("[data-editor-preview-toggle]")).toBeHidden();
});

test("document Markdown supports HTML blocks, GFM and math without executable HTML", async ({ page }) => {
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { renderDocumentMarkdown } = await import("/assets/document-markdown.js");
    const source = [
      '<div align="center"><h2>HTML heading</h2><br><mark>Highlighted</mark></div>',
      "",
      "<details open><summary>Details</summary><table><tr><td>HTML cell</td></tr></table></details>",
      "",
      "Text with <sub>subscript</sub> and <sup>superscript</sup>.",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "- parent",
      "  - child",
      "",
      "![Picture](https://example.invalid/picture.png)",
      "",
      "$x^2$",
      "",
      "```html",
      "<div>literal</div>",
      "```",
      "",
      "<script>window.previewExecuted = true</script>",
      '<img src="x" onerror="window.previewExecuted = true">',
      '<a href="javascript:alert(1)">bad</a>',
      '<iframe srcdoc="bad"></iframe><style>body { display:none }</style>'
    ].join("\n");
    const host = document.createElement("div");
    host.innerHTML = renderDocumentMarkdown(source);
    return {
      heading: host.querySelector('div[align="center"] h2')?.textContent,
      details: host.querySelector("details[open] summary")?.textContent,
      tables: host.querySelectorAll("table").length,
      sub: host.querySelector("sub")?.textContent,
      nested: host.querySelector("ul ul li")?.textContent,
      image: host.querySelector('img[alt="Picture"]')?.getAttribute("src"),
      math: !!host.querySelector(".katex"),
      code: host.querySelector("pre code")?.textContent,
      unsafe: host.querySelectorAll('script,iframe,style,[onerror],a[href^="javascript:"]').length
    };
  });
  expect(result).toEqual({
    heading: "HTML heading",
    details: "Details",
    tables: 2,
    sub: "subscript",
    nested: "child",
    image: "https://example.invalid/picture.png",
    math: true,
    code: "<div>literal</div>\n",
    unsafe: 0
  });
});
