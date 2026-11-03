import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, createLoadSkillTool, skillCatalogPrompt } from "../dist/src/runtime/skill-registry.js";

const skillRoot = fileURLToPath(new URL("../.pi/skills/", import.meta.url));
const NAME = "iterative-optimization";

async function skill() {
  const skills = await discoverSkills([skillRoot]);
  const found = skills.find((entry) => entry.name === NAME);
  assert.ok(found, `${NAME} must be discoverable through the real registry`);
  return { skills, found };
}

test("the skill is discoverable and loadable, and only its description reaches the prompt", async () => {
  const { skills, found } = await skill();
  // Progressive disclosure: the catalog carries name and description only.
  const catalog = skillCatalogPrompt(skills);
  assert.ok(catalog.includes(NAME));
  assert.ok(catalog.includes(found.description));
  assert.ok(!catalog.includes("Establish the referee first"), "the body must stay out of the prompt until loaded");

  const loaded = await createLoadSkillTool(skills).execute({ name: NAME });
  assert.equal(loaded.name, NAME);
  assert.ok(loaded.content.length > 1_000);
  assert.equal(loaded.directory, join(skillRoot, NAME));
});

test("the description says when to use it and when not to", async () => {
  const { found } = await skill();
  // Without a negative clause the skill loads for any task mentioning training,
  // which is the misfire the wording has to prevent.
  assert.match(found.description, /repeated rounds|over .* rounds/i);
  assert.match(found.description, /do not use/i);
  assert.match(found.description, /single training run|one-off|merely mentions/i);
});

test("the skill makes confirming the evaluation paths a precondition, not advice", async () => {
  const body = await readFile(join(skillRoot, NAME, "SKILL.md"), "utf8");

  // The load-bearing instruction: ask the user before the first round.
  assert.match(body, /askhuman/);
  assert.match(body, /grant_capabilities/);
  assert.match(body, /Ask once, in one question/i);
  assert.match(body, /read-only path the user named/i);

  // It must say why, since an agent that does not understand the reason will
  // rationalize skipping the question.
  assert.match(body, /must not be able to edit/i);
  assert.match(body, /silent|invisible|look the same/i);

  // Inspect first, then confirm — not an interrogation from a blank slate.
  assert.match(body, /Inspect the project/i);
  assert.match(body, /than asking them to describe their project from scratch/i);

  // Refusing to answer must not become a reason to stop working.
  assert.match(body, /continue but say once/i);

  // Reading the scorer stays allowed; only writing is refused.
  assert.match(body, /Read a protected path freely/i);
});

test("the skill states the loop invariants the runtime cannot enforce", async () => {
  const body = await readFile(join(skillRoot, NAME, "SKILL.md"), "utf8");
  assert.match(body, /baseline/i, "a series with nothing to compare against is not evidence");
  assert.match(body, /one\*{0,2} thing|changes \*{0,2}one/i, "two changes and one moved number teach nothing");
  assert.match(body, /metrics\.json/, "metrics come from a file, not from prose");
  assert.match(body, /start_job|check_job|kill_job/, "a long job is supervised, not deadlined");
  assert.match(body, /wedged|still making progress/i, "the model judges liveness; a clock cannot");
  assert.match(body, /failures be results|evidence about the search space/i);
  assert.match(body, /memory\.md/, "judgment belongs in memory, facts in the ledger");
});

test("the skill does not claim tools or guarantees that do not exist", async () => {
  const body = await readFile(join(skillRoot, NAME, "SKILL.md"), "utf8");
  // The ledger tools were deliberately removed; a skill referencing them would
  // send Main after something that is not there.
  for (const absent of ["experiment_open", "experiment_history", "experiment_record", "experiment_next_run", "experiment_close"]) {
    assert.ok(!body.includes(absent), `${absent} does not exist and must not be referenced`);
  }
  // The guard is not a sandbox, so the skill must not promise isolation.
  assert.ok(!/sandbox/i.test(body), "the skill must not imply the guard is a sandbox");
});
