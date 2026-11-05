import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("an evening participation note corrects its kind once and never claims a scheduled reminder", async ({
  page
}) => {
  test.setTimeout(120000);
  let attempts = 0;
  const quote =
    "帮我记录下，晚上问家人要不要参加，寒假有个为期两天的2027 寒假公开研学营，这是宣传页面https://example.invalid/camp";
  const context = {
    kind: "arrangement",
    status: "tentative",
    title: "晚上询问研学意向",
    content:
      "今晚询问家人是否参加2027寒假两天的公开研学营，具体日期和时刻待定。宣传页：https://example.invalid/camp",
    visibility: "task",
    quote,
    observedAt: "2026-11-05T09:06:52Z"
  };
  const provider = await modelProtocolFixture("openai-completions", (body) => {
    if (
      JSON.stringify(body.messages.filter((m) => m.role === "system")).includes(
        "Classify personal-context authorization"
      )
    )
      return { text: JSON.stringify({ authorized: true, sensitive: false, statement: "self_report" }) };
    if (attempts++ === 0)
      return {
        name: "manage_personal_context",
        arguments: {
          action: "save",
          context: {
            ...context,
            kind: "temporary_state",
            status: "active",
            timeZone: "Asia/Shanghai",
            reviewAt: "2026-11-05T19:00:00+08:00"
          }
        }
      };
    const last = body.messages.findLast((m) => m.role === "tool");
    if (attempts === 2) {
      expect(last.content).toContain("invalid_request");
      expect(last.content).toContain("temporary_state");
      expect(last.content).toContain("timeZone");
      return { name: "manage_personal_context", arguments: { action: "save", context } };
    }
    const saved = JSON.parse(last.content);
    expect(saved.reminderScheduled).toBe(false);
    return { text: "研学意向已记录，尚未设置定时提醒。晚上几点提醒你？" };
  });
  const dashboard = await startDashboard({
    modelEndpoint: provider.baseUrl,
    model: "protocol-fixture",
    env: { COWORK_MODEL_API: "openai-completions" }
  });
  try {
    await page.goto(dashboard.base);
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).locator("..").hover();
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).click();
    await page.locator("#composer-input").fill(quote);
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("尚未设置定时提醒", { timeout: 45000 });
    await expect(page.locator("#stop-button")).toBeHidden({ timeout: 30000 });
    const view = await (await page.request.get(`${dashboard.base}/api/personal-context`)).json();
    expect(view.records).toHaveLength(1);
    expect(view.records[0].kind).toBe("arrangement");
    expect(view.records[0].status).toBe("tentative");
    expect(view.records[0].startsAt).toBeUndefined();
    expect(view.records[0].endsAt).toBeUndefined();
    expect(attempts).toBe(3);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("chat saves an arrangement, a new conversation reads it, and settings cancel/delete it", async ({
  page
}, testInfo) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  let step = 0,
    phase = "save";
  const requests = [];
  const quote = "请把我的上海出差安排保存为跨对话个人情境";
  const provider = await modelProtocolFixture("openai-completions", (body) => {
    if (
      JSON.stringify(body.messages.filter((message) => message.role === "system")).includes(
        "Classify personal-context authorization"
      )
    )
      return {
        text:
          "```json\n" +
          JSON.stringify({ authorized: true, sensitive: false, statement: "self_report" }) +
          "\n```"
      };
    requests.push(body);
    if (phase === "save" && step++ === 0)
      return {
        name: "manage_personal_context",
        arguments: {
          action: "save",
          context: {
            kind: "arrangement",
            status: "confirmed",
            title: "上海出差",
            content: "已确认上海出差",
            visibility: "user",
            quote,
            observedAt: "2026-11-05T08:00:00Z",
            startsAt: "2099-11-20T09:00:00+08:00",
            endsAt: "2099-11-22T18:00:00+08:00",
            timeZone: "Asia/Shanghai"
          }
        }
      };
    if (phase === "read" && step++ === 0)
      return { name: "manage_personal_context", arguments: { action: "query" } };
    if (phase === "read") {
      const query = body.messages.findLast((message) => message.role === "tool");
      const result = JSON.parse(query.content);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].title).toBe("上海出差");
      expect(result.records[0].validity).toBe("current");
      return { text: `近期安排：${result.records[0].title}。跨对话安排核对完成` };
    }
    return { text: "安排保存完成" };
  });
  const dashboard = await startDashboard({
    modelEndpoint: provider.baseUrl,
    model: "protocol-fixture",
    env: { COWORK_MODEL_API: "openai-completions" }
  });
  try {
    await page.goto(dashboard.base);
    async function openContext() {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "管理情境与安排", exact: true }).click();
      return page.getByRole("dialog", { name: "情境与安排", exact: true });
    }
    let dialog = await openContext();
    const use = dialog.getByRole("checkbox", { name: "使用情境与安排", exact: true });
    await expect(use).not.toBeChecked();
    await use.check();
    await expect(use).toBeEnabled();
    await expect(dialog.getByRole("checkbox", { name: "从对话登记", exact: true })).not.toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "处理敏感情境", exact: true })).not.toBeChecked();
    await dialog.getByRole("button", { name: "关闭情境与安排" }).click();
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).locator("..").hover();
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).click();
    await page.locator("#composer-input").fill(quote);
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("安排保存完成", { timeout: 40000 });
    await expect(page.locator("#stop-button")).toBeHidden();
    let result = await (await page.request.get(`${dashboard.base}/api/personal-context`)).json();
    expect(result.records).toHaveLength(1);
    phase = "read";
    step = 0;
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).locator("..").hover();
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).click();
    await page.locator("#composer-input").fill("最近我有什么事");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("跨对话安排核对完成", { timeout: 40000 });
    await expect(page.locator("#stop-button")).toBeHidden();
    await expect(page.locator("#conversation")).toContainText("近期安排：上海出差");
    expect(JSON.stringify(requests.at(-1).messages.filter((message) => message.role === "system"))).toContain(
      "已确认上海出差"
    );
    dialog = await openContext();
    await expect(dialog.getByRole("heading", { name: "上海出差", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("personal-context.png"), fullPage: true });
    await dialog.getByRole("button", { name: "取消安排 上海出差", exact: true }).click();
    await expect(dialog.getByText("已取消或结束", { exact: false })).toBeVisible();
    await dialog.getByRole("checkbox", { name: "使用情境与安排", exact: true }).uncheck();
    await expect(dialog.getByRole("checkbox", { name: "使用情境与安排", exact: true })).toBeEnabled();
    page.once("dialog", (dialog) => dialog.accept());
    await dialog.getByRole("button", { name: "删除 上海出差", exact: true }).click();
    await expect(dialog.getByText("暂无情境与安排", { exact: true })).toBeVisible();
    await dashboard.restart();
    await page.goto(dashboard.base);
    dialog = await openContext();
    await expect(dialog.getByRole("checkbox", { name: "使用情境与安排", exact: true })).not.toBeChecked();
    await expect(dialog.getByText("暂无情境与安排", { exact: true })).toBeVisible();
    result = await (await page.request.get(`${dashboard.base}/api/personal-context`)).json();
    expect(result.records).toHaveLength(0);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("changing a context switch during a reply preserves the conflict and commits no arrangement", async ({
  page
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const firstRequest = new Promise((resolve) => {
    entered = resolve;
  });
  const requests = [];
  const quote = "请保存我的上海出差安排";
  const provider = await modelProtocolFixture("openai-completions", async (body) => {
    requests.push(body);
    if (requests.length === 1) {
      entered();
      await gate;
      return {
        name: "manage_personal_context",
        arguments: {
          action: "save",
          context: {
            kind: "arrangement",
            status: "tentative",
            title: "上海出差",
            content: "上海出差计划",
            visibility: "task",
            quote,
            observedAt: "2026-11-05T08:00:00Z"
          }
        }
      };
    }
    return { text: "设置已变化，请重新发送请求" };
  });
  const dashboard = await startDashboard({
    modelEndpoint: provider.baseUrl,
    model: "protocol-fixture",
    env: { COWORK_MODEL_API: "openai-completions" }
  });
  try {
    await page.goto(dashboard.base);
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).locator("..").hover();
    await page.locator(`[data-project-create="${dashboard.projectId}"]`).click();
    await page.locator("#composer-input").fill(quote);
    await page.locator("#send-button").click();
    await firstRequest;
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "管理情境与安排", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "情境与安排", exact: true });
    const registration = dialog.getByRole("checkbox", { name: "从对话登记", exact: true });
    await registration.check();
    await expect(registration).toBeEnabled();
    await dialog.getByRole("button", { name: "关闭情境与安排" }).click();
    release();
    await expect(page.locator("#conversation")).toContainText("设置已变化，请重新发送请求", {
      timeout: 40000
    });
    await expect(page.locator("#stop-button")).toBeHidden();
    const tools = JSON.stringify(requests.at(-1).messages.filter((message) => message.role === "tool"));
    expect(tools).toContain("conflict");
    expect(tools).toContain("resend");
    expect(tools).not.toContain("query revoked or changed");
    const view = await (await page.request.get(`${dashboard.base}/api/personal-context`)).json();
    expect(view.records).toHaveLength(0);
    expect(view.settings.registrationEnabled).toBe(true);
  } finally {
    release();
    await dashboard.stop();
    await provider.close();
  }
});
