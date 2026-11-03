import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";
import {
  ProjectExperienceStore,
  projectExperienceIdentity
} from "../dist/src/runtime/project-experience-store.js";
import {
  createProjectExperienceLearningService,
  enqueueProjectExperienceRun,
  processProjectExperienceLearning
} from "../dist/src/runtime/project-experience-learning.js";
import {
  createProjectExperienceEvidenceRecorder,
  readProjectExperienceEvidence
} from "../dist/src/runtime/project-experience-evidence.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const quote = "Use the project test runner before accepting a parser change.";
const validationQuote = "parser checks passed";
const proposal = (extra = {}) => ({
  kind: "skill",
  title: "Check parser changes",
  description: "When changing the project parser",
  content: "Run npm test to check parser changes before accepting the result.",
  quote,
  validationQuote,
  ...extra
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("Expected project learning state was not reached");
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-project-learning-"));
  const workspaceRoot = join(root, "workspace");
  const identity = { projectId: "project-fixture", projectDirectory: join(root, "project") };
  const storeRoot = join(root, "home", "project-experience");
  const store = new ProjectExperienceStore(identity, storeRoot);
  const userMemoryStore = new UserMemoryStore(join(root, "home", "memory", "user-memory.json"));
  await mkdir(identity.projectDirectory, { recursive: true });
  if (options.enabled !== false)
    await store.configure({
      enabled: true,
      learningEnabled: true,
      autoActivate: true,
      maxRequestsPerHour: 24
    });
  let changes = [proposal()];
  let decisions = [{ index: 0, supported: true, durable: true, validationRelevant: true }];
  const provider = await modelProtocolFixture("openai-completions", async (body, requests) => {
    if (options.handler) return options.handler(body, requests);
    const payload = JSON.parse(body.messages.at(-1).content);
    return { text: JSON.stringify(payload.proposals ? { decisions } : { changes }) };
  });
  t.after(async () => {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  const connection = {
    baseUrl: provider.baseUrl,
    apiKey: "fixture",
    api: "openai-completions",
    model: "protocol-fixture"
  };
  const workspace = new LocalWorkspaceStore(workspaceRoot);
  const reference = (taskId, runId = "run-a") => ({ identity, workspaceRoot, taskId, runId });
  const recordRun = async (taskId = "task-a", runId = "run-a", extra = {}) => {
    await workspace.createTask(taskId, { ...identity, goal: "Check a parser change" });
    const run = await workspace.createRun(taskId, runId);
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: `${quote}\nAPI_KEY=sk-secret-for-fixture-only` }],
        timestamp: 1
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "check-1",
            name: "bash",
            arguments: { command: extra.command ?? "npm test" }
          }
        ],
        timestamp: 2
      },
      {
        role: "toolResult",
        toolCallId: "check-1",
        toolName: "bash",
        isError: extra.failed === true,
        details: { exitCode: extra.failed ? 1 : 0 },
        content: [{ type: "text", text: extra.failed ? "parser checks FAILED" : validationQuote }],
        timestamp: 3
      },
      {
        role: "assistant",
        content: [{ type: "text", text: extra.summary ?? "The parser change was checked with npm test." }],
        timestamp: 4
      }
    ];
    await writeFile(
      join(run, "agents", "main", "result.json"),
      JSON.stringify({ termination: extra.failed ? "failed" : "completed", messages })
    );
    await writeFile(
      join(run, "run_events.jsonl"),
      `${JSON.stringify({ taskId, runId, type: extra.failed ? "run.failed" : "run.completed", payload: {} })}\n`
    );
    await workspace.transitionTask(taskId, "running", { runId });
    await workspace.transitionTask(taskId, extra.failed ? "failed" : "completed", { runId });
    return reference(taskId, runId);
  };
  const enqueue = async (taskId = "task-a", runId = "run-a", extra = {}) => {
    const ref = await recordRun(taskId, runId, extra);
    await enqueueProjectExperienceRun({ ...ref, store, now: 0 });
    return ref;
  };
  const processPass = (extra = {}) =>
    processProjectExperienceLearning({ store, userMemoryStore, connection, now: 60_001, ...extra });
  return {
    root,
    storeRoot,
    workspaceRoot,
    identity,
    store,
    userMemoryStore,
    provider,
    connection,
    reference,
    recordRun,
    enqueue,
    processPass,
    setChanges(value) {
      changes = value;
    },
    setDecisions(value) {
      decisions = value;
    }
  };
}

