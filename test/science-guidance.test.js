import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { scienceEnvironmentGuidance, scienceSkillRoots } from "../dist/src/runtime/science-guidance.js";
import {
  discoverSkills,
  createLoadSkillTool,
  skillCatalogPrompt
} from "../dist/src/runtime/skill-registry.js";

const source = resolve(".");
const require = createRequire(import.meta.url);
const selection = {
  enabled: true,
  catalogVersion: "sciagentgym-e9dbbea-mass-spec-v6",
  pythonExecutable: "/selected general/python3",
  chemistryPythonExecutable: "/selected chemistry/python3"
};

test("scientific workflow roots and interpreter guidance exist only for enabled scopes", async () => {
  for (const value of [undefined, { ...selection, enabled: false }]) {
    assert.deepEqual(scienceSkillRoots(value), []);
    assert.equal(scienceEnvironmentGuidance(value), "");
  }
  assert.deepEqual(scienceSkillRoots(selection, "/installation"), [
    join("/installation", ".pi/runtime/science-skills")
  ]);
  const text = scienceEnvironmentGuidance(selection);
  assert.ok(text.includes(JSON.stringify(selection.pythonExecutable)));
  assert.ok(text.includes(JSON.stringify(selection.chemistryPythonExecutable)));
  assert.match(text, /do not prove environment readiness/);
  assert.match(text, /never arbitrary code or file paths/);
  assert.match(text, /simple conversion or single calculation does not require a skill/);
  assert.ok(
    scienceEnvironmentGuidance({ ...selection, chemistryPythonExecutable: undefined }).includes(
      `Selected chemistry/RDKit Python executable: ${JSON.stringify(selection.pythonExecutable)}`
    )
  );
});

test("opt-in scientific skills load progressively and survive the installed desktop file selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-scientific-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultSkills = await discoverSkills([join(source, ".pi/skills")]);
  const names = ["molecular-analysis", "scientific-analysis"];
  assert.ok(defaultSkills.every((skill) => !names.includes(skill.name)));
  const config = require("../electron-builder.config.cjs");
  const filter = new FileMatcher(source, root, (pattern) => pattern, config.files).createFilter();
  const [originalRoot] = scienceSkillRoots(selection, source);
  const destination = join(root, relative(source, originalRoot));
  for (const name of names) {
    const file = join(originalRoot, name, "SKILL.md");
    assert.equal(filter(file, await stat(file)), true, name);
  }
  await cp(originalRoot, destination, { recursive: true });
  const skills = await discoverSkills(scienceSkillRoots(selection, root));
  assert.deepEqual(
    skills.map((skill) => skill.name),
    names
  );
  const catalog = skillCatalogPrompt(skills);
  assert.ok(names.every((name) => catalog.includes(name)));
  assert.doesNotMatch(catalog, /平均分子量 MolWt 与单同位素精确质量不同/);
  const loader = createLoadSkillTool(skills);
  const loaded = await loader.execute({ name: "molecular-analysis" });
  assert.equal(loaded.directory, join(destination, "molecular-analysis"));
  assert.match(loaded.content, /平均分子量 MolWt 与单同位素精确质量不同/);
  assert.match(loaded.content, /chemistry\/RDKit Python/);
  await assert.rejects(
    createLoadSkillTool(defaultSkills).execute({ name: "scientific-analysis" }),
    /unknown skill/
  );
});
