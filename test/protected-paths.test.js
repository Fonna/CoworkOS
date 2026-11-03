import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { resolveFileTarget, resolveProtectedTarget } from "../dist/src/tools/file-path.js";
import {
  ProtectedPaths,
  configuredProtectedPaths,
  projectWritesEnabled,
  guessedProtection,
  atriaInstallRoot,
  DEFAULT_PROTECTED_PATHS
} from "../dist/src/tools/protected-paths.js";

async function project(t) {
  // Resolve symlinks: on macOS /var is /private/var, and `pwd` reports the real path.
  const base = await realpath(await mkdtemp(join(tmpdir(), "atria-guard-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  // The agent's workspace sits outside the project, as it does in a real run.
  const workDir = join(base, "workspace", "agent");
  await mkdir(join(root, "pipeline"), { recursive: true });
  await mkdir(join(root, "eval"), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(root, "pipeline", "synth.py"), "# synthesis\n");
  await writeFile(join(root, "eval", "score.py"), "# the referee\n");
  return { root, workDir };
}

// Capabilities are granted per Task, so a test that exercises project edits
// grants them the way the extension does after the user agrees.
const GRANTED = {
  projectWrite: true,
  shell: true,
  evalPaths: [],
  longRunning: false,
  maxAttempts: 3,
  source: "task"
};

function toolsFor(root, workDir, overrides = {}) {
  return createBuiltinTools({
    rootDirectory: workDir,
    projectDirectory: root,
    capabilities: GRANTED,
    ...overrides
  });
}

test("the guard protects the referee and version control, but not the project's own code", async (t) => {
  const { root } = await project(t);
  const guard = new ProtectedPaths({ root });
  for (const path of ["eval/score.py", "benchmarks/run.sh", "tests/fixtures/a.json", ".git/config"]) {
    assert.ok(guard.match(join(root, path)), `${path} must be protected`);
  }
  // The patterns resolve against the user's project, so a project that happens
  // to keep its code in src/ must not find it locked: that is what the agent
  // is here to change.
  for (const path of [
    "pipeline/synth.py",
    "configs/data.yaml",
    "train.py",
    "src/synth/mix.py",
    "dist/bundle.js",
    "README.md"
  ]) {
    assert.equal(guard.match(join(root, path)), undefined, `${path} must stay writable`);
  }
  // A name that merely starts with a protected one is a different path.
  assert.equal(guard.match(join(root, "evaluation_notes.md")), undefined);
  assert.ok(guard.match(join(root, "evaluation/notes.md")));
  // Paths outside the guarded root are some other check's business.
  assert.equal(guard.match("/tmp/elsewhere/file.txt"), undefined);
});

test("the harness install is protected by absolute path, wherever it sits", async (t) => {
  const { root } = await project(t);
  const install = "/opt/atria";
  const guard = new ProtectedPaths({ root, protectedRoots: [install] });
  // An agent improving a pipeline must not edit the runtime that records
  // whether the pipeline improved — including from outside the project.
  assert.equal(guard.match("/opt/atria/src/runtime/experiment-program-store.ts"), install);
  assert.equal(guard.match("/opt/atria/.pi/extensions/cowork.ts"), install);
  assert.equal(
    guard.match(join(root, "src/synth/mix.py")),
    undefined,
    "the project's own src/ is untouched by this"
  );

  // Emptying the project patterns is allowed; the runtime stays protected.
  const opened = configuredProtectedPaths(root, { COWORK_PROTECTED_PATHS: "" }, [install]);
  assert.equal(opened.match(join(root, "eval/score.py")), undefined);
  assert.equal(
    opened.match("/opt/atria/src/x.ts"),
    install,
    "the recorder is never a legitimate target of what it records"
  );
});

test("atriaInstallRoot points at the harness, not at dist", () => {
  const root = atriaInstallRoot();
  assert.ok(existsSync(join(root, "package.json")), `${root} should be the install root`);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name, "coworkos");
});

test("an agent can edit the pipeline it is optimizing but not the scorer", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);

  await tools.get("write_file").execute({ path: "pipeline/synth.py", content: "# revised synthesis\n" });
  assert.equal(await readFile(join(root, "pipeline", "synth.py"), "utf8"), "# revised synthesis\n");

  await assert.rejects(
    () => tools.get("write_file").execute({ path: "eval/score.py", content: "def score(*_): return 100\n" }),
    /read-only for agents.*protected by "eval\/"/s,
    "an agent optimizing a score must not be able to edit the scorer"
  );
  assert.equal(await readFile(join(root, "eval", "score.py"), "utf8"), "# the referee\n");
});