test("project learning defaults off and does not collect or call a provider", async (t) => {
  const f = await fixture(t, { enabled: false });
  await f.enqueue();
  assert.equal((await f.store.read()).learningEnabled, false);
  assert.equal((await f.store.read()).pending.length, 0);
  assert.equal(await f.processPass(), 0);
  assert.equal(f.provider.requests.length, 0);
});

test("only terminal project-owned Run evidence is read, bounded and secret-filtered", async (t) => {
  const f = await fixture(t);
  const ref = await f.recordRun();
  const evidence = await readProjectExperienceEvidence(ref);
  assert.equal(evidence.status, "completed");
  assert.ok(evidence.sources.some((source) => source.validation));
  assert.doesNotMatch(JSON.stringify(evidence), /sk-secret|API_KEY/);
  assert.equal(
    await readProjectExperienceEvidence({ ...ref, identity: { ...f.identity, projectId: "other" } }),
    undefined
  );
  const resultPath = join(f.workspaceRoot, ref.taskId, "runs", ref.runId, "agents", "main", "result.json");
  await writeFile(resultPath, `{"termination":"completed","messages":${" ".repeat(2 * 1024 * 1024)}[]}`);
  await writeFile(
    join(f.workspaceRoot, ref.taskId, "agents", "main", "context", "memory.md"),
    `Summary ${"x".repeat(12000)}\nA bounded useful project lesson.`
  );
  const bounded = await readProjectExperienceEvidence(ref);
  assert.ok(JSON.stringify(bounded).length < 13000);
  assert.equal(
    bounded.sources.some((source) => source.validation),
    false
  );
  await writeFile(join(f.workspaceRoot, ref.taskId, "runs", ref.runId, "run_events.jsonl"), "");
  assert.equal(await readProjectExperienceEvidence(ref), undefined);
});

test("directory-scoped CLI Tasks retain project evidence without a catalog projectId", async (t) => {
  const f = await fixture(t);
  const ref = await f.recordRun();
  const taskPath = join(f.workspaceRoot, ref.taskId, "task.json");
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  delete task.projectId;
  await writeFile(taskPath, JSON.stringify(task));
  const identity = projectExperienceIdentity(task);
  assert.match(identity.projectId, /^directory:/);
  const store = new ProjectExperienceStore(identity, f.storeRoot);
  await store.configure({ enabled: true, learningEnabled: true });
  await enqueueProjectExperienceRun({ ...ref, identity, store, now: 0 });
  assert.equal(await f.processPass({ store }), 0);
  assert.equal((await store.read()).candidates.length, 1);
  assert.equal(f.provider.requests.length, 2);
});

test("displaying a check command cannot counterfeit host validation evidence", async (t) => {
  const f = await fixture(t);
  const rejected = [
    "echo 'npm test'",
    "printf '%s' 'pytest'",
    "echo npm test && true",
    "bash -c 'npm test'",
    "node -e \"console.log('npm test')\"",
    "echo $(npm test)",
    "npm test | cat",
    "npm test; echo success"
  ];
  for (const [index, command] of rejected.entries()) {
    const ref = await f.recordRun(`display-${index}`, "run-a", { command });
    const evidence = await readProjectExperienceEvidence(ref);
    assert.equal(
      evidence.sources.some((source) => source.validation),
      false,
      command
    );
  }
  for (const [index, command] of [
    "npm test",
    "cd 'project directory' && npm run check",
    "node --test test/parser.test.js",
    "python3 -m pytest"
  ].entries()) {
    const ref = await f.recordRun(`direct-${index}`, "run-a", { command });
    const evidence = await readProjectExperienceEvidence(ref);
    assert.equal(
      evidence.sources.some((source) => source.validation),
      true,
      command
    );
  }
});

test("standalone current-turn receipts persist terminal evidence without scanning a transcript", async (t) => {
  const f = await fixture(t);
  const workspace = new LocalWorkspaceStore(f.workspaceRoot);
  await workspace.createTask("standalone", { ...f.identity, goal: "Check parser" });
  const runPath = await workspace.createRun("standalone", "run-a");
  const ref = f.reference("standalone");
  const recorder = createProjectExperienceEvidenceRecorder(ref);
  recorder.record([{ role: "user", content: `${quote}\n\nAttached files:\nSECRET_ATTACHMENT_TEXT` }]);
  recorder.record([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "check", name: "bash", arguments: { command: "npm test" } }]
    }
  ]);
  recorder.record([
    {
      role: "toolResult",
      toolCallId: "check",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: validationQuote }]
    }
  ]);
  recorder.record([
    {
      role: "toolResult",
      toolCallId: "large-tool",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "LARGE_TOOL_BODY".repeat(1000000) }]
    }
  ]);
  assert.equal(
    await readProjectExperienceEvidence(ref),
    undefined,
    "receipts are not terminal before finish"
  );
  await recorder.finish("completed");
  const evidence = await readProjectExperienceEvidence(ref);
  assert.equal(evidence.status, "completed");
  assert.ok(evidence.sources.some((source) => source.validation));
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET_ATTACHMENT_TEXT|LARGE_TOOL_BODY/);
  assert.equal((await stat(join(runPath, "experience-evidence.json"))).mode & 0o777, 0o600);
  assert.ok((await stat(join(runPath, "experience-evidence.json"))).size < 14000);
});

