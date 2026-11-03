import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
import { GoalSupervisor } from "../dist/src/runtime/goal-supervisor.js";

const brief = {
  title: "Claude Code 长期跟进",
  objective: "跟进官方版本与兼容性变化",
  preferences: ["普通更新周报，重要变化及时提醒"],
  notificationPolicy: "digest",
  digest: { dayOfWeek: 0, hour: 18, minute: 0, timeZone: "Asia/Shanghai" }
};
const post = async (base, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
};
const goalPath = (goal) => `/api/tasks/${goal.taskId}/goals/${goal.programId}`;
async function fixtureModel({ hold = false, registerScope, parallelFallback = false } = {}) {
  const requests = [];
  const plans = new Map();
  let feeds;
  let sources = [];
  let reuseExisting = false;
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/feed/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (req.method === "GET") {
      res.end(JSON.stringify({ data: [{ id: "goal-fixture" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `goal-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "goal-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant" });
    if (hold) return;
    const call = (name, input) => {
      send({
        tool_calls: [
          {
            index: 0,
            id: `goal-call-${requests.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(input) }
          }
        ]
      });
      send({}, "tool_calls");
    };
    if (!body.tools?.some((tool) => tool.function?.name === "manage_goal")) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "enable-monitors",
            type: "function",
            function: {
              name: "enable_tools",
              arguments: JSON.stringify({ groups: ["monitors"] })
            }
          }
        ]
      });
      send({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    const text = JSON.stringify(body.messages);
    // An in-session create can deliver its command before Pi exits. That
    // running session still has its original system prompt; the durable Inbox
    // event, rather than a restarted prompt, supplies the new goal context.
    const hasGoalContext = body.messages.some(
      (message) =>
        (message.role === "system" && String(message.content).includes("<long_term_goal_state>")) ||
        (message.role === "user" && JSON.stringify(message.content).includes("watch.goal_command"))
    );
    if (reuseExisting && !hasGoalContext) {
      const actions = body.messages.flatMap((message) =>
        (message.tool_calls ?? [])
          .filter((entry) => entry.function?.name === "manage_goal")
          .map((entry) => JSON.parse(entry.function.arguments).action)
      );
      const previous = body.messages.findLast((message) => message.role === "tool");
      if (!actions.includes("list")) call("manage_goal", { action: "list" });
      else if (!actions.includes("get")) {
        const existing = JSON.parse(previous.content).goals.find((goal) => goal.title === brief.title);
        call("manage_goal", { action: "get", programId: existing.programId });
      } else if (!actions.includes("steer")) {
        const existing = JSON.parse(previous.content);
        call("manage_goal", {
          action: "steer",
          programId: existing.programId,
          revision: existing.goal.revision,
          message: "复用当前目标，核对现有来源后继续跟进；不新建采集器，不恢复暂停的目标。"
        });
      } else if (
        !body.messages.some((message) =>
          message.tool_calls?.some((entry) => entry.function?.name === "create_watcher")
        )
      ) {
        // Deliberately reproduce a model dropping programId after delegation.
        call("create_watcher", {
          template: "resource-version",
          task: "错误的独立替代采集器",
          source: sources[0],
          config: { stableChecks: 1 },
          cadenceSeconds: 60,
          scope: "background"
        });
      } else {
        const steer = body.messages
          .flatMap((message) => message.tool_calls ?? [])
          .findLast(
            (entry) =>
              entry.function?.name === "manage_goal" &&
              JSON.parse(entry.function.arguments).action === "steer"
          );
        const response = body.messages.find((message) => message.tool_call_id === steer.id);
        send({
          content: response.content.includes("目标已暂停") ? "已有目标保持暂停。" : "已复用并交给后台跟进。"
        });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    if (registerScope && !hasGoalContext) {
      if (
        !body.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.tool_calls?.some((call) => call.function?.name === "manage_goal")
        )
      ) {
        send({
          tool_calls: [
            {
              index: 0,
              id: "register-goal",
              type: "function",
              function: {
                name: "manage_goal",
                arguments: JSON.stringify({ action: "create", scope: registerScope, brief })
              }
            },
            ...(parallelFallback
              ? [
                  {
                    index: 1,
                    id: "parallel-fallback",
                    type: "function",
                    function: {
                      name: "create_watcher",
                      arguments: JSON.stringify({
                        template: "resource-version",
                        task: "同一响应中的错误独立采集器",
                        source: sources[0],
                        cadenceSeconds: 60,
                        scope: "background",
                        config: { stableChecks: 1 }
                      })
                    }
                  }
                ]
              : [])
          ]
        });
        send({}, "tool_calls");
      } else {
        send({ content: "长期目标已登记。" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    const match = text.match(/goal_[a-f0-9]{32}/);
    if (!match) {
      send({ content: "请登记长期目标。" });
      send({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    const programId = match[0];
    const index = plans.get(programId) ?? 0;
    plans.set(programId, index + 1);
    if (index === 0 || index === 1)
      call("create_watcher", {
        programId,
        task: index === 0 ? "Claude Code 官方发布" : "Claude Code 公告",
        template: "resource-version",
        source: sources[index],
        cadenceSeconds: 60,
        config: { stableChecks: 1 }
      });
    else if (index === 2)
      call("record_goal_progress", {
        programId,
        revision: 1,
        summary: "已接入两个来源，等待新发布",
        nextAction: "核实新发布对项目的影响",
        waitingFor: "可靠来源的新内容",
        disposition: "wait",
        steps: [
          { id: "sources", description: "接入官方来源", status: "completed", evidence: "两个探针已通过" },
          { id: "follow", description: "分析新增版本", status: "active" }
        ],
        facts: ["仅报告有证据的变化"]
      });
    else if (index === 3)
      call("publish_goal_update", {
        programId,
        revision: 2,
        topicKey: "claude-code/test-version/permissions",
        kind: "important",
        title: "测试：Claude Code 权限变化",
        summary: "本地协议测试数据，用于验证动态链路。",
        sources: [{ title: "官方测试来源", url: "https://example.com/release" }]
      });
    else if (index === 4)
      call("publish_goal_update", {
        programId,
        revision: 2,
        topicKey: "claude-code/test-version/permissions",
        kind: "important",
        title: "测试：同一版本的另一条报道",
        summary: "同一变化的新证据",
        sources: [{ title: "另一测试来源", url: "https://example.com/announcement" }]
      });
    else if (index === 6) call("manage_goal", { action: "get", programId });
    else if (index === 7) {
      const previous = body.messages.findLast((message) => message.role === "tool");
      const current = JSON.parse(previous.content);
      call("record_goal_progress", {
        programId,
        revision: current.goal.revision,
        summary: "已根据新要求调整计划",
        disposition: "wait",
        waitingFor: "新的官方公告"
      });
    } else {
      send({ content: "已制定计划，继续等待可靠来源变化。" });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  feeds = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint: `${feeds}/v1`,
    requests,
    setSources: (value) => {
      sources = value;
    },
    reuseExistingGoal: () => {
      reuseExisting = true;
    },
    stop: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      })
  };
}

for (const scope of ["session", "background"])
  test(`${scope}: goal → real Pi tools → grouped sources → quiet wait → durable UI`, async ({ page }) => {
    test.setTimeout(90000);
    const model = await fixtureModel();
    const app = await startDashboard({
      monitoring: true,
      modelEndpoint: model.endpoint,
      model: "goal-fixture"
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      let source;
      if (scope === "session")
        source = await post(app.base, "/api/tasks", { goal: "监控 Claude Code", taskId: "goal-session" });
      const sources = [join(app.root, "releases.json"), join(app.root, "announcements.json")];
      for (const source of sources)
        await writeFile(source, JSON.stringify({ items: [], description: "Claude Code source snapshot" }));
      model.setSources(sources);
      const program = await post(app.base, "/api/goals", {
        brief,
        scope,
        requestId: "browser-goal",
        ...(source ? { sourceTaskId: source.taskId } : {})
      });
      expect(program.scope).toBe(scope);
      const read = async () => (await fetch(`${app.base}${goalPath(program)}`)).json();
      await expect.poll(async () => (await read()).goal.disposition, { timeout: 40000 }).toBe("wait");
      await expect.poll(async () => (await read()).activity.unreadCount).toBe(1);
      await expect
        .poll(
          async () => (await (await fetch(`${app.base}/api/tasks/${program.taskId}`)).json()).runtime.active
        )
        .toBe(false);
      const goal = await read();
      expect(goal.monitors).toHaveLength(2);
      expect(
        goal.monitors.every(
          (monitor) => monitor.taskId === program.taskId && monitor.programId === program.programId
        )
      ).toBe(true);
      expect(goal.activity.updates[0].sources).toHaveLength(2);
      expect(model.requests[0].tools.map((tool) => tool.function.name)).toContain("enable_tools");
      expect(model.requests[0].tools.map((tool) => tool.function.name)).not.toContain("manage_goal");
      expect(model.requests[1].tools.map((tool) => tool.function.name)).toEqual(
        expect.arrayContaining(["manage_goal", "record_goal_progress", "publish_goal_update"])
      );
      expect(JSON.stringify(model.requests[0].messages)).toContain("long_term_goal_state");
      const count = model.requests.length;
      for (const monitor of goal.monitors) {
        const statePath = join(
          app.workspaceRoot,
          program.taskId,
          "watch",
          "programs",
          program.programId,
          "monitor-state",
          `${monitor.monitorId}.json`
        );
        const state = JSON.parse(await readFile(statePath, "utf8"));
        await writeFile(
          statePath,
          JSON.stringify({
            ...state,
            lastCheckedAt: "1970-01-01T00:00:00Z",
            nextCheckAt: "1970-01-01T00:00:00Z"
          })
        );
      }
      await expect
        .poll(async () =>
          (await read()).monitors.every(
            (monitor, index) => monitor.state.checkCount > (goal.monitors[index].state.checkCount ?? 0)
          )
        )
        .toBe(true);
      expect(model.requests).toHaveLength(count);
      await page.goto(app.base);
      await expect(page.locator("#goals-unread")).toHaveText("1");
      await expect(page.locator("#monitors-nav")).not.toBeVisible();
      await page.locator("#goals-nav").click();
      await page.locator("[data-goal-id]").filter({ hasText: brief.title }).click();
      await expect(page.locator(".goal-plan")).toHaveCount(0);
      await page.getByRole("tab", { name: "计划", exact: true }).click();
      await expect(page.locator(".goal-plan")).toContainText("接入官方来源");
      await page.getByRole("tab", { name: "进展", exact: true }).click();
      await expect(page.locator(".goal-notices")).toContainText("权限变化");
      await page.getByRole("button", { name: "标为已读", exact: true }).click();
      await expect(page.locator("#goals-unread")).not.toBeVisible();
      if (scope === "background")
        await page.screenshot({ path: ".tmp/watcher-verification/long-term-goal-desktop.png" });
      await page.getByRole("button", { name: "暂停", exact: true }).click();
      await expect(page.locator(".goal-detail-heading")).toContainText("已暂停");
      await page.waitForTimeout(2500);
      expect(model.requests).toHaveLength(count);
      await page.reload();
      await page.locator("#goals-nav").click();
      await page.locator("[data-goal-id]").filter({ hasText: brief.title }).click();
      await expect(page.locator(".goal-detail-heading")).toContainText("已暂停");
      await page.locator(".goal-menu > summary").click();
      await page.getByRole("button", { name: "修改要求", exact: true }).click();
      await page.locator('[name="preferences"]').fill("仅跟进官方来源\n停止关注一般讨论");
      await page.getByRole("button", { name: "保存要求", exact: true }).click();
      await expect
        .poll(async () => (await read()).goal.brief.preferences)
        .toEqual(["仅跟进官方来源", "停止关注一般讨论"]);
      expect(model.requests).toHaveLength(count);
      await page.getByRole("button", { name: "恢复", exact: true }).click();
      await expect.poll(() => model.requests.length).toBeGreaterThan(count);
      await expect
        .poll(
          async () => (await (await fetch(`${app.base}/api/tasks/${program.taskId}`)).json()).runtime.active
        )
        .toBe(false);
      await page.locator(".goal-menu > summary").click();
      await page.getByRole("button", { name: "结束目标", exact: true }).click();
      await page.getByRole("button", { name: "确认结束", exact: true }).click();
      await expect(page.locator(".goal-detail-heading")).toContainText("已结束");
      if (scope === "background") expect((await read()).task.status).toBe("cancelled");
      expect(errors).toEqual([]);
    } catch (error) {
      await writeFile(
        `.tmp/watcher-verification/goal-debug-${scope}.json`,
        JSON.stringify(
          {
            goals: await (await fetch(`${app.base}/api/goals`)).json(),
            tasks: await (await fetch(`${app.base}/api/tasks`)).json(),
            requests: model.requests
          },
          null,
          2
        )
      );
      throw error;
    } finally {
      await app.stop();
      await model.stop();
    }
  });

test("creation drafts, stale edits, decisions, digest and narrow-screen navigation", async ({ page }) => {
  const app = await startDashboard();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(app.base);
    await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    await page.locator("#goals-nav").click();
    await expect(page.locator("[data-goal-health]")).toBeHidden();
    await page.getByRole("button", { name: "新建目标", exact: true }).click();
    await page.locator(".goal-form-advanced > summary").click();
    await page.locator('[name="title"]').fill(brief.title);
    await page.locator('[name="objective"]').fill(brief.objective);
    await page.getByRole("button", { name: "开始跟进", exact: true }).click();
    await expect(page.locator(".goal-form-dialog")).not.toBeVisible();
    await expect(page.locator(".goal-detail-heading")).toContainText(brief.title);
    await page.screenshot({ path: ".tmp/watcher-verification/long-term-goal-mobile.png" });
    const { goals } = await (await fetch(`${app.base}/api/goals`)).json();
    const goal = goals[0];
    const management = new GoalManagement(app.workspaceRoot);
    const updated = await management.progress(goal.taskId, goal.programId, 1, {
      summary: "需要确认来源",
      waitingFor: "是否仅关注官方公告？",
      disposition: "needs_input"
    });
    const stale = await fetch(`${app.base}${goalPath(goal)}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "edit", revision: 1, brief })
    });
    expect(stale.status).toBe(409);
    await page.reload();
    if (!(await page.locator("#goals-nav").isVisible()))
      await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    await page.locator("#goals-nav").click();
    await page.locator("[data-goal-id]").click();
    await expect(page.locator("[data-goal-answer]")).toContainText("你的决定");
    await page.locator('[name="answer"]').fill("只看官方来源");
    // Unconfigured model must keep the submitted answer durable for later delivery.
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    expect(updated.goal.decisionRequestId).toBeTruthy();
    const inboxPath = join(
      app.workspaceRoot,
      goal.taskId,
      "runs",
      goal.watchRunId,
      "agents",
      "main",
      "inbox-store.json"
    );
    await expect
      .poll(async () => (await readFile(inboxPath, "utf8").catch(() => "")).includes("只看官方来源"))
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".goal-dialog")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "切换侧栏", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A scheduled digest merges ordinary updates, without any model request.
    const edited = await management.edit(goal.taskId, goal.programId, updated.goal.revision, brief);
    await management.publish(goal.taskId, goal.programId, edited.goal.revision, {
      topicKey: "routine-test",
      kind: "routine",
      title: "普通更新",
      summary: "进入周报"
    });
    await management.store.withGoal(goal.taskId, goal.programId, (current) =>
      management.store.save(current, { ...current.goal, nextDigestAt: "2026-01-04T10:00:00Z" })
    );
    await new GoalSupervisor(app.workspaceRoot).runTask(goal.taskId, goal.watchRunId);
    expect(
      (await management.get(goal.taskId, goal.programId)).activity.notifications.some(
        (notice) => notice.kind === "digest"
      )
    ).toBe(true);
  } finally {
    await app.stop();
  }
});

test("pausing an in-flight background Main aborts the model without failure or automatic retry", async () => {
  const model = await fixtureModel({ hold: true });
  const app = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "goal-fixture",
    env: { COWORK_INBOX_POLL_MS: "1000" }
  });
  try {
    const goal = await post(app.base, "/api/goals", { brief, scope: "background", requestId: "held-main" });
    await expect.poll(() => model.requests.length).toBeGreaterThan(0);
    const count = model.requests.length;
    await post(app.base, `${goalPath(goal)}/control`, { action: "pause", revision: 1 });
    const read = async () => await (await fetch(`${app.base}/api/tasks/${goal.taskId}`)).json();
    await expect.poll(async () => (await read()).runtime.active, { timeout: 15000 }).toBe(false);
    expect((await read()).task.status).toBe("waiting");
    expect((await read()).task.lastError).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(model.requests).toHaveLength(count);
  } finally {
    await app.stop();
    await model.stop();
  }
});

test("a host restart preserves goals, pending decisions, plans and unread receipts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "atria-goal-restart-"));
  let app;
  try {
    app = await startDashboard({ workspace });
    const goal = await post(app.base, "/api/goals", { brief, scope: "background", requestId: "restart" });
    const manager = new GoalManagement(workspace);
    await manager.progress(goal.taskId, goal.programId, 1, {
      summary: "等待用户选择",
      waitingFor: "是否包含预览版本？",
      disposition: "needs_input",
      steps: [{ id: "review", description: "确认跟进范围", status: "blocked" }]
    });
    await app.restart();
    const current = await (await fetch(`${app.base}${goalPath(goal)}`)).json();
    expect(current.goal.steps[0].description).toBe("确认跟进范围");
    expect(current.decision.status).toBe("pending");
    expect(current.activity.unreadCount).toBe(1);
    await post(
      app.base,
      `${goalPath(goal)}/notifications/${current.activity.notifications[0].notificationId}/read`,
      {}
    );
    await app.restart();
    expect((await (await fetch(`${app.base}${goalPath(goal)}`)).json()).activity.unreadCount).toBe(0);
  } finally {
    await app?.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const scope of ["session", "background"])
  test(`${scope}: a conversation discovers manage_goal and registers the responsibility explicitly`, async ({
    page
  }, testInfo) => {
    const model = await fixtureModel({ registerScope: scope });
    const app = await startDashboard({
      monitoring: true,
      modelEndpoint: model.endpoint,
      model: "goal-fixture"
    });
    try {
      const sources = [join(app.root, "release.json"), join(app.root, "notice.json")];
      for (const source of sources) await writeFile(source, "{}");
      model.setSources(sources);
      await page.goto(app.base);
      await page
        .locator("#composer-input")
        .fill(
          scope === "session"
            ? "请在当前会话内登记 Claude Code 的长期跟进目标，然后等待新增资讯。"
            : "请在后台登记 Claude Code 的长期跟进目标，不依赖当前会话，然后等待新增资讯。"
        );
      await page.locator("#send-button").click();
      let goal;
      await expect
        .poll(
          async () => {
            goal = (await (await fetch(`${app.base}/api/goals`)).json()).goals[0];
            return goal?.goal?.disposition;
          },
          { timeout: 30000 }
        )
        .toBe("wait");
      expect(goal.scope).toBe(scope);
      const registration = (await (await fetch(`${app.base}/api/tasks`)).json()).tasks.find(
        (task) => task.monitoring?.scope !== "background"
      );
      expect(registration).toBeTruthy();
      expect(goal.taskId === registration.taskId).toBe(scope === "session");
      const current = await (await fetch(`${app.base}${goalPath(goal)}`)).json();
      expect(current.monitors).toHaveLength(2);
      expect(current.watchRunId).toBeTruthy();
      expect((await (await fetch(`${app.base}/api/goals`)).json()).goals).toHaveLength(1);
      await page.locator("#goals-nav").click();
      await page.locator(".goal-item").filter({ hasText: brief.title }).click();
      await expect(page.locator(".goal-detail-heading")).toContainText(brief.title);
      await page.getByRole("tab", { name: "设置", exact: true }).click();
      await expect(page.locator(".goal-settings")).toContainText(
        scope === "session" ? "在原对话中继续" : "独立后台"
      );
    } catch (error) {
      const tasks = await (await fetch(`${app.base}/api/tasks`)).json();
      await testInfo.attach("conversation-goal-state", {
        body: JSON.stringify({
          goals: await (await fetch(`${app.base}/api/goals`)).json(),
          tasks: await Promise.all(
            tasks.tasks.map((task) =>
              fetch(`${app.base}/api/tasks/${task.taskId}`).then((response) => response.json())
            )
          ),
          requests: model.requests
        }),
        contentType: "application/json"
      });
      throw error;
    } finally {
      await app.stop();
      await model.stop();
    }
  });

test("a same-response collector fallback cannot race background goal registration", async ({ page }) => {
  test.setTimeout(90000);
  const model = await fixtureModel({ registerScope: "background", parallelFallback: true });
  const app = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "goal-fixture"
  });
  try {
    const sources = [join(app.root, "release.json"), join(app.root, "notice.json")];
    for (const source of sources) await writeFile(source, "{}");
    model.setSources(sources);
    await page.goto(app.base);
    await page.locator("#composer-input").fill("在后台跟进 Claude Code，仅登记一个目标，不另建独立监控。");
    await page.locator("#send-button").click();
    await expect
      .poll(
        async () =>
          (await (await fetch(`${app.base}/api/goals`)).json()).goals.filter(
            (goal) => goal.goal?.disposition === "wait"
          ).length,
        { timeout: 30000 }
      )
      .toBe(1);
    expect((await (await fetch(`${app.base}/api/goals`)).json()).goals).toHaveLength(1);
    expect((await (await fetch(`${app.base}/api/tasks`)).json()).tasks).toHaveLength(2);
    const fallback = model.requests
      .flatMap((request) => request.messages)
      .find((message) => message.role === "tool" && message.tool_call_id === "parallel-fallback");
    expect(fallback.content).toContain("交接");
  } finally {
    await app.stop();
    await model.stop();
  }
});

for (const scope of ["session", "background"])
  test(`${scope}: a fresh conversation reuses a goal, hands off to Main and respects its pause after restart`, async ({
    page
  }) => {
    test.setTimeout(90000);
    const model = await fixtureModel();
    const app = await startDashboard({
      monitoring: true,
      modelEndpoint: model.endpoint,
      model: "goal-fixture"
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const sources = [join(app.root, "release.json"), join(app.root, "notice.json")];
      for (const source of sources) await writeFile(source, "{}");
      model.setSources(sources);
      const sourceTask =
        scope === "session"
          ? await post(app.base, "/api/tasks", { taskId: "reuse-source", goal: "会话内监控" })
          : undefined;
      const goal = await post(app.base, "/api/goals", {
        brief,
        scope,
        ...(sourceTask ? { sourceTaskId: sourceTask.taskId } : {}),
        requestId: "existing-goal"
      });
      const read = () => fetch(`${app.base}${goalPath(goal)}`).then((response) => response.json());
      const owner = () => fetch(`${app.base}/api/tasks/${goal.taskId}`).then((response) => response.json());
      await expect.poll(async () => (await read()).goal.disposition, { timeout: 30000 }).toBe("wait");
      await expect.poll(async () => (await owner()).runtime.active).toBe(false);
      const originalIds = (await read()).monitors.map((monitor) => monitor.monitorId).sort();
      model.reuseExistingGoal();
      await page.goto(app.base);
      await page.locator("#new-conversation").click();
      await page
        .locator("#composer-input")
        .fill("复用已有的 Claude Code 长期任务，请后台核对状态后继续跟进，不要重复创建。");
      await page.locator("#send-button").click();
      await expect
        .poll(async () => (await read()).goal.summary, { timeout: 30000 })
        .toBe("已根据新要求调整计划");
      await expect.poll(async () => (await owner()).runtime.active).toBe(false);
      const current = await read();
      expect(current.monitors.map((monitor) => monitor.monitorId).sort()).toEqual(originalIds);
      expect((await (await fetch(`${app.base}/api/goals`)).json()).goals).toHaveLength(1);
      const inbox = JSON.parse(
        await readFile(
          join(app.workspaceRoot, goal.taskId, "runs", goal.watchRunId, "agents/main/inbox-store.json"),
          "utf8"
        )
      );
      const handoffs = inbox.filter((message) => message.payload?.type === "watch.goal_steer");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0].state).toBe("consumed");
      expect(handoffs[0].payload.sourceTaskId).not.toBe(goal.taskId);
      const backgroundRequests = () =>
        model.requests.filter((request) =>
          request.messages.some(
            (message) =>
              message.role === "system" && String(message.content).includes("<long_term_goal_state>")
          )
        ).length;
      await page.locator("#goals-nav").click();
      await page.locator(".goal-item").click();
      await expect(page.locator(".goal-progress")).toContainText("已根据新要求调整计划");
      await page.getByRole("button", { name: "暂停", exact: true }).click();
      await expect(page.locator(".goal-detail-heading")).toContainText("已暂停");
      const pausedChecks = (await read()).monitors.map((monitor) => monitor.state?.checkCount);
      // Make every source due while paused: a stable count must come from the
      // durable pause gate, not merely the sixty-second polling interval.
      for (const monitorId of originalIds) {
        const file = join(
          app.workspaceRoot,
          goal.taskId,
          "watch",
          "programs",
          goal.programId,
          "monitor-state",
          `${monitorId}.json`
        );
        const state = JSON.parse(await readFile(file, "utf8"));
        await writeFile(file, JSON.stringify({ ...state, nextCheckAt: "1970-01-01T00:00:00Z" }));
      }
      const backgroundBeforePause = backgroundRequests();
      await app.restart();
      await page.goto(`${app.base}/#goals/${goal.taskId}/${goal.programId}/progress`);
      await expect(page.locator(".goal-detail-heading")).toContainText("已暂停");
      // A new conversation can read the goal, but even a model attempting a
      // follow-up handoff cannot resume it or create a replacement.
      await page.locator("#new-conversation").click();
      await page
        .locator("#composer-input")
        .fill("复用已有 Claude Code 目标核对状态；保持暂停，不要创建替代任务。");
      await page.locator("#send-button").click();
      await expect(page.locator('[data-answer-kind="final"]')).toContainText("已有目标保持暂停", {
        timeout: 30000
      });
      await page.waitForTimeout(1500);
      expect(backgroundRequests()).toBe(backgroundBeforePause);
      expect((await read()).status).toBe("paused");
      expect((await read()).monitors.map((monitor) => monitor.state?.checkCount)).toEqual(pausedChecks);
      expect((await read()).monitors.map((monitor) => monitor.monitorId).sort()).toEqual(originalIds);
      expect((await (await fetch(`${app.base}/api/goals`)).json()).goals).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await app.stop();
      await model.stop();
    }
  });

test("a failed create preserves the goal draft and retries with the same request identity", async ({
  page
}) => {
  const app = await startDashboard();
  try {
    let attempts = 0;
    const identities = [];
    await page.route("**/api/goals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      identities.push(route.request().postDataJSON().requestId);
      if (++attempts === 1)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "暂时离线" })
        });
      else await route.continue();
    });
    await page.goto(app.base);
    await page.locator("#goals-nav").click();
    await page.getByRole("button", { name: "新建目标", exact: true }).click();
    await page.locator(".goal-form-advanced > summary").click();
    await page.locator('[name="title"]').fill(brief.title);
    await page.locator('[name="objective"]').fill(brief.objective);
    await page.getByRole("button", { name: "开始跟进", exact: true }).click();
    await expect(page.locator("[data-form-error]")).toContainText("暂时离线");
    await expect(page.locator('[name="objective"]')).toHaveValue(brief.objective);
    await page.getByRole("button", { name: "开始跟进", exact: true }).click();
    await expect(page.locator(".goal-form-dialog")).not.toBeVisible();
    expect(identities[0]).toBe(identities[1]);
  } finally {
    await app.stop();
  }
});

test("a rejected source is visible on the goal without pretending observation is healthy", async ({
  page
}) => {
  const app = await startDashboard();
  try {
    const goal = await post(app.base, "/api/goals", {
      brief,
      scope: "background",
      requestId: "broken-source"
    });
    const source = join(app.root, "invalid-metric.json");
    await writeFile(source, "not-json");
    const response = await fetch(`${app.base}/api/tasks/${goal.taskId}/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        programId: goal.programId,
        task: "无法读取的指标",
        template: "metric-threshold",
        source,
        cadenceSeconds: 60,
        config: { metric: "loss", unit: "ratio", threshold: 2 }
      })
    });
    expect(response.status).toBe(422);
    await page.goto(app.base);
    await page.locator("#goals-nav").click();
    await page.locator("[data-goal-id]").click();
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await expect(page.locator(".goal-source-settings")).toContainText("1 项来源需要检查");
    await expect(page.locator(".goal-source-settings")).toContainText("未通过验收");
    await expect(page.locator(".goal-source-settings")).toContainText("JSON");
  } finally {
    await app.stop();
  }
});
