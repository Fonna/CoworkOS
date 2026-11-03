import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { ProjectExperienceStore } from "../dist/src/runtime/project-experience-store.js";
import { readProjectExperienceEvidence } from "../dist/src/runtime/project-experience-evidence.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

test(
  "real Pi refreshes project experience and generated Skill scope across disable and project changes",
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-project-experience-pi-"));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(root, "config.json"), "{}");
    const workspaceRoot = join(root, "workspace");
    const workspace = new LocalWorkspaceStore(workspaceRoot);
    const identityA = { projectId: "project-a", projectDirectory: join(root, "project-a") };
    const identityB = { projectId: "project-b", projectDirectory: join(root, "project-b") };
    const storeRoot = join(root, "home", "project-experience");
    const a = new ProjectExperienceStore(identityA, storeRoot);
    const b = new ProjectExperienceStore(identityB, storeRoot);
    for (const [store, identity, marker] of [
      [a, identityA, "PROJECT_A"],
      [b, identityB, "PROJECT_B"]
    ]) {
      await mkdir(identity.projectDirectory, { recursive: true });
      await store.configure({ enabled: true, learningEnabled: true, autoActivate: true });
      await store.save({
        kind: "experience",
        title: `${marker} convention`,
        description: "Project convention",
        content: `${marker}_FACT: Preserve this project's parser contract.`
      });
      for (let index = 0; index < 3; index++) {
        await store.applyProposal({
          taskId: `checked-${marker}-${index}`,
          runId: "run-checked",
          expectedGeneration: (await store.read()).generation,
          verified: true,
          changes: [
            {
              kind: "skill",
              title: `${marker} parser check`,
              description: `Use ${marker} parser check for parser changes.`,
              content: `${marker}_SKILL_BODY: Run the project's existing parser tests and inspect their result before accepting a change.`,
              quote: "The project parser tests were run.",
              validationQuote: "parser tests passed"
            }
          ]
        });
      }
      await store.configure({ learningEnabled: false });
    }
    const skillA = (await a.readProfile()).skills[0];
    const skillB = (await b.readProfile()).skills[0];
    assert.ok(skillA && skillB, "checked independent Tasks published managed Skill files");
    const nameA = `learned-${skillA.id}`;
    const nameB = `learned-${skillB.id}`;
    const skillAPath = await realpath(skillA.path);
    let phase = "load-and-disable";
    let step = 0;
    const failures = [];
    const provider = await modelProtocolFixture("openai-completions", async (body) => {
      try {
        const system = JSON.stringify(body.messages.filter((message) => message.role === "system"));
        const tool = [...body.messages].reverse().find((message) => message.role === "tool");
        if (phase === "load-and-disable") {
          if (step++ === 0) {
            assert.match(system, /PROJECT_A_FACT/);
            assert.ok(system.includes(nameA));
            assert.doesNotMatch(system, /PROJECT_B_FACT/);
            assert.ok(!system.includes(nameB));
            assert.doesNotMatch(system, /PROJECT_A_SKILL_BODY/, "Skill body is loaded only when requested");
            return { name: "load_skill", arguments: { name: nameA } };
          }
          if (step === 2) {
            assert.match(JSON.stringify(tool?.content), /PROJECT_A_SKILL_BODY/);
            const loaded = JSON.parse(
              typeof tool.content === "string"
                ? tool.content
                : tool.content.map((part) => part.text ?? "").join("")
            );
            assert.equal(await realpath(loaded.path), skillAPath);
            await a.configure({ enabled: false });
            return { name: "load_skill", arguments: { name: nameA } };
          }
          assert.doesNotMatch(system, /PROJECT_A_FACT/);
          assert.ok(!system.includes(nameA), "disabling removes the next request's managed catalog");
          assert.doesNotMatch(JSON.stringify(tool?.content), /PROJECT_A_SKILL_BODY/);
          assert.match(JSON.stringify(tool?.content), /not found|unknown|available|Unknown|不存在/i);
        } else if (phase === "disabled-next-task") {
          assert.doesNotMatch(system, /PROJECT_A_FACT|PROJECT_B_FACT/);
          assert.ok(!system.includes(nameA) && !system.includes(nameB));
        } else if (phase === "other-project") {
          assert.match(system, /PROJECT_B_FACT/);
          assert.ok(system.includes(nameB));
          assert.doesNotMatch(system, /PROJECT_A_FACT/);
          assert.ok(!system.includes(nameA));
        } else {
          assert.match(system, /PROJECT_A_FACT/);
          assert.ok(system.includes(nameA));
          assert.doesNotMatch(system, /PROJECT_B_FACT/);
          assert.ok(!system.includes(nameB));
        }
      } catch (error) {
        failures.push(error.message);
      }
      return { text: "Project knowledge check completed." };
    });
    t.after(() => provider.close());
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(COWORK_|ATRIA_|PI_|SERPER_|EXA_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/.test(
            key
          )
      )
    );
    Object.assign(env, {
      ATRIA_HOME: join(root, "home"),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_TABS_INDEX: join(root, "tabs.json"),
      COWORK_API_BASE: provider.baseUrl,
      COWORK_API_KEY: "fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_MODEL_API: "openai-completions",
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_WEB_TOOLS: "0",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    });
    const run = async (taskId, identity) => {
      step = 0;
      await workspace.createTask(taskId, { ...identity, goal: "Check project parser guidance" });
      await workspace.createRun(taskId, `run-${taskId}`);
      let output = "";
      child = spawn(
        process.execPath,
        [
          "scripts/atria.mjs",
          "--print",
          "--mode",
          "json",
          "--session-dir",
          join(root, "sessions", taskId),
          "Check the current project parser guidance."
        ],
        {
          cwd: resolve("."),
          env: {
            ...env,
            COWORK_PROJECT_DIR: identity.projectDirectory,
            COWORK_TASK_ID: taskId,
            COWORK_RUN_ID: `run-${taskId}`
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const [code] = await once(child, "exit");
      assert.equal(code, 0, output.slice(-5000));
      assert.deepEqual(failures, [], output.slice(-5000));
    };
    await run("project-load", identityA);
    assert.equal(step, 3, "the real host executed both skill load calls");
    phase = "disabled-next-task";
    await run("project-disabled", identityA);
    phase = "other-project";
    await run("project-other", identityB);
    await a.configure({ enabled: true, learningEnabled: true });
    phase = "reenabled-project";
    await run("project-return", identityA);
    const learnedRun = await readProjectExperienceEvidence({
      identity: identityA,
      workspaceRoot,
      taskId: "project-return",
      runId: "run-project-return"
    });
    assert.equal(
      learnedRun?.status,
      "completed",
      "standalone completion persisted bounded terminal receipts"
    );
    assert.ok(
      (await a.read()).pending.some((item) => item.taskId === "project-return"),
      "standalone finalized Run queued project learning"
    );
    assert.equal(provider.requests.length, 6);
  }
);