test("the learner sends a bounded relevant prior shortlist instead of the entire project knowledge store", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 20; index++) {
    await f.store.save({
      kind: "skill",
      title: `Manual procedure ${index}`,
      description: "An existing project procedure",
      content: "A manual project procedure. ".repeat(200)
    });
  }
  await f.enqueue();
  await f.processPass();
  const payload = JSON.parse(f.provider.requests[0].body.messages.at(-1).content);
  assert.ok(payload.existingItems.length <= 20);
  assert.ok(JSON.stringify(payload.existingItems).length <= 12040);
  assert.ok(JSON.stringify(payload).length < 26000);
});

test("idle and two tool-free JSON requests produce candidates then require independent checked Tasks", async (t) => {
  const f = await fixture(t);
  await f.enqueue();
  assert.equal(await f.processPass({ now: 59_999 }), 0);
  assert.equal(f.provider.requests.length, 0);
  assert.equal(await f.processPass(), 0);
  let doc = await f.store.read();
  assert.equal(doc.candidates.length, 1);
  assert.equal(doc.candidates[0].supportCount, 1);
  await f.enqueue("task-a", "run-b");
  await f.processPass();
  assert.equal((await f.store.read()).candidates[0].supportCount, 1);
  await f.enqueue("task-b");
  await f.processPass();
  await f.enqueue("task-c");
  assert.equal(await f.processPass(), 1);
  doc = await f.store.read();
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].kind, "skill");
  assert.equal(doc.entries[0].supportCount, 3);
  assert.equal(doc.candidates.length, 0);
  const skill = (await f.store.readProfile()).skills[0];
  assert.match(await readFile(skill.path, "utf8"), /Run npm test/);
  assert.equal(f.provider.requests.length, 8);
  assert.ok(f.provider.requests.every(({ body }) => !body.tools?.length));
  assert.ok(
    f.provider.requests.every(
      ({ body }) => body.reasoning_effort === undefined || body.reasoning_effort === "none"
    )
  );
});

test("a model copying an exact candidate id still accumulates independent project evidence", async (t) => {
  const f = await fixture(t);
  await f.enqueue();
  await f.processPass();
  for (const taskId of ["task-b", "task-c"]) {
    const candidate = (await f.store.read()).candidates[0];
    f.setChanges([proposal({ id: candidate.id, revision: candidate.revision })]);
    await f.enqueue(taskId);
    await f.processPass();
  }
  assert.equal((await f.store.read()).entries[0].supportCount, 3);
  assert.equal((await f.store.read()).candidates.length, 0);
});

test("a validated skill accumulates independently from an unvalidated experience in the same batch", async (t) => {
  const f = await fixture(t);
  f.setChanges([
    proposal(),
    proposal({
      kind: "experience",
      title: "Parser lesson",
      content: "Check parser changes before accepting them.",
      validationQuote: undefined
    })
  ]);
  f.setDecisions([
    { index: 0, supported: true, durable: true, validationRelevant: true },
    { index: 1, supported: true, durable: true, validationRelevant: false }
  ]);
  for (const taskId of ["mixed-a", "mixed-b", "mixed-c"]) {
    await f.enqueue(taskId);
    await f.processPass();
  }
  const doc = await f.store.read();
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].kind, "skill");
  assert.ok(doc.entries[0].sources.every((source) => source.verified));
  assert.equal(doc.candidates.length, 1);
  assert.equal(doc.candidates[0].kind, "experience");
  assert.equal(doc.candidates[0].verified, false);
});