test("apply_patch is guarded on the same paths as write_file", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);
  await assert.rejects(
    () =>
      tools
        .get("apply_patch")
        .execute({ path: "eval/score.py", oldText: "# the referee", newText: "# tampered" }),
    /read-only for agents/
  );
});

test("reading a protected path is allowed; only writing is refused", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);
  // Understanding how it is scored is legitimate and necessary work.
  const read = await tools.get("read_file").execute({ path: "eval/score.py" });
  assert.match(read.content, /the referee/);
});

test("without project writes an agent stays in its own directory", async (t) => {
  const { root, workDir } = await project(t);
  const tools = createBuiltinTools({ rootDirectory: workDir, projectDirectory: root });

  // A relative path is its own private path, not a route into the project.
  await tools.get("write_file").execute({ path: "pipeline/synth.py", content: "copy\n" });
  assert.equal(await readFile(join(workDir, "pipeline", "synth.py"), "utf8"), "copy\n");
  assert.equal(
    await readFile(join(root, "pipeline", "synth.py"), "utf8"),
    "# synthesis\n",
    "the project is untouched"
  );

  await assert.rejects(
    () => tools.get("write_file").execute({ path: "../../project/eval/score.py", content: "x" }),
    /escapes workspace/
  );
});

test("the environment preset can grant project writes for a preconfigured run", () => {
  // The normal path is a Task grant. This exists for a run configured ahead of
  // time — a benchmark harness, an unattended job — and is off unless set.
  assert.equal(projectWritesEnabled({}), false, "an ordinary task gets the sandbox");
  assert.equal(projectWritesEnabled({ COWORK_PROJECT_WRITE: "1" }), true);
  assert.equal(projectWritesEnabled({ COWORK_PROJECT_WRITE: "0" }), false);
  assert.equal(projectWritesEnabled({ COWORK_PROJECT_WRITE: "false" }), false);
});

test("the protected set is configurable, and can be emptied deliberately", () => {
  const root = "/project";
  assert.ok(configuredProtectedPaths(root, {}).match("/project/eval/x.py"), "defaults apply when unset");

  const custom = configuredProtectedPaths(root, { COWORK_PROTECTED_PATHS: "scoring/, golden.json" });
  assert.ok(custom.match("/project/scoring/run.py"));
  assert.ok(custom.match("/project/golden.json"));
  assert.equal(
    custom.match("/project/eval/x.py"),
    undefined,
    "an override replaces the defaults rather than adding to them"
  );

  assert.equal(
    configuredProtectedPaths(root, { COWORK_PROTECTED_PATHS: "" }).match("/project/eval/x.py"),
    undefined,
    "the guard can be turned off, but only by saying so"
  );
});

test("the refusal names the path, the pattern and what to do instead", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);
  const error = await tools
    .get("write_file")
    .execute({ path: "eval/score.py", content: "x" })
    .catch((caught) => caught);
  assert.match(error.message, /eval\/score\.py/);
  assert.match(error.message, /protected by "eval\/"/);
  assert.match(error.message, /COWORK_PROTECTED_PATHS/, "the refusal says how the user can change it");
});

