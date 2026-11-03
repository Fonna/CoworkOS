import { expect } from "@playwright/test";

/** Independent launching no longer requires a directory choice. */
export async function confirmApplicationWorkspace(page) {
  await expect(page.getByRole("dialog", { name: /^新建.*实例$/ })).toHaveCount(0);
}
