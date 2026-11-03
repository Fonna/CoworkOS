import { test, expect } from "@playwright/test";
import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function seed(page, dashboard, { failed = false } = {}) {
  const taskId = "reading-width";
  await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: "阅读列验收" } });
  const user = { role: "user", timestamp: 1, content: "请核对这份合成报告。" };
  let humanQuestion;
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "核对工具结果。" },
      {
        type: "text",
        text: `${"一段可读的报告正文。\n\n".repeat(40)}\n\`\`\`js\n${"long_code_".repeat(100)}\n\`\`\`\n\n| 列 | 值 |\n| --- | --- |\n| ${"long_cell_".repeat(60)} | 内容 |`
      }
    ]
  };
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    const detail = await (await route.fetch()).json();
    return route.fulfill({
      json: {
        ...detail,
        task: {
          ...detail.task,
          status: failed ? "failed" : "completed",
          lastError: failed ? "Synthetic connection failure" : undefined
        },
        runtime: { active: false },
        humanRequests: humanQuestion ? [humanQuestion] : [],
        messages: [user, answer],
        runtimeEvents: [
          { type: "turn_start" },
          { type: "message_start", message: user },
          { type: "message_start", message: answer },
          { type: "tool_execution_start", toolCallId: "read", toolName: "read" },
          { type: "tool_execution_end", toolCallId: "read", toolName: "read", result: "合成工具结果" },
          { type: "message_end", message: answer },
          { type: "turn_end", message: answer }
        ].map((payload, index) => ({
          type: "runtime_event",
          runId: "reading-run",
          eventId: `reading-event-${index}`,
          payload
        }))
      }
    });
  });
  await page.goto(dashboard.base);
  await expect(page.locator(failed ? ".request-error" : ".chat-message.main")).toBeVisible();
  return {
    setHumanQuestion(request) {
      humanQuestion = request;
    },
    append(text) {
      answer.content[1].text += `\n\n${text}`;
    }
  };
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const { x, width } = document.querySelector(selector).getBoundingClientRect();
      return { x, width, center: x + width / 2 };
    };
    return {
      pane: rect("#conversation-pane"),
      answer: rect(".chat-message.main"),
      user: rect(".chat-message.user"),
      history: rect(".execution-history"),
      composer: rect(".composer"),
      pageWidth: document.documentElement.scrollWidth
    };
  });
}

async function checkColumn(page) {
  const boxes = await geometry(page);
  for (const key of ["answer", "history", "composer"]) {
    expect(boxes[key].width, key).toBeLessThanOrEqual(960.5);
    expect(Math.abs(boxes[key].center - boxes.pane.center), key).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes[key].x - boxes.composer.x), key).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes[key].width - boxes.composer.width), key).toBeLessThanOrEqual(1);
  }
  expect(
    Math.abs(boxes.user.x + boxes.user.width - boxes.composer.x - boxes.composer.width)
  ).toBeLessThanOrEqual(1);
  expect(boxes.pageWidth).toBeLessThanOrEqual(page.viewportSize().width);
  return boxes;
}

