import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { contentText, Type } from "@earendil-works/pi-ai";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { TraceRecorder } from "../dist/src/storage/trace-recorder.js";
import { UserMemoryStore, userMemoryRevision } from "../dist/src/runtime/user-memory-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const marker = "OPTIONAL_PERSONAL_MEMORY";
const memory = `<user_memory>\n${marker}${"m".repeat(1600)}\n</user_memory>`;
const prompt = "CURRENT_REQUEST_MUST_REMAIN_INTACT：保留全部输入并执行当前任务。";
const estimate = (messages) =>
  messages.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0);
const readRequests = async (path) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((row) => row.type === "model_request");

for (const [reserveTokens, maxTokens, priorUsage = 0] of [
  [500, 64],
  [100, 800],
  [100, 64, 850]
]) {
  test(`PiSession omits optional memory instead of compacting or truncating user input (reserve ${reserveTokens}, output ${maxTokens}, previous usage ${priorUsage})`, async (t) => {
    const provider = await modelProtocolFixture("openai-completions", () => ({ text: "Done" }));
    t.after(() => provider.close());
    const root = await mkdtemp(join(tmpdir(), "atria-memory-budget-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const trace = new TraceRecorder(join(root, "run.jsonl"));
    const result = await new PiSession({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      model: "protocol-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      contextWindow: 1000,
      maxTokens,
      systemPrompt: `CURRENT_POLICY_${"s".repeat(650)}`,
      prepareUserMemory: async () => memory,
      tools: new Map(),
      initialMessages: priorUsage
        ? [
            {
              role: "assistant",
              content: [{ type: "text", text: "Previous response" }],
              stopReason: "stop",
              api: "openai-completions",
              provider: "cowork-glm",
              model: "protocol-fixture",
              usage: {
                input: priorUsage - 10,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: priorUsage,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
              },
              timestamp: 1
            }
          ]
        : [],
      compaction: { reserveTokens, keepRecentTokens: 32 },
      trace: { recorder: trace, taskId: "task", runId: "run", agentId: "main" },
      maxErrorRetries: 0
    }).run(prompt);
    assert.equal(result.termination, "completed");
    assert.equal(result.compaction.compactionCount, 0, "optional memory must not force a summary request");
    assert.equal(provider.requests.length, 1);
    const request = provider.requests[0].body;
    assert.equal(contentText(request.messages.find((message) => message.role === "user").content), prompt);
    assert.doesNotMatch(JSON.stringify(request), new RegExp(marker));
    const recorded = (await readRequests(trace.modelRequestPath))[0];
    assert.ok(estimate(recorded.payload.context.messages) <= 1000 - Math.max(reserveTokens, maxTokens));
    assert.equal(
      result.messages.some((message) => JSON.stringify(message).includes(marker)),
      false
    );
  });
}

for (const oversized of [false, true])
  test(`PiSession checks the final compacted request with ${oversized ? "oversized" : "fitting"} memory and refreshes deletion on a real tool turn`, async (t) => {
    let activeMemory = oversized ? `${memory}${"m".repeat(6000)}` : "<user_memory>FRESH_MEMORY</user_memory>";
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      if (JSON.stringify(body).includes("context summarization assistant"))
        return { text: "OLD_HISTORY_SUMMARY" };
      if (!body.messages.some((message) => message.role === "tool"))
        return { name: "clear_memory", arguments: {} };
      return { text: "Done" };
    });
    t.after(() => provider.close());
    const root = await mkdtemp(join(tmpdir(), "atria-memory-compacted-budget-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const trace = new TraceRecorder(join(root, "run.jsonl"));
    const result = await new PiSession({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      model: "protocol-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      contextWindow: 2000,
      maxTokens: 128,
      systemPrompt: "CURRENT_POLICY",
      prepareUserMemory: async () => activeMemory,
      tools: new Map(),
      agentTools: [
        {
          name: "clear_memory",
          label: "Clear optional memory",
          description: "Remove optional memory for the next request.",
          parameters: Type.Object({}),
          execute: async () => {
            activeMemory = "";
            return { content: [{ type: "text", text: "Cleared" }] };
          }
        }
      ],
      initialMessages: [
        { role: "user", content: "OLD_HISTORY_".repeat(1000), timestamp: 1 },
        { role: "user", content: "Keep the current request.", timestamp: 2 }
      ],
      compaction: { reserveTokens: 800, keepRecentTokens: 32 },
      trace: { recorder: trace, taskId: "task", runId: "run", agentId: "main" },
      maxErrorRetries: 0
    }).run(prompt);
    assert.equal(result.termination, "completed");
    assert.equal(result.compaction.compactionCount, 1);
    const records = await readRequests(trace.modelRequestPath);
    const main = records.filter(
      (row) => !row.payload.systemPrompt.includes("context summarization assistant")
    );
    assert.equal(main.length, 2);
    if (oversized) assert.doesNotMatch(JSON.stringify(main[0].payload.request), new RegExp(marker));
    else assert.match(JSON.stringify(main[0].payload.request), /FRESH_MEMORY/);
    assert.doesNotMatch(JSON.stringify(main[1].payload.request), /FRESH_MEMORY/);
    for (const row of main) {
      assert.ok(
        estimate(row.payload.context.messages) <= 1200,
        "final request stays within the input budget"
      );
      assert.match(JSON.stringify(row.payload.request), /CURRENT_REQUEST_MUST_REMAIN_INTACT/);
    }
    assert.doesNotMatch(JSON.stringify(result.messages), /FRESH_MEMORY/);
  });

test(
  "real Pi host honors a custom model compaction reserve and refreshes disabled memory",
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-memory-host-budget-"));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await rm(root, { recursive: true, force: true });
    });
    const project = join(root, "project");
    const piDirectory = join(root, "pi");
    await mkdir(project);
    await mkdir(piDirectory);
    await writeFile(join(root, "config.json"), JSON.stringify({ contextWindow: 64000, mainMaxTokens: 128 }));
    const store = new UserMemoryStore(join(root, "home", "memory", "user-memory.json"));
    await store.setEnabled(true);
    await store.saveText(`${marker}${"m".repeat(1600)}`, userMemoryRevision(await store.read()));
    await store.setEnabled(false);
    let phase = "baseline";
    let turn = 0;
    const provider = await modelProtocolFixture("openai-completions", () => {
      if (phase === "refresh" && turn++ === 0)
        return { name: "manage_user_memory", arguments: { action: "disable", quote: "关闭用户记忆" } };
      return { text: "Done" };
    });
    t.after(() => provider.close());
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^(COWORK_|ATRIA_|PI_|SERPER_|EXA_|OPENAI_|ANTHROPIC_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/.test(
            name
          )
      )
    );
    const run = async () => {
      const taskId = `budget-${phase}`;
      const runId = `run-${phase}`;
      const text = phase === "refresh" ? `${prompt} 关闭用户记忆` : prompt;
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
          ...(phase === "custom" ? ["--system-prompt", "CUSTOM_POLICY_KEEP_VERBATIM"] : []),
          text
        ],
        {
          cwd: resolve("."),
          env: {
            ...inherited,
            ATRIA_HOME: join(root, "home"),
            COWORK_CONFIG: join(root, "config.json"),
            COWORK_WORKSPACE: join(root, "workspace"),
            COWORK_PROJECT_DIR: project,
            COWORK_TABS_INDEX: join(root, "tabs.json"),
            COWORK_TASK_ID: taskId,
            COWORK_RUN_ID: runId,
            COWORK_API_BASE: provider.baseUrl,
            COWORK_API_KEY: "fixture",
            COWORK_MODEL: "protocol-fixture",
            COWORK_MODEL_API: "openai-completions",
            COWORK_MAIN_MAX_TOKENS: "128",
            COWORK_DISABLE_WATCH_SUPERVISOR: "1",
            COWORK_WEB_TOOLS: "0",
            COWORK_REASONING_EFFORT: "off",
            COWORK_SUPPORTS_REASONING_EFFORT: "0",
            PI_CODING_AGENT_DIR: piDirectory,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0"
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
      assert.equal(code, 0, output);
      return readRequests(join(root, "workspace", taskId, "sessions", "main", `${runId}-requests.jsonl`));
    };
    const baseline = await run();
    assert.equal(baseline.length, 1);
    const baseTokens = estimate(baseline[0].payload.context.messages);
    const inputBudget = baseTokens + 100;
    assert.ok(inputBudget < 64000);
    await writeFile(
      join(piDirectory, "settings.json"),
      JSON.stringify({
        compaction: {
          enabled: true,
          reserveTokens: 128,
          keepRecentTokens: 32,
          modelOverrides: { "cowork-glm/protocol-fixture": { reserveTokens: 64000 - inputBudget } }
        }
      })
    );
    await store.setEnabled(true);
    phase = "limitedx";
    const limited = await run();
    assert.equal(limited.length, 1, "memory does not cause a separate compaction request");
    assert.match(JSON.stringify(limited[0].payload.request), /CURRENT_REQUEST_MUST_REMAIN_INTACT/);
    assert.doesNotMatch(JSON.stringify(limited[0].payload.request), new RegExp(marker));
    assert.ok(estimate(limited[0].payload.context.messages) <= inputBudget);
    await writeFile(
      join(piDirectory, "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 128 } })
    );
    phase = "refresh";
    const refreshed = await run();
    assert.equal(refreshed.length, 2);
    assert.match(refreshed[0].payload.systemPrompt, new RegExp(marker));
    assert.doesNotMatch(refreshed[1].payload.systemPrompt, new RegExp(marker));
    assert.equal((await store.read()).enabled, false);
    await store.setEnabled(true);
    phase = "custom";
    const custom = await run();
    assert.match(custom[0].payload.systemPrompt, /^CUSTOM_POLICY_KEEP_VERBATIM/);
    assert.match(custom[0].payload.systemPrompt, new RegExp(marker));
    assert.doesNotMatch(custom[0].payload.systemPrompt, /You are CoworkOS Main/);
  }
);
