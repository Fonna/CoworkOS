import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MacComputerDriver } from "../dist/src/gui/macos-driver.js";
import { ComputerUse } from "../dist/src/gui/computer-use.js";

test(
  "native computer driver saves Chinese/Emoji/long/multiline input in an isolated app; movement refuses stale input",
  { timeout: 60_000 },
  async (t) => {
    if (process.platform !== "darwin") {
      t.skip("macOS native driver");
      return;
    }
    const driver = new MacComputerDriver();
    const initial = await driver.status();
    if (!initial.available || !initial.screenRecording || !initial.accessibility) {
      t.skip(
        "native driver requires existing screen recording/accessibility permissions; no prompts in tests"
      );
      return;
    }
    if (initial.controlAvailable === false) {
      t.skip(`native input unavailable: ${initial.reason || "unlocked foreground desktop required"}`);
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "atria-computer-native-"));
    let child, fixturePid;
    const computer = new ComputerUse(driver);
    try {
      const contents = join(root, "AtriaCUAProbe.app", "Contents");
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await writeFile(
        join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.atria.computer-use-probe</string><key>CFBundleExecutable</key><string>probe</string><key>CFBundleName</key><string>AtriaCUAProbe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
      );
      const binary = join(contents, "MacOS", "probe");
      execFileSync("/usr/bin/xcrun", ["swiftc", "test/fixtures/computer-window.swift", "-o", binary]);
      await writeFile(join(root, "events"), "");
      child = spawn("/usr/bin/open", ["-n", "-W", join(root, "AtriaCUAProbe.app"), "--args", root], {
        stdio: "ignore"
      });
      const events = [];
      const wait = async (predicate) => {
        for (let index = 0; index < 200; index++) {
          events.splice(
            0,
            events.length,
            ...(await readFile(join(root, "events"), "utf8"))
              .split("\n")
              .slice(0, -1)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          );
          const value = events.find(predicate);
          if (value) return value;
          if (child.exitCode !== null) throw new Error("isolated native window exited");
          await delay(50);
        }
        throw new Error(`isolated native window timed out: ${JSON.stringify(events)}`);
      };
      const ready = await wait((value) => value.ready);
      fixturePid = ready.pid;
      await delay(300);
      const grant = await computer.authorize("native-probe", ready.pid, ready.windowId, "control");
      let observation = await computer.observe("native-probe", grant.sessionId);
      const focusObservation = async () => {
        const latest = await computer.observe("native-probe", grant.sessionId);
        await computer.act("native-probe", grant.sessionId, latest.observationId, { type: "activate" });
        return computer.observe("native-probe", grant.sessionId);
      };
      assert.deepEqual(
        Buffer.from(observation.image, "base64").subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );
      await computer.act("native-probe", grant.sessionId, observation.observationId, { type: "activate" });
      await delay(250);
      observation = await computer.observe("native-probe", grant.sessionId);
      observation = await focusObservation();
      const fieldText = `CoworkOS CUA 中文 😀 ${"长文本".repeat(30)}`;
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "click",
        x: observation.width / 2,
        y: observation.height - 170,
        button: "left"
      });
      observation = await focusObservation();
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "key",
        keys: ["Meta", "a"]
      });
      observation = await focusObservation();
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "type",
        text: fieldText
      });
      observation = await focusObservation();
      if (process.env.COWORK_KEEP_CUA_PROBE === "1")
        await writeFile(".tmp/computer-native-probe.png", Buffer.from(observation.image, "base64"));
      await wait((value) => value.text === fieldText);
      observation = await focusObservation();
      if (observation.accessibilityText) assert.ok(observation.accessibilityText.includes(fieldText));
      if (process.env.COWORK_KEEP_CUA_PROBE === "1")
        await writeFile(".tmp/computer-native-probe.png", Buffer.from(observation.image, "base64"));
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "click",
        x: 100,
        y: observation.height - 80,
        button: "left"
      });
      observation = await focusObservation();
      const documentText = "第一行 😀\nSecond line 中文\n第三行";
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "type",
        text: documentText
      });
      observation = await focusObservation();
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "click",
        x: 550,
        y: observation.height - 276,
        button: "left"
      });
      await wait((value) => value.saved);
      assert.deepEqual(JSON.parse(await readFile(join(root, "saved.json"), "utf8")), {
        field: fieldText,
        document: documentText
      });
      // Verify genuine AXSetValue / AXPress effects through the fixture's saved output.
      observation = await focusObservation();
      assert.equal(observation.accessibility.available, true);
      const inputElement = observation.accessibility.elements.find(
        (element) => element.name === "Probe input" && element.actions.includes("set_value")
      );
      assert.ok(inputElement, "native editable AX input must be discoverable");
      const axText = "AX 中文 😀 value";
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "set_value",
        elementId: inputElement.elementId,
        value: axText
      });
      const waited = await computer.wait(
        "native-probe",
        grant.sessionId,
        { type: "element", name: "Probe input", value: axText, state: "present" },
        5000
      );
      assert.equal(waited.status, "condition_met");
      observation = waited.observation;
      const saveElement = observation.accessibility.elements.find(
        (element) => element.name === "Save probe" && element.actions.includes("press")
      );
      assert.ok(saveElement, "native save AX button must be discoverable");
      await computer.act("native-probe", grant.sessionId, observation.observationId, {
        type: "press",
        elementId: saveElement.elementId
      });
      for (let index = 0; index < 100; index++) {
        if (JSON.parse(await readFile(join(root, "saved.json"), "utf8")).field === axText) break;
        await delay(50);
      }
      assert.equal(JSON.parse(await readFile(join(root, "saved.json"), "utf8")).field, axText);
      // Replacing the control with an identical label/value/identifier at its old
      // position must reject the old native identity, even with a fresh window credential.
      observation = await computer.observe("native-probe", grant.sessionId);
      const oldInput = observation.accessibility.elements.find(
        (element) => element.name === "Probe input" && element.actions.includes("set_value")
      );
      await writeFile(join(root, "control"), "replace");
      await wait((value) => value.replaced);
      await assert.rejects(
        computer.act("native-probe", grant.sessionId, observation.observationId, {
          type: "set_value",
          elementId: oldInput.elementId,
          value: "MUST_NOT_APPEAR"
        }),
        { errorCode: "stale_element", dispatchStatus: "not_sent" }
      );
      observation = await computer.observe("native-probe", grant.sessionId);
      if (process.env.COWORK_KEEP_CUA_PROBE === "1")
        await writeFile(".tmp/computer-native-saved.png", Buffer.from(observation.image, "base64"));
      await writeFile(join(root, "control"), "move");
      await wait((value) => value.moved);
      await assert.rejects(
        computer.act("native-probe", grant.sessionId, observation.observationId, {
          type: "type",
          text: "MUST_NOT_APPEAR"
        }),
        /位置和尺寸/
      );
      assert.equal(
        events.some((value) => value.text?.includes("MUST_NOT_APPEAR")),
        false
      );
      observation = await computer.observe("native-probe", grant.sessionId);
      await writeFile(join(root, "control"), "other");
      await wait((value) => value.otherWindow);
      await assert.rejects(
        computer.act("native-probe", grant.sessionId, observation.observationId, {
          type: "type",
          text: "MUST_NOT_APPEAR"
        }),
        /另一个窗口|失去焦点/
      );
      computer.takeOver();
      await assert.rejects(computer.observe("native-probe", grant.sessionId), /已暂停/);
    } finally {
      computer.close();
      if (child) {
        const exited =
          child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
        await writeFile(join(root, "control"), "quit");
        try {
          await Promise.race([
            exited,
            delay(3000).then(() => {
              throw new Error("probe quit timed out");
            })
          ]);
        } catch {
          if (fixturePid)
            try {
              process.kill(fixturePid, "SIGTERM");
            } catch {}
          child.kill("SIGTERM");
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);
