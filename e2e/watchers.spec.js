import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configuredMainMaxTokens } from "../dist/src/runtime/runtime-settings.js";

async function modelFixture({
  failFirst = false,
  failAnalysis = false,
  analyze = false,
  holdAnalysis = false,
  naturalMain = false
} = {}) {
  let calls = 0;
  let mainCalls = 0;
  const requests = [];
  let creation;
  let analysisUnavailable = failAnalysis;
  let analysisHeld = holdAnalysis;
  const held = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "watch-fixture" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    calls++;
    const classification = analyze && !body.tools?.length;
    if (classification && analysisUnavailable) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "synthetic analysis outage" } }));
      return;
    }
    if (failFirst && calls === 1) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "synthetic temporary model failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `watch-${calls}`, object: "chat.completion.chunk", model: "watch-fixture", created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant" });
    const last = body.messages.findLast((message) => message.role === "tool");
    if (
      !classification &&
      !naturalMain &&
      !body.tools?.some((tool) => tool.function?.name === "sleep_until")
    ) {
      send({
        tool_calls: [
          {
            index: 0,
            id: `enable-monitors-${calls}`,
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
    if (!classification) mainCalls++;
    if (classification) {
      if (analysisHeld) {
        held.push(() => {
          if (res.destroyed || res.writableEnded) return;
          send({ content: "classification: relevant_change\nConfirmed fixture event." });
          send({}, "stop");
          res.end("data: [DONE]\n\n");
        });
        return;
      }
      send({ content: "classification: relevant_change\nloss 达到 3，超过阈值 2，应该交给 Main 核实。" });
      send({}, "stop");
    } else if (creation && mainCalls === 1) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "create-monitor",
            type: "function",
            function: { name: "create_watcher", arguments: JSON.stringify(creation) }
          }
        ]
      });
      send({}, "tool_calls");
    } else if (!creation && !failFirst && !analyze && mainCalls % 2 === 0) {
      send({ content: "监控已登记，等待新的指标事件。" });
      send({}, "stop");
    } else {
      send({ content: "本轮事件已核实，继续等待新的变化。" });
      if (naturalMain) {
        send({}, "stop");
        res.end("data: [DONE]\n\n");
        return;
      }
      send({
        tool_calls: [
          {
            index: 0,
            id: `park-${calls}`,
            type: "function",
            function: {
              name: "sleep_until",
              arguments: JSON.stringify({ reason: "本轮指标事件已处理，继续等待新的变化" })
            }
          }
        ]
      });
      send({}, "tool_calls");
    }
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    setHoldAnalysis: (value) => {
      analysisHeld = value;
    },
    setAnalysisUnavailable: (value) => {
      analysisUnavailable = value;
    },
    releaseAnalysis: () => {
      for (const finish of held.splice(0)) finish();
    },
    setCreation: (input) => {
      creation = input;
    },
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    calls: () => calls,
    stop: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      })
  };
}
async function openMonitors(page) {
  if (!(await page.locator(".goal-dialog").isVisible())) await page.locator("#goals-nav").click();
  await expect(page.locator(".goal-workspace")).toBeVisible();
  if (!(await page.locator("#monitors-nav").isVisible())) await page.locator(".goal-system summary").click();
  await page.locator("#monitors-nav").click();
}
async function createViaUI(page, source, scope, name) {
  await openMonitors(page);
  await page.locator("[data-watch-new]").click();
  const form = page.locator(".watch-form").filter({ has: page.locator('input[name="task"]') });
  await form.locator('[name="task"]').fill(name);
  await form.locator('[name="scope"]').selectOption(scope);
  await form.locator('[name="template"]').selectOption("metric-threshold");
  await form.locator('[name="source"]').fill(source);
  await form.locator('[name="metric"]').fill("loss");
  await form.locator('[name="unit"]').fill("ratio");
  await form.locator('[name="threshold"]').fill("2");
  await form.locator('[name="consecutiveSamples"]').fill("1");
  await form.getByRole("button", { name: "创建监控", exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(page.locator("[data-watch-list] .watch-card").filter({ hasText: name })).toBeVisible();
}
async function expandCard(card) {
  if (!(await card.locator(".watch-disclosure").evaluate((node) => node.open)))
    await card.locator(".watch-row").click();
}
async function forceDue(fixture, monitor) {
  const path = join(
    fixture.workspaceRoot,
    monitor.taskId,
    "watch",
    "programs",
    monitor.programId,
    "monitor-state",
    `${monitor.monitorId}.json`
  );
  const state = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    JSON.stringify({
      ...state,
      lastCheckedAt: "1970-01-01T00:00:00Z",
      nextCheckAt: "1970-01-01T00:00:00Z",
      retryAt: undefined,
      pollRetryAt: undefined,
      analysisRetryAt: undefined
    })
  );
}

for (const scope of ["session", "background"]) {
  test(`${scope}: create, quiet polling, wake a real Pi, pause and restore through the shipped UI`, async ({
    page
  }) => {
    test.setTimeout(90000);
    const model = await modelFixture();
    const fixture = await startDashboard({
      monitoring: true,
      modelEndpoint: model.endpoint,
      model: "watch-fixture"
    });
    const source = join(fixture.root, "metric.json");
    const writeMetric = (value) =>
      writeFile(
        source,
        JSON.stringify({ metric: "loss", unit: "ratio", value, observedAt: new Date().toISOString() })
      );
    try {
      await writeMetric(0);
      const task = await (
        await fetch(`${fixture.base}/api/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "训练指标监控", taskId: `training-${scope}` })
        })
      ).json();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.base);
      await expect(page.locator(`button[data-task="${task.taskId}"]`)).toBeVisible();
      await page.locator(`button[data-task="${task.taskId}"]`).click();
      const name = `${scope === "session" ? "会话内" : "独立后台"} loss 监控`;
      await createViaUI(page, source, scope, name);
      const card = page.locator("[data-watch-list] .watch-card").filter({ hasText: name });
      const data = await (await fetch(`${fixture.base}/api/monitors`)).json();
      const monitor = data.monitors.find((item) => item.task === name);
      expect(monitor.scope).toBe(scope);
      expect(monitor.taskId === task.taskId).toBe(scope === "session");
      await forceDue(fixture, monitor);
      await expect
        .poll(
          async () =>
            (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json()).monitors[0]
              .state.checkCount
        )
        .toBe(1);
      expect(model.calls()).toBe(0);
      if (scope === "background") {
        await expandCard(card);
        await page
          .locator(`[data-watch-list] [data-monitor-id="${monitor.monitorId}"] [data-watch-action="open"]`)
          .click();
        await expect(page.locator(".monitoring-empty")).toContainText("后台监控会话");
        await openMonitors(page);
      }
      await writeMetric(3);
      await forceDue(fixture, monitor);
      await expect.poll(model.calls).toBeGreaterThanOrEqual(1);
      await expect
        .poll(
          async () =>
            (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}`)).json()).runtime.active
        )
        .toBe(false);
      await expect
        .poll(
          async () =>
            (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json()).sleep?.reason
        )
        .toContain("本轮指标事件已处理");
      await expandCard(card);
      await page
        .locator(`[data-watch-list] [data-monitor-id="${monitor.monitorId}"] [data-watch-action="open"]`)
        .click();
      await expect(page.locator(".live-workflow-head")).toContainText("本轮已处理，持续等待新进展");
      await openMonitors(page);
      await expect(page.locator("[data-watch-list] .watch-card").filter({ hasText: name })).toContainText(
        "候选事件 1 次"
      );
      expect(
        model.requests.some((request) => JSON.stringify(request.messages).includes("metric.threshold"))
      ).toBe(true);
      const calls = model.calls();
      await forceDue(fixture, monitor);
      await expect
        .poll(
          async () =>
            (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json()).monitors[0]
              .state.checkCount
        )
        .toBe(3);
      expect(model.calls()).toBe(calls);
      await expandCard(card);
      await card.getByRole("button", { name: "暂停", exact: true }).click();
      await expect(card).toContainText("已暂停");
      const lastRealState = (
        await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json()
      ).monitors[0].state;
      await forceDue(fixture, monitor);
      await page.waitForTimeout(1300);
      const paused = await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json();
      expect(paused.monitors[0].state.checkCount).toBe(3);
      const pausedPath = join(
        fixture.workspaceRoot,
        monitor.taskId,
        "watch",
        "programs",
        monitor.programId,
        "monitor-state",
        `${monitor.monitorId}.json`
      );
      await writeFile(
        pausedPath,
        JSON.stringify({ ...paused.monitors[0].state, lastCheckedAt: lastRealState.lastCheckedAt })
      );
      await page.reload();
      await openMonitors(page);
      await expect(card).toContainText("已暂停");
      await expandCard(card);
      await card.getByRole("button", { name: "恢复", exact: true }).click();
      await expect(card).toContainText("监控中");
      await card.getByRole("button", { name: "设置", exact: true }).click();
      const edit = page.locator(".watch-form").filter({ has: page.locator('[name="cadenceSeconds"]') });
      await edit.locator('[name="cadenceSeconds"]').fill("120");
      await edit.getByRole("button", { name: "保存", exact: true }).click();
      await expect(card).toContainText("每 2 分钟");
      await card.getByRole("button", { name: "查看记录" }).click();
      await expect(card.locator(".watch-records")).toContainText("事件处理完成");
      await mkdir(".tmp/watcher-verification", { recursive: true });
      await page.screenshot({ path: `.tmp/watcher-verification/${scope}.png`, fullPage: true });
      if (scope === "background") {
        await card.getByRole("button", { name: "结束监控", exact: true }).click();
        await expect
          .poll(
            async () =>
              (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}`)).json()).task.status
          )
          .toBe("cancelled");
        expect(model.calls()).toBe(calls);
      }
      expect(errors).toEqual([]);
    } finally {
      await fixture.stop();
      await model.stop();
    }
  });
}

test("standalone monitoring can be created with no user conversation and a failed probe is visible", async ({
  page
}) => {
  const fixture = await startDashboard({ monitoring: true });
  try {
    await page.goto(fixture.base);
    const source = join(fixture.root, "missing.json");
    await openMonitors(page);
    await page.locator("[data-watch-new]").click();
    const form = page.locator(".watch-form").filter({ has: page.locator('input[name="task"]') });
    await form.locator('[name="task"]').fill("失败探针");
    await form.locator('[name="source"]').fill(source);
    await form.getByRole("button", { name: "创建监控", exact: true }).click();
    await expect(form.locator("[data-error]")).not.toHaveText("");
    await form.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator("[data-watch-list] .watch-card")).toContainText("未启用");
  } finally {
    await fixture.stop();
  }
});

test("a stalled classifier does not block another Task's polls, Main wake or host shutdown", async () => {
  const model = await modelFixture({ analyze: true, holdAnalysis: true });
  const fixture = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "watch-fixture"
  });
  try {
    const create = async (name, eventMode) => {
      const source = join(fixture.root, `${name}.json`);
      const sample = (value) =>
        writeFile(
          source,
          JSON.stringify({ metric: "loss", unit: "ratio", value, observedAt: new Date().toISOString() })
        );
      await sample(0);
      const res = await fetch(`${fixture.base}/api/monitors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: name,
          template: "metric-threshold",
          source,
          scope: "background",
          eventMode,
          cadenceSeconds: 60,
          config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 }
        })
      });
      expect(res.ok).toBe(true);
      return { ...(await res.json()), sample };
    };
    const slow = await create("slow-analysis", "analyze");
    await slow.sample(3);
    await forceDue(fixture, slow);
    await expect.poll(model.calls).toBe(1);
    const fast = await create("independent-direct", "direct");
    await fast.sample(3);
    await forceDue(fixture, fast);
    await expect
      .poll(
        async () =>
          (await (await fetch(`${fixture.base}/api/tasks/${fast.taskId}/monitors`)).json()).sleep?.reason
      )
      .toContain("本轮指标事件已处理");
    expect(model.calls()).toBe(3);
    await forceDue(fixture, fast);
    await expect
      .poll(
        async () =>
          (await (await fetch(`${fixture.base}/api/tasks/${fast.taskId}/monitors`)).json()).monitors[0].state
            .checkCount
      )
      .toBe(2);
    const stuck = await (await fetch(`${fixture.base}/api/tasks/${slow.taskId}/monitors`)).json();
    expect(stuck.monitors[0].state.processing).toBe(true);
    expect(stuck.monitors[0].state.modelRunCount).toBe(1);
    const at = Date.now();
    // Stop without releasing the response: cancellation must reach Pi.
    await fixture.stop();
    expect(Date.now() - at).toBeLessThan(4000);
  } finally {
    model.releaseAnalysis();
    await fixture.stop();
    await model.stop();
  }
});

