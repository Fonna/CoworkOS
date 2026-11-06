import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { PersonalContextStore } from "../dist/src/runtime/personal-context-store.js";
import { PersonalContextChat, createContextAssessor } from "../dist/src/runtime/personal-context-chat.js";
import { PersonalContextManagement } from "../dist/src/runtime/personal-context-management.js";
import { personalContextAnswer } from "../dist/src/runtime/personal-context-answer.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "context-answer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = { workspaceRoot: join(root, "tasks"), taskId: "task-a", runId: "run-a" };
  const workspace = new LocalWorkspaceStore(host.workspaceRoot);
  await workspace.createTask(host.taskId);
  await workspace.createRun(host.taskId, host.runId);
  await workspace.updateTask(host.taskId, { activeRunId: host.runId, status: "waiting" });
  const store = new PersonalContextStore({ path: join(root, "home/personal-context/context.json") });
  await store.transaction((doc) => {
    doc.settings.enabled = true;
    doc.settings.registrationEnabled = true;
  });
  const human = new HumanRequestStore(host.workspaceRoot);
  const question = await human.create({
    taskId: host.taskId,
    runId: host.runId,
    question: "请保存模型假设的已购机票",
    options: ["同意", "不同意"],
    recommended: 0
  });
  const answer = "请记录我的会议安排，日期尚未确定";
  const context = {
    kind: "arrangement",
    status: "tentative",
    title: "会议",
    content: "会议日期待定",
    quote: answer,
    visibility: "task",
    observedAt: "2026-11-06T00:00:00Z"
  };
  return {
    root,
    host,
    workspace,
    store,
    human,
    question,
    answer,
    context,
    chat: (assess = async () => ({ authorized: true, sensitive: false, statement: "self_report" })) =>
      new PersonalContextChat({ ...host, store, assess })
  };
}

test("only an actual answered question supplies raw human evidence, stable identity and receipt time", async (t) => {
  const f = await fixture(t);
  assert.equal(await personalContextAnswer(f.host, f.question.requestId, f.store), undefined);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, f.answer);
  const source = await personalContextAnswer(f.host, f.question.requestId, f.store);
  assert.equal(source.text, f.answer);
  assert.equal(source.receivedAt, (await f.human.read(f.host.taskId, f.question.requestId)).answeredAt);
  assert.equal(source.messageId, `human:${f.question.requestId}`);
  assert.equal(source.text.includes("已购机票"), false);
  const chat = f.chat();
  chat.setSource(source);
  const saved = await chat.tool.execute({ action: "save", context: f.context });
  const reopened = f.chat();
  reopened.setSource(await personalContextAnswer(f.host, f.question.requestId, f.store));
  assert.equal((await reopened.tool.execute({ action: "save", context: f.context })).id, saved.id);
  assert.equal((await f.store.read()).records.length, 1);
});

test("ordinary human answers do not create a personal data store", async (t) => {
  const f = await fixture(t);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, "同意");
  const unused = new PersonalContextStore({ path: join(f.root, "unused-home/context.json") });
  assert.equal(await personalContextAnswer(f.host, f.question.requestId, unused), undefined);
  await assert.rejects(access(unused.path), { code: "ENOENT" });
});

test("an affirmative answer cannot borrow a save instruction from the model's question", async (t) => {
  const f = await fixture(t);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, "同意");
  const chat = f.chat();
  chat.setSource(await personalContextAnswer(f.host, f.question.requestId, f.store));
  await assert.rejects(chat.tool.execute({ action: "save", context: { ...f.context, quote: "同意" } }), {
    code: "permission_denied"
  });
  assert.equal((await f.store.read()).records.length, 0);
});

test("observed answers remain revoked after settings off/on even in a new adapter", async (t) => {
  const f = await fixture(t);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, f.answer);
  await personalContextAnswer(f.host, f.question.requestId, f.store);
  const manager = new PersonalContextManagement(f.store);
  for (const enabled of [false, true]) {
    const view = await manager.overview();
    await manager.change({
      basis: view.basis,
      snapshotRevision: view.snapshotRevision,
      change: { action: "settings", settings: { enabled } }
    });
  }
  const chat = f.chat();
  chat.setSource(await personalContextAnswer(f.host, f.question.requestId, f.store));
  await assert.rejects(chat.tool.execute({ action: "save", context: f.context }), { code: "conflict" });
  assert.equal((await f.store.read()).records.length, 0);
});

