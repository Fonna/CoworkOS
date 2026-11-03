import assert from "node:assert/strict";

/** Independent launches enter managed storage without a compulsory directory choice. */
export function confirmApplicationWorkspaceInDom(page) {
  assert.equal(page.$("[data-app-workspace]"), null, "independent launch must not require a workspace modal");
}
