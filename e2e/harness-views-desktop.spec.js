import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("CAD and Office native views survive closing and reopening the Mac main window", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "Window recreation follows the macOS desktop lifecycle");
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "atria-harness-native-"));
  let native;
  try {
    await mkdir(join(root, "host"));
    await mkdir(join(root, "runtime", "bin"), { recursive: true });
    await mkdir(join(root, "task"));
    await writeFile(join(root, "host", "managed-service.cjs"), "// fixture\n");
    await writeFile(join(root, "runtime", "bin", "node"), "// fixture\n");
    await writeFile(
      join(root, "selector.html"),
      "<body>CAD selector fixture<script>window.CadStepSelector={setSteps(){}};</script></body>"
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)
      )
    );
    native = await electron.launch({
      executablePath: require("electron"),
      args: [resolve("test/fixtures/harness-desktop.cjs")],
      env: { ...env, ATRIA_TEST_HARNESS_FIXTURE: root, ATRIA_HOME: join(root, "home") },
      timeout: 60_000
    });
    let page = await native.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [kind, labels] of [
      ["cad", ["CAD viewer fixture", "CAD selector fixture"]],
      ["office", ["Office editor fixture"]]
    ]) {
      await native.evaluate(async (_, kind) => globalThis.harnessFixture.show(kind, `${kind}-first`), kind);
      await expect
        .poll(() => native.evaluate(() => globalThis.harnessFixture.snapshot().length))
        .toBe(labels.length);
      await expect.poll(() => native.evaluate(() => globalThis.harnessFixture.contents())).toEqual(labels);
      await page.close();
      const opened = native.waitForEvent("window");
      await native.evaluate(() => globalThis.harnessFixture.reopen());
      page = await opened;
      page.on("pageerror", (error) => errors.push(error.message));
      await native.evaluate(
        async (_, kind) => globalThis.harnessFixture.show(kind, `${kind}-reopened`),
        kind
      );
      await expect
        .poll(() => native.evaluate(() => globalThis.harnessFixture.snapshot().length))
        .toBe(labels.length);
      await expect.poll(() => native.evaluate(() => globalThis.harnessFixture.contents())).toEqual(labels);
      // A delayed detach from the old page may not remove the new page's view.
      await native.evaluate((_, kind) => globalThis.harnessFixture.detach(kind, `${kind}-first`), kind);
      expect(await native.evaluate(() => globalThis.harnessFixture.snapshot().length)).toBe(labels.length);
      await page.screenshot({ path: testInfo.outputPath(`${kind}-reopened.png`) });
      await native.evaluate((_, kind) => globalThis.harnessFixture.detach(kind, `${kind}-reopened`), kind);
      expect(await native.evaluate(() => globalThis.harnessFixture.snapshot().length)).toBe(0);
    }
    expect(errors).toEqual([]);
  } finally {
    try {
      if (native) {
        const child = native.process();
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        timer.unref();
        try {
          await native.close();
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
