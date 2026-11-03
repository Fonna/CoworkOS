import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createComponentService } from "../dist/src/software/components/service.js";
import { createDashboardHandler } from "../dist/src/dashboard/routes.js";

test("public component management uses real HTTP retry, cancellation, activation and uninstall while preserving documents", async ({
  page
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-component-browser-"));
  const source = join(root, "editor"),
    home = join(root, "components"),
    archive = join(root, "editor.tar.gz");
  await mkdir(source);
  await writeFile(join(source, "index.html"), "<html>fixture editor</html>");
  await writeFile(join(source, "LICENSE.txt"), "AGPL-3.0");
  await writeFile(join(source, "source.tar.gz"), "source fixture");
  await writeFile(join(root, "user-document.pptx"), "user data");
  execFileSync("tar", ["-czf", archive, "-C", source, "."]);
  const bytes = await readFile(archive),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  let downloads = 0,
    bad = true,
    slow = false;
  const artifact = {
    apiVersion: 1,
    id: "pptist",
    version: "1",
    hostVersion: "1.0.0",
    platform: "any",
    file: "editor.tar.gz",
    downloadBytes: bytes.length,
    installedBytes: 1024,
    sha256
  };
  const download = createServer((request, response) => {
    if (request.url.endsWith(".json")) return response.end(JSON.stringify({ artifacts: [artifact] }));
    downloads++;
    if (slow) {
      response.writeHead(200, { "content-length": bytes.length });
      response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      return;
    }
    response.end(bad ? Buffer.alloc(bytes.length) : bytes);
  });
  await new Promise((resolve) => download.listen(0, "127.0.0.1", resolve));
  const service = createComponentService({
    home,
    hostVersion: "1.0.0",
    platform: "linux-x64",
    githubToken: () => "",
    legacy: async () => undefined,
    releaseRoot: `http://127.0.0.1:${download.address().port}`
  });
  let handler;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<div class="sidebar-bottom"></div><input aria-label="普通聊天"><div id="manager"></div><script type="module">import { mountComponentManager } from "/assets/workbench/component-manager.js";import { installComponentPreparation } from "/assets/controllers/component-preparation.js";mountComponentManager(document.getElementById("manager"));installComponentPreparation({open: (id) => { document.getElementById("manager").dataset.selected = id; }});</script>'
      );
    } else void handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createDashboardHandler({ dashboardUrl: base, uiRoot: resolve("web"), components: service });
  try {
    await page.goto(base);
    await expect(page.locator(".component-auth")).toHaveCount(0);
    const ppt = page.locator("section").filter({ hasText: "PPT 编辑器" });
    await expect(ppt).toContainText("未安装");
    await ppt.getByRole("button", { name: "安装 / 重试", exact: true }).click();
    await expect(ppt).toContainText("integrity verification failed");
    bad = false;
    slow = true;
    await ppt.getByRole("button", { name: "安装 / 重试", exact: true }).click();
    const preparation = page.locator("[data-component-preparation]");
    await expect(preparation).toContainText("正在准备 PPT 编辑器");
    await expect(ppt.getByRole("progressbar")).toBeVisible();
    await page.getByRole("textbox", { name: "普通聊天" }).fill("组件准备时继续聊天");
    await preparation.click();
    await expect(page.locator("#manager")).toHaveAttribute("data-selected", "pptist");
    await ppt.getByRole("button", { name: "取消安装", exact: true }).click();
    await expect(ppt).toContainText("已取消");
    slow = false;
    await ppt.getByRole("button", { name: "安装 / 重试", exact: true }).click();
    await expect(ppt).toContainText("可用");
    await expect(preparation).toBeHidden();
    await expect(page.getByRole("textbox", { name: "普通聊天" })).toHaveValue("组件准备时继续聊天");
    expect(downloads).toBe(3);
    await ppt.getByRole("button", { name: "停用", exact: true }).click();
    await expect(ppt).toContainText("已停用");
    await page.reload();
    await ppt.getByRole("button", { name: "启用", exact: true }).click();
    await expect(ppt).toContainText("可用");
    await ppt.getByRole("button", { name: "卸载组件", exact: true }).click();
    await expect(ppt).toContainText("组件已卸载");
    expect(await readFile(join(root, "user-document.pptx"), "utf8")).toBe("user data");
    expect((await service.status("pptist")).available).toBe(false);
  } finally {
    await service.stop();
    server.closeAllConnections();
    download.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => download.close(resolve))
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
