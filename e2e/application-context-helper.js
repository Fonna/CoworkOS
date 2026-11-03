import { expect } from "@playwright/test";
import { useApplicationInConversation } from "./workbench-menu-helper.js";

/** Load the visible app through the conversation's regular context selector. */
export async function loadCurrentApplication(page, { taskId, newConversation = false, appInstanceId } = {}) {
  const response = await page.request.get(new URL("/api/workbench/tabs", page.url()).href);
  expect(response.ok()).toBe(true);
  const { tabs, activeTabId } = await response.json();
  const application = tabs.find(
    (tab) =>
      tab.kind === "application" &&
      (appInstanceId ? tab.appInstanceId === appInstanceId : tab.tabId === activeTabId)
  );
  expect(application, "an application is selected before loading its context").toBeTruthy();
  if ((newConversation || taskId) && !(await page.locator(".conversation-sidebar").isVisible()))
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  if (newConversation) await page.locator("#new-conversation").click();
  else if (taskId) await page.locator(`#project-list [data-task="${taskId}"]`).click();
  else if (await page.locator("[data-app-collaborate]").isVisible()) {
    await useApplicationInConversation(page);
    expect(application.appInstanceId, "the loaded application has an instance identity").toBeTruthy();
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const selectedTask = document.querySelector("#project-list .conversation-item.active")?.dataset
              .task;
            if (!selectedTask) return undefined;
            const response = await fetch("/api/tasks/" + encodeURIComponent(selectedTask));
            if (!response.ok) return undefined;
            return (await response.json()).applications?.loadedInstanceId;
          }),
        { timeout: 30_000, message: "the workspace menu loads the selected application instance" }
      )
      .toBe(application.appInstanceId);
    await expect(page.locator("#app-bind-select")).toHaveClass(/is-bound/);
    await expect(page.locator("#app-bind-select")).toBeEnabled();
    return application;
  }
  await expect(page.locator("#app-bind-select")).toBeVisible();
  await page.locator("#app-bind-select").click();
  await page.locator(`[data-bind-instance="${application.appInstanceId ?? application.resourceId}"]`).click();
  await expect(page.locator("#app-bind-select")).toHaveClass(/is-bound/);
  await expect(page.locator("#app-bind-select")).toBeEnabled();
  return application;
}
