import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProjectExperienceStore,
  ProjectExperienceConflictError,
  ProjectExperienceCapacityError,
  listProjectExperienceIdentities,
  projectExperienceIdentity
} from "../dist/src/runtime/project-experience-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-project-experience-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = {
    projectId: "project-a",
    projectDirectory: join(root, "project-a"),
    projectCatalogPath: join(root, "catalog.json")
  };
  return { root, identity, store: new ProjectExperienceStore(identity, join(root, "knowledge")) };
}
const manual = (kind = "experience", content = "Run the project fixture before changing the migration.") => ({
  kind,
  title: "Migration workflow",
  description: "A verified local workflow",
  content
});
const proposal = (fields = {}) => ({
  ...manual(),
  quote: "The migration fixture passed",
  validationQuote: "exit code 0",
  ...fields
});
async function configure(store, autoActivate = true) {
  await store.configure({ enabled: true, learningEnabled: true, autoActivate });
  return (await store.read()).generation;
}
async function submit(store, generation, taskId, change = proposal(), verified = true, extras = {}) {
  return store.applyProposal({
    taskId,
    runId: `run-${taskId}`,
    changes: [change],
    expectedGeneration: generation,
    verified,
    ...extras
  });
}

test("project identity is stable across directory moves and isolated across catalogs and projects", async (t) => {
  const { root, identity, store } = await fixture(t);
  assert.deepEqual([...(await store.read()).entries], []);
  assert.equal((await store.readProfile()).enabled, false);
  const saved = await store.save(manual());
  await store.configure({ enabled: true });
  const moved = new ProjectExperienceStore(
    { ...identity, projectDirectory: join(root, "renamed") },
    join(root, "knowledge")
  );
  assert.equal(moved.path, store.path);
  assert.equal((await moved.read()).entries[0].id, saved.id);
  assert.equal((await moved.readProfile()).experiences[0].content, saved.content);
  for (const other of [
    { ...identity, projectId: "project-b" },
    { ...identity, projectCatalogPath: join(root, "other-catalog") }
  ]) {
    const isolated = new ProjectExperienceStore(other, join(root, "knowledge"));
    assert.notEqual(isolated.path, store.path);
    assert.equal((await isolated.read()).entries.length, 0);
  }
  assert.equal((await listProjectExperienceIdentities(join(root, "knowledge"))).length, 1);
  assert.equal(projectExperienceIdentity({ kind: "workspace", ...identity }), undefined);
  assert.equal(projectExperienceIdentity({ temporaryWorkspaceRoot: root, ...identity }), undefined);
  assert.equal(projectExperienceIdentity(identity, "/wrong").projectDirectory, identity.projectDirectory);
});

test("manual entries are active and pinned, private on disk, and use optimistic revisions", async (t) => {
  const { store } = await fixture(t);
  const entry = await store.save(manual(), 0);
  assert.equal(entry.state, "active");
  assert.equal(entry.pinned, true);
  assert.equal(entry.origin, "manual");
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  await assert.rejects(
    store.save({ ...manual(), id: entry.id, revision: entry.revision + 1 }),
    ProjectExperienceConflictError
  );
  await assert.rejects(store.save(manual("skill"), 0), ProjectExperienceConflictError);
  const doc = await store.read();
  await assert.rejects(store.configure({ enabled: true }, doc.revision - 1), ProjectExperienceConflictError);
  assert.equal((await store.read()).entries.length, 1);
});

test("project experience and skill budgets reject whole mutations without losing saved data", async (t) => {
  const { store } = await fixture(t);
  for (let index = 0; index < 40; index++) await store.save({ ...manual(), title: `Experience ${index}` });
  await assert.rejects(store.save(manual()), ProjectExperienceCapacityError);
  await assert.rejects(
    store.save({ ...manual(), content: "x".repeat(1001) }),
    ProjectExperienceCapacityError
  );
  for (let index = 0; index < 20; index++) await store.save({ ...manual("skill"), title: `Skill ${index}` });
  await assert.rejects(store.save(manual("skill")), ProjectExperienceCapacityError);
  await assert.rejects(store.save({ ...manual("skill"), content: "x".repeat(6001) }));
  assert.equal((await store.read()).entries.length, 60);
});

test("automatic activation requires three independently verified Tasks; replays do not add support", async (t) => {
  const { store } = await fixture(t);
  const generation = await configure(store);
  assert.equal(await submit(store, generation, "one"), 0);
  assert.equal(await submit(store, generation, "one"), 0);
  assert.equal((await store.read()).candidates[0].supportCount, 1);
  await submit(store, generation, "two", proposal(), false);
  await submit(store, generation, "three");
  assert.equal((await store.read()).entries.length, 0);
  assert.equal(await submit(store, generation, "four"), 1);
  const entry = (await store.read()).entries[0];
  assert.equal(entry.origin, "automatic");
  assert.equal(entry.pinned, false);
  assert.equal(entry.sources.filter((source) => source.verified).length, 3);
  assert.equal((await store.read()).candidates.length, 0);
});

