import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MacComputerDriver } from "../dist/src/gui/macos-driver.js";

test("native subprocess error envelopes preserve dispatch certainty; aborted sent requests remain unknown", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Mac driver subprocess protocol");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "atria-computer-driver-"));
  const executable = join(root, "fixture.mjs");
  const target = {
    pid: 1,
    windowId: 2,
    bundleId: "org.atria.fixture",
    application: "Fixture",
    title: "Protocol"
  };
  const frame = { width: 1, height: 1, image: "unused", frame: { x: 0, y: 0, width: 1, height: 1 } };
  let active, controller;
  try {
    const helper = (response) =>
      writeFile(
        executable,
        `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(response)}); process.exit(1); });\n`,
        { mode: 0o700 }
      );
    for (const dispatchStatus of ["not_sent", "sent", "unknown"]) {
      await helper(
        JSON.stringify({
          error: "isolated protocol failure",
          errorCode: "native_action_failed",
          dispatchStatus
        })
      );
      const driver = new MacComputerDriver(executable);
      await assert.rejects(driver.act(target, { type: "activate" }, frame, new AbortController().signal), {
        errorCode: "native_action_failed",
        dispatchStatus,
        requiresObservation: true
      });
    }
    await helper("invalid response");
    await assert.rejects(
      new MacComputerDriver(executable).act(
        target,
        { type: "activate" },
        frame,
        new AbortController().signal
      ),
      { errorCode: "invalid_driver_response", dispatchStatus: "unknown" }
    );
    const marker = join(root, "sent");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport {writeFileSync} from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => { writeFileSync(${JSON.stringify(marker)}, "dispatched"); setInterval(() => {}, 1000); });\n`,
      { mode: 0o700 }
    );
    const abort = new AbortController();
    controller = abort;
    const acting = new MacComputerDriver(executable).act(target, { type: "activate" }, frame, abort.signal);
    active = acting;
    const rejected = assert.rejects(acting, {
      name: "AbortError",
      dispatchStatus: "unknown",
      requiresObservation: true
    });
    for (let index = 0; index < 100; index++) {
      if (await readFile(marker, "utf8").catch(() => "")) break;
      await delay(10);
    }
    assert.equal(await readFile(marker, "utf8"), "dispatched");
    abort.abort();
    await rejected;
  } finally {
    controller?.abort();
    await active?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