test("conversation and composer share the available pane's centered reading column", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const { append, setHumanQuestion } = await seed(page, dashboard);
    for (const width of [1440, 2048, 2560, 3200]) {
      await page.emulateMedia({ colorScheme: [1440, 2560].includes(width) ? "dark" : "light" });
      await page.setViewportSize({ width, height: 900 });
      if (process.env.ATRIA_WIDTH_BASELINE === "1") console.log(width, await geometry(page));
      else await checkColumn(page);
      await page.locator("#conversation").evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: info.outputPath(`reading-${width}.png`) });
    }
    if (process.env.ATRIA_WIDTH_BASELINE === "1") return;
    const composer = await page.locator(".composer").boundingBox();
    setHumanQuestion({
      requestId: "reading-question",
      status: "pending",
      question: "请选择报告格式",
      context: "合成宽度验收",
      options: ["Markdown", "PDF"],
      recommended: 0
    });
    await expect(page.locator("#human-questions")).toBeVisible();
    const question = await page.locator("#human-questions").boundingBox();
    expect(question.x).toBeCloseTo(composer.x, 0);
    expect(question.width).toBeCloseTo(composer.width, 0);
    setHumanQuestion(null);
    await expect(page.locator("#human-questions")).toBeHidden();
    const input = page.locator("#composer-input");
    await input.fill("保留未发送草稿");
    await input.focus();
    await page.evaluate(() => {
      document.querySelector("#conversation").scrollTop = 180;
    });
    const top = await page.locator("#conversation").evaluate((node) => node.scrollTop);
    await page.setViewportSize({ width: 2560, height: 900 });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("保留未发送草稿");
    expect(await page.locator("#conversation").evaluate((node) => node.scrollTop)).toBeCloseTo(top, 0);
    append("历史阅读期间新增回复");
    await expect(page.locator("#conversation")).toContainText("历史阅读期间新增回复");
    expect(await page.locator("#conversation").evaluate((node) => node.scrollTop)).toBeCloseTo(top, 0);
    await page.locator("#conversation").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    append("跟随最新回复验收");
    await expect(page.locator("#conversation")).toContainText("跟随最新回复验收");
    expect(
      await page
        .locator("#conversation")
        .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
    ).toBeLessThanOrEqual(2);
    await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    await expect(page.locator("#sidebar-divider")).toBeHidden();
    await checkColumn(page);
    await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    await expect(page.locator("#sidebar-divider")).toBeVisible();
    const divider = await page.locator("#sidebar-divider").boundingBox();
    await page.mouse.move(divider.x + 2, divider.y + 80);
    await page.mouse.down();
    await page.mouse.move(410, divider.y + 80);
    await page.mouse.up();
    await checkColumn(page);
    await page.locator("#output-pane-toggle").click();
    await checkColumn(page);
    await page.locator("#output-pane-toggle").click();
    await checkColumn(page);
    for (const width of [752, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await checkColumn(page);
      await expect(input).toHaveValue("保留未发送草稿");
      await page.screenshot({ path: info.outputPath(`reading-${width}.png`) });
    }
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await confirmApplicationWorkspace(page);
    await page.locator("[data-empty-new]").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("reading-column.txt");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await loadCurrentApplication(page, { taskId: "reading-width" });
    await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
    await checkColumn(page);
    const split = page.locator("[data-workspace-divider]");
    await split.focus();
    await split.press("Home");
    await checkColumn(page);
    await split.press("End");
    await checkColumn(page);
    await expect(input).toHaveValue("保留未发送草稿");
    await page.screenshot({ path: info.outputPath("reading-split-2560.png") });
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("failure recovery stays within the shared column", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard, { failed: true });
    for (const width of [1440, 2560, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".request-error")).toBeVisible();
      const error = await page.locator(".request-error").boundingBox();
      const composer = await page.locator(".composer").boundingBox();
      expect(error.x).toBeCloseTo(composer.x, 0);
      expect(error.width).toBeCloseTo(composer.width, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("reading columns stay within the viewport across desktop and mobile breakpoints", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ colorScheme: "light" });
    await seed(page, dashboard);
    await page.locator("#composer-input").fill("边界窗口保留草稿");
    for (const width of [900, 901, 959, 960, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [left, right] of [
        [false, false],
        [true, false],
        [true, true],
        [false, true]
      ]) {
        const body = page.locator("body");
        const leftClass = width <= 900 ? "sidebar-mobile-open" : "sidebar-collapsed";
        const desiredLeft = width <= 900 ? !left : left;
        if ((await body.evaluate((node, name) => node.classList.contains(name), leftClass)) !== desiredLeft)
          await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
        if ((await body.evaluate((node) => node.classList.contains("output-collapsed"))) !== right) {
          await page.locator("#output-pane-toggle").click();
        }
        await checkColumn(page);
        const content = await page.locator(".chat-message.main").boundingBox();
        for (const selector of [".chat-message.main pre", ".chat-message.main table"]) {
          const box = await page.locator(selector).boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(content.x - 1);
          expect(box.x + box.width).toBeLessThanOrEqual(content.x + content.width + 1);
        }
        expect(
          await page.locator(".chat-message.main pre").evaluate((node) => node.scrollWidth > node.clientWidth)
        ).toBe(true);
        await expect(page.locator("#composer-input")).toHaveValue("边界窗口保留草稿");
        await page.screenshot({
          path: info.outputPath(`boundary-${width}-${Number(left)}-${Number(right)}.png`)
        });
        if (width > 900 && !left) {
          const divider = page.locator("#sidebar-divider");
          await divider.focus();
          await divider.press("End");
          await checkColumn(page);
          await divider.press("Home");
          await checkColumn(page);
        }
      }
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});
