import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { minimalReplace, operationId } from "../web/assets/workbench/adapters/text-editor.js";
import { buildTabs } from "../web/assets/workbench/host.js";

/**
 * The MVP's acceptance demo, run end to end.
 *
 * Every step is one of the nine success criteria from the plan: the Agent
 * creates a document and a tab appears, the user edits it the way the browser
 * adapter would, the conversation shows an unread badge, state survives a
 * restart, the Agent is told what changed and continues without clobbering it,
 * history distinguishes who did what, undo works and the file publishes.
 */
async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

async function scenario(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-workbench-e2e-"));
  const workspaceRoot = join(root, "workspace");
  await new LocalWorkspaceStore(workspaceRoot).createTask("task", { goal: "产品方案协作" });
  await writeFile(join(root, "config.json"), "{}");
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/cli/dashboard.js"], {
    cwd: resolve("."),
    stdio: "ignore",
    env: {
      ...process.env,
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_UI_PORT: String(port),
      COWORK_API_BASE: "",
      COWORK_API_KEY: ""
    }
  });
  t.after(async () => {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/tasks`)).ok) break;
    } catch {
      /* waiting for the listener */
    }
    if (child.exitCode !== null) throw new Error("dashboard exited before listening");
    await delay(20);
  }
  const call = async (path, options) => {
    const response = await fetch(`${base}${path}`, options);
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };
  return { base, call, workspaceRoot, agent: new ApplicationService(workspaceRoot) };
}

const post = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {})
});
const agentActor = { type: "agent", id: "main" };

/** Type into the document the way the browser adapter does: one debounced patch. */
async function typeInEditor(call, resourceId, before, after, appInstanceId) {
  const patch = minimalReplace(before, after);
  const result = await call(
    `/api/tasks/task/resources/${resourceId}/operations`,
    post({
      operationId: operationId(),
      appType: "text-editor",
      operationType: "text.replace",
      baseRevision: (await call(`/api/tasks/task/resources/${resourceId}`)).body.resource.revision,
      appInstanceId,
      payload: { from: patch.from, to: patch.to, text: patch.text }
    })
  );
  assert.equal(result.status, 200, `editing must succeed: ${JSON.stringify(result.body)}`);
  return result.body.snapshot.content;
}

test("the MVP acceptance demo runs end to end", { timeout: 60000 }, async (t) => {
  const { call, workspaceRoot, agent } = await scenario(t);

  // 1–2. The Agent creates the document; a tab opens for it automatically.
  const created = await agent.createResource({
    taskId: "task",
    kind: "text/markdown",
    title: "proposal.md",
    actor: agentActor,
    initialContent:
      "# 产品方案\n\n## 背景\n这是初稿的背景段落。\n\n## 目标用户\n目标用户是谁还需要确认。\n\n- 支持协作\n"
  });
  const resourceId = created.resource.resourceId;
  const appInstanceId = created.appInstance.appInstanceId;
  await agent.context.recordAcknowledged("task", "main", resourceId, created.resource.revision);

  let detail = await call("/api/tasks/task");
  assert.equal(
    detail.body.applications.instances.length,
    1,
    "creating a resource must open an application window"
  );
  assert.equal(detail.body.applications.instances[0].title, "proposal.md");
  // The strip is global, so it is read from its own endpoint rather than
  // derived from one task's detail.
  await call("/api/workbench/tabs", post({ kind: "application", resourceId, bindTo: "task" }));
  const strip = (await call("/api/workbench/tabs")).body;
  const tab = strip.tabs.find((entry) => entry.resourceId === resourceId);
  assert.ok(tab, "the document appears in the global strip");
  assert.equal(tab.title, "proposal.md");
  // One document, one tab: it names no conversation and lists the ones that
  // reference it instead.
  assert.equal(tab.taskId, undefined);
  assert.deepEqual(
    tab.conversations.map((entry) => entry.taskId),
    ["task"]
  );
  assert.equal(
    buildTabs({ tabs: strip.tabs, activeTabId: strip.activeTabId }).tabs.at(-1).title,
    "proposal.md"
  );

  // 3. The user makes three edits: rewrite a sentence, delete a paragraph, add a list item.
  let content = (await call(`/api/tasks/task/resources/${resourceId}`)).body.snapshot.content;
  content = await typeInEditor(
    call,
    resourceId,
    content,
    content.replace("## 背景", "## 问题背景"),
    appInstanceId
  );
  content = await typeInEditor(
    call,
    resourceId,
    content,
    content.replace("这是初稿的背景段落。\n", ""),
    appInstanceId
  );
  content = await typeInEditor(call, resourceId, content, `${content}- 支持离线工作\n`, appInstanceId);
  assert.match(content, /## 问题背景/);
  assert.equal(content.includes("这是初稿的背景段落"), false);
  assert.match(content, /支持离线工作/);

  // 4. The conversation shows three unread changes, and everything survives a reload.
  detail = await call("/api/tasks/task");
  const unread = detail.body.applications.unread.find((entry) => entry.resourceId === resourceId);
  assert.equal(unread.unread, 3, "the tab badge counts changes the Agent has not read");
  const reopened = new ApplicationService(workspaceRoot);
  const afterReload = await reopened.readResource("task", resourceId);
  assert.equal(afterReload.snapshot.content, content, "a page reload must not lose the document");
  assert.equal(afterReload.resource.revision, 3);

  // 5. The user binds the conversation to this document and selects a
  // paragraph. Binding is explicit — the Agent creating the resource opened a
  // tab, but did not attach the conversation to it.
  await call(`/api/tasks/task/app-instances/${appInstanceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: true, status: "open" })
  });
  const target = content.indexOf("目标用户是谁还需要确认。");
  await call(`/api/tasks/task/resources/${resourceId}/selection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: "text.range/v1",
      appInstanceId,
      data: { anchor: target, head: target + 12 }
    })
  });

  // 6. The Agent's next turn is handed the active app, selection and the three changes.
  const context = await reopened.activeContext({ taskId: "task", agentId: "main" });
  assert.equal(context.resource.resourceId, resourceId);
  assert.equal(context.resource.revision, 3);
  assert.equal(context.changesSinceAgentRevision.length, 3);
  assert.match(context.selection.summary, /目标用户是谁/);
  const rendered = reopened.context.render(context);
  assert.match(rendered, /问题背景/);
  assert.match(rendered, /支持离线工作/);
  // The Agent is told what changed, within a fixed budget — never handed the
  // document. A long deleted section is described by length, not reproduced.
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 8 * 1024);
  assert.equal(rendered.includes(content), false, "the full document must never be injected");
  const longDeletion = await reopened.applyOperation({
    taskId: "task",
    resourceId,
    operationId: "user-long-delete",
    appType: "text-editor",
    operationType: "text.replace",
    baseRevision: 3,
    actor: { type: "user", id: "local" },
    payload: { from: 0, to: 0, text: `${"需要被删除的长段落".repeat(30)}\n` }
  });
  const removal = await reopened.applyOperation({
    taskId: "task",
    resourceId,
    operationId: "user-long-delete-2",
    appType: "text-editor",
    operationType: "text.replace",
    baseRevision: longDeletion.resource.revision,
    actor: { type: "user", id: "local" },
    payload: { from: 0, to: 271, text: "" }
  });
  assert.ok(
    removal.event.summary.length < 100,
    `a long deletion must be summarized, got ${removal.event.summary.length}`
  );
  assert.match(removal.event.summary, /删除/);
  await reopened.undo({ taskId: "task", resourceId, actor: { type: "user", id: "local" } });
  await reopened.undo({ taskId: "task", resourceId, actor: { type: "user", id: "local" } });
  assert.equal(
    (await reopened.readResource("task", resourceId)).snapshot.content,
    content,
    "the demo document is restored"
  );
  const restoredRevision = (await reopened.readResource("task", resourceId)).resource.revision;

  // 7. The Agent rewrites only the selected sentence, on the current revision.
  const beforeAgent = (await reopened.readResource("task", resourceId)).snapshot.content;
  const agentEdit = await reopened.applyOperation({
    taskId: "task",
    resourceId,
    operationId: "agent-rewrite",
    appType: "text-editor",
    operationType: "text.replace",
    baseRevision: restoredRevision,
    actor: agentActor,
    payload: { from: target, to: target + 12, text: "目标用户是需要在多人项目中协同的一线产品经理。" }
  });
  assert.equal(agentEdit.resource.revision, restoredRevision + 1);
  const afterAgent = agentEdit.snapshot.content;
  assert.match(afterAgent, /一线产品经理/);
  // The user's three edits are all still there: the Agent added, it did not overwrite.
  assert.match(afterAgent, /## 问题背景/);
  assert.match(afterAgent, /支持离线工作/);
  assert.equal(afterAgent.includes("这是初稿的背景段落"), false);
  assert.equal(
    beforeAgent.replace("目标用户是谁还需要确认。", "目标用户是需要在多人项目中协同的一线产品经理。"),
    afterAgent
  );

  // 8. History attributes each revision, undo works, and the file publishes.
  const history = (await call(`/api/tasks/task/resources/${resourceId}/operations?afterRevision=0&limit=200`))
    .body;
  assert.deepEqual(
    history.operations.slice(0, 3).map((event) => event.actor.type),
    ["user", "user", "user"]
  );
  assert.equal(history.operations.at(-1).actor.type, "agent", "the Agent's rewrite is attributed to it");
  assert.ok(
    history.operations.every((event) => event.summary.length > 0),
    "每条记录都要能读懂"
  );

  const undone = await call(`/api/tasks/task/resources/${resourceId}/undo`, post({ appInstanceId }));
  assert.equal(undone.status, 200);
  assert.equal(undone.body.snapshot.content, beforeAgent, "undo reverses the last change");
  assert.equal(
    undone.body.resource.revision,
    agentEdit.resource.revision + 1,
    "undo is a new revision, not a rewrite of history"
  );

  const redone = await call(
    `/api/tasks/task/resources/${resourceId}/operations`,
    post({
      operationId: "agent-rewrite-again",
      appType: "text-editor",
      operationType: "text.replace",
      baseRevision: undone.body.resource.revision,
      payload: { from: target, to: target + 12, text: "目标用户是需要在多人项目中协同的一线产品经理。" }
    })
  );
  assert.equal(redone.status, 200);

  // 8b. No publish step: the document is already one of the Task's outputs,
  // at its live revision, and its file is on disk under the Task.
  detail = await call("/api/tasks/task");
  const deliverable = detail.body.applications.deliverables.find((row) => row.resourceId === resourceId);
  assert.ok(deliverable, "the document appears in the outputs panel without being published");
  assert.equal(deliverable.kind, "resource");
  assert.equal(deliverable.editable, true);
  assert.equal(deliverable.revision, redone.body.resource.revision);
  const onDisk = await readFile(
    join(workspaceRoot, "applications", "text-editor", "files", redone.body.resource.path),
    "utf8"
  );
  assert.equal(onDisk, redone.body.snapshot.content, "the file holds exactly what the editor shows");
  assert.match(onDisk, /一线产品经理/);
  assert.match(onDisk, /支持离线工作/);
});

test(
  "a conflict during the demo preserves the user's draft rather than resolving it silently",
  { timeout: 60000 },
  async (t) => {
    const { call, agent } = await scenario(t);
    const created = await agent.createResource({
      taskId: "task",
      kind: "text/markdown",
      title: "shared.md",
      initialContent: "第一行\n",
      actor: agentActor
    });
    const resourceId = created.resource.resourceId;

    // The Agent read revision 0 and is preparing an edit. The user saves first.
    await call(
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "user-first",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "用户先写的一行\n" }
      })
    );

    await assert.rejects(
      () =>
        agent.applyOperation({
          taskId: "task",
          resourceId,
          operationId: "agent-stale",
          appType: "text-editor",
          operationType: "text.replace",
          baseRevision: 0,
          payload: { from: 0, to: 3, text: "Agent 覆盖" },
          actor: agentActor
        }),
      (error) => error.code === "revision_conflict" && error.details.currentRevision === 1
    );
    const current = await agent.readResource("task", resourceId);
    assert.equal(
      current.snapshot.content,
      "用户先写的一行\n第一行\n",
      "the user's line must survive the refused write"
    );

    // Recomputing against the new revision succeeds and keeps both.
    const recovered = await agent.applyOperation({
      taskId: "task",
      resourceId,
      operationId: "agent-retry",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 1,
      payload: { at: current.snapshot.content.length, text: "CoworkOS 补的一行\n" },
      actor: agentActor
    });
    assert.equal(recovered.snapshot.content, "用户先写的一行\n第一行\nCoworkOS 补的一行\n");
  }
);
