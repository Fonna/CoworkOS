import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MemoryCapacityError,
  UserMemoryStore,
  userMemoryContext,
  userMemoryRevision
} from "../dist/src/runtime/user-memory-store.js";
import { processUserMemoryLearning } from "../dist/src/runtime/user-memory-learning.js";
import { createUserMemoryTool } from "../dist/src/runtime/user-memory-tools.js";
import { handleUserMemoryRequest } from "../dist/src/dashboard/user-memory-routes.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const observedSpeech = "回答请保留重点并用简短句子组织";
const directSpeech = "我平时写邮件都喜欢简洁一些";
const manualSource = { taskId: "settings", runId: "settings", quote: "manual", origin: "settings" };

function observation(content = "偏好简洁表达", quote = observedSpeech, extra = {}) {
  return {
    action: "remember",
    content,
    category: "preference",
    scope: "user",
    quote,
    durability: "persistent",
    evidence: "observed",
    ...extra
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-admission-"));
  const store = new UserMemoryStore(join(root, "memory.json"));
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await store.setLearningOptions({ maxRequestsPerHour: 24 });
  let reply = [];
  const provider = await modelProtocolFixture("openai-completions", (body) =>
    typeof reply === "function" ? reply(body) : { text: JSON.stringify({ changes: reply }) }
  );
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
  return {
    root,
    store,
    provider,
    connection,
    setReply(value) {
      reply = value;
    },
    async learn(taskId, changes = [observation()], options = {}) {
      reply = options.reply ?? changes;
      const current = new UserMemoryStore(store.path);
      const now = options.now ?? Date.now();
      await current.enqueueLearning(
        {
          taskId,
          runId: options.runId ?? `${taskId}-run`,
          text: options.text ?? changes[0]?.quote ?? observedSpeech,
          projectDirectory: options.projectDirectory
        },
        now - 60_001
      );
      if (options.worker) {
        const moduleUrl = new URL("../dist/src/runtime/user-memory-learning.js", import.meta.url).href;
        const storeUrl = new URL("../dist/src/runtime/user-memory-store.js", import.meta.url).href;
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import { processUserMemoryLearning } from ${JSON.stringify(moduleUrl)};
          import { UserMemoryStore } from ${JSON.stringify(storeUrl)};
          const result = await processUserMemoryLearning({
            store: new UserMemoryStore(process.argv[1]),
            connection: JSON.parse(process.argv[2]), now: Number(process.argv[3]),
            isTaskActive: () => false, isForegroundActive: () => false
          });
          console.log(JSON.stringify(result));`,
            store.path,
            JSON.stringify(connection),
            String(now)
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) =>
                  !/^(COWORK_|ATRIA_|PI_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/.test(
                    key
                  )
              )
            )
          }
        );
        let output = "",
          error = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          error += chunk;
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          const [code, signal] = await once(child, "exit");
          assert.equal(signal, null, error);
          assert.equal(code, 0, error);
          return JSON.parse(output);
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await once(child, "exit");
          }
        }
      }
      return processUserMemoryLearning({
        store: new UserMemoryStore(store.path),
        connection,
        now,
        isTaskActive: () => false,
        isForegroundActive: () => false
      });
    }
  };
}

test("old documents keep learning off and migrate to an empty private candidate collection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-admission-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "memory.json"));
  const original = JSON.stringify({ version: 1, enabled: true, entries: [] });
  await writeFile(store.path, original);
  const document = await store.read();
  assert.equal(document.learningEnabled, false);
  assert.deepEqual(document.candidates, []);
  await store.enqueueLearning({ taskId: "task", runId: "run", text: directSpeech });
  assert.equal((await store.read()).pending.length, 0);
  assert.equal(await readFile(store.path, "utf8"), original);
});

test("an observation needs three independent Tasks and survives each worker restart", async (t) => {
  const f = await fixture(t);
  for (const task of ["task-a", "task-b"]) {
    assert.equal(await f.learn(task, [observation()], { worker: true }), 0);
    const document = await new UserMemoryStore(f.store.path).read();
    assert.equal(document.entries.length, 0);
    assert.equal(document.candidates.length, 1);
    assert.equal(await userMemoryContext(new UserMemoryStore(f.store.path)), "");
  }
  assert.equal((await f.store.read()).candidates[0].supports.length, 2);
  assert.equal(await f.learn("task-c", [observation()], { worker: true }), 1);
  const promoted = await f.store.read();
  assert.equal(promoted.entries.length, 1);
  assert.equal(promoted.entries[0].content, "偏好简洁表达");
  assert.equal(promoted.entries[0].source.origin, "automatic");
  assert.equal(promoted.candidates.length, 0);
  assert.equal(f.provider.requests.length, 3);
  assert.match(await userMemoryContext(f.store), /偏好简洁表达/);
});

test("replay, retries and different Runs of the same Task cannot create independent support", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.learn("same-task"), 0);
  assert.equal(await f.learn("same-task"), 0);
  assert.equal(f.provider.requests.length, 1, "already processed input does not request inference again");
  for (const runId of ["retry-run", "later-run", "another-run"])
    assert.equal(await f.learn("same-task", [observation()], { runId }), 0);
  const candidate = (await f.store.read()).candidates[0];
  assert.equal(candidate.supports.length, 1);
  assert.deepEqual(candidate.supports, [createHash("sha256").update("same-task").digest("hex")]);
  assert.doesNotMatch(JSON.stringify(candidate), /same-task|retry-run|later-run|another-run/);
  assert.equal((await f.store.read()).entries.length, 0);
  assert.equal(await f.learn("second-task"), 0);
  assert.equal((await f.store.read()).candidates[0].supports.length, 2);
  assert.equal(await f.learn("third-task"), 1);
});

test("empty model output and omitted evidence never admit a fact from a single Task", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  await f.store.enqueueLearning({ taskId: "task", runId: "run", text: directSpeech }, now - 60_001);
  f.setReply(() => ({ text: "" }));
  assert.equal(await processUserMemoryLearning({ store: f.store, connection: f.connection, now }), 0);
  const failed = await f.store.read();
  assert.equal(failed.pending.length, 1);
  assert.equal(failed.pending[0].attempts, 1);
  assert.equal(failed.entries.length, 0);
  assert.equal(failed.candidates.length, 0);
  const { evidence: _evidence, ...missingEvidence } = observation("邮件偏好简洁", directSpeech);
  f.setReply([missingEvidence]);
  assert.equal(
    await processUserMemoryLearning({
      store: new UserMemoryStore(f.store.path),
      connection: f.connection,
      now: failed.pending[0].availableAt + 1
    }),
    0
  );
  const saved = await f.store.read();
  assert.equal(saved.entries.length, 0);
  assert.equal(saved.candidates.length, 1);
  assert.equal(saved.candidates[0].supports.length, 1);
  assert.equal(saved.pending.length, 0);
});

test("omitted evidence requires the same three independent Tasks as an observation", async (t) => {
  const f = await fixture(t);
  const { evidence: _evidence, ...proposal } = observation();
  for (const taskId of ["one", "two"]) {
    assert.equal(await f.learn(taskId, [proposal]), 0);
    assert.equal((await f.store.read()).entries.length, 0);
  }
  assert.equal(await f.learn("three", [proposal]), 1);
  assert.equal((await f.store.read()).entries.length, 1);
});

for (const [text, content, extra] of [
  [directSpeech, "邮件偏好简洁", {}],
  ["我的工作主要是数据分析", "从事数据分析工作", { category: "background" }],
  [
    "本项目一直使用 TypeScript，统一使用双引号",
    "使用 TypeScript 和双引号",
    { scope: "project", category: "constraint" }
  ]
]) {
  test(`a clear stable self-description or project convention is admitted directly: ${content}`, async (t) => {
    const f = await fixture(t);
    const projectDirectory = extra.scope === "project" ? join(f.root, "project") : undefined;
    assert.equal(
      await f.learn("task", [observation(content, text, { ...extra, evidence: "direct" })], {
        projectDirectory
      }),
      1
    );
    const saved = await f.store.read();
    assert.equal(saved.entries[0].content, content);
    assert.equal(saved.candidates.length, 0);
  });
}

for (const text of [
  "我的朋友平时写邮件都喜欢简洁一些",
  "请扮演一名长期喜欢简洁邮件的用户",
  "我这次写邮件希望简洁一些"
]) {
  test(`a model cannot label third-party, role-play or one-off input as direct evidence: ${text}`, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.learn("task", [observation("邮件偏好简洁", text, { evidence: "direct" })]), 0);
    assert.equal((await f.store.read()).entries.length, 0);
    assert.equal((await f.store.read()).candidates.length, 0);
  });
}

for (const text of [
  `客户说：“${directSpeech}”。请帮他写邮件。`,
  `请扮演一个用户，说“${directSpeech}”，然后写一段对话。`,
  `下面是小说人物的自述：“${directSpeech}”，帮我润色。`
]) {
  test(`a narrow first-person quote cannot hide its third-party source: ${text}`, async (t) => {
    const f = await fixture(t);
    assert.equal(
      await f.learn("task", [observation("邮件偏好简洁", directSpeech, { evidence: "direct" })], {
        text
      }),
      0
    );
    assert.equal((await f.store.read()).entries.length, 0);
    assert.equal((await f.store.read()).candidates.length, 0);
  });
}

for (const [text, quote] of [
  ["帮朋友写一段自我介绍：我叫小李，我长期从事财务工作", "我长期从事财务工作"],
  ["小李说：\n我长期从事数据分析工作", "我长期从事数据分析工作"],
  ["请为小李代写自我介绍。\n我的工作主要是数据分析。", "我的工作主要是数据分析。"],
  ["I am writing a first-person bio for Alex.", "I am writing a first-person bio for Alex."],
  [
    "Write a self introduction for my friend: My name is Lee. I have always worked in finance.",
    "I have always worked in finance."
  ]
]) {
  test(`a narrow background quote does not transfer a friend's identity to the user: ${text}`, async (t) => {
    const f = await fixture(t);
    assert.equal(
      await f.learn(
        "task",
        [
          observation("用户从事财务工作", quote, {
            category: "background",
            evidence: "direct"
          })
        ],
        { text }
      ),
      0
    );
    const saved = await f.store.read();
    assert.equal(saved.entries.length, 0);
    assert.equal(saved.candidates.length, 0);
  });
}

for (const text of [
  "我这次写邮件希望简洁一些",
  `客户说：“${directSpeech}”。请帮他写邮件。`,
  `请扮演一个用户，说“${directSpeech}”，然后写一段对话。`
]) {
  test(`repeated one-off or third-party observations never accumulate support: ${text}`, async (t) => {
    const f = await fixture(t);
    for (const taskId of ["one", "two", "three"])
      assert.equal(await f.learn(taskId, [observation("邮件偏好简洁", text)]), 0);
    const saved = await f.store.read();
    assert.equal(saved.entries.length, 0);
    assert.equal(saved.candidates.length, 0);
  });
}

test("observed background or constraints cannot become facts through repeated Tasks", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) {
    const changes = [
      observation("用户从事财务工作", "整理财务数据时请保留原始数值", { category: "background" }),
      observation("禁止使用第三方依赖", "依赖尽量少一点，保持示例简洁", { category: "constraint" })
    ];
    assert.equal(
      await f.learn(`task-${index}`, changes, {
        text: changes.map((change) => change.quote).join("\n")
      }),
      0
    );
  }
  assert.equal((await f.store.read()).entries.length, 0);
  assert.equal((await f.store.read()).candidates.length, 0);
});

