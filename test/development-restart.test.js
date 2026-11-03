import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  developmentLaunchEnvironment,
  restartDevelopment,
  waitForExit
} from "../scripts/restart-development.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-restart-development-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, nodeExecutable: process.execPath, npmCli: join(root, "npm-cli.js") };
}

async function runningChild(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
  });
  return { child, exited };
}

test("development restart waits for the actual old PID to exit before replacing and launching the Finder entry", async (t) => {
  const options = await fixture(t);
  const { child, exited } = await runningChild(t);
  const directory = join(options.root, "Applications");
  const entry = join(directory, "CoworkOS Dev.app/Contents/MacOS/CoworkOS Dev");
  const actions = [];
  const restarting = restartDevelopment({
    ...options,
    pid: child.pid,
    entry,
    pollMs: 5,
    installDevelopmentAppImpl: async (received) => {
      assert.equal(child.exitCode === null && child.signalCode === null, false);
      assert.equal(received.directory, directory);
      assert.deepEqual(received.toolchain, {
        nodeExecutable: options.nodeExecutable,
        npmCli: options.npmCli
      });
      actions.push("install");
      return entry;
    },
    launchImpl: async (executable) => {
      assert.equal(executable, entry);
      actions.push("launch");
    }
  });
  await delay(30);
  assert.deepEqual(actions, []);
  child.kill("SIGTERM");
  await exited;
  assert.deepEqual(await restarting, { restarted: true, executable: entry });
  assert.deepEqual(actions, ["install", "launch"]);
});

test("development restart timeout keeps the existing runtime and does not launch another App", async (t) => {
  const options = await fixture(t);
  const { child } = await runningChild(t);
  let installations = 0,
    launches = 0;
  await assert.rejects(
    restartDevelopment({
      ...options,
      pid: child.pid,
      timeoutMs: 30,
      pollMs: 5,
      developmentExecutableImpl: async () => {
        installations++;
        return "unused";
      },
      launchImpl: async () => {
        launches++;
      }
    }),
    /尚未退出/
  );
  assert.equal(installations, 0);
  assert.equal(launches, 0);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("cached development launch refreshes its own runtime without publishing a Finder entry", async (t) => {
  const options = await fixture(t);
  const entry = join(
    options.root,
    ".tmp/desktop-runtime/previous/CoworkOS Dev.app/Contents/MacOS/CoworkOS Dev"
  );
  const executable = join(
    options.root,
    ".tmp/desktop-runtime/next/CoworkOS Dev.app/Contents/MacOS/CoworkOS Dev"
  );
  const actions = [];
  const result = await restartDevelopment({
    ...options,
    pid: 42,
    entry,
    waitForExitImpl: async (pid) => {
      assert.equal(pid, 42);
      actions.push("exit");
    },
    installDevelopmentAppImpl: async () => {
      assert.fail("Must not install a Finder entry");
    },
    developmentExecutableImpl: async (received) => {
      assert.equal(received.root, options.root);
      actions.push("runtime");
      return executable;
    },
    launchImpl: async (received) => {
      assert.equal(received, executable);
      actions.push("launch");
    }
  });
  assert.equal(result.restarted, true);
  assert.deepEqual(actions, ["exit", "runtime", "launch"]);
});

test("a failed development runtime refresh never launches an incomplete App", async (t) => {
  const options = await fixture(t);
  let launches = 0;
  await assert.rejects(
    restartDevelopment({
      ...options,
      pid: 42,
      waitForExitImpl: async () => {},
      developmentExecutableImpl: async () => {
        throw new Error("Runtime refresh failed");
      },
      launchImpl: async () => {
        launches++;
      }
    }),
    /Runtime refresh failed/
  );
  assert.equal(launches, 0);
});

test("restart imports the updated development helper only after exit", async (t) => {
  const options = await fixture(t);
  await mkdir(join(options.root, "scripts"));
  const module = join(options.root, "scripts/desktop-dev.mjs");
  await writeFile(
    module,
    "export async function developmentExecutable(){ throw new Error('Old helper'); }\n"
  );
  let launched;
  await restartDevelopment({
    ...options,
    pid: 42,
    waitForExitImpl: async () => {
      await writeFile(module, "export async function developmentExecutable(){ return 'new-runtime'; }\n");
    },
    launchImpl: async (executable) => {
      launched = executable;
    }
  });
  assert.equal(launched, "new-runtime");
});

test("invalid restart metadata is rejected before waiting or touching an application", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    restartDevelopment({
      ...options,
      pid: 42,
      entry: join(options.root, "Other.app/Contents/MacOS/Other"),
      waitForExitImpl: async () => assert.fail("Must not wait for invalid metadata")
    }),
    /入口无效/
  );
  await assert.rejects(restartDevelopment({ ...options, root: "relative", pid: 42 }), /工具链路径/);
  await assert.rejects(waitForExit(process.pid), /进程 ID 无效/);
  await assert.rejects(waitForExit(-1), /进程 ID 无效/);
});

