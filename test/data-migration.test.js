import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { migrateLegacyDesktopData, importLegacyData } from "../scripts/data-migration.cjs";
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { desktopPaths } = require("../desktop/paths.cjs");
const { createModelSettings } = require("../desktop/model-settings.cjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-data-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "old"),
    home = join(root, "new");
  await mkdir(join(source, "workspace", "task", "sessions", "main", "pi"), { recursive: true });
  await mkdir(join(source, "workspace", "task", "agents", "main", "context"), { recursive: true });
  await mkdir(join(source, "runtime"));
  await mkdir(join(source, "pi-agent", "sessions", "project"), { recursive: true });
  await mkdir(join(source, "logs"));
  const task = { taskId: "task", status: "completed", projectDirectory: join(root, "external-project") };
  await writeFile(join(source, "workspace", "task", "task.json"), JSON.stringify(task));
  await writeFile(
    join(source, "runtime", "workspaces.json"),
    JSON.stringify({ version: 1, workspaces: [{ workspaceRoot: join(source, "workspace") }] })
  );
  await writeFile(join(source, "model-config.json"), '{"fixture":"encrypted-model-configuration"}');
  await writeFile(join(source, "logs", "backend.log"), "模型进程日志\n");
  const entries = [
    { type: "session", cwd: task.projectDirectory },
    {
      type: "custom",
      customType: "atria-cli-task",
      data: {
        workspaceRoot: join(source, "workspace"),
        sessionFile: join(source, "pi-agent", "sessions", "project", "session.jsonl")
      }
    },
    { type: "message", message: { role: "user", content: `Keep original history ${source}` } }
  ];
  await writeFile(
    join(source, "pi-agent", "sessions", "project", "session.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
  await writeFile(
    join(source, "workspace", "task", "agents", "main", "context", "messages.json"),
    JSON.stringify(entries)
  );
  return { root, source, home, task, entries };
}

test("first desktop start stages and copies legacy history without changing source or message contents", async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.source, "pi-agent", "sessions", "project", "session.jsonl"), "utf8");
  assert.equal((await migrateLegacyDesktopData(f)).status, "migrated");
  assert.equal(await readFile(join(f.home, "logs", "backend.log"), "utf8"), "模型进程日志\n");
  assert.equal(
    await readFile(join(f.source, "pi-agent", "sessions", "project", "session.jsonl"), "utf8"),
    original
  );
  const saved = (await readFile(join(f.home, "pi", "sessions", "project", "session.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(saved[1].data.workspaceRoot, join(f.home, "workspace"));
  assert.equal(saved[1].data.sessionFile, join(f.home, "pi", "sessions", "project", "session.jsonl"));
  assert.deepEqual(saved[2], f.entries[2]);
  assert.equal(
    JSON.parse(await readFile(join(f.home, "workspace", "task", "task.json"), "utf8")).projectDirectory,
    f.task.projectDirectory
  );
  assert.equal(
    JSON.parse(await readFile(join(f.home, "runtime", "workspaces.json"), "utf8")).workspaces[0]
      .workspaceRoot,
    join(f.home, "workspace")
  );
  assert.equal((await migrateLegacyDesktopData(f)).status, "completed");
  assert.ok(!(await readdir(f.home)).some((name) => name.startsWith(".legacy-stage-")));
});

test("project catalogs and pending updates relocate control paths while preserving project identity and external folders", async (t) => {
  const f = await fixture(t);
  const catalogPath = join(f.source, "runtime", "projects.json");
  const project = {
    projectId: "project_11111111-1111-1111-1111-111111111111",
    projectName: "Retained project",
    projectDirectory: f.task.projectDirectory,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const catalog = {
    version: 1,
    projects: [project],
    pending: {
      projectId: project.projectId,
      next: { ...project, projectDirectory: join(f.root, "external-next") },
      tasks: [{ taskId: "task", storageRoot: join(f.source, "workspace") }]
    }
  };
  await writeFile(catalogPath, JSON.stringify(catalog));
  await writeFile(
    join(f.source, "workspace", "task", "task.json"),
    JSON.stringify({
      ...f.task,
      projectId: project.projectId,
      projectCatalogPath: catalogPath
    })
  );
  assert.equal((await migrateLegacyDesktopData(f)).status, "migrated");
  const task = JSON.parse(await readFile(join(f.home, "workspace", "task", "task.json"), "utf8"));
  assert.equal(task.projectCatalogPath, join(f.home, "runtime", "projects.json"));
  assert.equal(task.projectId, project.projectId);
  const moved = JSON.parse(await readFile(join(f.home, "runtime", "projects.json"), "utf8"));
  assert.deepEqual(moved.projects, [project]);
  assert.equal(moved.pending.next.projectDirectory, catalog.pending.next.projectDirectory);
  assert.equal(moved.pending.tasks[0].storageRoot, join(f.home, "workspace"));
  assert.deepEqual(JSON.parse(await readFile(catalogPath, "utf8")), catalog);
});

test("an existing CLI home is preserved and explicit imports remain separate, discoverable and conflict-safe", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, "workspace"), { recursive: true });
  await writeFile(join(f.home, "workspace", "keep.txt"), "existing user history");
  assert.equal((await migrateLegacyDesktopData(f)).status, "available");
  const result = await importLegacyData({ ...f, name: "old-app" });
  assert.equal(result.workspaceRoot, join(f.home, "imports", "old-app", "workspace"));
  assert.ok(result.catalogRoots.includes(result.workspaceRoot));
  assert.equal(await readFile(join(f.home, "workspace", "keep.txt"), "utf8"), "existing user history");
  assert.equal(await readFile(join(f.source, "logs", "backend.log"), "utf8"), "模型进程日志\n");
  await assert.rejects(importLegacyData({ ...f, name: "old-app" }), /未覆盖/);
  await assert.rejects(importLegacyData({ ...f, name: ".." }), /安全目录名/);
});