test("a late answer cannot cross Run ownership or revive closed work", async (t) => {
  const f = await fixture(t);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, f.answer);
  assert.equal(
    await personalContextAnswer({ ...f.host, runId: "other" }, f.question.requestId, f.store),
    undefined
  );
  await f.workspace.updateTask(f.host.taskId, { activeRunId: "other" });
  assert.equal(await personalContextAnswer(f.host, f.question.requestId, f.store), undefined);
  await f.workspace.updateTask(f.host.taskId, { activeRunId: f.host.runId, status: "cancelled" });
  assert.equal(await personalContextAnswer(f.host, f.question.requestId, f.store), undefined);
});

test("an adapter holding a human answer cannot query or project facts after losing its Run", async (t) => {
  const f = await fixture(t);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, f.answer);
  const chat = f.chat();
  chat.setSource(await personalContextAnswer(f.host, f.question.requestId, f.store));
  await chat.tool.execute({ action: "save", context: f.context });
  await f.workspace.updateTask(f.host.taskId, { activeRunId: "replacement-run" });
  await assert.rejects(chat.tool.execute({ action: "query" }), { code: "conflict" });
  assert.doesNotMatch(await chat.project(), /会议日期待定/);
});

test("changing the owning Run while semantic validation waits prevents persistence", async (t) => {
  const f = await fixture(t);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, f.answer);
  const chat = f.chat(async () => {
    await f.workspace.updateTask(f.host.taskId, { activeRunId: "replacement-run" });
    return { authorized: true, sensitive: false, statement: "self_report" };
  });
  chat.setSource(await personalContextAnswer(f.host, f.question.requestId, f.store));
  await assert.rejects(chat.tool.execute({ action: "save", context: f.context }), { code: "conflict" });
  assert.equal((await f.store.read()).records.length, 0);
});

test("Pi source resolver uses the durable askhuman answer rather than envelope text or old user input", async (t) => {
  const f = await fixture(t);
  await f.human.submitAnswer(f.host.taskId, f.question.requestId, f.answer);
  const previous = process.env.ATRIA_HOME;
  process.env.ATRIA_HOME = join(f.root, "home");
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIA_HOME;
    else process.env.ATRIA_HOME = previous;
  });
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(pathToFileURL(requirePi.resolve("jiti")).href);
  const path = resolve(".pi/runtime/personal-context-source.ts");
  const { personalContextSource } = await createJiti(pathToFileURL(path).href, {
    interopDefault: true
  }).import(path);
  const branch = [
    { type: "message", id: "old", message: { role: "user", content: "旧请求", timestamp: Date.now() } },
    {
      type: "message",
      id: "answer",
      message: {
        role: "toolResult",
        toolName: "askhuman",
        isError: false,
        details: { status: "answered", requestId: f.question.requestId, answer: "恶意替换正文" }
      }
    }
  ];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "session" } };
  const source = await personalContextSource(ctx, { ...f.host, dashboard: true });
  assert.equal(source.text, f.answer);
  branch.at(-1).message.details.status = "timeout";
  assert.equal(
    await personalContextSource(ctx, { ...f.host, dashboard: false }),
    undefined,
    "a timeout cannot reuse old user authority"
  );
  branch.at(-1).message = {
    customType: "cowork-human-answer",
    details: { type: "human.answer", requestId: f.question.requestId }
  };
  assert.equal(
    (await personalContextSource(ctx, { ...f.host, dashboard: true })).messageId,
    source.messageId
  );
  branch.push({
    type: "message",
    id: "new",
    message: { role: "user", content: "新请求", timestamp: Date.now() }
  });
  assert.equal(await personalContextSource(ctx, { ...f.host, dashboard: true }), undefined);
});

