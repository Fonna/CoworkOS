import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

async function fixture(t, timeoutMs) {
  const root = await mkdtemp(join(tmpdir(), "atria-question-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = new LocalWorkspaceStore(root);
  await task.createTask("task");
  await task.createRun("task", "run");
  const human = new HumanRequestStore(root);
  const inbox = new MainInboxDelivery(root, "task", "run");
  const tools = new Map();
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const modulePath = resolve(".pi/runtime/tools/coordination.ts");
  const jiti = createJiti(pathToFileURL(modulePath).href, { interopDefault: true });
  const { registerCoordinationTools } = await jiti.import(modulePath);
  registerCoordinationTools(
    {
      registerTool(tool) {
        tools.set(tool.name, tool);
      }
    },
    {
      taskId: "task",
      mainRunId: "run",
      workspaceRoot: root,
      runtimeEnv: { COWORK_HUMAN_ANSWER_TIMEOUT_MS: String(timeoutMs) },
      humanStore: human,
      inboxDelivery: inbox,
      updateRuntime() {}
    }
  );
  return { human, inbox, tool: tools.get("askhuman"), ctx: { ui: { notify() {} } } };
}

test("aborting askhuman releases its wait promptly and clears the pending question", async (t) => {
  const f = await fixture(t, 1000);
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await f.tool.execute("ask", { question: "继续吗？" }, controller.signal, undefined, f.ctx);
  assert.equal(result.details.status, "cancelled");
  assert.ok(Date.now() - started < 700, "Escape must not wait out the configured human timeout");
  assert.deepEqual(await f.human.list("task", "pending"), []);
});

test("askhuman timeout and rendered recommendation use the same normalized option", async (t) => {
  const f = await fixture(t, 0);
  const result = await f.tool.execute(
    "ask",
    { question: "格式？", options: [" ", "Markdown", "PDF"], recommended: 1 },
    undefined,
    undefined,
    f.ctx
  );
  const [question] = await f.human.list("task");
  assert.equal(question.options[question.recommended], "Markdown");
  assert.equal(result.details.recommendedOption, "Markdown");
});
