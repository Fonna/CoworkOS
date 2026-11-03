import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";

/**
 * Registration is Main's acceptance action. These tests pin what that means:
 * the package is validated, its probe must actually run, and a rule that
 * cannot run is never allowed to poll and report quiet.
 */

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const TASK = "activation-task";
const RUN = `main-${TASK}`;

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerProvider() {},
    registerCommand() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendMessage: async () => {}
  };
}

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

/** A package written where the authoring skill tells authors to draft one. */
async function harness(t, { rule, wake = "important" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-activation-"));
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  process.env.COWORK_API_BASE = "https://example.test";
  process.env.COWORK_API_KEY = "test-key";
  process.env.COWORK_CONFIG = join(root, "config.json");
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  process.env.COWORK_WORKSPACE = root;
  process.env.COWORK_TASK_ID = TASK;
  process.env.COWORK_RUN_ID = RUN;
  process.env.COWORK_HARNESS_ROOT = process.cwd();
  const store = new LocalWorkspaceStore(root);
  await store.createTask(TASK, { goal: "watch a topic" });
  await store.createRun(TASK, RUN);

  const relative = join("agents", "main", "work", "virtual-agents", "observer");
  const directory = join(root, TASK, relative);
  await mkdir(join(directory, "watcher"), { recursive: true });
  await mkdir(join(directory, "tests"), { recursive: true });
  await writeFile(join(directory, "AGENT.md"), "Report verified changes only.");
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      name: "test-observer",
      version: "0.1.0",
      entrypoint: "watcher/rule.mjs",
      handler: "AGENT.md",
      sources: ["https://example.test/announcements"],
      state: "watcher/state.json",
      events: { dedupeKey: "source id and version", wake }
    })
  );
  // A local fixture rule: no network, so the probe is deterministic.
  await writeFile(
    join(directory, "watcher/rule.mjs"),
    rule ??
      `export default async function check(context) {
  const seen = (context.previousState?.seen ?? 0) + 1;
  return { events: seen === 1 ? [{ source: "fixture", type: "source.changed", dedupeKey: "fixture-1", payload: { seen } }] : [], state: { seen } };
}\n`
  );

  const pi = fakePi();
  (await loadExtension())(pi);
  return { root, store, pi, relative };
}

const ctx = { ui: { notify() {}, setStatus() {} } };

test("a reviewed package activates, installs its rule, and records a baseline", async (t) => {
  const { root, pi, relative } = await harness(t);
  const result = await pi.tools
    .get("activate_virtual_agent")
    .execute(
      "call-1",
      { path: relative, task: "watch official announcements", cadenceSeconds: 3600 },
      undefined,
      undefined,
      ctx
    );

  assert.equal(result.details.activated, true);
  assert.equal(result.details.probe.events, 1);
  const { programId, monitorId } = result.details;

  const programs = new WatchProgramStore(root);
  const found = await programs.findVirtualAgent(TASK, monitorId);
  assert.ok(found, "the monitor resolves through the control plane");
  assert.equal(found.monitor.status, "active");
  assert.equal(found.monitor.profileId, "custom");
  assert.deepEqual(found.monitor.sourcesHint, ["https://example.test/announcements"]);
  assert.equal((await programs.readVirtualAgentState(TASK, programId, monitorId)).status, "active");

  // The rule and the accepted handler live where ScriptWatcher polls them.
  const monitorDirectory = join(root, TASK, "agents", "subagents", monitorId, "watcher");
  assert.match(
    await readFile(join(monitorDirectory, "rule.mjs"), "utf8"),
    /export default async function check/
  );
  assert.equal(await readFile(join(monitorDirectory, "AGENT.md"), "utf8"), "Report verified changes only.");
  // Registration established the cursor, so the next poll reports what is new.
  assert.deepEqual(JSON.parse(await readFile(join(monitorDirectory, "state.json"), "utf8")), { seen: 1 });
});

test("events.wake carries onto the monitor unchanged", async (t) => {
  const { root, pi, relative } = await harness(t, { wake: "always" });
  const result = await pi.tools
    .get("activate_virtual_agent")
    .execute("call-1", { path: relative, task: "watch", cadenceSeconds: 3600 }, undefined, undefined, ctx);
  assert.equal(
    (await new WatchProgramStore(root).findVirtualAgent(TASK, result.details.monitorId)).monitor.wake,
    "always"
  );
});

test("a rule that cannot run is registered as a draft and never polls", async (t) => {
  const { root, pi, relative } = await harness(t, {
    rule: 'export default async function check() { throw new Error("source unreachable"); }\n'
  });
  const result = await pi.tools
    .get("activate_virtual_agent")
    .execute("call-1", { path: relative, task: "watch", cadenceSeconds: 3600 }, undefined, undefined, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.details.activated, false);
  assert.equal(result.details.reason, "probe_failed");
  assert.match(result.details.error, /source unreachable/);

  const programs = new WatchProgramStore(root);
  assert.equal((await programs.findVirtualAgent(TASK, result.details.monitorId)).monitor.status, "draft");

  // A draft is not polled, so a broken rule cannot be mistaken for "no change".
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "http://model.test",
    apiKey: "k",
    executor: async () => {
      throw new Error("must not run");
    }
  });
  const cycle = await supervisor.runCycle({ taskId: TASK });
  assert.equal(cycle.monitors, 0);
  assert.equal(cycle.polled, 0);
});

test("an invalid package is refused before anything is registered", async (t) => {
  const { root, pi, relative } = await harness(t);
  await writeFile(join(root, TASK, relative, "manifest.json"), JSON.stringify({ name: "broken" }));
  const result = await pi.tools
    .get("activate_virtual_agent")
    .execute("call-1", { path: relative, task: "watch", cadenceSeconds: 3600 }, undefined, undefined, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.details.reason, "invalid_package");
  assert.deepEqual(
    await new WatchProgramStore(root).listPrograms(TASK),
    [],
    "nothing is registered from a package that did not validate"
  );
});

test("a package path outside the Task workspace is refused", async (t) => {
  const { pi } = await harness(t);
  await assert.rejects(
    pi.tools
      .get("activate_virtual_agent")
      .execute(
        "call-1",
        { path: "../../etc", task: "watch", cadenceSeconds: 3600 },
        undefined,
        undefined,
        ctx
      ),
    /escapes the Task workspace/
  );
});
