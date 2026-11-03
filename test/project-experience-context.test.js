import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { ProjectExperienceStore } from "../dist/src/runtime/project-experience-store.js";
import {
  projectExperienceContext,
  projectExperienceSkillCatalog
} from "../dist/src/runtime/project-experience-context.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

test("project facts and generated catalog are bounded, private to their project and immediately revoked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-project-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new ProjectExperienceStore({ projectId: "a", projectDirectory: join(root, "a") }, root);
  const second = new ProjectExperienceStore({ projectId: "b", projectDirectory: join(root, "b") }, root);
  for (let i = 0; i < 12; i++)
    await first.save({
      kind: "experience",
      title: `Fact ${i}`,
      content: `PRIVATE_A_${i} ${"x".repeat(900)}`
    });
  const skill = await first.save({
    kind: "skill",
    title: "Checks",
    description: "Validate this project",
    content: "PRIVATE_SKILL_BODY"
  });
  assert.equal(await projectExperienceContext(first), "");
  await first.configure({ enabled: true });
  const text = await projectExperienceContext(first);
  assert.ok(text.length <= 4000);
  assert.match(text, /PRIVATE_A_/);
  assert.doesNotMatch(text, /PRIVATE_SKILL_BODY/);
  assert.equal(await projectExperienceContext(second), "");
  const catalog = await projectExperienceSkillCatalog(first);
  assert.match(catalog, new RegExp(`learned-${skill.id}`));
  assert.doesNotMatch(catalog, /PRIVATE_SKILL_BODY/);
  await first.setState(skill.id, skill.revision, "disabled");
  assert.equal(await projectExperienceSkillCatalog(first), "");
  await first.configure({ enabled: false });
  assert.equal(await projectExperienceContext(first), "");
});

test("real PiSession omits oversized project experience without summarizing or trimming the current task", async (t) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "Done" }));
  t.after(() => provider.close());
  const prompt = "CURRENT_PROJECT_TASK_MUST_REMAIN_INTACT";
  const session = new PiSession({
    api: "openai-completions",
    baseUrl: provider.baseUrl,
    apiKey: "fixture",
    model: "protocol-fixture",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    contextWindow: 1000,
    maxTokens: 128,
    systemPrompt: "CURRENT_POLICY",
    tools: new Map(),
    maxErrorRetries: 0,
    compaction: { reserveTokens: 256, keepRecentTokens: 32 },
    prepareUserMemory: async () => "PERSONAL_REFERENCE",
    prepareProjectExperience: async () => `OVERSIZED_PROJECT_REFERENCE${"x".repeat(12000)}`
  });
  const result = await session.run(prompt);
  assert.equal(result.termination, "completed");
  assert.equal(result.compaction.compactionCount, 0);
  assert.equal(provider.requests.length, 1);
  const body = JSON.stringify(provider.requests[0].body);
  assert.match(body, /CURRENT_PROJECT_TASK_MUST_REMAIN_INTACT/);
  assert.match(body, /PERSONAL_REFERENCE/);
  assert.doesNotMatch(body, /OVERSIZED_PROJECT_REFERENCE/);
});