for (const scope of ["session", "background"]) {
  test(`${scope}: a stalled analysis keeps sampling its source and delivering another monitor in the same Task`, async () => {
    const model = await modelFixture({ analyze: true, holdAnalysis: true });
    const fixture = await startDashboard({
      monitoring: true,
      modelEndpoint: model.endpoint,
      model: "watch-fixture"
    });
    try {
      const task = await (
        await fetch(`${fixture.base}/api/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "同一会话内的独立监控", taskId: `stalled-${scope}` })
        })
      ).json();
      const create = async (name, eventMode, taskId, monitorScope) => {
        const source = join(fixture.root, `${name}.json`);
        const sample = (value) =>
          writeFile(
            source,
            JSON.stringify({ metric: "loss", unit: "ratio", value, observedAt: new Date().toISOString() })
          );
        await sample(0);
        const response = await fetch(`${fixture.base}/api/tasks/${taskId}/monitors`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task: name,
            scope: monitorScope,
            template: "metric-threshold",
            source,
            eventMode,
            cadenceSeconds: 60,
            config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 }
          })
        });
        expect(response.ok).toBe(true);
        return { ...(await response.json()), sample };
      };
      const slow = await create("slow-same-task", "analyze", task.taskId, scope);
      const fast = await create("direct-same-task", "direct", slow.taskId, "session");
      const detail = async () =>
        await (await fetch(`${fixture.base}/api/tasks/${slow.taskId}/monitors`)).json();
      const state = async (monitor) =>
        (await detail()).monitors.find((item) => item.monitorId === monitor.monitorId).state;
      await slow.sample(3);
      await forceDue(fixture, slow);
      await expect.poll(model.calls).toBe(1);
      await expect.poll(async () => (await state(slow)).processing).toBe(true);
      const checks = (await state(slow)).checkCount;
      await slow.sample(0);
      await forceDue(fixture, slow);
      await fast.sample(3);
      await forceDue(fixture, fast);
      await expect.poll(async () => (await state(slow)).checkCount).toBe(checks + 1);
      await expect.poll(async () => (await detail()).sleep?.reason).toContain("本轮指标事件已处理");
      expect((await state(fast)).wakeRequestCount).toBe(1);
      expect((await state(slow)).processing).toBe(true);
      expect((await state(slow)).modelRunCount).toBe(1);
      expect(model.calls()).toBe(3);
      await slow.sample(4);
      await forceDue(fixture, slow);
      await expect.poll(async () => (await state(slow)).eventCount).toBe(2);
      expect((await state(slow)).modelRunCount).toBe(1);
      const control = async (action) => {
        const response = await fetch(
          `${fixture.base}/api/tasks/${slow.taskId}/monitors/${slow.monitorId}/control`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action })
          }
        );
        expect(response.ok).toBe(true);
      };
      await control("pause");
      await expect.poll(async () => (await state(slow)).processing).toBe(false);
      model.setHoldAnalysis(false);
      await control("resume");
      const program = JSON.parse(
        await readFile(
          join(fixture.workspaceRoot, slow.taskId, "watch", "programs", slow.programId, "program.json"),
          "utf8"
        )
      );
      const sourceInbox = join(
        fixture.workspaceRoot,
        slow.taskId,
        "runs",
        program.watchRunId ?? `watch-${slow.programId}`,
        "agents",
        slow.monitorId,
        "inbox-store.json"
      );
      await expect
        .poll(async () => {
          const data = JSON.parse(await readFile(sourceInbox, "utf8"));
          return data.filter((message) => message.state === "consumed").length;
        })
        .toBe(2);
      expect((await state(slow)).wakeRequestCount).toBe(2);
      expect((await state(slow)).eventCount).toBe(2);
    } finally {
      await fixture.stop();
      model.releaseAnalysis();
      await model.stop();
    }
  });
}

test("a background goal keeps observing after Main answers normally without sleep_until", async () => {
  const model = await modelFixture({ naturalMain: true });
  const fixture = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "watch-fixture"
  });
  try {
    const source = join(fixture.root, "standing.json");
    const sample = (value) =>
      writeFile(
        source,
        JSON.stringify({ metric: "loss", unit: "ratio", value, observedAt: new Date().toISOString() })
      );
    await sample(0);
    const res = await fetch(`${fixture.base}/api/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "长期观察 loss",
        template: "metric-threshold",
        source,
        scope: "background",
        eventMode: "direct",
        cadenceSeconds: 60,
        config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 }
      })
    });
    expect(res.ok).toBe(true);
    const monitor = await res.json();
    await sample(3);
    await forceDue(fixture, monitor);
    await expect
      .poll(async () => {
        const detail = await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}`)).json();
        const data = await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json();
        return {
          calls: model.calls(),
          active: detail.runtime.active,
          status: detail.task.status,
          park: Boolean(data.sleep)
        };
      })
      .toEqual({ calls: 1, active: false, status: "waiting", park: true });
    await sample(0);
    await forceDue(fixture, monitor);
    await expect
      .poll(
        async () =>
          (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json()).monitors[0]
            .state.checkCount
      )
      .toBe(2);
    await sample(4);
    await forceDue(fixture, monitor);
    await expect.poll(model.calls).toBe(2);
    await expect
      .poll(
        async () => (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}`)).json()).task.status
      )
      .toBe("waiting");
  } finally {
    await fixture.stop();
    await model.stop();
  }
});