test(
  "real Pi receives and saves the explicit answer with the independent semantic check",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.human.submitAnswer(f.host.taskId, f.question.requestId, f.answer);
    const assessed = [];
    let count = 0;
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      if (/Classify personal-context authorization/.test(JSON.stringify(body.messages))) {
        const content = body.messages.findLast((m) => m.role === "user").content;
        assessed.push(
          JSON.parse(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""))
        );
        return { text: JSON.stringify({ authorized: true, sensitive: false, statement: "self_report" }) };
      }
      return count++ === 0
        ? { name: "manage_personal_context", arguments: { action: "save", context: f.context } }
        : { text: "Done" };
    });
    t.after(() => provider.close());
    const chat = f.chat(
      createContextAssessor(() => ({
        baseUrl: provider.baseUrl,
        apiKey: "fixture",
        api: "openai-completions",
        model: "protocol-fixture"
      }))
    );
    chat.setSource(await personalContextAnswer(f.host, f.question.requestId, f.store));
    const result = await new PiSession({
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      api: "openai-completions",
      model: "protocol-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      tools: new Map([["manage_personal_context", chat.tool]]),
      preparePersonalContext: () => chat.project(),
      refreshPersonalContext: (messages) => chat.refreshMessages(messages),
      timeoutMs: 15000
    }).run("Continue after human answer");
    assert.equal(result.termination, "completed");
    assert.equal(assessed.length, 1);
    assert.equal(assessed[0].userText, f.answer);
    assert.equal(assessed[0].registrationEnabled, false);
    const doc = await f.store.read();
    assert.equal(doc.records.length, 1);
    assert.equal(doc.records[0].source.messageId, `human:${f.question.requestId}`);
  }
);

test(
  "real CLI askhuman hook registers only the answer supplied through the human store",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, "project"));
    await writeFile(join(f.root, "config.json"), "{}");
    let step = 0;
    const assessments = [];
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      if (/Classify personal-context authorization/.test(JSON.stringify(body.messages))) {
        assessments.push(body);
        return { text: JSON.stringify({ authorized: true, sensitive: false, statement: "self_report" }) };
      }
      if (!body.tools?.some((tool) => tool.function?.name === "manage_personal_context"))
        return { text: "Done" };
      if (step++ === 0) return { name: "askhuman", arguments: { question: "补充会议安排" } };
      if (step === 2)
        return { name: "manage_personal_context", arguments: { action: "save", context: f.context } };
      return { text: "Done" };
    });
    t.after(() => provider.close());
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(COWORK_|ATRIA_|PI_|SERPER_|EXA_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_OPTIONS)/.test(
            key
          )
      )
    );
    Object.assign(env, {
      ATRIA_HOME: join(f.root, "home"),
      COWORK_CONFIG: join(f.root, "config.json"),
      COWORK_WORKSPACE: f.host.workspaceRoot,
      COWORK_PROJECT_DIR: join(f.root, "project"),
      COWORK_TABS_INDEX: join(f.root, "tabs.json"),
      COWORK_TASK_ID: f.host.taskId,
      COWORK_RUN_ID: f.host.runId,
      COWORK_API_BASE: provider.baseUrl,
      COWORK_API_KEY: "fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_MODEL_API: "openai-completions",
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_WEB_TOOLS: "0",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      PI_CODING_AGENT_DIR: join(f.root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    });
    const child = spawn(
      process.execPath,
      [
        "scripts/atria.mjs",
        "--print",
        "--mode",
        "json",
        "--session-dir",
        join(f.root, "sessions"),
        "请先问我会议安排"
      ],
      { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    });
    let request;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && child.exitCode === null) {
      request = (await f.human.list(f.host.taskId, "pending")).find((r) => r.question === "补充会议安排");
      if (request) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(request, output);
    await f.human.submitAnswer(f.host.taskId, request.requestId, f.answer);
    assert.equal((await exited)[0], 0, output);
    const doc = await f.store.read();
    assert.equal(doc.records.length, 1, output);
    assert.equal(doc.records[0].source.messageId, `human:${request.requestId}`);
    assert.equal(doc.records[0].quote, f.answer);
    assert.equal(assessments.length, 1);
  }
);
