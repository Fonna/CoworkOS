import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { discoverSkills, createLoadSkillTool } from "../dist/src/runtime/skill-registry.js";

const harnessNames = ["blender-harness", "cad-harness", "freecad-harness", "office-harness"];
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const helperPath = resolve(".pi/runtime/application-skills.ts");
const { mainApplicationSkillScope, mainApplicationSkills } = await createJiti(
  pathToFileURL(helperPath).href
).import(helperPath);

test("ordinary skill discovery withholds every application-only harness workflow", async () => {
  const skills = await discoverSkills([resolve(".pi/skills")]);
  for (const name of harnessNames) assert.ok(!skills.some((skill) => skill.name === name), name);
  assert.ok(
    skills.some((skill) => skill.name === "blender"),
    "ordinary native workflows remain available"
  );
});

test("application scope allows only the active workflow and application roots win collisions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-skill-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "skills");
  await mkdir(join(appRoot, "blender"), { recursive: true });
  await writeFile(
    join(appRoot, "blender", "SKILL.md"),
    "---\nname: blender\ndescription: External Blender workflow\n---\nUse execute_blender_code."
  );
  const roots = [appRoot, resolve(".pi/skills")];
  const skills = await discoverSkills(roots, { applications: ["blender-harness"] });
  const loaded = await createLoadSkillTool(skills).execute({ name: "blender" });
  assert.equal(loaded.directory, join(appRoot, "blender"));
  assert.match(loaded.content, /execute_blender_code/);
  assert.ok(skills.some((skill) => skill.name === "blender-harness"));
  for (const name of harnessNames.filter((name) => name !== "blender-harness"))
    assert.ok(!skills.some((skill) => skill.name === name), name);
  const detached = await discoverSkills([resolve(".pi/skills")]);
  assert.match(
    (await createLoadSkillTool(detached).execute({ name: "blender" })).content,
    /blender_read_scene/
  );
  await assert.rejects(
    () => createLoadSkillTool(detached).execute({ name: "blender-harness" }),
    /unknown skill/
  );
});

test("explicit Pi skill files retain SDK-compatible inferred names and application scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-explicit-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userPath = join(root, "user-skill", "SKILL.md");
  const appPath = join(root, "app-skill", "SKILL.md");
  await mkdir(join(root, "user-skill"));
  await mkdir(join(root, "app-skill"));
  await writeFile(
    userPath,
    "---\ndescription: An explicit SDK skill without a name field\n---\nUser workflow."
  );
  await writeFile(
    appPath,
    "---\ndescription: Scoped explicit skill\napplication: example-app\n---\nApp workflow."
  );
  assert.deepEqual(
    (await discoverSkills([userPath, appPath])).map((skill) => skill.name),
    ["user-skill"]
  );
  assert.deepEqual(
    (await discoverSkills([userPath, appPath], { applications: ["example-app"] })).map((skill) => skill.name),
    ["app-skill", "user-skill"]
  );
});

test("Main's canonical SDK catalog preserves overrides and YAML while honoring disabled and empty selections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-sdk-skill-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const overridePath = join(root, "blender", "SKILL.md");
  const yamlPath = join(root, "yaml-skill", "SKILL.md");
  await mkdir(join(root, "blender"));
  await mkdir(join(root, "yaml-skill"));
  await writeFile(overridePath, "---\nname: blender\ndescription: User override\n---\nUSER_OVERRIDE body.");
  await writeFile(
    yamlPath,
    "---\nname: yaml-skill\ndescription:\n  Valid SDK description split onto next line.\n---\nYAML_WORKFLOW body."
  );
  const sdk = () =>
    loadSkills({ cwd: root, agentDir: root, skillPaths: [overridePath, yamlPath], includeDefaults: false })
      .skills;
  const base = [resolve(".pi/skills")];
  let selected = sdk();
  let scope = mainApplicationSkillScope(base, undefined, resolve("."), selected);
  let catalog = await mainApplicationSkills(scope, selected);
  assert.equal(catalog.find((skill) => skill.name === "blender").filePath, overridePath);
  assert.equal(
    catalog.find((skill) => skill.name === "yaml-skill").description,
    "Valid SDK description split onto next line."
  );
  let tool = createLoadSkillTool(await discoverSkills(scope.skillRoots));
  assert.match((await tool.execute({ name: "blender" })).content, /USER_OVERRIDE body/);
  assert.match((await tool.execute({ name: "yaml-skill" })).content, /YAML_WORKFLOW body/);

  await writeFile(
    overridePath,
    "---\nname: blender\ndescription: User override\ndisable-model-invocation: true\n---\nDisabled body."
  );
  selected = sdk();
  scope = mainApplicationSkillScope(base, undefined, resolve("."), selected);
  catalog = await mainApplicationSkills(scope, selected);
  assert.ok(
    !catalog.some((skill) => skill.name === "blender"),
    "a disabled user override does not fall back to bundled Blender"
  );
  tool = createLoadSkillTool(await discoverSkills(scope.skillRoots));
  await assert.rejects(() => tool.execute({ name: "blender" }), /unknown skill/);

  scope = mainApplicationSkillScope(base, undefined, resolve("."), []);
  assert.deepEqual(await mainApplicationSkills(scope, []), [], "an explicit empty SDK catalog stays empty");
  assert.deepEqual(await discoverSkills(scope.skillRoots), []);
  const legacy = mainApplicationSkillScope(base, undefined, resolve("."), undefined);
  assert.ok((await discoverSkills(legacy.skillRoots)).some((skill) => skill.name === "blender"));
});