test("a one-shot timer still delivers its final event after the probe retires", async () => {
  const model = await modelFixture({ naturalMain: true });
  const fixture = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "watch-fixture"
  });
  try {
    const startAt = new Date(Date.now() + 5000).toISOString();
    const res = await fetch(`${fixture.base}/api/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "一次性到点提醒，提醒后完成",
        template: "timer",
        scope: "background",
        cadenceSeconds: 60,
        config: { startAt, intervalMs: null }
      })
    });
    expect(res.ok).toBe(true);
    const monitor = await res.json();
    await expect.poll(() => Date.now(), { timeout: 15000 }).toBeGreaterThanOrEqual(Date.parse(startAt));
    await forceDue(fixture, monitor);
    await expect.poll(model.calls).toBe(1);
    await expect
      .poll(
        async () => (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}`)).json()).task.status
      )
      .toBe("completed");
    expect(
      (await (await fetch(`${fixture.base}/api/tasks/${monitor.taskId}/monitors`)).json()).monitors[0].status
    ).toBe("retired");
  } finally {
    await fixture.stop();
    await model.stop();
  }
});

const sharedBudgetCases = [
  { name: "default", config: {}, env: {}, maxTokens: 65536 },
  {
    name: "config",
    config: { mainMaxTurns: 17, mainMaxTokens: 24576, mainTimeoutMs: 45000 },
    env: {},
    maxTokens: 24576
  },
  {
    name: "environment override",
    config: { mainMaxTurns: 17, mainMaxTokens: 24576, mainTimeoutMs: 45000 },
    env: {
      COWORK_MAIN_MAX_TURNS: "19",
      COWORK_MAIN_MAX_TOKENS: "32768",
      COWORK_MAIN_TIMEOUT_MS: "60000"
    },
    maxTokens: 32768
  }
];
for (const budget of sharedBudgetCases)
  for (const scope of ["session", "background"])
    test(`${scope}: analysis and Main share ${budget.name} budgets and server thinking defaults`, async () => {
      const model = await modelFixture({ analyze: true });
      const fixture = await startDashboard({
        monitoring: true,
        modelEndpoint: model.endpoint,
        model: "watch-fixture",
        config: {
          supportsReasoningEffort: false,
          subagentMaxTurns: 1,
          subagentMaxTokens: 1024,
          subagentTimeoutMs: 1,
          ...budget.config
        },
        env: {
          COWORK_REASONING_EFFORT: undefined,
          COWORK_SUPPORTS_REASONING_EFFORT: undefined,
          COWORK_MAIN_MAX_TURNS: undefined,
          COWORK_MAIN_MAX_TOKENS: undefined,
          COWORK_MAIN_TIMEOUT_MS: undefined,
          ...budget.env
        }
      });
      try {
        const source = join(fixture.root, "metric.json");
        const sample = (value) =>
          writeFile(
            source,
            JSON.stringify({
              metric: "loss",
              unit: "ratio",
              value,
              observedAt: new Date().toISOString()
            })
          );
        await sample(0);
        if (scope === "session") {
          await fetch(`${fixture.base}/api/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: "analysis-session", goal: "持续分析指标" })
          });
        }
        const response = await fetch(
          scope === "session"
            ? `${fixture.base}/api/tasks/analysis-session/monitors`
            : `${fixture.base}/api/monitors`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              task: "分析 loss 阈值事件并让 Main 核实",
              template: "metric-threshold",
              source,
              config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 },
              cadenceSeconds: 60,
              eventMode: "analyze",
              scope
            })
          }
        );
        expect(response.ok).toBe(true);
        const created = await response.json();
        const mainRunId = (await (await fetch(`${fixture.base}/api/tasks/${created.taskId}`)).json()).task
          .activeRunId;
        await sample(3);
        await forceDue(fixture, created);
        await expect
          .poll(
            async () => {
              const monitoring = await (
                await fetch(`${fixture.base}/api/tasks/${created.taskId}/monitors`)
              ).json();
              const detail = await (await fetch(`${fixture.base}/api/tasks/${created.taskId}`)).json();
              return {
                calls: model.calls(),
                monitor: monitoring.monitors[0].state,
                task: detail.task.status,
                run: detail.task.activeRunId
              };
            },
            { timeout: 30000 }
          )
          .toMatchObject({ calls: 3 })
          .catch(async (error) => {
            const monitoring = await (
              await fetch(`${fixture.base}/api/tasks/${created.taskId}/monitors`)
            ).json();
            const detail = await (await fetch(`${fixture.base}/api/tasks/${created.taskId}`)).json();
            console.log(JSON.stringify({ monitoring, task: detail.task, runtime: detail.runtime }));
            throw error;
          });
        await expect
          .poll(
            async () =>
              (await (await fetch(`${fixture.base}/api/tasks/${created.taskId}/monitors`)).json()).sleep
                ?.reason
          )
          .toContain("本轮指标事件已处理");
        expect(model.requests[0].max_completion_tokens ?? model.requests[0].max_tokens).toBe(
          budget.maxTokens
        );
        expect(model.requests[0].tools ?? []).toHaveLength(0);
        expect(model.requests[1].max_completion_tokens ?? model.requests[1].max_tokens).toBe(
          budget.maxTokens
        );
        expect(model.requests[1].tools.map((tool) => tool.function.name)).toContain("enable_tools");
        expect(model.requests[1].tools.map((tool) => tool.function.name)).not.toContain("sleep_until");
        expect(model.requests[2].tools.map((tool) => tool.function.name)).toContain("sleep_until");
        expect(model.requests[2].max_completion_tokens ?? model.requests[2].max_tokens).toBe(
          budget.maxTokens
        );
        expect(
          (await (await fetch(`${fixture.base}/api/tasks/${created.taskId}`)).json()).task.activeRunId
        ).toBe(mainRunId);
        for (const request of model.requests) {
          expect(request).not.toHaveProperty("reasoning_effort");
          expect(request).not.toHaveProperty("thinking");
          expect(request).not.toHaveProperty("reasoning");
        }
      } finally {
        await fixture.stop();
        await model.stop();
      }
    });

test("the real Main discovers create_watcher and activates a template through an explicit model tool call", async ({
  page
}) => {
  const model = await modelFixture();
  const fixture = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "watch-fixture"
  });
  try {
    const source = join(fixture.root, "metric.json");
    await writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value: 0, observedAt: new Date().toISOString() })
    );
    model.setCreation({
      task: "模型登记的 loss 监控",
      template: "metric-threshold",
      source,
      config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 },
      cadenceSeconds: 60,
      scope: "session"
    });
    await fetch(`${fixture.base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "通过模型创建监控", taskId: "model-watch" })
    });
    await fetch(`${fixture.base}/api/tasks/model-watch/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "为本轮训练登记 loss 监控，然后等待变化。" })
    });
    await expect
      .poll(
        async () =>
          (await (await fetch(`${fixture.base}/api/tasks/model-watch/monitors`)).json()).monitors[0]?.status
      )
      .toBe("active");
    await expect
      .poll(
        async () =>
          (await (await fetch(`${fixture.base}/api/tasks/model-watch/monitors`)).json()).sleep?.reason
      )
      .toContain("本轮指标事件已处理");
    expect(model.requests[0].tools.some((tool) => tool.function.name === "create_watcher")).toBe(false);
    expect(model.requests[0].tools.some((tool) => tool.function.name === "enable_tools")).toBe(true);
    expect(model.requests[1].tools.some((tool) => tool.function.name === "create_watcher")).toBe(true);
    expect(model.requests.length).toBe(3);
    await page.goto(fixture.base);
    await openMonitors(page);
    await expect(page.locator("[data-watch-list] .watch-card")).toContainText("模型登记的 loss 监控");
  } finally {
    await fixture.stop();
    await model.stop();
  }
});

test("a model API failure keeps background monitoring open and resumes its saved event", async () => {
  const model = await modelFixture({ failFirst: true });
  const fixture = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "watch-fixture"
  });
  try {
    const source = join(fixture.root, "metric.json");
    await writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value: 0, observedAt: new Date().toISOString() })
    );
    const created = await (
      await fetch(`${fixture.base}/api/monitors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: "failure recovery",
          template: "metric-threshold",
          source,
          config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 },
          cadenceSeconds: 60
        })
      })
    ).json();
    await writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value: 3, observedAt: new Date().toISOString() })
    );
    await forceDue(fixture, created);
    await expect
      .poll(
        async () =>
          (await (await fetch(`${fixture.base}/api/tasks/${created.taskId}`)).json()).task.watchRecovery
            ?.retries
      )
      .toBe(1);
    expect((await (await fetch(`${fixture.base}/api/tasks/${created.taskId}`)).json()).task.status).toBe(
      "waiting"
    );
    await writeFile(
      join(fixture.workspaceRoot, created.taskId, "agents", "main", "relaunch.json"),
      JSON.stringify({ attempts: 0, lastAttemptAt: "" })
    );
    await expect.poll(model.calls).toBe(3);
    await expect
      .poll(
        async () =>
          (await (await fetch(`${fixture.base}/api/tasks/${created.taskId}/monitors`)).json()).sleep?.reason
      )
      .toContain("本轮指标事件已处理");
    for (const request of model.requests)
      expect(request.max_completion_tokens ?? request.max_tokens).toBe(configuredMainMaxTokens());
    expect(
      (await (await fetch(`${fixture.base}/api/tasks/${created.taskId}/monitors`)).json()).monitors[0].status
    ).toBe("active");
  } finally {
    await fixture.stop();
    await model.stop();
  }
});