test("commands run in the project and get a shell when project writes are on", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);

  const cwd = await tools.get("run_command").execute({ command: "pwd" });
  assert.equal(cwd.stdout.trim(), root, "work happens where the pipeline lives");

  // Pipes, redirection and backgrounding are how a pipeline is actually driven.
  const piped = await tools.get("run_command").execute({ command: "echo hello | tr a-z A-Z" });
  assert.equal(piped.stdout.trim(), "HELLO");
  await tools.get("run_command").execute({ command: "echo logged > run.log 2>&1" });
  assert.equal((await readFile(join(root, "run.log"), "utf8")).trim(), "logged");

  const explicit = await tools.get("run_command").execute({ command: "pwd", cwd: "pipeline" });
  assert.equal(explicit.stdout.trim(), join(root, "pipeline"));
});

test("without project writes commands stay in the working directory and get no shell", async (t) => {
  const { root, workDir } = await project(t);
  const tools = createBuiltinTools({ rootDirectory: workDir, projectDirectory: root });
  const cwd = await tools.get("run_command").execute({ command: "pwd" });
  assert.equal(cwd.stdout.trim(), workDir);
  // No shell: the pipe is an argument, not an operator.
  const piped = await tools.get("run_command").execute({ command: "echo", args: ["a | b"] });
  assert.equal(piped.stdout.trim(), "a | b");
});

test("a command cwd cannot escape to somewhere writes could not reach", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);
  await assert.rejects(
    () => tools.get("run_command").execute({ command: "pwd", cwd: "../../../etc" }),
    /escapes workspace/
  );
  await assert.rejects(
    () => tools.get("run_command").execute({ command: "pwd", cwd: "/etc" }),
    /must be relative/
  );
});

test("the guard stops tool writes, not a process that goes around it", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);

  // This is the documented limit, asserted so it cannot be mistaken for a
  // sandbox. Enforcing it against a spawned process needs filesystem
  // permissions, not a check in the tool layer.
  await tools
    .get("run_command")
    .execute({ command: `printf 'bypassed' > ${join(root, "eval", "score.py")}` });
  assert.equal(
    await readFile(join(root, "eval", "score.py"), "utf8"),
    "bypassed",
    "a shell command can still reach a protected path: real isolation must come from the filesystem"
  );
});

test("COWORK_EVAL_PATHS protects the scorer wherever the user actually keeps it", () => {
  const root = "/proj";
  // The layouts the guessed fallback misses — which is most of them.
  const declared = configuredProtectedPaths(root, {
    COWORK_EVAL_PATHS: "src/eval/, scripts/evaluate.py, data/test.jsonl"
  });
  assert.ok(declared.match("/proj/src/eval/scorer.py"));
  assert.ok(declared.match("/proj/scripts/evaluate.py"));
  assert.ok(declared.match("/proj/data/test.jsonl"));
  // Declaring eval paths does not lock the rest of the project.
  assert.equal(declared.match("/proj/src/synth/mix.py"), undefined);
  assert.equal(declared.match("/proj/data/train.jsonl"), undefined);
  // It is additive: the conventional names stay protected too.
  assert.ok(declared.match("/proj/eval/run.py"));
  assert.ok(declared.match("/proj/.git/config"));
});

test("a declared eval path cannot be unprotected by clearing the fallback", () => {
  const root = "/proj";
  const guard = configuredProtectedPaths(
    root,
    { COWORK_EVAL_PATHS: "scoring/", COWORK_PROTECTED_PATHS: "" },
    ["/opt/atria"]
  );
  assert.ok(guard.match("/proj/scoring/run.py"), "the referee stays the referee");
  assert.equal(guard.match("/proj/eval/run.py"), undefined, "but the guessed fallback is gone as asked");
  assert.equal(guard.match("/opt/atria/src/x.ts"), "/opt/atria");
});