test("candidate consolidation preserves the target of an automatic Skill evolution", async (t) => {
  const f = await fixture(t);
  for (const taskId of ["original-a", "original-b", "original-c"]) {
    await f.enqueue(taskId);
    await f.processPass();
  }
  const original = (await f.store.read()).entries[0];
  const content = "Run npm test and inspect the parser check result before accepting a change.";
  f.setChanges([proposal({ id: original.id, revision: original.revision, content })]);
  await f.enqueue("evolve-a");
  await f.processPass();
  const candidate = (await f.store.read()).candidates[0];
  assert.equal(candidate.targetId, original.id);
  f.setChanges([proposal({ id: candidate.id, revision: candidate.revision, content })]);
  await f.enqueue("evolve-b");
  await f.processPass();
  f.setChanges([proposal({ content })]);
  await f.enqueue("evolve-c");
  await f.processPass();
  const doc = await f.store.read();
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].id, original.id);
  assert.equal(doc.entries[0].version, 2);
  assert.equal(doc.entries[0].content, content);
  assert.equal(doc.candidates.length, 0);
});

test("failed or unrelated checks never automatically publish a generated skill", async (t) => {
  const f = await fixture(t);
  for (const taskId of ["task-f1", "task-f2", "task-f3"]) {
    await f.enqueue(taskId, "run-a", { failed: true });
    await f.processPass();
  }
  assert.equal((await f.store.read()).entries.length, 0);
  assert.equal((await f.store.read()).candidates[0].verified, false);
  f.setChanges([
    proposal({ title: "Unrelated check", content: "Use unrelated command as a project check." })
  ]);
  for (const taskId of ["task-u1", "task-u2", "task-u3"]) {
    await f.enqueue(taskId, "run-a", { command: "printf 'parser checks passed'" });
    await f.processPass();
  }
  assert.equal((await f.store.readProfile()).skills.length, 0);
  f.setDecisions([{ index: 0, supported: true, durable: true, validationRelevant: false }]);
  f.setChanges([
    proposal({ title: "Semantically unrelated check", content: "Reuse an unrelated successful check." })
  ]);
  for (const taskId of ["task-s1", "task-s2", "task-s3"]) {
    await f.enqueue(taskId);
    await f.processPass();
  }
  assert.equal((await f.store.read()).entries.length, 0);
});

test("unsupported quotes and reviewer rejection cannot create project knowledge", async (t) => {
  const f = await fixture(t);
  f.setChanges([proposal({ quote: "A quote never present in the Run" })]);
  await f.enqueue();
  await f.processPass();
  assert.equal(f.provider.requests.length, 1);
  assert.equal((await f.store.read()).candidates.length, 0);
  f.setChanges([proposal()]);
  f.setDecisions([{ index: 0, supported: false, durable: true, validationRelevant: true }]);
  await f.enqueue("task-b");
  await f.processPass();
  assert.equal((await f.store.read()).candidates.length, 0);
  assert.equal((await f.store.read()).pending.length, 0);
});

test("a same-generation external request receipt before commit cannot deadlock the project store", async (t) => {
  const f = await fixture(t);
  await f.enqueue();
  const apply = f.store.applyProposal.bind(f.store);
  f.store.applyProposal = async (input) => {
    const other = new ProjectExperienceStore(f.identity, f.storeRoot);
    assert.equal(await other.claimLearningRequest(60_001, input.expectedGeneration), true);
    return apply(input);
  };
  await f.processPass();
  assert.equal((await f.store.read()).candidates.length, 1);
  assert.equal((await f.store.read()).pending.length, 0);
});

test("pause preserves intake and manual changes invalidate an in-flight proposal", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    handler: async (body) => {
      entered.resolve();
      await release.promise;
      const payload = JSON.parse(body.messages.at(-1).content);
      return { text: JSON.stringify(payload.proposals ? { decisions: [] } : { changes: [proposal()] }) };
    }
  });
  await f.enqueue();
  const pass = f.processPass();
  await entered.promise;
  await f.store.configure({ learningEnabled: false });
  await waitFor(async () => (await f.store.read()).learningEnabled === false);
  await delay(150);
  release.resolve();
  assert.equal(await pass, 0);
  assert.equal((await f.store.read()).pending.length, 1);
  assert.equal((await f.store.read()).pending[0].attempts, 0);
  await f.store.configure({ learningEnabled: true });
  await f.store.save({
    kind: "experience",
    title: "Manual project convention",
    description: "",
    content: "Use the manual convention."
  });
  assert.equal((await f.store.read()).pending.length, 0);
  await enqueueProjectExperienceRun({ ...f.reference("task-a"), store: f.store, now: 0 });
  assert.equal((await f.store.read()).pending.length, 0);
  assert.equal((await f.store.read()).candidates.length, 0);
});