test("candidates stay outside profile and may be manually accepted when automatic activation is off", async (t) => {
  const { store } = await fixture(t);
  const generation = await configure(store, false);
  for (const task of ["one", "two", "three"]) await submit(store, generation, task);
  assert.equal((await store.readProfile()).experiences.length, 0);
  const candidate = (await store.read()).candidates[0];
  const accepted = await store.setState(candidate.id, candidate.revision, "active");
  assert.equal(accepted.pinned, true);
  assert.equal((await store.readProfile()).experiences.length, 1);
});

test("skill publication is scoped to private generated paths and follows enable, disable, and deletion", async (t) => {
  const { store } = await fixture(t);
  const skill = await store.save(manual("skill", "1. Run the local fixture.\n2. Inspect its output."));
  assert.equal((await store.readProfile()).skills.length, 0);
  await store.configure({ enabled: true });
  let profile = await store.readProfile();
  const path = profile.skills[0].path;
  assert.ok(path.startsWith(store.directory));
  assert.match(await readFile(path, "utf8"), new RegExp(`name: learned-${skill.id}`));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  let current = await store.setState(skill.id, skill.revision, "disabled");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  current = await store.setState(current.id, current.revision, "active");
  await store.configure({ enabled: false });
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await store.configure({ enabled: true });
  profile = await new ProjectExperienceStore(store.identity, join(store.directory, "..")).readProfile();
  assert.equal(profile.skills.length, 1);
  await store.remove(current.id, current.revision);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("automatic evolution preserves versions; manual rollback pins and blocks further evolution", async (t) => {
  const { store } = await fixture(t);
  let generation = await configure(store);
  for (const task of ["a", "b", "c"]) await submit(store, generation, task);
  let entry = (await store.read()).entries[0];
  const update = proposal({
    id: entry.id,
    revision: entry.revision,
    content: "Use the revised migration fixture."
  });
  for (const task of ["d", "e", "f"]) await submit(store, generation, task, update);
  entry = (await store.read()).entries[0];
  assert.equal(entry.version, 2);
  assert.equal(entry.versions[0].content, manual().content);
  entry = await store.rollback(entry.id, entry.revision, 1);
  assert.equal(entry.version, 3);
  assert.equal(entry.content, manual().content);
  assert.equal(entry.pinned, true);
  generation = (await store.read()).generation;
  for (const task of ["g", "h", "i"])
    await submit(
      store,
      generation,
      task,
      proposal({ id: entry.id, revision: entry.revision, content: "An unwanted rewrite." })
    );
  assert.equal((await store.read()).entries[0].content, manual().content);
});

test("configuration pauses retain pending input while manual corrections invalidate old evidence and replays", async (t) => {
  const { store } = await fixture(t);
  const generation = await configure(store);
  await store.enqueueLearning(
    { taskId: "one", runId: "run-one", text: "a trusted run reference" },
    10,
    0,
    generation
  );
  await store.configure({ learningEnabled: false });
  assert.equal((await store.read()).pending.length, 1);
  assert.equal(await submit(store, generation, "old"), 0);
  await store.configure({ learningEnabled: true });
  await store.save(manual());
  assert.equal((await store.read()).pending.length, 0);
  await store.enqueueLearning({ taskId: "one", runId: "run-one", text: "a trusted run reference" });
  assert.equal((await store.read()).pending.length, 0);
});

test("commit guard and generation are rechecked while locked; aborted work neither consumes nor changes evidence", async (t) => {
  const { store } = await fixture(t);
  const generation = await configure(store);
  await store.enqueueLearning({ taskId: "one", runId: "run-one", text: "run reference" }, 0, 0);
  const job = (await store.read()).pending[0];
  assert.equal(
    await submit(store, generation, "one", proposal(), true, { jobId: job.id, isCurrent: async () => false }),
    0
  );
  assert.equal((await store.read()).pending.length, 1);
  assert.equal((await store.read()).candidates.length, 0);
  await store.configure({ autoActivate: false });
  assert.equal(await submit(store, generation, "one", proposal(), true, { jobId: job.id }), 0);
  assert.equal((await store.read()).pending.length, 1);
});

test("restart preserves queue, request quota, bounded provenance and safe rejection", async (t) => {
  const { store, root, identity } = await fixture(t);
  let generation = await configure(store, false);
  await assert.rejects(store.configure({ maxRequestsPerHour: 1 }));
  await store.configure({ maxRequestsPerHour: 2 });
  generation = (await store.read()).generation;
  assert.equal(await store.claimLearningRequest(1000, generation), true);
  const restarted = new ProjectExperienceStore(identity, join(root, "knowledge"));
  assert.equal(await restarted.claimLearningRequest(1001, generation), true);
  assert.equal(await restarted.claimLearningRequest(1002, generation), false);
  for (let index = 0; index < 35; index++)
    await restarted.enqueueLearning(
      { taskId: `task-${index}`, runId: `run-${index}`, text: "a run reference" },
      1000,
      0
    );
  assert.equal((await restarted.read()).pending.length, 30);
  await submit(restarted, generation, "one");
  const candidate = (await restarted.read()).candidates[0];
  await restarted.setState(candidate.id, candidate.revision, "rejected");
  generation = (await restarted.read()).generation;
  await submit(restarted, generation, "another");
  assert.equal((await restarted.read()).candidates.length, 0);
});

test("corrupt canonical knowledge fails closed without overwriting data or returning cached context", async (t) => {
  const { store } = await fixture(t);
  await store.save(manual());
  await store.configure({ enabled: true });
  assert.equal((await store.readProfile()).experiences.length, 1);
  await writeFile(store.path, "{broken", "utf8");
  await assert.rejects(store.readProfile(), /invalid/);
  await assert.rejects(store.save(manual()), /invalid/);
  assert.equal(await readFile(store.path, "utf8"), "{broken");
});

test("stale or deleted profile reconstructs only current active knowledge", async (t) => {
  const { store } = await fixture(t);
  const item = await store.save(manual());
  await store.configure({ enabled: true });
  const oldProfile = await readFile(join(store.directory, "profile.json"), "utf8");
  await store.remove(item.id, item.revision);
  await writeFile(join(store.directory, "profile.json"), oldProfile);
  const restarted = new ProjectExperienceStore(store.identity, join(store.directory, ".."));
  assert.equal((await restarted.readProfile()).experiences.length, 0);
  await rm(join(store.directory, "profile.json"));
  assert.equal(
    (await new ProjectExperienceStore(store.identity, join(store.directory, "..")).readProfile()).experiences
      .length,
    0
  );
});

test("concurrent stale edits serialize and leave exactly one complete new version", async (t) => {
  const { store, root, identity } = await fixture(t);
  const entry = await store.save(manual());
  const second = new ProjectExperienceStore(identity, join(root, "knowledge"));
  const results = await Promise.allSettled([
    store.save({
      ...manual("experience", "First complete revision."),
      id: entry.id,
      revision: entry.revision
    }),
    second.save({
      ...manual("experience", "Second complete revision."),
      id: entry.id,
      revision: entry.revision
    })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(
    results.find((result) => result.status === "rejected").reason instanceof ProjectExperienceConflictError
  );
  const current = (await store.read()).entries[0];
  assert.equal(current.version, 2);
  assert.ok(["First complete revision.", "Second complete revision."].includes(current.content));
});

test("version history is bounded and expired candidate evidence cannot count toward activation", async (t) => {
  const { store } = await fixture(t);
  let entry = await store.save(manual());
  for (let index = 0; index < 10; index++)
    entry = await store.save({
      ...manual("experience", `Revision ${index}`),
      id: entry.id,
      revision: entry.revision
    });
  assert.equal(entry.versions.length, 8);
  await assert.rejects(store.rollback(entry.id, entry.revision, 1), ProjectExperienceConflictError);
  const generation = await configure(store);
  await submit(store, generation, "one", proposal({ content: "A different automatic experience." }));
  await submit(store, generation, "two", proposal({ content: "A different automatic experience." }));
  const doc = await store.read();
  doc.candidates[0].updatedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
  await writeFile(store.path, JSON.stringify(doc));
  await submit(store, generation, "three", proposal({ content: "A different automatic experience." }));
  assert.equal((await store.read()).candidates[0].supportCount, 1);
  assert.equal((await store.read()).entries.length, 1);
});

test("rejecting a candidate remains possible when formal knowledge capacity is full", async (t) => {
  const { store } = await fixture(t);
  const generation = await configure(store);
  for (let index = 0; index < 40; index++) await store.save({ ...manual(), title: `Experience ${index}` });
  const currentGeneration = (await store.read()).generation;
  await submit(store, currentGeneration, "one", proposal({ content: "A new candidate awaiting review." }));
  const candidate = (await store.read()).candidates[0];
  const rejected = await store.setState(candidate.id, candidate.revision, "rejected");
  assert.equal(rejected.state, "rejected");
  assert.equal((await store.read()).candidates.length, 0);
  assert.notEqual(generation, currentGeneration);
});

test("clearing the learning model restores the connection default and invalidates in-flight work", async (t) => {
  const { store } = await fixture(t);
  await store.configure({ model: "dedicated-model" });
  const before = await store.read();
  await store.configure({ model: "" });
  const after = await store.read();
  assert.equal(after.learningOptions.model, undefined);
  assert.equal(after.generation, before.generation + 1);
});