test("candidates stay out of foreground context, management tools and public HTTP responses", async (t) => {
  const f = await fixture(t);
  const privateText = "PRIVATE_CANDIDATE_DO_NOT_INJECT";
  assert.equal(await f.learn("task", [observation(privateText)]), 0);
  assert.equal((await f.store.read()).candidates.length, 1);
  assert.equal(await userMemoryContext(f.store), "");
  const tool = createUserMemoryTool({ store: f.store, taskId: "task", runId: "run", userText: () => "" });
  const listed = await tool.execute({ action: "list" });
  assert.equal("candidates" in listed, false);
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE_CANDIDATE/);
  const server = createServer((request, response) => {
    handleUserMemoryRequest(request, response, new URL(request.url, "http://127.0.0.1"), f.store).catch(
      (error) => {
        response.writeHead(error.status ?? 500);
        response.end();
      }
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/user-memory`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal("candidates" in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_CANDIDATE/);
});

test("the same project preference cannot combine support from different projects or user scope", async (t) => {
  const f = await fixture(t);
  const projectA = join(f.root, "project-a"),
    projectB = join(f.root, "project-b");
  const projectChange = observation("偏好简洁表达", observedSpeech, { scope: "project" });
  assert.equal(await f.learn("a-1", [projectChange], { projectDirectory: projectA }), 0);
  assert.equal(await f.learn("b-1", [projectChange], { projectDirectory: projectB }), 0);
  assert.equal(await f.learn("user-1"), 0);
  assert.equal((await f.store.read()).candidates.length, 3);
  assert.equal(await f.learn("a-2", [projectChange], { projectDirectory: projectA }), 0);
  assert.equal(await f.learn("a-3", [projectChange], { projectDirectory: projectA }), 1);
  const saved = await f.store.read();
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].projectDirectory, projectA);
  assert.equal(saved.candidates.length, 2);
  assert.equal(await userMemoryContext(f.store, projectB), "");
});

for (const action of ["remember", "update", "forget", "save_text"]) {
  test(`manual ${action} clears older candidates in its scope`, async (t) => {
    const f = await fixture(t);
    const original = await f.store.remember({
      content: "用户明确选择的称呼是小张",
      category: "background",
      scope: "user",
      source: manualSource
    });
    await f.learn("before-edit");
    const project = join(f.root, "project");
    await f.learn("project-task", [observation("项目表达简洁", observedSpeech, { scope: "project" })], {
      projectDirectory: project
    });
    assert.equal((await f.store.read()).candidates.length, 2);
    if (action === "remember")
      await f.store.remember({
        content: "手动保留的其他事实",
        category: "background",
        scope: "user",
        source: manualSource
      });
    else if (action === "update")
      await f.store.update(original.id, original.revision, "用户选择的称呼是小李", manualSource);
    else if (action === "forget") await f.store.forget(original.id, original.revision);
    else await f.store.saveText("", userMemoryRevision(await f.store.read()));
    let candidates = (await f.store.read()).candidates;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].projectDirectory, project);
    assert.equal(await f.learn("after-edit"), 0);
    candidates = (await f.store.read()).candidates;
    assert.equal(candidates.find((item) => item.scope === "user").supports.length, 1);
  });
}

test("repeated observations update an automatic entry only after three Tasks, preserving its identity", async (t) => {
  const f = await fixture(t);
  const old = await f.store.remember({
    content: "邮件偏好简洁",
    category: "preference",
    scope: "user",
    source: { ...manualSource, origin: "automatic" }
  });
  const proposed = observation("邮件偏好详细", "说明请展开背景并补充必要的细节", {
    action: "update",
    id: old.id,
    revision: old.revision
  });
  for (const task of ["one", "two"]) {
    assert.equal(await f.learn(task, [proposed]), 0);
    assert.equal((await f.store.read()).entries[0].content, old.content);
  }
  assert.equal(await f.learn("three", [proposed]), 1);
  const saved = (await f.store.read()).entries;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, old.id);
  assert.equal(saved[0].revision, old.revision + 1);
  assert.equal(saved[0].content, proposed.content);
});

test("manually confirming an automatic entry clears its candidate and blocks later automatic updates", async (t) => {
  const f = await fixture(t);
  const old = await f.store.remember({
    content: "邮件偏好简洁",
    category: "preference",
    scope: "user",
    source: { ...manualSource, origin: "automatic" }
  });
  const proposed = observation("邮件偏好详细", "说明请展开背景并补充必要的细节", {
    action: "update",
    id: old.id,
    revision: old.revision
  });
  await f.learn("before-one", [proposed]);
  await f.learn("before-two", [proposed]);
  assert.equal((await f.store.read()).candidates[0].supports.length, 2);
  const confirmed = await f.store.update(old.id, old.revision, "用户确认邮件应当简洁", manualSource);
  assert.equal((await f.store.read()).candidates.length, 0);
  const directUpdate = {
    ...proposed,
    revision: confirmed.revision,
    quote: "我以后都更喜欢详细地写邮件",
    evidence: "direct"
  };
  assert.equal(await f.learn("after-confirmation", [directUpdate]), 0);
  const saved = await f.store.read();
  assert.deepEqual(saved.entries, [JSON.parse(JSON.stringify(confirmed))]);
  assert.equal(saved.candidates.length, 0);
});

test("a manual project edit clears only that project's candidates", async (t) => {
  const f = await fixture(t);
  const projectA = join(f.root, "project-a"),
    projectB = join(f.root, "project-b");
  for (const [task, projectDirectory] of [
    ["a", projectA],
    ["b", projectB]
  ])
    await f.learn(task, [observation("项目表达简洁", observedSpeech, { scope: "project" })], {
      projectDirectory
    });
  await f.learn("user");
  await f.store.remember({
    content: "本项目采用手动确认的约定",
    category: "constraint",
    scope: "project",
    projectDirectory: projectA,
    source: manualSource
  });
  const candidates = (await f.store.read()).candidates;
  assert.equal(candidates.length, 2);
  assert.equal(
    candidates.some((candidate) => candidate.projectDirectory === projectA),
    false
  );
  assert.equal(
    candidates.some((candidate) => candidate.projectDirectory === projectB),
    true
  );
  assert.equal(
    candidates.some((candidate) => candidate.scope === "user"),
    true
  );
});

test("candidate count, content and support evidence remain bounded", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 21; index++)
    assert.equal(await f.learn(`task-${index}`, [observation(`偏好简洁表达，主题${index}`)]), 0);
  const candidates = (await f.store.read()).candidates;
  assert.equal(candidates.length, 20);
  assert.ok(candidates.every((item) => item.content.length <= 500 && item.supports.length <= 3));
  assert.ok(JSON.stringify(candidates).length < 30_000);
  assert.equal(await f.learn("oversized", [observation("x".repeat(501))]), 0);
  const saved = await f.store.read();
  assert.equal(saved.entries.length, 0);
  assert.ok(saved.candidates.every((item) => item.content.length <= 500));
});

test("an oversized direct proposal creates neither a formal memory nor a private candidate", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.learn("oversized-direct", [
      observation("字".repeat(501), directSpeech, {
        evidence: "direct"
      })
    ]),
    0
  );
  const saved = await f.store.read();
  assert.equal(saved.entries.length, 0);
  assert.equal(saved.candidates.length, 0);
});

test("candidates expire after 30 days even if a replay refreshed updatedAt", async (t) => {
  const f = await fixture(t);
  await f.learn("old-source");
  const document = await f.store.read();
  document.candidates[0].firstSeenAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
  document.candidates[0].updatedAt = new Date().toISOString();
  await writeFile(f.store.path, JSON.stringify(document));
  assert.equal(await f.learn("new-one"), 0);
  assert.equal((await f.store.read()).candidates[0].supports.length, 1);
  assert.equal(await f.learn("new-two"), 0);
  assert.equal(await f.learn("new-three"), 1);
});

test("a weak observation near capacity neither compresses nor rewrites formal memory", async (t) => {
  const f = await fixture(t);
  const old = await f.store.remember({
    content: "喜欢跑步。".repeat(399),
    category: "preference",
    scope: "user",
    source: { ...manualSource, origin: "automatic" }
  });
  assert.equal(await f.learn("weak-task"), 0);
  const saved = await f.store.read();
  assert.deepEqual(saved.entries, [JSON.parse(JSON.stringify(old))]);
  assert.equal(saved.candidates.length, 1);
  assert.equal(saved.pending.length, 0);
  assert.equal(f.provider.requests.length, 1, "unadmitted candidates cannot trigger compression");
});

async function pendingCompactionFixture(t, extraChanges = []) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-compaction-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "memory.json"));
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  const originals = [];
  for (let index = 0; index < 5; index++)
    originals.push(
      await store.remember({
        content: String(index) + "字".repeat(397),
        category: "preference",
        scope: "user",
        source: { ...manualSource, origin: "automatic" }
      })
    );
  const explicit = await store.remember({
    content: "手动偏好",
    category: "preference",
    scope: "user",
    source: manualSource
  });
  const proposed = observation("邮件偏好简洁并保留技术说明的重点");
  for (const taskId of ["one", "two"]) {
    await store.enqueueLearning({ taskId, runId: taskId, text: observedSpeech }, Date.now() - 60_001);
    assert.equal(await store.applyLearning((await store.read()).pending[0], [proposed]), 0);
  }
  await store.enqueueLearning(
    { taskId: "three", runId: "three", text: `${directSpeech}\n${observedSpeech}` },
    Date.now() - 60_001
  );
  const before = await store.read();
  const changes = [...extraChanges.map((change) => change(originals)), proposed];
  await assert.rejects(
    store.applyLearning(before.pending[0], changes, { requireCapacity: true }),
    MemoryCapacityError
  );
  return {
    store,
    originals,
    explicit,
    changes,
    before,
    job: before.pending[0],
    compaction: {
      revision: userMemoryRevision(before),
      entries: originals.map((entry, index) => ({ id: entry.id, content: `保留偏好${index}` }))
    }
  };
}

test("manual reconfirmation invalidates an in-flight compaction even when entries are unchanged", async (t) => {
  const f = await pendingCompactionFixture(t);
  await f.store.remember({
    content: f.explicit.content,
    category: f.explicit.category,
    scope: f.explicit.scope,
    source: manualSource
  });
  assert.equal((await f.store.read()).candidates.length, 0);
  assert.equal(
    await f.store.applyLearning(f.job, f.changes, { requireCapacity: true, compaction: f.compaction }),
    0
  );
  const saved = await f.store.read();
  assert.deepEqual(saved.entries, f.before.entries);
  assert.equal(saved.candidates.length, 0, "a stale result cannot recreate cleared support");
  assert.equal(saved.pending.length, 1, "fresh learning can reconsider the pending source");
});

for (const withDirectChange of [false, true]) {
  test(`expired support cannot justify compaction with ${withDirectChange ? "an unrelated admitted update" : "no admitted changes"}`, async (t) => {
    const f = await pendingCompactionFixture(
      t,
      withDirectChange
        ? [
            (originals) =>
              observation(originals[0].content.slice(0, -1), directSpeech, {
                action: "update",
                id: originals[0].id,
                revision: originals[0].revision,
                evidence: "direct"
              })
          ]
        : []
    );
    const expired = await f.store.read();
    expired.candidates[0].firstSeenAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await writeFile(f.store.path, JSON.stringify(expired));
    assert.equal(
      await f.store.applyLearning(f.job, f.changes, { requireCapacity: true, compaction: f.compaction }),
      withDirectChange ? 1 : 0
    );
    const saved = await f.store.read();
    assert.deepEqual(saved.entries.slice(1), f.before.entries.slice(1));
    assert.equal(saved.entries[0].content, withDirectChange ? f.changes[0].content : f.originals[0].content);
    assert.equal(saved.candidates[0].supports.length, 1);
    assert.equal(saved.pending.length, 0);
  });
}

test("capacity retries atomically preserve prior support and partial changes until compression succeeds", async (t) => {
  const f = await fixture(t);
  const originals = [];
  for (let index = 0; index < 5; index++)
    originals.push(
      await f.store.remember({
        content: String(index) + "字".repeat(397),
        category: "preference",
        scope: "user",
        source: { ...manualSource, origin: "automatic" }
      })
    );
  const proposed = observation("邮件偏好简洁并保留技术说明的重点");
  assert.equal(await f.learn("one", [proposed]), 0);
  assert.equal(await f.learn("two", [proposed]), 0);
  const before = JSON.parse(JSON.stringify((await f.store.read()).entries));
  const changes = [
    observation(originals[0].content + "续", directSpeech, {
      action: "update",
      id: originals[0].id,
      revision: originals[0].revision,
      evidence: "direct"
    }),
    proposed
  ];
  let compressions = 0;
  const reply = async (body) => {
    const payload = JSON.parse(body.messages.find((message) => message.role === "user").content);
    if (!payload.automaticMemories) return { text: JSON.stringify({ changes }) };
    compressions++;
    const uncommitted = await new UserMemoryStore(f.store.path).read();
    assert.deepEqual(uncommitted.entries, before, "an earlier change in the failed batch cannot leak");
    assert.equal(uncommitted.candidates[0].supports.length, 2, "failed admission cannot consume support");
    assert.equal(uncommitted.pending.length, 1, "input stays queued during compression");
    return {
      text: JSON.stringify({
        entries:
          compressions === 1
            ? []
            : originals.map((entry, index) => ({
                id: entry.id,
                content: `保留偏好${index}`
              }))
      })
    };
  };
  assert.equal(
    await f.learn("three", changes, {
      text: `${directSpeech}\n${observedSpeech}`,
      reply
    }),
    0
  );
  const failed = await new UserMemoryStore(f.store.path).read();
  assert.deepEqual(failed.entries, before);
  assert.equal(failed.candidates[0].supports.length, 2);
  assert.equal(failed.pending.length, 1);
  assert.equal(failed.pending[0].attempts, 1);
  f.setReply(reply);
  assert.equal(
    await processUserMemoryLearning({
      store: new UserMemoryStore(f.store.path),
      connection: f.connection,
      now: failed.pending[0].availableAt + 1,
      isTaskActive: () => false,
      isForegroundActive: () => false
    }),
    2
  );
  const saved = await f.store.read();
  assert.equal(saved.entries.length, 6);
  assert.equal(saved.entries.filter((entry) => entry.content === proposed.content).length, 1);
  assert.equal(saved.entries.find((entry) => entry.id === originals[0].id).content, changes[0].content);
  assert.equal(saved.candidates.length, 0);
  assert.equal(saved.pending.length, 0);
  assert.equal(compressions, 2);
  assert.equal(f.provider.requests.length, 6);
});
