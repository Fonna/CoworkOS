import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";

test("a packaged light App prepares components automatically while local chat and bundled PPT remain usable, then cancels on quit", async ({
  browserName
}, testInfo) => {
  test.skip(
    process.platform !== "darwin" ||
      process.env.ATRIA_PUBLIC_COMPONENTS_SMOKE !== "1" ||
      !process.env.ATRIA_DESKTOP_APP,
    "Explicit light App candidate, ATRIA_PUBLIC_COMPONENTS_SMOKE=1 and macOS required"
  );
  test.setTimeout(120_000);
  const app = resolve(process.env.ATRIA_DESKTOP_APP);
  const appRoot = join(app, "Contents/Resources/app");
  const metadata = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
  expect(metadata.atriaAutoInstallComponents).toBe(true);
  expect(metadata.atriaBundledComponents).toBe(false);
  expect(metadata.atriaBundledPptist).toBe(true);
  for (const path of ["cadquery/bin/python3", "blender/Blender.app/Contents/MacOS/Blender"])
    await expect(access(join(app, "Contents/Resources", path))).rejects.toThrow();
  for (const file of ["index.html", "LICENSE.txt", "source.tar.gz"])
    await access(join(appRoot, "web/assets/pptist/generated", file));

  const root = await mkdtemp(join(tmpdir(), "atria-public-components-native-"));
  const data = join(root, "data");
  const bytes = Buffer.alloc(4096, 1);
  const artifact = {
    apiVersion: 1,
    id: "cadquery",
    version: "native-smoke",
    hostVersion: metadata.version,
    platform: "darwin-arm64",
    file: "native-cad.tar.gz",
    downloadBytes: bytes.length,
    installedBytes: bytes.length * 2,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
  const requests = [],
    activeDownloads = new Set();
  let downloads = 0,
    closedDownloads = 0;
  const source = createServer((request, response) => {
    requests.push({ path: request.url, authenticated: Boolean(request.headers.authorization) });
    if (request.url === "/atria-components-darwin-arm64.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ artifacts: [artifact] }));
    } else if (request.url === `/${artifact.file}`) {
      downloads++;
      activeDownloads.add(response);
      response.once("close", () => {
        activeDownloads.delete(response);
        closedDownloads++;
      });
      response.writeHead(200, { "content-length": bytes.length });
      // Hold CAD in a real partial download. Sequential preparation leaves Blender queued.
      response.write(bytes.subarray(0, 1024));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((done) => source.listen(0, "127.0.0.1", done));
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: "PUBLIC_LIGHT_PACKAGED_TASK_OK"
  }));
  const env = desktopSmokeEnvironment({ data });
  env.ATRIA_COMPONENTS_RELEASE_ROOT = `http://127.0.0.1:${source.address().port}`;
  let native, page;
  try {
    native = await electron.launch({
      executablePath: join(app, "Contents/MacOS/CoworkOS"),
      args: ["--use-mock-keychain"],
      env,
      timeout: 60_000
    });
    page = await native.firstWindow();
    await expect.poll(() => activeDownloads.size, { timeout: 30_000 }).toBe(1);
    const initialDownloads = downloads;
    const initialOrigin = await page.evaluate(() => location.origin);
    const connection = page.getByRole("dialog", { name: "连接模型" });
    await expect(connection).toBeVisible();
    await connection.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await connection.locator('[name="api"]').selectOption("openai-completions");
    await connection.locator('[name="model"]').fill("protocol-fixture");
    await connection.locator('[name="apiKey"]').fill("local-public-components-fixture");
    await connection.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => location.origin), { timeout: 30_000 })
      .not.toBe(initialOrigin);
    await expect(connection).toBeHidden();
    await expect.poll(() => downloads, { timeout: 30_000 }).toBeGreaterThan(initialDownloads);
    await expect.poll(() => activeDownloads.size).toBe(1);

    const states = await page.evaluate(
      async () => (await (await fetch("/api/components")).json()).components
    );
    expect(states.find((state) => state.id === "pptist")).toMatchObject({ available: true, bundled: true });
    expect(states.find((state) => state.id === "cadquery")).toMatchObject({
      available: false,
      installing: true
    });
    expect(states.find((state) => state.id === "blender").installing).toBe(false);
    const notice = page.locator("[data-component-preparation]");
    await expect(notice).toContainText("正在准备 CAD 精确内核");
    await notice.click();
    const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
    const cad = settings.locator('[data-component-id="cadquery"]');
    await expect(cad).toBeFocused();
    await expect(cad.getByRole("progressbar")).toBeVisible();
    await expect(cad.getByRole("button", { name: "取消安装", exact: true })).toBeEnabled();
    await expect(settings.locator(".component-auth")).toHaveCount(0);
    await expect(settings.locator('[data-component-id="pptist"]')).toContainText("可用");
    await page.screenshot({ path: testInfo.outputPath("packaged-light-preparing-components.png") });
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();

    await page.locator("#new-project").click();
    await page.locator("#project-name").fill("Public components native smoke");
    await page.locator("#project-directory").fill(root);
    await page.locator("#project-submit").click();
    await expect(page.locator("#project-modal")).toBeHidden();
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("PUBLIC_LIGHT_PACKAGED_TASK");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("PUBLIC_LIGHT_PACKAGED_TASK_OK", {
      timeout: 30_000
    });
    await expect(page.locator("#stop-button")).toBeHidden();
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(activeDownloads.size).toBe(1);
    expect(requests.every((request) => !request.authenticated)).toBe(true);

    await native.close();
    native = undefined;
    await expect.poll(() => activeDownloads.size).toBe(0);
    expect(closedDownloads).toBe(downloads);
    const installation = JSON.parse(await readFile(join(data, "components/cadquery/install.json"), "utf8"));
    expect(installation.phase).toBe("cancelled");
    const files = await readdir(join(data, "components/cadquery"));
    expect(files.some((file) => /^(?:\.download-|\.staging-|\.install-lock$)/.test(file))).toBe(false);
    await expect(access(join(data, "components/blender"))).rejects.toThrow();
    await writeFile(
      testInfo.outputPath("packaged-light-summary.json"),
      JSON.stringify(
        {
          version: metadata.version,
          componentSource: "local-http-fixture",
          automaticPreparation: true,
          pptAvailable: true,
          pptBundled: metadata.atriaBundledPptist,
          nativeRuntimesBundled: false,
          ordinaryLocalTaskCompleted: true,
          downloads,
          closedDownloads,
          anonymousRequests: requests.every((request) => !request.authenticated),
          quitPhase: installation.phase,
          requests
        },
        null,
        2
      )
    );
  } finally {
    if (native) {
      await page?.screenshot({ path: testInfo.outputPath("packaged-light-last-state.png") }).catch(() => {});
      await native.close().catch(() => {});
    }
    const log = await readFile(join(data, "logs/dashboard.log"), "utf8").catch(() => undefined);
    if (log) await testInfo.attach("dashboard.log", { body: log, contentType: "text/plain" });
    await provider.close();
    source.closeAllConnections();
    await new Promise((done) => source.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
