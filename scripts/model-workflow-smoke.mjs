import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

// Explicit opt-in only. Ordinary tests never use an account or model quota.
const endpoint = process.env.COWORK_SMOKE_API_BASE;
const apiKey = process.env.COWORK_SMOKE_API_KEY;
const model = process.env.COWORK_SMOKE_MODEL;
if (!endpoint || !apiKey || !model)
  throw new Error("Set COWORK_SMOKE_API_BASE, COWORK_SMOKE_API_KEY and COWORK_SMOKE_MODEL");
const server = await startDashboard({
  modelEndpoint: endpoint,
  model,
  env: { COWORK_API_KEY: apiKey, COWORK_HUMAN_ANSWER_TIMEOUT_MS: "120000" }
});
const taskId = "model-workflow-smoke";
const expected = "WINDOWS_READY_42";
const api = async (path, body) => {
  const response = await fetch(server.base + path, {
    ...(body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
    signal: AbortSignal.timeout(10000)
  });
  assert.ok(response.ok, `Smoke API returned HTTP ${response.status}`);
  return response.json();
};
try {
  const prompt =
    "This is an isolated acceptance test. First write result.md containing PENDING in your working directory and read it back. Then call askhuman to ask which acceptance code to put in this file. Wait for the actual answer; do not guess or use a recommendation. After receiving it, replace result.md with exactly that code, read it back to verify, and finish. Use file tools, not shell commands. Do not delegate.";
  await api("/api/tasks", { taskId, goal: prompt });
  await api(`/api/tasks/${taskId}/run`, { prompt });
  const path = join(server.workspaceRoot, taskId, "agents", "main", "work", "result.md");
  let answered = false,
    completed = false;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const detail = await api(`/api/tasks/${taskId}`);
    const question = detail.humanRequests?.find((value) => value.status === "pending");
    if (question && !answered) {
      assert.match(await readFile(path, "utf8"), /PENDING/);
      await api(`/api/tasks/${taskId}/human/${question.requestId}/answer`, { answer: expected });
      answered = true;
    }
    if (!detail.runtime.active) {
      assert.equal(detail.task.status, "completed", "Model workflow did not complete");
      completed = true;
      break;
    }
    await delay(100);
  }
  assert.ok(answered && completed, "Model did not complete the human-answer workflow within 180 seconds");
  assert.equal((await readFile(path, "utf8")).trim(), expected);
  await server.restart({ newPort: true });
  const restored = await api(`/api/tasks/${taskId}`);
  assert.equal(restored.task.status, "completed");
  assert.equal((await readFile(path, "utf8")).trim(), expected);
  console.log(
    JSON.stringify({ ok: true, model, fileVerified: true, humanAnswerVerified: true, restartVerified: true })
  );
} finally {
  await server.stop();
}