test("guessedProtection reports when only the fallback is in effect", () => {
  // This drives the startup warning: a guess that misses is invisible until
  // the recorded results are already worthless.
  assert.equal(guessedProtection({}), true);
  assert.equal(
    guessedProtection({ COWORK_PROTECTED_PATHS: "eval/" }),
    true,
    "overriding the guess is still a guess"
  );
  assert.equal(guessedProtection({ COWORK_EVAL_PATHS: "src/eval/" }), false);
  assert.equal(guessedProtection({ COWORK_EVAL_PATHS: "  " }), true, "blank is not a declaration");
});

test("an agent cannot edit a declared scorer that sits inside the code it is changing", async (t) => {
  const { root, workDir } = await project(t);
  await mkdir(join(root, "src", "eval"), { recursive: true });
  await mkdir(join(root, "src", "synth"), { recursive: true });
  await writeFile(join(root, "src", "eval", "scorer.py"), "# 裁判\n");
  await writeFile(join(root, "src", "synth", "mix.py"), "# v1\n");

  const tools = createBuiltinTools({
    rootDirectory: workDir,
    projectDirectory: root,
    capabilities: { ...GRANTED, evalPaths: ["src/eval/"] }
  });
  // Same parent directory, opposite permissions: the distinction is what the
  // path is for, not where it sits.
  await tools.get("write_file").execute({ path: "src/synth/mix.py", content: "# v2\n" });
  assert.match(await readFile(join(root, "src", "synth", "mix.py"), "utf8"), /v2/);
  await assert.rejects(
    () =>
      tools.get("write_file").execute({ path: "src/eval/scorer.py", content: "def score(*_): return 100\n" }),
    /read-only for agents/
  );
  assert.match(await readFile(join(root, "src", "eval", "scorer.py"), "utf8"), /裁判/);
});

test("the default set covers scoring inputs, not the project's own layout", () => {
  assert.ok(DEFAULT_PROTECTED_PATHS.includes("eval/"));
  assert.ok(DEFAULT_PROTECTED_PATHS.includes("benchmarks/"));
  assert.ok(DEFAULT_PROTECTED_PATHS.includes(".git/"));
  // src/ and dist/ belong to the project being optimized; the harness's own
  // copies are protected by absolute path instead.
  assert.ok(!DEFAULT_PROTECTED_PATHS.includes("src/"));
  assert.ok(!DEFAULT_PROTECTED_PATHS.includes("dist/"));
});

test("a relative path resolves to the root that actually holds the file", async (t) => {
  const { root, workDir } = await project(t);
  const tools = toolsFor(root, workDir);

  // Existing project file: editing it means the project's copy.
  await tools
    .get("apply_patch")
    .execute({ path: "pipeline/synth.py", oldText: "# synthesis", newText: "# edited in project" });
  assert.match(await readFile(join(root, "pipeline", "synth.py"), "utf8"), /edited in project/);

  // An existing private file keeps resolving privately even when the project
  // has the same relative path.
  await mkdir(join(workDir, "pipeline"), { recursive: true });
  await writeFile(join(workDir, "pipeline", "local.py"), "mine\n");
  await writeFile(join(root, "pipeline", "local.py"), "theirs\n");
  const read = await tools.get("read_file").execute({ path: "pipeline/local.py" });
  assert.equal(read.content, "mine\n", "an agent's own file is not shadowed by the project");

  // Scratch space stays the agent's own even for new files.
  await tools.get("write_file").execute({ path: "work/notes.md", content: "draft\n" });
  assert.equal(await readFile(join(workDir, "work", "notes.md"), "utf8"), "draft\n");

  // Any other new file lands in the project, which is where the work is.
  await tools.get("write_file").execute({ path: "pipeline/filter.py", content: "new stage\n" });
  assert.equal(await readFile(join(root, "pipeline", "filter.py"), "utf8"), "new stage\n");
});