test("switching model connection aborts before a reviewer request and preserves retry attempts", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify({ changes: [proposal()] }) };
    }
  });
  await f.enqueue();
  let current = true;
  const pass = f.processPass({ isConnectionCurrent: () => current });
  await entered.promise;
  current = false;
  await delay(150);
  release.resolve();
  assert.equal(await pass, 0);
  assert.equal(f.provider.requests.length, 1);
  assert.equal((await f.store.read()).pending[0].attempts, 0);
  assert.equal((await f.store.read()).candidates.length, 0);
});

test("the service snapshots connection fields even when its connection object is mutated in place", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify({ changes: [proposal()] }) };
    }
  });
  await f.enqueue();
  const connection = { ...f.connection };
  const service = createProjectExperienceLearningService({
    stores: async () => [f.store],
    userMemoryStore: f.userMemoryStore,
    connection: () => connection
  });
  t.after(() => service.stop());
  service.start();
  await entered.promise;
  connection.model = "another-model";
  await delay(150);
  release.resolve();
  await service.stop();
  assert.equal(f.provider.requests.length, 1);
  assert.equal((await f.store.read()).pending[0].attempts, 0);
  assert.equal((await f.store.read()).candidates.length, 0);
});

test(
  "a foreground lease on another process preempts learning and recovers after owner death",
  { timeout: 15000 },
  async (t) => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(t, {
      handler: async () => {
        entered.resolve();
        await release.promise;
        return { text: JSON.stringify({ changes: [proposal()] }) };
      }
    });
    await f.enqueue();
    const pass = f.processPass();
    await entered.promise;
    const moduleUrl = new URL("../dist/src/runtime/run-service.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { RunService } from ${JSON.stringify(moduleUrl)};
    await new RunService(process.argv[1]).runPi({ taskId:"foreground-task",runId:"foreground-run",prompt:"好",baseUrl:"http://127.0.0.1:1/v1",apiKey:"fixture",tools:()=>new Map(),prepare:async()=>{process.send("active");setInterval(()=>{},1000);await new Promise(()=>{});} });`,
        f.workspaceRoot
      ],
      {
        env: { ...process.env, ATRIA_HOME: join(f.root, "home") },
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    await Promise.race([
      once(child, "message"),
      exited.then(() => assert.fail(stderr || "foreground host did not start"))
    ]);
    await delay(200);
    release.resolve();
    assert.equal(await pass, 0);
    assert.equal(f.provider.requests.length, 1);
    assert.equal((await f.store.read()).pending[0].attempts, 0);
    assert.equal(await f.processPass(), 0);
    child.kill("SIGKILL");
    await exited;
    assert.equal(await f.userMemoryStore.isForegroundActive(), false);
  }
);

test("persisted intake survives restart, bounded failures, and service shutdown", async (t) => {
  const f = await fixture(t);
  await f.enqueue();
  const restarted = new ProjectExperienceStore(f.identity, f.storeRoot);
  const service = createProjectExperienceLearningService({
    stores: async () => [restarted],
    userMemoryStore: f.userMemoryStore,
    connection: () => f.connection
  });
  t.after(() => service.stop());
  service.start();
  await waitFor(async () => (await restarted.read()).candidates.length === 1);
  await service.stop();
  assert.equal((await restarted.read()).pending.length, 0);
  assert.equal(f.provider.requests.length, 2);
  const broken = await fixture(t, { handler: () => ({ text: "not JSON" }) });
  await broken.enqueue();
  await broken.processPass();
  await broken.processPass();
  assert.equal(broken.provider.requests.length, 1);
  assert.equal((await broken.store.read()).pending[0].attempts, 1);
  await broken.processPass({ now: 120_002 });
  await broken.processPass({ now: 420_003 });
  await broken.processPass({ now: 900_000 });
  assert.equal(broken.provider.requests.length, 3);
  assert.equal((await broken.store.read()).pending[0].attempts, 3);
});

test("malformed persisted project identity skips evidence without poisoning later learning", async (t) => {
  const f = await fixture(t);
  const ref = await f.recordRun("malformed-identity", "run-malformed");
  const path = join(f.workspaceRoot, ref.taskId, "task.json");
  const task = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...task, projectId: "x".repeat(1001) }));
  assert.equal(await readProjectExperienceEvidence(ref), undefined);
  const valid = await f.recordRun("valid-identity", "run-valid");
  assert.equal((await readProjectExperienceEvidence(valid)).status, "completed");
});
