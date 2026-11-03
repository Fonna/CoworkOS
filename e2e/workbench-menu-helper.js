/** Use the current document through the workspace menu, preserving its ownership. */
export async function useApplicationInConversation(page) {
  await page.locator("[data-app-collaborate]").click();
}
