import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverSkills,
  createLoadSkillTool,
  skillCatalogPrompt
} from "../dist/src/runtime/skill-registry.js";

const skillRoot = fileURLToPath(new URL("../.pi/skills/", import.meta.url));
const NAME = "machine-learning-model-search";

async function skill() {
  const skills = await discoverSkills([skillRoot]);
  const found = skills.find((entry) => entry.name === NAME);
  assert.ok(found, `${NAME} must be discoverable through the real registry`);
  return { skills, found };
}

async function body() {
  return readFile(join(skillRoot, NAME, "SKILL.md"), "utf8");
}

test("the skill is discoverable and loadable, and only its description reaches the prompt", async () => {
  const { skills, found } = await skill();
  const catalog = skillCatalogPrompt(skills);
  assert.ok(catalog.includes(NAME));
  assert.ok(catalog.includes(found.description));
  assert.ok(
    !catalog.includes("Independent routes with a complete problem view"),
    "the body must stay out of the prompt until loaded"
  );

  const loaded = await createLoadSkillTool(skills).execute({ name: NAME });
  assert.equal(loaded.name, NAME);
  assert.ok(loaded.content.length > 1_000);
  assert.equal(loaded.directory, join(skillRoot, NAME));
});

test("the description says when not to load it, and stays cheap enough to carry every turn", async () => {
  const { found } = await skill();
  assert.match(found.description, /excludes/i, "a skill that only says when it applies will misfire");
  assert.match(found.description, /machine learning coding/i);
  assert.doesNotMatch(await body(), /Kaggle|MLE-bench|mlebench-search|submission\.csv/);
  // Keep an explicit budget for the activation instructions carried every turn.
  assert.ok(found.description.length < 1200, `description is ${found.description.length} characters`);
});

test("the skill routes long work to the supervised job tools, not a foreground wait", async () => {
  const text = await body();
  assert.match(text, /`start_job`/, "training must go to the background tool Main actually has");
  assert.match(text, /`check_job`/);
  assert.match(text, /`kill_job`/);
  assert.match(text, /longRunning/, "the tools are gated, so the skill has to say so");
  assert.match(text, /log has been quiet|quiet/i, "quiet time is the evidence that replaces a timeout");

  // The mechanism this skill was first written against does not exist here:
  // Main has no fixed foreground yield, no PID/status-file protocol.
  for (const absent of ["120 seconds", "PGID", "status-file", "status file"]) {
    assert.ok(!text.includes(absent), `${absent} describes a mechanism this harness does not have`);
  }
});

test("the search discipline that Runtime cannot enforce is stated", async () => {
  const text = await body();
  assert.match(
    text,
    /at least one independent end-to-end/i,
    "the point of the skill is a second route, not a second opinion"
  );
  assert.match(
    text,
    /find \//,
    "an unbounded filesystem search is the failure this section exists to prevent"
  );
  assert.match(text, /validation contract/i);
  assert.match(
    text,
    /Do not urge a normally progressing child/i,
    "hurrying a working route is the failure mode worth naming"
  );
});
