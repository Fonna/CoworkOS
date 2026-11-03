import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";

test("Mac native voice bridge saves synthetic text, cancels preparation on project switch, and cleans up without recording", async ({
  browserName
}, testInfo) => {
  test.skip(process.platform !== "darwin", "Native speech integration requires macOS");
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "atria-native-voice-"));
  const executable = join(root, "fake-speech");
  const control = join(root, "control.json");
  const log = join(root, "helper.jsonl");
  await writeFile(control, JSON.stringify({ delay: 0 }));
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
const log = operation => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ operation, pid: process.pid, args: process.argv.slice(2) }) + "\\n");
const emit = value => console.log(JSON.stringify(value));
log("start");
const timer = setTimeout(() => {
  if (control.error) { emit({ type: "error", code: control.error, message: "fixture error" }); emit({ type: "ended", reason: "error" }); process.exit(0); }
  emit({ type: "started", locale: "zh-cn", mode: "on-device" });
}, control.delay);
readline.createInterface({ input: process.stdin }).on("line", line => {
  log(line);
  if (line === "stop") {
    clearTimeout(timer);
    emit({ type: "result", transcript: "原生桥接测试文字", final: true });
    emit({ type: "ended", reason: "completed" });
    process.exit(0);
  } else if (line === "cancel") {
    clearTimeout(timer);
    // Benign late text from an already cancelled fixture must be discarded.
    emit({ type: "result", transcript: "已经取消的测试文字", final: true });
    emit({ type: "ended", reason: "cancelled" });
    process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
`,
    { mode: 0o700 }
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|GOOGLE_API_KEY$|GOOGLE_DEFAULT_CLIENT_)/.test(
          name
        )
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: join(root, "profile"),
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    COWORK_SPEECH_INPUT_EXECUTABLE: executable,
    PI_OFFLINE: "1"
  });
  let native;
  const errors = [];
  const readLog = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const launch = async () => {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 60_000
    });
    await native.evaluate(({ session, dialog }) => {
      globalThis.voiceMediaRequests = [];
      globalThis.voiceMediaChecks = [];
      session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
        if (permission === "media") globalThis.voiceMediaChecks.push(permission);
        return false;
      });
      session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
        globalThis.voiceMediaRequests.push(permission);
        callback(false);
      });
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    const page = await native.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator(".mic-button")).toBeVisible();
    const model = page.getByRole("dialog", { name: "连接模型" });
    await expect(model).toBeVisible();
    await model.getByRole("button", { name: "关闭设置", exact: true }).click();
    return page;
  };
  const createProject = async (page, name) => {
    const directory = join(root, name);
    await mkdir(directory);
    await page.locator("#new-project").click();
    await page.locator("#project-name").fill(name);
    await page.locator("#project-directory").fill(directory);
    await page.locator("#project-submit").click();
    await expect(page.locator("#project-modal")).toBeHidden();
    await expect(page.locator("#project-context")).toHaveText(name);
  };
  try {
    let page = await launch();
    expect(await page.evaluate(() => window.bookmanDesktop.voiceInput.supported)).toBe(true);
    await createProject(page, "语音项目A");
    const input = page.locator("#composer-input");
    const microphone = page.locator(".mic-button");
    await input.fill("保留手动草稿");
    await microphone.click();
    await expect(microphone).toHaveAttribute("data-voice-state", "listening");
    await input.fill("保留手动草稿，仍可编辑");
    await microphone.click();
    await expect(input).toHaveValue("保留手动草稿，仍可编辑\n原生桥接测试文字");
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(input).toHaveValue("保留手动草稿，仍可编辑\n原生桥接测试文字");
    const model = page.getByRole("dialog", { name: "连接模型" });
    await expect(model).toBeVisible();
    await model.getByRole("button", { name: "关闭设置", exact: true }).click();
    await createProject(page, "语音项目B");
    await input.fill("项目B的草稿");
    await page.getByRole("button", { name: "语音项目A", exact: true }).click();
    await expect(input).toHaveValue("保留手动草稿，仍可编辑\n原生桥接测试文字");
    await writeFile(control, JSON.stringify({ delay: 2000 }));
    await microphone.click();
    await expect(microphone).toHaveAttribute("data-voice-state", "starting");
    await expect
      .poll(async () => (await readLog()).filter((entry) => entry.operation === "start").length)
      .toBe(2);
    await page.getByRole("button", { name: "语音项目B", exact: true }).click();
    await expect(input).toHaveValue("项目B的草稿");
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () => (await readLog()).filter((entry) => entry.operation === "cancel").length)
      .toBe(1);
    await expect(input).toHaveValue("项目B的草稿");
    await writeFile(control, JSON.stringify({ delay: 0, error: "speech_denied" }));
    await microphone.click();
    await expect(page.locator("#toast")).toContainText("语音识别访问被拒绝");
    await expect(input).toHaveValue("项目B的草稿");
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    const media = await native.evaluate(() => ({
      checks: globalThis.voiceMediaChecks,
      requests: globalThis.voiceMediaRequests
    }));
    expect(media.requests).toEqual([]);
    // Preview windows receive no native voice bridge.
    const opened = native.waitForEvent("window");
    await page.evaluate(() => window.open("/assets/pptist/generated/LICENSE.txt", "_blank"));
    const viewer = await opened;
    await expect(viewer.locator("body")).toContainText("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(await viewer.evaluate(() => typeof window.bookmanDesktop)).toBe("undefined");
    await viewer.close();
    await writeFile(control, JSON.stringify({ delay: 0 }));
    await microphone.click();
    await expect(microphone).toHaveAttribute("data-voice-state", "listening");
    await page.screenshot({ path: testInfo.outputPath("native-voice-listening.png") });
    await native.close();
    native = undefined;
    await expect
      .poll(async () => (await readLog()).filter((entry) => entry.operation === "cancel").length)
      .toBe(2);
    const records = await readLog();
    for (const pid of new Set(records.map((entry) => entry.pid))) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
    page = await launch();
    await expect(page.locator("#composer-input")).toHaveValue("项目B的草稿");
    expect(errors).toEqual([]);
    const evidence = JSON.stringify(
      { records, media, rendererErrors: errors, realAudioCaptured: false },
      null,
      2
    );
    await writeFile(testInfo.outputPath("fake-helper-lifecycle.json"), `${evidence}\n`);
    await testInfo.attach("fake-helper-lifecycle", {
      body: Buffer.from(evidence),
      contentType: "application/json"
    });
  } finally {
    await native?.close();
    await rm(root, { recursive: true, force: true });
  }
});