test("restart preserves the selected data and workspace paths without forwarding model credentials", async (t) => {
  const options = await fixture(t);
  const data = join(options.root, "selected-profile");
  const workspace = join(options.root, "selected-workspace");
  await mkdir(data);
  await writeFile(join(data, "draft.txt"), "existing draft\n");
  const runtimeEnvironment = { COWORK_DESKTOP_DATA: data, COWORK_WORKSPACE: workspace };
  let launchedEnvironment;
  await restartDevelopment({
    ...options,
    pid: 42,
    runtimeEnvironment,
    waitForExitImpl: async () => {
      assert.equal(await readFile(join(data, "draft.txt"), "utf8"), "existing draft\n");
    },
    developmentExecutableImpl: async () => "new-runtime",
    launchImpl: async (_executable, received) => {
      launchedEnvironment = developmentLaunchEnvironment(received, {
        PATH: "/usr/bin",
        COWORK_API_KEY: "fixture-model-key",
        COWORK_MODEL: "fixture-model",
        COWORK_CONFIG: join(options.root, "config.json"),
        COWORK_DESKTOP_DATA: join(options.root, "other-profile"),
        PI_CODING_AGENT_DIR: join(options.root, "other-pi"),
        ELECTRON_RUN_AS_NODE: "1"
      });
    }
  });
  assert.equal(launchedEnvironment.COWORK_DESKTOP_DATA, data);
  assert.equal(launchedEnvironment.COWORK_WORKSPACE, workspace);
  assert.equal(launchedEnvironment.COWORK_DESKTOP_NODE_EXECUTABLE, options.nodeExecutable);
  assert.equal(launchedEnvironment.COWORK_DESKTOP_NPM_CLI, options.npmCli);
  assert.equal(launchedEnvironment.PATH, "/usr/bin");
  for (const name of [
    "COWORK_API_KEY",
    "COWORK_MODEL",
    "COWORK_CONFIG",
    "PI_CODING_AGENT_DIR",
    "ELECTRON_RUN_AS_NODE"
  ])
    assert.equal(launchedEnvironment[name], undefined);
  assert.equal(await readFile(join(data, "draft.txt"), "utf8"), "existing draft\n");
});

test("restart rejects secret fields and relative paths in its profile metadata", async (t) => {
  const options = await fixture(t);
  for (const runtimeEnvironment of [
    { COWORK_API_KEY: "fixture-model-key" },
    { COWORK_WORKSPACE: "relative" },
    { COWORK_DESKTOP_DATA: 42 },
    ["not-a-map"]
  ]) {
    await assert.rejects(
      restartDevelopment({
        ...options,
        pid: 42,
        runtimeEnvironment,
        waitForExitImpl: async () => assert.fail("Must reject before waiting")
      }),
      /路径/
    );
  }
});
