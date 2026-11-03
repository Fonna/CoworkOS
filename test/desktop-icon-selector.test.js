import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const { selectApplicationIcon, refreshDockIcon } = createRequire(import.meta.url)(
  "../desktop/application-icon.cjs"
);

test("app icon selection prefers the runtime export, falls back to the build export, and preserves the system default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-icon-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "dist/src/desktop/atria-icon.png");
  const build = join(root, "build/atria-icon.png");
  const raw = join(root, "web/assets/atria-symbol.png");
  for (const path of [runtime, build, raw]) await mkdir(dirname(path), { recursive: true });
  await writeFile(raw, "raw brand artwork");
  assert.equal(selectApplicationIcon(root), undefined, "raw brand artwork never overrides the bundle icon");
  await writeFile(build, "rounded build icon");
  assert.equal(selectApplicationIcon(root), build);
  await writeFile(runtime, "rounded runtime icon");
  assert.equal(selectApplicationIcon(root), runtime);
  await rm(runtime);
  assert.equal(selectApplicationIcon(root), build);
  await rm(build);
  assert.equal(selectApplicationIcon(root), undefined);
});

test("Dock refresh reads newly generated icons each time and does not replace a default with missing artwork", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-icon-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "dist/src/desktop/atria-icon.png");
  await mkdir(dirname(runtime), { recursive: true });
  const loaded = [];
  const dock = { setIcon: (path) => loaded.push(path) };
  refreshDockIcon(root, dock);
  assert.deepEqual(loaded, []);
  await writeFile(runtime, "first rounded export");
  refreshDockIcon(root, dock);
  await writeFile(runtime, "rebuilt rounded export");
  refreshDockIcon(root, dock);
  assert.deepEqual(loaded, [runtime, runtime], "same-path rebuilds are reloaded instead of cached");
  await rm(runtime);
  refreshDockIcon(root, dock);
  assert.deepEqual(loaded, [runtime, runtime], "missing output leaves the existing/system icon alone");
});
