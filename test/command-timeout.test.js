import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  configuredCommandTimeout
} from "../dist/src/runtime/runtime-settings.js";

const inherited = process.env.COWORK_COMMAND_TIMEOUT_MS;
before(() => {
  delete process.env.COWORK_COMMAND_TIMEOUT_MS;
});
after(() => {
  if (inherited === undefined) delete process.env.COWORK_COMMAND_TIMEOUT_MS;
  else process.env.COWORK_COMMAND_TIMEOUT_MS = inherited;
});

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-command-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("command timeout falls back to the default and reads the environment override", () => {
  assert.equal(configuredCommandTimeout({}), DEFAULT_COMMAND_TIMEOUT_MS);
  assert.equal(configuredCommandTimeout({ COWORK_COMMAND_TIMEOUT_MS: "7200000" }), 7_200_000);
  // Zero is a meaningful value here: an unlimited deadline for long jobs.
  assert.equal(configuredCommandTimeout({ COWORK_COMMAND_TIMEOUT_MS: "0" }), 0);
  assert.equal(
    configuredCommandTimeout({ COWORK_COMMAND_TIMEOUT_MS: "not-a-number" }),
    DEFAULT_COMMAND_TIMEOUT_MS
  );
});

test("a long command survives when the deadline is unlimited", async (t) => {
  const root = await workspace(t);
  const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 0 });
  const result = await tools
    .get("run_command")
    .execute({ command: "sh", args: ["-c", "sleep 1; echo finished"] });
  assert.equal(result.failed, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "finished");
});

test("a command killed by its deadline is reported as a timeout, not a crash", async (t) => {
  const root = await workspace(t);
  const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 300 });
  const result = await tools.get("run_command").execute({ command: "sleep", args: ["30"] });
  assert.equal(result.failed, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 300);
});

test("an ordinary failure is not mislabeled as a timeout", async (t) => {
  const root = await workspace(t);
  const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 30_000 });
  const nonZero = await tools.get("run_command").execute({ command: "sh", args: ["-c", "exit 3"] });
  assert.equal(nonZero.failed, true);
  assert.equal(nonZero.exitCode, 3);
  assert.equal(nonZero.timedOut, undefined);
  // A process that signals itself also reports SIGTERM; it did not reach its deadline.
  const selfKilled = await tools.get("run_command").execute({ command: "sh", args: ["-c", "kill -TERM $$"] });
  assert.equal(selfKilled.failed, true);
  assert.equal(selfKilled.signal, "SIGTERM");
  assert.equal(selfKilled.timedOut, undefined);
});

test(
  "cancelling a foreground command stops its actual child without labeling it a timeout",
  { timeout: 5000 },
  async (t) => {
    const root = await workspace(t);
    const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 30000 });
    const controller = new AbortController();
    const pending = tools.get("run_command").execute(
      {
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(()=>{},1000)"]
      },
      controller.signal
    );
    t.after(async () => {
      controller.abort();
      await pending;
    });
    let pid;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try {
        pid = Number(await readFile(join(root, "pid.txt"), "utf8"));
      } catch {
        await wait(10);
      }
    }
    assert.ok(pid);
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.isError, true);
    assert.equal(result.timedOut, undefined);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
);

async function waitForFile(path) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await wait(10);
    }
  }
  assert.fail(`process fixture did not create ${path}`);
}

function treeScript(tag) {
  const worker = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync('${tag}-worker.pid', String(process.pid));
    const tick = () => fs.writeFileSync('${tag}-ticks.txt', String(Date.now()));
    tick(); setInterval(tick, 10);
  `;
  return `
    const fs = require('node:fs');
    fs.writeFileSync('${tag}-wrapper.pid', String(process.pid));
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio: 'ignore'});
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
}

async function trackTree(t, root, tag) {
  const pids = await Promise.all(
    ["worker", "wrapper"].map(async (role) => Number(await waitForFile(join(root, `${tag}-${role}.pid`))))
  );
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  });
  await waitForFile(join(root, `${tag}-ticks.txt`));
}

async function assertTreeStopped(root, tag) {
  // A heartbeat checks observable work rather than treating an unreaped Unix zombie as alive.
  await wait(50);
  const before = await readFile(join(root, `${tag}-ticks.txt`), "utf8");
  await wait(150);
  assert.equal(await readFile(join(root, `${tag}-ticks.txt`), "utf8"), before);
}

test(
  "explicit foreground cancellation reaps descendants when their wrapper exits first",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const root = await workspace(t);
    const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 0 });
    const controller = new AbortController();
    const pending = tools
      .get("run_command")
      .execute({ command: process.execPath, args: ["-e", treeScript("cancel")] }, controller.signal);
    t.after(async () => {
      controller.abort();
      await pending;
    });
    await trackTree(t, root, "cancel");
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, undefined);
    await assertTreeStopped(root, "cancel");
  }
);

test(
  "a foreground deadline reaps TERM-ignoring descendants",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const root = await workspace(t);
    const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 1000 });
    const pending = tools
      .get("run_tests")
      .execute({ command: process.execPath, args: ["-e", treeScript("deadline")] });
    await trackTree(t, root, "deadline");
    const result = await pending;
    assert.equal(result.failed, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.timeoutMs, 1000);
    await assertTreeStopped(root, "deadline");
  }
);