test("linked parents cannot read or write outside the permitted roots, including new files", async (t) => {
  const { root, workDir } = await project(t);
  const outside = join(root, "..", "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel.txt"), "untouched");
  await symlink(outside, join(workDir, "shortcut"), "dir");
  await symlink(outside, join(root, "shortcut"), "dir");
  const tools = toolsFor(root, workDir, {
    protectedPaths: new ProtectedPaths({ root, protectedRoots: [outside] })
  });
  for (const [name, input] of [
    ["read_file", { path: "shortcut/sentinel.txt" }],
    ["write_file", { path: "shortcut/sentinel.txt", content: "changed" }],
    ["apply_patch", { path: "shortcut/sentinel.txt", oldText: "untouched", newText: "changed" }],
    ["write_file", { path: "shortcut/new/file.txt", content: "new" }],
    ["run_command", { command: "pwd", cwd: "shortcut" }]
  ]) {
    await assert.rejects(() => tools.get(name).execute(input), /escapes workspace through symbolic links/);
  }
  assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "untouched");
  assert.equal(existsSync(join(outside, "new")), false);
});

test("aliases inside a project preserve protection of evaluation and framework state", async (t) => {
  const { root, workDir } = await project(t);
  await symlink(join(root, "eval"), join(root, "score-alias"), "dir");
  await mkdir(join(workDir, "context"));
  await writeFile(join(workDir, "context", "messages.json"), "original-state");
  await symlink(join(workDir, "context", "messages.json"), join(workDir, "state-alias.json"));
  const tools = toolsFor(root, workDir);
  for (const path of ["score-alias/score.py", "score-alias/new/result.txt", "state-alias.json"]) {
    await assert.rejects(
      () => tools.get("write_file").execute({ path, content: "changed" }),
      /read-only|framework-managed/
    );
  }
  assert.equal(await readFile(join(root, "eval", "score.py"), "utf8"), "# the referee\n");
  assert.equal(existsSync(join(root, "eval", "new")), false);
  assert.equal(await readFile(join(workDir, "context", "messages.json"), "utf8"), "original-state");
});

test("ordinary in-root links remain usable and configured root aliases retain their protections", async (t) => {
  const { root, workDir } = await project(t);
  const rootAlias = join(root, "..", "project-alias");
  await symlink(root, rootAlias, "dir");
  await symlink(join(root, "pipeline"), join(root, "source"), "dir");
  const tools = toolsFor(rootAlias, workDir);
  await tools.get("write_file").execute({ path: "source/new.txt", content: "v1" });
  await tools.get("apply_patch").execute({ path: "source/new.txt", oldText: "v1", newText: "v2" });
  assert.equal((await tools.get("read_file").execute({ path: "source/new.txt" })).content, "v2");
  assert.equal(await readFile(join(root, "pipeline", "new.txt"), "utf8"), "v2");
  assert.equal((await lstat(join(root, "source"))).isSymbolicLink(), true);
  await assert.rejects(
    () => tools.get("write_file").execute({ path: "eval/score.py", content: "changed" }),
    /read-only/
  );
});

test("absolute protection covers legitimate '..' prefixed descendants and their aliases", async (t) => {
  const { root, workDir } = await project(t);
  const locked = join(root, "locked");
  await mkdir(join(locked, "..cache"), { recursive: true });
  await writeFile(join(locked, "..cache", "sentinel.txt"), "original");
  await symlink(locked, join(workDir, "linked-locked"), "dir");
  const guard = new ProtectedPaths({ root, patterns: [], protectedRoots: [locked] });
  assert.equal(guard.match(join(locked, "..cache", "sentinel.txt")), locked);
  const tools = toolsFor(root, workDir, { protectedPaths: guard });
  for (const path of ["locked/..cache/sentinel.txt", "linked-locked/..cache/sentinel.txt"]) {
    assert.equal((await tools.get("read_file").execute({ path })).content, "original");
    await assert.rejects(() => tools.get("write_file").execute({ path, content: "changed" }), /read-only/);
    await assert.rejects(
      () => tools.get("apply_patch").execute({ path, oldText: "original", newText: "changed" }),
      /read-only/
    );
  }
  await assert.rejects(
    () => tools.get("write_file").execute({ path: "locked/..cache/new/result.txt", content: "changed" }),
    /read-only/
  );
  assert.equal(await readFile(join(locked, "..cache", "sentinel.txt"), "utf8"), "original");
  assert.equal(existsSync(join(locked, "..cache", "new")), false);
});