test("failed or live-source migrations preserve all data and can be retried", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, "runtime", "workspaces.json"), '{"version":99}');
  await assert.rejects(migrateLegacyDesktopData(f), /不兼容/);
  await assert.rejects(readFile(join(f.home, "workspace", "task", "task.json")), { code: "ENOENT" });
  await writeFile(join(f.source, "runtime", "workspaces.json"), '{"version":1,"workspaces":[]}');
  if (process.platform !== "win32") {
    await symlink(`${hostname()}-${process.pid}`, join(f.source, "SingletonLock"));
    await assert.rejects(migrateLegacyDesktopData(f), /退出旧版/);
    await rm(join(f.source, "SingletonLock"));
  }
  assert.equal((await migrateLegacyDesktopData(f)).status, "migrated");
});

test("a partially committed migration resumes, and a new destination conflict is never overwritten", async (t) => {
  const f = await fixture(t);
  await mkdir(f.home);
  const stage = join(f.home, ".legacy-stage-fixture");
  await mkdir(stage);
  await writeFile(join(stage, "model-config.json"), "staged model");
  await mkdir(join(f.home, "workspace")); // Committed just before a simulated crash.
  const state = {
    version: 1,
    source: f.source,
    stage,
    entries: ["workspace", "model-config.json"],
    committed: [],
    status: "pending"
  };
  await writeFile(join(f.home, ".legacy-migration.json"), JSON.stringify(state));
  await writeFile(join(f.home, "model-config.json"), "another process's configuration");
  await assert.rejects(migrateLegacyDesktopData(f), /未覆盖/);
  assert.equal(await readFile(join(f.home, "model-config.json"), "utf8"), "another process's configuration");
  await rm(join(f.home, "model-config.json"));
  assert.equal((await migrateLegacyDesktopData(f)).status, "migrated");
  assert.equal(await readFile(join(f.home, "model-config.json"), "utf8"), "staged model");
});