test(
  "group EPERM falls back to live members and cleanup sends KILL only once",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const root = await workspace(t);
    const realKill = process.kill.bind(process);
    let groupKills = 0;
    t.mock.method(process, "kill", (pid, signal) => {
      if (pid < 0 && signal === "SIGKILL") {
        groupKills += 1;
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    const controller = new AbortController();
    const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 0 });
    const pending = tools
      .get("run_command")
      .execute({ command: process.execPath, args: ["-e", treeScript("eperm")] }, controller.signal);
    t.after(async () => {
      controller.abort();
      await pending;
    });
    await trackTree(t, root, "eperm");
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, undefined);
    assert.equal(groupKills, 1);
    await assertTreeStopped(root, "eperm");
  }
);

test(
  "a deadline force-stops a foreground command that ignores TERM",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const root = await workspace(t);
    const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 1000 });
    const pending = tools.get("run_command").execute({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{}); const fs=require('fs'); fs.writeFileSync('stubborn.pid',String(process.pid)); const tick=()=>fs.writeFileSync('stubborn-ticks.txt',String(Date.now())); tick(); setInterval(tick,10)"
      ]
    });
    const pid = Number(await waitForFile(join(root, "stubborn.pid")));
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    const result = await pending;
    assert.equal(result.timedOut, true);
    await assertTreeStopped(root, "stubborn");
  }
);

test(
  "cancelling one foreground command leaves another command running",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const root = await workspace(t);
    const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 0 });
    const first = new AbortController();
    const other = new AbortController();
    const start = (tag, controller) =>
      tools
        .get("run_command")
        .execute({ command: process.execPath, args: ["-e", treeScript(tag)] }, controller.signal);
    const firstRun = start("first", first);
    const otherRun = start("other", other);
    t.after(async () => {
      first.abort();
      other.abort();
      await Promise.allSettled([firstRun, otherRun]);
    });
    await Promise.all([trackTree(t, root, "first"), trackTree(t, root, "other")]);
    first.abort();
    await firstRun;
    await assertTreeStopped(root, "first");
    const before = await readFile(join(root, "other-ticks.txt"), "utf8");
    await wait(100);
    assert.notEqual(await readFile(join(root, "other-ticks.txt"), "utf8"), before);
    other.abort();
    await otherRun;
    await assertTreeStopped(root, "other");
  }
);

test(
  "foreground process ownership survives an abrupt owner SIGKILL",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const root = await workspace(t);
    const launcher = join(root, "owner.mjs");
    const builtinUrl = new URL("../dist/src/tools/builtin.js", import.meta.url).href;
    await writeFile(
      launcher,
      `import {createBuiltinTools} from ${JSON.stringify(builtinUrl)};
       await createBuiltinTools({rootDirectory:process.cwd(),commandTimeoutMs:0}).get('run_command').execute(
         {command:process.execPath,args:['-e',${JSON.stringify(treeScript("owner"))}]});`
    );
    const owner = spawn(process.execPath, [launcher], {
      cwd: root,
      stdio: "ignore"
    });
    const closed = once(owner, "close");
    t.after(() => owner.kill("SIGKILL"));
    await trackTree(t, root, "owner");
    owner.kill("SIGKILL");
    await closed;
    // The command host detects lifecycle-pipe EOF and has its own bounded shutdown.
    await wait(1500);
    await assertTreeStopped(root, "owner");
  }
);

test(
  "normal foreground completion does not leave unregistered descendants running",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const root = await workspace(t);
    const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 0 });
    const script = `${treeScript("completed")}
      const timer = setInterval(() => {
        if (fs.existsSync('completed-ticks.txt')) { clearInterval(timer); console.log('finished'); process.exit(0); }
      }, 10);`;
    const pending = tools.get("run_command").execute({ command: process.execPath, args: ["-e", script] });
    await trackTree(t, root, "completed");
    const result = await pending;
    assert.equal(result.failed, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "finished");
    assert.equal(result.timedOut, undefined);
    await assertTreeStopped(root, "completed");
  }
);

test("output limits remain errors and are not mislabeled as deadlines", async (t) => {
  const root = await workspace(t);
  const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 30_000, maxOutputBytes: 64 });
  for (const stream of ["stdout", "stderr"]) {
    const result = await tools.get("run_command").execute({
      command: process.execPath,
      args: ["-e", `process.${stream}.write('x'.repeat(1024));setInterval(()=>{},1000)`]
    });
    assert.equal(result.failed, true);
    assert.equal(result.isError, true);
    assert.equal(result.timedOut, undefined);
    assert.ok(Buffer.byteLength(result[stream]) <= 64);
  }
});

test("UTF-8 output limits never add a replacement character beyond the byte budget", async (t) => {
  const root = await workspace(t);
  const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 30_000, maxOutputBytes: 64 });
  for (const stream of ["stdout", "stderr"]) {
    const result = await tools.get("run_command").execute({
      command: process.execPath,
      args: ["-e", `process.${stream}.write('中'.repeat(100));setInterval(()=>{},1000)`]
    });
    assert.equal(result.failed, true);
    assert.equal(result.timedOut, undefined);
    assert.ok(Buffer.byteLength(result[stream]) <= 64);
    assert.equal(result[stream], "中".repeat(21));
  }
});

test("a foreground command that cannot start remains an explicit tool error", async (t) => {
  const root = await workspace(t);
  const tools = createBuiltinTools({ rootDirectory: root, commandTimeoutMs: 30_000 });
  const result = await tools.get("run_command").execute({ command: "atria-nonexistent-command" });
  assert.equal(result.failed, true);
  assert.equal(result.isError, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, undefined);
  assert.match(result.stderr, /ENOENT/);
});
