import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { GlobalWorkspaceCatalog } from "../dist/src/workspace/global-catalog.js";

test("global workspace catalog deduplicates roots without moving task data", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-global-catalog-"));
  const workspaceA = join(root, "project-a");
  const workspaceB = join(root, "project-b");
  const index = join(root, "global", "workspaces.json");
  try {
    const catalog = new GlobalWorkspaceCatalog(index);
    await catalog.register(workspaceA);
    await catalog.register(workspaceB);
    await catalog.register(resolve(workspaceA));
    assert.deepEqual(new Set(await catalog.list()), new Set([resolve(workspaceA), resolve(workspaceB)]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