test("a classifier failure shows its real cause and its saved event survives pause and recovery", async ({
  page
}) => {
  const model = await modelFixture({ analyze: true, failAnalysis: true });
  const fixture = await startDashboard({
    monitoring: true,
    modelEndpoint: model.endpoint,
    model: "watch-fixture"
  });
  try {
    const source = join(fixture.root, "metric.json");
    const metric = (value) =>
      writeFile(
        source,
        JSON.stringify({ metric: "loss", unit: "ratio", value, observedAt: new Date().toISOString() })
      );
    await metric(0);
    const created = await (
      await fetch(`${fixture.base}/api/monitors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: "analysis outage fixture",
          template: "metric-threshold",
          source,
          scope: "background",
          eventMode: "analyze",
          config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 },
          cadenceSeconds: 60
        })
      })
    ).json();
    const detail = async () =>
      await (await fetch(`${fixture.base}/api/tasks/${created.taskId}/monitors`)).json();
    await metric(3);
    await forceDue(fixture, created);
    await expect.poll(async () => (await detail()).monitors[0].state.analysisFailures).toBe(1);
    await page.goto(fixture.base);
    await openMonitors(page);
    const card = page.locator("[data-watch-list] .watch-card").filter({ hasText: "analysis outage fixture" });
    await expandCard(card);
    await expect(card).toContainText("事件分析失败 · 等待重试");
    await expect(card.locator(".watch-summary")).toContainText("synthetic analysis outage");
    await expect(card.locator(".watch-summary")).not.toContainText("did not return a textual summary");
    await expect(card.locator(".watch-summary")).not.toContainText("Diagnostics");
    await card.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(card).toContainText("已暂停");
    const pausedCalls = model.calls();
    const pausedCycle = (await detail()).scheduler.lastCycleAt;
    await forceDue(fixture, created);
    await expect.poll(async () => (await detail()).scheduler.lastCycleAt).not.toBe(pausedCycle);
    expect(model.calls()).toBe(pausedCalls);
    model.setAnalysisUnavailable(false);
    await card.getByRole("button", { name: "恢复", exact: true }).click();
    await forceDue(fixture, created);
    await expect.poll(async () => (await detail()).sleep?.reason).toContain("本轮指标事件已处理");
    const recovered = (await detail()).monitors[0].state;
    expect(recovered.modelRunCount).toBe(2);
    expect(recovered.wakeRequestCount).toBe(1);
    expect(recovered.analysisFailures).toBe(0);
    await expect(card).toContainText("监控中");
    await expect(card.locator(".watch-summary")).not.toContainText("synthetic analysis outage");
    for (const request of model.requests)
      expect(request.max_completion_tokens ?? request.max_tokens).toBe(configuredMainMaxTokens());
  } finally {
    await fixture.stop();
    await model.stop();
  }
});

test("monitoring stays out of the conversation and disclosures survive refresh without spilling records", async ({
  page
}) => {
  const fixture = await startDashboard();
  try {
    const parent = await (
      await fetch(`${fixture.base}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "ordinary-work", goal: "日常开发" })
      })
    ).json();
    const source = join(fixture.root, "metric.json");
    await writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value: 0, observedAt: new Date().toISOString() })
    );
    const create = async (task, scope) =>
      await (
        await fetch(
          scope === "session"
            ? `${fixture.base}/api/tasks/${parent.taskId}/monitors`
            : `${fixture.base}/api/monitors`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              task,
              scope,
              template: "metric-threshold",
              source,
              config: { metric: "loss", unit: "ratio", threshold: 2 },
              cadenceSeconds: 900
            })
          }
        )
      ).json();
    await create("本会话指标", "session");
    const background = await create("后台资讯", "background");
    const historical = await create("历史监控", "background");
    await fetch(`${fixture.base}/api/tasks/${historical.taskId}/monitors/${historical.monitorId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retire" })
    });
    await page.goto(fixture.base);
    await expect(page.locator("#topbar-task")).toContainText("日常开发");
    await expect(page.locator("#project-list [data-task]")).toHaveCount(1);
    await expect(page.locator(`#project-list [data-task="${background.taskId}"]`)).toHaveCount(0);
    await expect(page.locator("#monitor-section")).toHaveText("监控1 项");
    await expect(page.locator("#monitor-section .watch-card")).toHaveCount(0);
    await openMonitors(page);
    const panel = page.locator(".watch-dialog").filter({ has: page.locator("#watch-list-title") });
    await expect(panel.locator(".watch-card")).toHaveCount(2);
    await expect(panel.locator(".watch-disclosure[open]")).toHaveCount(0);
    await expect(panel.locator("[data-scheduler]")).not.toBeVisible();
    await expect(panel.locator(".watch-detail").first()).not.toBeVisible();
    const card = panel.locator(`[data-monitor-id="${background.monitorId}"]`);
    await card.locator(".watch-row").focus();
    await page.keyboard.press("Enter");
    await expect(card.locator(".watch-disclosure")).toHaveAttribute("open", "");
    await page.keyboard.press("Tab");
    await expect(card.locator(".watch-result > summary")).toBeFocused();
    await card.getByRole("button", { name: "查看记录", exact: true }).click();
    await expect(card.locator(".watch-records")).toBeVisible();
    const records = await card.locator(".watch-records").innerText();
    await card.locator(".watch-row").click();
    await expect(card.locator(".watch-records")).not.toBeVisible();
    await page.waitForResponse(
      (response) => response.url().endsWith("/api/monitors") && response.request().method() === "GET"
    );
    await expect(card.locator(".watch-disclosure")).not.toHaveAttribute("open", "");
    await expandCard(card);
    await expect(card.locator(".watch-records")).toHaveText(records, { useInnerText: true });
    await card.getByRole("button", { name: "收起记录", exact: true }).click();
    await expect(card.locator(".watch-records")).not.toBeVisible();
    const controlPath = `**/api/tasks/${background.taskId}/monitors/${background.monitorId}/control`;
    await page.route(controlPath, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "暂时无法暂停" })
      })
    );
    await card.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(card.locator('[role="alert"]')).toContainText("暂时无法暂停");
    await page.waitForResponse(
      (response) => response.url().endsWith("/api/monitors") && response.request().method() === "GET"
    );
    await expect(card.locator('[role="alert"]')).toContainText("暂时无法暂停");
    await page.unroute(controlPath);
    await card.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(card).toContainText("已暂停");
    await expect(card.locator('[role="alert"]')).not.toBeVisible();
    await panel.locator('[data-watch-filter="history"]').click();
    await expect(panel.locator(".watch-card")).toHaveCount(1);
    await expect(panel.locator(".watch-card")).toContainText("历史监控");
    await panel.getByRole("button", { name: "关闭监控任务" }).click();
    await page.locator("#monitor-manage").click();
    await expect(panel.locator("#watch-list-title")).toHaveText("本会话的监控");
    await expect(panel.locator(".watch-card")).toHaveCount(1);
    await expect(panel.locator(".watch-card")).toContainText("本会话指标");
    await panel.getByRole("button", { name: "查看全部会话" }).click();
    await expect(panel.locator(".watch-card")).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(panel).toBeVisible();
    expect(await page.locator("body").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  } finally {
    await fixture.stop();
  }
});

