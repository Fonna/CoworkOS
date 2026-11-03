import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function waitFor(check, description) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, description);
    await delay(20);
  }
}

test(
  "a new Dashboard process resumes a queued input with prior tool evidence and no repeated side effect",
  { timeout: 60_000 },
  async (t) => {
    let dashboard;
    let release;
    const heldResponse = new Promise((resolve) => {
      release = resolve;
    });
    const provider = await modelProtocolFixture("openai-completions", async (_body, requests) => {
      if (requests.length === 1)
        return {
          name: "bash",
          arguments: {
            command: `printf 'once\\n' >> ${shellQuote(join(dashboard.root, "effect.txt"))}; printf RESTART_TOOL_EVIDENCE`
          }
        };
      if (requests.length === 2) await heldResponse;
      return { text: "Restart continuation complete." };
    });
    t.after(async () => {
      release();
      await dashboard?.stop();
      await provider.close();
    });
    dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
    const api = async (path, body) => {
      const response = await fetch(`${dashboard.base}${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            }),
        signal: AbortSignal.timeout(5_000)
      });
      const payload = await response.json();
      assert.ok(response.ok, JSON.stringify(payload));
      return payload;
    };
    const taskId = "restart-queued-evidence";
    const prompt = "Run the isolated side effect once, then wait for completion.";
    const queuedText = "RESTART_QUEUED_INPUT";
    await api("/api/tasks", { taskId, goal: prompt });
    const first = await api(`/api/tasks/${taskId}/run`, { prompt });
    await waitFor(() => provider.requests.length === 2, "the completed tool must reach the next model call");
    assert.equal(await readFile(join(dashboard.root, "effect.txt"), "utf8"), "once\n");
    const queued = await api(`/api/tasks/${taskId}/interject`, {
      message: queuedText,
      delivery: "followUp"
    });
    const inboxPath = join(
      dashboard.workspaceRoot,
      taskId,
      "runs",
      first.runId,
      "agents/main/inbox-store.json"
    );
    const readQueued = async () =>
      JSON.parse(await readFile(inboxPath, "utf8")).find((entry) => entry.messageId === queued.messageId);
    assert.equal((await readQueued()).state, "ready");

    const oldProcess = dashboard.child;
    const oldPid = oldProcess.pid;
    await dashboard.restart({ newPort: true });
    assert.notEqual(dashboard.child.pid, oldPid, "recovery runs in a newly launched backend process");
    assert.ok(oldProcess.exitCode !== null || oldProcess.signalCode !== null, "the old backend exited");
    const restored = await api(`/api/tasks/${taskId}`);
    assert.equal(restored.task.status, "waiting");
    assert.equal(restored.task.activeRunId, first.runId);
    assert.equal(restored.runtime.active, false);
    assert.equal((await readQueued()).state, "ready");
    assert.equal(provider.requests.length, 2, "restart alone must not issue another model request");
    release();

    const resumed = await api(`/api/tasks/${taskId}/interject/${queued.messageId}/steer`, {});
    assert.equal(resumed.runId, first.runId);
    await waitFor(() => provider.requests.length === 3, "the queued request must reach the resumed model");
    const messages = provider.requests[2].body.messages;
    assert.ok(
      messages.some(
        (message) =>
          message.role === "tool" && JSON.stringify(message.content).includes("RESTART_TOOL_EVIDENCE")
      ),
      "completed tool evidence survives backend restart"
    );
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content))
      .join("\n");
    assert.equal(userText.split(queuedText).length - 1, 1, "the queued input enters context exactly once");
    assert.ok(userText.includes(prompt), "the original request is retained");
    await waitFor(
      async () => !(await api(`/api/tasks/${taskId}`)).runtime.active,
      "the resumed Run must settle"
    );
    assert.equal((await api(`/api/tasks/${taskId}`)).task.status, "completed");
    assert.equal((await readQueued()).state, "consumed");
    assert.equal(await readFile(join(dashboard.root, "effect.txt"), "utf8"), "once\n");
    assert.equal(provider.requests.length, 3);
  }
);
