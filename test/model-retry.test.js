import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ensurePiRetryDefaults } from "../dist/src/runtime/model-retry.js";

test("Main retry defaults reach native Pi without overwriting explicit settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-retry-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  await writeFile(
    path,
    JSON.stringify({ theme: "light", retry: { baseDelayMs: 1, provider: { maxRetries: 0 } } })
  );
  await Promise.all([ensurePiRetryDefaults(root), ensurePiRetryDefaults(root)]);
  const settings = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(settings, {
    theme: "light",
    retry: { baseDelayMs: 1, provider: { maxRetries: 0 }, maxRetries: 5 }
  });
  assert.equal(SettingsManager.create(root, root).getRetrySettings().maxRetries, 5);
  for (const retry of [{ enabled: false, maxRetries: 0 }, { maxRetries: 2 }]) {
    const raw = JSON.stringify({ theme: "light", retry });
    await writeFile(path, raw);
    await ensurePiRetryDefaults(root);
    assert.equal(await readFile(path, "utf8"), raw);
  }
  const invalid = '{"credential":"private-test-key",invalid}';
  await writeFile(path, invalid);
  await assert.rejects(ensurePiRetryDefaults(root), (error) => {
    assert.match(error.message, /设置无法读取/);
    assert.doesNotMatch(error.message, /private-test-key/);
    return true;
  });
  assert.equal(await readFile(path, "utf8"), invalid);
});