test("a workspace containing only background monitors opens a neutral welcome until explicitly viewed", async ({
  page
}) => {
  const fixture = await startDashboard();
  try {
    const source = join(fixture.root, "metric.json");
    await writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value: 0, observedAt: new Date().toISOString() })
    );
    const created = await (
      await fetch(`${fixture.base}/api/monitors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: "安静的后台监控",
          template: "metric-threshold",
          source,
          config: { metric: "loss", unit: "ratio", threshold: 2 },
          cadenceSeconds: 900
        })
      })
    ).json();
    await page.goto(fixture.base);
    await expect(page.locator(".monitoring-empty")).toHaveCount(0);
    await expect(page.locator("#project-list [data-task]")).toHaveCount(0);
    await expect(page.locator("#monitor-section")).not.toBeVisible();
    await openMonitors(page);
    const card = page.locator(`[data-watch-list] [data-monitor-id="${created.monitorId}"]`);
    await expandCard(card);
    await card.getByRole("button", { name: "打开会话", exact: true }).click();
    await expect(page.locator(".monitoring-empty")).toContainText("后台监控会话");
    await expect(page.locator(`#project-list [data-task="${created.taskId}"]`)).toBeVisible();
    await expect(page.locator("#monitor-section")).toBeVisible();
    await page.locator("#new-conversation").click();
    await expect(page.locator("#monitor-section")).not.toBeVisible();
    await expect(page.locator("#project-list [data-task]")).toHaveCount(0);
    await fetch(`${fixture.base}/api/tasks/${created.taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    await page.reload();
    await expect(page.locator(`#project-list [data-task="${created.taskId}"]`)).toBeVisible();
  } finally {
    await fixture.stop();
  }
});

