import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { discoverSkills, createLoadSkillTool } from "../dist/src/runtime/skill-registry.js";

const skillRoot = fileURLToPath(new URL("../.pi/skills/", import.meta.url));
const validator = join(skillRoot, "virtual-agent-authoring/scripts/validate_package.mjs");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "virtual-agent-authoring-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = {
    name: "test-observer", version: "0.1.0", entrypoint: "watcher/rule.mjs",
    handler: "AGENT.md", sources: ["https://example.test/announcements"],
    state: "watcher/state.json", events: { dedupeKey: "source id and version", wake: "important" }
  };
  await mkdir(join(directory, "watcher"));
  await mkdir(join(directory, "tests"));
  await writeFile(join(directory, "AGENT.md"), "Observe announcements and report verified changes.");
  // A syntax check must not execute module-level code.
  await writeFile(join(directory, "watcher/rule.mjs"), 'throw new Error("must not execute during validation"); export default () => ({ events: [] });');
  const save = (value) => writeFile(join(directory, "manifest.json"), JSON.stringify(value));
  await save(manifest);
  const check = () => spawnSync(process.execPath, [validator, directory], { encoding: "utf8", timeout: 5_000 });
  return { directory, manifest, save, check };
}

test("authoring skill is discoverable and loadable through the real Subagent registry", async () => {
  const skills = await discoverSkills([skillRoot]);
  const skill = skills.find((entry) => entry.name === "virtual-agent-authoring");
  assert.ok(skill);
  const result = await createLoadSkillTool(skills).execute({ name: skill.name });
  assert.equal(result.path, skill.path);
  assert.ok(result.content.length > 0);
});

test("package validation accepts a draft without state and never executes its probe", async (t) => {
  const { check } = await fixture(t);
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});

test("invalid manifests and fields fail cleanly without crashing", async (t) => {
  const { manifest, save, check } = await fixture(t);
  for (const value of [null, false, 42, [], {}, { ...manifest, entrypoint: 12 }, { ...manifest, handler: [] }, { ...manifest, sources: [] }, { ...manifest, events: { wake: "sometimes" } }]) {
    await save(value);
    const result = check();
    assert.equal(result.status, 1, `Unexpected success for ${JSON.stringify(value)}`);
    assert.doesNotMatch(result.stderr, /TypeError|at file:\/\//);
  }
});

test("validator rejects paths outside the package including symlink targets", async (t) => {
  const { directory, manifest, save, check } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "virtual-agent-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "rule.mjs"), "export default () => [];");
  await symlink(outside, join(directory, "external"), "dir");
  for (const patch of [
    { entrypoint: "../rule.mjs" }, { handler: join(directory, "AGENT.md") },
    { entrypoint: "external/rule.mjs" }, { state: "external/new-state.json" }
  ]) {
    await save({ ...manifest, ...patch });
    assert.equal(check().status, 1, JSON.stringify(patch));
  }
});

test("validator rejects missing handlers, a tests file, and invalid probe syntax", async (t) => {
  const { directory, manifest, save, check } = await fixture(t);
  await save({ ...manifest, handler: "missing.md" });
  assert.equal(check().status, 1);
  await save(manifest);
  await rm(join(directory, "tests"), { recursive: true });
  await writeFile(join(directory, "tests"), "not a directory");
  assert.equal(check().status, 1);
  await rm(join(directory, "tests"));
  await mkdir(join(directory, "tests"));
  await writeFile(join(directory, "watcher/rule.mjs"), "export default (;");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /syntax check failed/);
});