test("a dangling evaluation link permits ordinary code edits while protecting its future target", async (t) => {
  const { root, workDir } = await project(t);
  await rm(join(root, "eval"), { recursive: true });
  await symlink("future-scorer", join(root, "eval"), "dir");
  const tools = toolsFor(root, workDir, {
    protectedPaths: new ProtectedPaths({ root, patterns: ["eval/"] })
  });
  await tools.get("write_file").execute({ path: "pipeline/new.txt", content: "v1" });
  await tools.get("apply_patch").execute({ path: "pipeline/new.txt", oldText: "v1", newText: "v2" });
  assert.equal((await tools.get("read_file").execute({ path: "pipeline/new.txt" })).content, "v2");
  await assert.rejects(
    () => tools.get("write_file").execute({ path: "future-scorer/new/result.txt", content: "bad" }),
    /read-only/
  );
  assert.equal(existsSync(join(root, "future-scorer")), false);
  // A file operation still cannot create a directory through a dangling link.
  await assert.rejects(resolveFileTarget(join(root, "eval", "new.txt")), { code: "ENOENT" });
  await mkdir(join(root, "future-scorer"));
  await writeFile(join(root, "future-scorer", "score.py"), "original scorer");
  assert.equal(
    (await tools.get("read_file").execute({ path: "future-scorer/score.py" })).content,
    "original scorer"
  );
  await assert.rejects(
    () =>
      tools
        .get("apply_patch")
        .execute({ path: "future-scorer/score.py", oldText: "original", newText: "changed" }),
    /read-only/
  );
  assert.equal(await readFile(join(root, "future-scorer", "score.py"), "utf8"), "original scorer");
});

test("protected future targets follow a link before interpreting its '..' component", async (t) => {
  const { root, workDir } = await project(t);
  await rm(join(root, "eval"), { recursive: true });
  await mkdir(join(root, "real-parent", "child"), { recursive: true });
  await mkdir(join(root, "links"));
  await symlink(join(root, "real-parent", "child"), join(root, "links", "step"), "dir");
  await symlink("links/step/../future-scorer", join(root, "eval"), "dir");
  assert.equal(await resolveProtectedTarget(join(root, "eval")), join(root, "real-parent", "future-scorer"));
  const tools = toolsFor(root, workDir, {
    protectedPaths: new ProtectedPaths({ root, patterns: ["eval/"] })
  });
  await assert.rejects(
    () => tools.get("write_file").execute({ path: "real-parent/future-scorer/new.txt", content: "bad" }),
    /read-only/
  );
  assert.equal(existsSync(join(root, "real-parent", "future-scorer")), false);
  await tools.get("write_file").execute({ path: "links/future-scorer/new.txt", content: "ordinary code" });
  assert.equal(
    (await tools.get("read_file").execute({ path: "links/future-scorer/new.txt" })).content,
    "ordinary code"
  );
});

test("protected target resolution bounds link chains and ordinary files still reject cycles", async (t) => {
  const { root } = await project(t);
  for (let index = 0; index < 40; index += 1)
    await symlink(index === 39 ? "future" : `link-${index + 1}`, join(root, `link-${index}`));
  assert.equal(await resolveProtectedTarget(join(root, "link-0")), join(root, "future"));
  await symlink("link-0", join(root, "too-long"));
  await assert.rejects(resolveProtectedTarget(join(root, "too-long")), /too many symbolic links/);
  await symlink("cycle-b", join(root, "cycle-a"));
  await symlink("cycle-a", join(root, "cycle-b"));
  await assert.rejects(resolveProtectedTarget(join(root, "cycle-a")), /too many symbolic links/);
  await assert.rejects(resolveFileTarget(join(root, "cycle-a")), { code: "ELOOP" });
});