test("advanced monitor limits remain optional and invalid hidden fields reopen for correction", async ({
  page
}) => {
  const fixture = await startDashboard();
  try {
    const source = join(fixture.root, "metric.json");
    await writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value: 0, observedAt: new Date().toISOString() })
    );
    await page.goto(fixture.base);
    await openMonitors(page);
    await page.locator("[data-watch-new]").click();
    const form = page.locator(".watch-form").filter({ has: page.locator('input[name="task"]') });
    await expect(form.locator('[name="scope"]')).toHaveValue("background");
    await expect(form.locator('[name="maxWakeRequestsPerDay"]')).not.toBeVisible();
    await form.locator('[name="task"]').fill("设置验收");
    await form.locator('[name="template"]').selectOption("metric-threshold");
    await form.locator('[name="source"]').fill(source);
    await form.locator('[name="metric"]').fill("loss");
    await form.locator('[name="unit"]').fill("ratio");
    await form.locator('[name="threshold"]').fill("2");
    await form.locator(".watch-advanced > summary").click();
    await form.locator('[name="maxWakeRequestsPerDay"]').fill("0");
    await form.locator(".watch-advanced > summary").click();
    await form.getByRole("button", { name: "创建监控", exact: true }).click();
    await expect(form.locator(".watch-advanced")).toHaveAttribute("open", "");
    await expect(form.locator('[name="maxWakeRequestsPerDay"]')).toBeFocused();
    await form.locator('[name="maxWakeRequestsPerDay"]').fill("7");
    await form.locator('[name="maxModelRunsPerDay"]').fill("11");
    await form.locator(".watch-advanced > summary").click();
    await form.getByRole("button", { name: "创建监控", exact: true }).click();
    await expect(form).not.toBeVisible();
    const monitor = (await (await fetch(`${fixture.base}/api/monitors`)).json()).monitors[0];
    expect(monitor.maxWakeRequestsPerDay).toBe(7);
    expect(monitor.maxModelRunsPerDay).toBe(11);
  } finally {
    await fixture.stop();
  }
});