test("the CLI imports source workspace data and registers history inside its selected ATRIA_HOME", async (t) => {
  const f = await fixture(t);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(key))
  );
  env.ATRIA_HOME = f.home;
  const result = await exec(
    process.execPath,
    [
      resolve("scripts/atria.mjs"),
      "data",
      "import",
      "--from",
      join(f.source, "workspace"),
      "--kind",
      "workspace",
      "--name",
      "source-checkout"
    ],
    { env, cwd: f.root }
  );
  assert.match(result.stdout, /原始目录已保留/);
  const catalog = JSON.parse(await readFile(join(f.home, "runtime", "workspaces.json"), "utf8"));
  assert.ok(
    catalog.workspaces.some(
      (entry) => entry.workspaceRoot === join(f.home, "imports", "source-checkout", "workspace")
    )
  );
  const paths = await exec(process.execPath, [resolve("scripts/atria.mjs"), "data", "paths"], {
    env,
    cwd: f.root
  });
  assert.equal(JSON.parse(paths.stdout).workspaceRoot, join(f.home, "workspace"));
});

test("damaged migration markers cannot move, overwrite or remove unrelated files", async (t) => {
  const f = await fixture(t);
  await mkdir(f.home);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "unrelated user data");
  const state = {
    version: 1,
    source: f.source,
    stage: join(f.home, ".legacy-stage-safe"),
    entries: ["workspace"],
    committed: [],
    status: "pending"
  };
  for (const corrupt of [
    { version: 2 },
    { status: "unknown" },
    { entries: ["../outside"] },
    { committed: ["model-config.json"] },
    { stage: outside },
    { stage: join(f.home, ".legacy-stage-safe", "..", "..", "outside") },
    { entries: [] }
  ]) {
    await writeFile(join(f.home, ".legacy-migration.json"), JSON.stringify({ ...state, ...corrupt }));
    await assert.rejects(migrateLegacyDesktopData(f), /状态记录损坏/);
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "unrelated user data");
  }
  if (process.platform !== "win32") {
    await symlink(outside, state.stage);
    await writeFile(join(f.home, ".legacy-migration.json"), JSON.stringify(state));
    await assert.rejects(migrateLegacyDesktopData(f), /暂存目录无效/);
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "unrelated user data");
  }
});

test("abandoned ownerless locks recover after a TTL while a live migration lock is never removed", async (t) => {
  const f = await fixture(t);
  const lock = join(f.home, ".data-migration.lock");
  await mkdir(lock, { recursive: true });
  const old = new Date(Date.now() - 11 * 60_000);
  await utimes(lock, old, old);
  assert.equal((await migrateLegacyDesktopData(f)).status, "migrated");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  await utimes(lock, old, old);
  await assert.rejects(migrateLegacyDesktopData(f), /正在迁移/);
  assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).pid, process.pid);
});

test("a copied legacy development key can be replaced without changing its retained original ciphertext", async (t) => {
  const f = await fixture(t);
  const originalConfig = JSON.stringify({ baseUrl: "https://example.test/v1", model: "fixture" });
  await writeFile(join(f.source, "model-config.json"), originalConfig);
  await writeFile(join(f.source, "model-secret.bin"), "old-development-encrypted-fixture");
  await migrateLegacyDesktopData(f);
  const secure = {
    isEncryptionAvailable: () => true,
    decryptString: (bytes) => {
      if (!String(bytes).startsWith("atria-encrypted:")) throw new Error("old identity cannot decrypt");
      return String(bytes).slice("atria-encrypted:".length);
    },
    encryptString: (value) => Buffer.from(`atria-encrypted:${value}`)
  };
  const settings = createModelSettings(desktopPaths("/install", f.home, {}), secure);
  assert.equal((await settings.read({ allowUnavailableSecret: true })).apiKey, undefined);
  assert.equal(await readFile(join(f.home, "model-secret.bin"), "utf8"), "old-development-encrypted-fixture");
  await settings.save({
    baseUrl: "https://example.test/v1",
    model: "fixture",
    apiKey: "replacement-fixture"
  });
  assert.equal((await settings.read()).apiKey, "replacement-fixture");
  assert.equal(await readFile(join(f.source, "model-config.json"), "utf8"), originalConfig);
  assert.equal(
    await readFile(join(f.source, "model-secret.bin"), "utf8"),
    "old-development-encrypted-fixture"
  );
});
