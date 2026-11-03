import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const toolResult = (body) =>
  JSON.parse(messageText(body.messages.findLast((message) => message.role === "tool")));
const harnessNames = ["blender-harness", "cad-harness", "freecad-harness", "office-harness"];

// Script a real Main session through bind/rebind/detach, dispatch and durable
// recovery. The local provider checks routing plumbing, not model preference.
test(
  "real Pi scopes harness skills through binding, dispatch, detach and queue recovery",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-harness-skills-pi-"));
    const workspace = join(root, "workspace"),
      project = join(root, "project"),
      home = join(root, "atria");
    const taskId = "skills-task",
      runId = "skills-run";
    await mkdir(project);
    await mkdir(home);
    await writeFile(join(project, "boundary.txt"), "Refresh the current application context.\n");
    await writeFile(join(root, "config.json"), "{}");
    const userSkillPath = join(root, "pi", "skills", "blender", "SKILL.md");
    await mkdir(join(root, "pi", "skills", "blender"), { recursive: true });
    await writeFile(
      userSkillPath,
      "---\nname: blender\ndescription:\n  USER_BLENDER_WORKFLOW selected by the SDK.\n---\nUSER_BLENDER_WORKFLOW body."
    );
    const plugins = [
      {
        name: "blender-harness",
        skill: "blender",
        marker: "BLENDER_EXTERNAL_WORKFLOW",
        kind: "application/blender-session+json"
      },
      {
        name: "cad-harness",
        skill: "cad",
        marker: "CAD_EXTERNAL_WORKFLOW",
        kind: "application/cad-session+json"
      },
      {
        name: "office-harness",
        skill: "ppt",
        marker: "OFFICE_EXTERNAL_WORKFLOW",
        kind: "application/office-session+json"
      }
    ];
    for (const plugin of plugins) {
      plugin.path = join(root, plugin.name);
      const skillDir = join(plugin.path, "skills", plugin.skill);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---\nname: ${plugin.skill}\ndescription: ${plugin.marker}\n---\n${plugin.marker} body.\n`
      );
    }
    await writeFile(join(home, "plugin-registry.json"), JSON.stringify({ plugins }));
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask(taskId, { goal: "Verify scoped application workflows" });
    await store.createRun(taskId, runId);
    const service = new ApplicationService(workspace);
    for (const plugin of plugins) {
      const created = await service.createResource({
        taskId,
        kind: plugin.kind,
        title: plugin.name,
        actor: { type: "user", id: "local" }
      });
      plugin.resourceId = created.resource.resourceId;
    }
    const failures = [],
      steps = { main: 0, child: 0, general: 0, recovered: 0 };
    let child,
      exited,
      output = "",
      recovering = false;
    const boundary = { name: "read", arguments: { path: join(project, "boundary.txt") } };
    const provider = await modelProtocolFixture("openai-completions", async (body) => {
      try {
        const system = body.messages
          .filter((message) => ["system", "developer"].includes(message.role))
          .map(messageText)
          .join("\n");
        const delegated = system.includes("You are a CoworkOS Subagent");
        const role = delegated
          ? recovering
            ? "recovered"
            : system.includes("BLENDER_EXTERNAL_WORKFLOW")
              ? "child"
              : "general"
          : "main";
        const step = ++steps[role];
        if (role === "general") {
          assert.ok(
            system.includes("USER_BLENDER_WORKFLOW"),
            "ordinary delegates inherit the SDK-selected user override"
          );
          for (const name of harnessNames) assert.ok(!system.includes(`- ${name}:`), name);
          if (step === 1) return { name: "load_skill", arguments: { name: "blender" } };
          assert.equal(step, 2);
          assert.match(toolResult(body).content, /USER_BLENDER_WORKFLOW body/);
          return { text: "User workflow loaded." };
        }
        if (delegated) {
          assert.ok(
            system.includes("BLENDER_EXTERNAL_WORKFLOW"),
            "dispatch/recovery inherits the application catalog"
          );
          assert.ok(system.includes("blender-harness"));
          assert.ok(!system.includes("office-harness"));
          if (step === 1) return { name: "load_skill", arguments: { name: "blender" } };
          assert.equal(step, 2);
          assert.match(toolResult(body).content, /BLENDER_EXTERNAL_WORKFLOW body/);
          return { text: "External Blender workflow loaded." };
        }
        const catalog = system.match(/<skills>[\s\S]*?<\/skills>/g)?.at(-1) ?? "";
        if (step === 1 || step === 9) {
          for (const name of harnessNames) assert.ok(!catalog.includes(`<name>${name}</name>`), name);
          assert.ok(
            catalog.includes(userSkillPath),
            "the SDK-selected user override is restored outside harness scope"
          );
        }
        if (step === 1) {
          await service.bindResource(taskId, plugins[0].resourceId);
          return boundary;
        }
        if ([2, 5, 7].includes(step)) {
          const plugin = plugins[step === 2 ? 0 : step === 5 ? 1 : 2];
          assert.ok(
            catalog.includes(join(plugin.path, "skills", plugin.skill, "SKILL.md")),
            `catalog includes ${plugin.name}'s actual skill path`
          );
          assert.ok(catalog.includes(`<name>${plugin.name}</name>`));
          for (const name of harnessNames.filter((name) => name !== plugin.name))
            assert.ok(!catalog.includes(`<name>${name}</name>`), name);
          return { name: "load_skill", arguments: { name: plugin.skill } };
        }
        if (step === 3) {
          assert.match(toolResult(body).content, /BLENDER_EXTERNAL_WORKFLOW body/);
          return {
            name: "call_subagent",
            arguments: {
              mode: "sync",
              task: "Load the bound Blender application's blender skill and report its marker."
            }
          };
        }
        if (step === 4) {
          const result = toolResult(body);
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          assert.match(result.response, /External Blender workflow loaded/);
          await service.bindResource(taskId, plugins[1].resourceId);
          return boundary;
        }
        if (step === 6) {
          assert.match(toolResult(body).content, /CAD_EXTERNAL_WORKFLOW body/);
          await service.bindResource(taskId, plugins[2].resourceId);
          return boundary;
        }
        if (step === 8) {
          assert.match(toolResult(body).content, /OFFICE_EXTERNAL_WORKFLOW body/);
          await service.bindResource(taskId, undefined);
          return boundary;
        }
        if (step === 9) return { name: "load_skill", arguments: { name: "blender" } };
        if (step === 10) {
          assert.match(toolResult(body).content, /USER_BLENDER_WORKFLOW body/);
          return {
            name: "call_subagent",
            arguments: {
              mode: "sync",
              task: "Load the ordinary SDK-selected blender skill and report its marker."
            }
          };
        }
        assert.equal(step, 11);
        assert.equal(toolResult(body).status, "succeeded");
        assert.match(toolResult(body).response, /User workflow loaded/);
        return { text: "Application skill scopes verified." };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "Skill scope fixture failed." };
      }
    });
    t.after(async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
        await exited;
      }
      await provider.close();
      await rm(root, { recursive: true, force: true });
    });
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name) && name !== "NODE_OPTIONS"
      )
    );
    child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-id",
        runId,
        "--session-dir",
        join(root, "sessions"),
        "Verify scoped application workflows."
      ],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...inherited,
          ATRIA_HOME: home,
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: workspace,
          COWORK_PROJECT_DIR: project,
          COWORK_TASK_ID: taskId,
          COWORK_RUN_ID: runId,
          COWORK_GLOBAL_INDEX: join(root, "index.json"),
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: provider.baseUrl,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "protocol-fixture",
          COWORK_MODEL_API: "openai-completions",
          COWORK_DASHBOARD_URL: "",
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          COWORK_WEB_TOOLS: "0",
          COWORK_MAX_ATTEMPTS: "1",
          COWORK_SUBAGENT_TIMEOUT_MS: "20000",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    exited = once(child, "exit");
    const record = (chunk) => {
      output = (output + chunk).slice(-20_000);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.deepEqual(steps, { main: 11, child: 2, general: 2, recovered: 0 });

    const queue = new DurableScheduler(join(workspace, taskId, "runs", runId, "queue.json"));
    const dispatched = (await queue.list())[0];
    assert.deepEqual(dispatched.payload.skillApplications, ["blender-harness"]);
    assert.equal(dispatched.payload.skillRoots[1], join(plugins[0].path, "skills"));
    // Re-drive a durable queued call after Main has detached. Startup defaults
    // deliberately omit the application; only the saved dispatch can restore it.
    await queue.enqueue({
      stepId: "recover-skill-scope",
      taskId,
      runId,
      agentId: "recovered-agent",
      importance: "normal",
      payload: dispatched.payload
    });
    recovering = true;
    const results = await new CoordinatorRuntime().recoverRun({
      taskId,
      runId,
      workspaceRoot: workspace,
      baseUrl: provider.baseUrl,
      apiKey: "local-fixture",
      model: "protocol-fixture",
      api: "openai-completions",
      supportsReasoningEffort: false,
      skillRoots: [resolve(".pi/skills")],
      skillApplications: [],
      maxAttempts: 1,
      questionTimeoutMs: 0,
      maxErrorRetries: 0,
      timeoutMs: 20_000
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "succeeded", JSON.stringify(results));
    assert.match(results[0].response, /External Blender workflow loaded/);
    assert.deepEqual(failures, []);
    assert.equal(steps.recovered, 2);
    assert.match(await readFile(join(project, "boundary.txt"), "utf8"), /Refresh/);
  }
);
