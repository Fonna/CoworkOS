import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
test(
  "base CLI completes a real Main/file/delegation lifecycle and resumes without installing optional components",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-base-components-pi-"));
    const harness = resolve(process.env.TEST_ATRIA_CLI_ROOT || ".");
    const workspace = join(root, "workspace"),
      project = join(root, "project"),
      sessions = join(root, "sessions"),
      components = join(root, "components");
    await mkdir(project);
    await mkdir(components);
    await writeFile(join(root, "config.json"), "{}");
    let mainCalls = 0,
      subagentCalls = 0,
      child,
      childExit,
      output = "";
    const model = await modelProtocolFixture("openai-completions", (body) => {
      const names = body.tools?.map((tool) => tool.function.name) || [];
      if (!names.includes("call_subagent")) {
        subagentCalls++;
        return { text: "BASE_SUBAGENT_COMPLETED" };
      }
      mainCalls++;
      if (mainCalls === 1)
        return {
          name: "bash",
          arguments: { command: `printf base-file-content > ${quote(join(project, "base.txt"))}` }
        };
      if (mainCalls === 2)
        return {
          name: "call_subagent",
          arguments: { task: "BASE_SUBAGENT_TASK: verify this ordinary base task", mode: "sync" }
        };
      if (mainCalls === 3) return { text: "BASE_MAIN_COMPLETED" };
      assert.match(JSON.stringify(body.messages), /BASE_MAIN_COMPLETED/);
      assert.match(JSON.stringify(body.messages), /BASE_MAIN_START/);
      return { text: "BASE_RESTART_RECOVERED" };
    });
    t.after(async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        await childExit;
      }
      await model.close();
      await rm(root, { recursive: true, force: true });
    });
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("base-task", { goal: "base lifecycle" });
    await store.createRun("base-task", "base-run");
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name)
        )
      ),
      HOME: join(root, "home"),
      ATRIA_HOME: join(root, "home"),
      ATRIA_COMPONENTS_HOME: components,
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_WORKSPACE: workspace,
      COWORK_PROJECT_DIR: project,
      COWORK_TASK_ID: "base-task",
      COWORK_RUN_ID: "base-run",
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_TABS_INDEX: join(root, "tabs.json"),
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_MODEL_API: "openai-completions",
      COWORK_HARNESS_ROOT: harness,
      COWORK_DASHBOARD_URL: "",
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      COWORK_WEB_TOOLS: "0",
      COWORK_SERPER_API_KEY: "",
      SERPER_API_KEY: "",
      COWORK_CADQUERY_PYTHON: join(root, "missing-cadquery"),
      COWORK_BLENDER_EXECUTABLE: join(root, "missing-blender"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    };
    async function launch(args) {
      child = spawn(
        process.execPath,
        [
          join(harness, "scripts/start-pi.mjs"),
          "--print",
          "--mode",
          "json",
          "--session-dir",
          sessions,
          ...args
        ],
        { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }
      );
      childExit = once(child, "exit");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      assert.equal((await childExit)[0], 0, output);
    }
    await launch(["--session-id", "22222222-2222-4222-8222-222222222222", "BASE_MAIN_START"]);
    assert.equal(await readFile(join(project, "base.txt"), "utf8"), "base-file-content");
    assert.equal(subagentCalls, 1, output);
    assert.match(output, /BASE_MAIN_COMPLETED/);
    const files = (await readdir(sessions)).filter((file) => file.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    await launch(["--session", join(sessions, files[0]), "BASE_RESTART_CONTINUE"]);
    assert.equal(mainCalls, 4, output);
    assert.match(output, /BASE_RESTART_RECOVERED/);
    assert.deepEqual(await readdir(components), []);
    assert.match(await readFile(join(sessions, files[0]), "utf8"), /BASE_SUBAGENT_COMPLETED/);
    assert.equal(await readFile(join(project, "base.txt"), "utf8"), "base-file-content");
  }
);
