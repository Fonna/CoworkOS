import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceDirectory } from "../dist/src/dashboard/workspace-directory.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

test("a catalog read shares project assignments and does not rescan known tasks for application evidence", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "atria-catalog-performance-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = join(root, "workspace");
  const projectRoot = join(root, "project");
  await fs.mkdir(projectRoot);
  const directory = createWorkspaceDirectory(storage, join(root, "index.json"), () => "fixture");
  const project = await directory.createProject({ projectName: "Project", projectDirectory: projectRoot });
  const store = new LocalWorkspaceStore(storage);
  for (let index = 0; index < 57; index++)
    await store.createTask(`task-${index}`, {
      goal: `Task ${index}`,
      projectId: project.projectId,
      projectDirectory: projectRoot,
      projectCatalogPath: directory.projectCatalog.filePath
    });
  await directory.globalTaskPayload();

  const counts = { task: 0, project: 0 };
  const original = fs.readFile;
  fs.readFile = async (path, ...args) => {
    const name = String(path);
    if (name.startsWith(root)) {
      if (name.endsWith("/task.json")) counts.task++;
      if (name === directory.projectCatalog.filePath) counts.project++;
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  let payload;
  try {
    payload = await directory.globalTaskPayload();
  } finally {
    fs.readFile = original;
    syncBuiltinESMExports();
  }
  assert.equal(payload.tasks.length, 57);
  t.diagnostic(JSON.stringify(counts));
  assert.ok(counts.task <= 57, `each Task should be read once, observed ${counts.task}`);
  assert.ok(counts.project <= 3, `project assignments must share a snapshot, observed ${counts.project}`);

  await store.updateTask("task-0", { title: "Renamed outside the catalog read" });
  await store.createTask("later", {
    goal: "Fresh task",
    projectId: project.projectId,
    projectDirectory: projectRoot,
    projectCatalogPath: directory.projectCatalog.filePath
  });
  const next = await directory.globalTaskPayload();
  assert.equal(next.tasks.length, 58);
  assert.equal(next.tasks.find((task) => task.taskId === "task-0").title, "Renamed outside the catalog read");
});

test("a catalog read reloads a Task recovered by another process while waiting for its edit lock", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "atria-catalog-edit-recovery-"));
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (exited) await exited;
    await fs.rm(root, { recursive: true, force: true });
  });
  const storage = join(root, "workspace");
  const projectRoot = join(root, "project");
  await fs.mkdir(projectRoot);
  const directory = createWorkspaceDirectory(storage, join(root, "index.json"), () => "fixture");
  const project = await directory.createProject({ projectName: "Project", projectDirectory: projectRoot });
  const store = new LocalWorkspaceStore(storage);
  await store.createTask("task", {
    goal: "Original task",
    projectId: project.projectId,
    projectDirectory: projectRoot,
    projectCatalogPath: directory.projectCatalog.filePath
  });
  await store.transitionTask("task", "running", { runId: "old-run" });
  await store.transitionTask("task", "failed", { runId: "old-run" });

  const moduleUrl = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const transactionPath = join(storage, "task", "sessions", "main", "edit-transaction.json");
  child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { once } from "node:events";
        import { beginMessageEditTransaction, rollbackMessageEditTransaction } from ${moduleUrl("../dist/src/runtime/main-message-edit-transaction.js")};
        import { withFileLock } from ${moduleUrl("../dist/src/storage/file-lock.js")};
        import { LocalWorkspaceStore } from ${moduleUrl("../dist/src/workspace/workspace-store.js")};
        const root = ${JSON.stringify(storage)};
        await beginMessageEditTransaction(root, "task", "edit-run", {}, { editId: "edit", prompt: "Edited task" });
        await new LocalWorkspaceStore(root).transitionTask("task", "running", { runId: "edit-run" });
        await withFileLock(${JSON.stringify(transactionPath)}, async () => {
          process.send("locked");
          await once(process, "message");
          await rollbackMessageEditTransaction(root, "task");
        });
        process.disconnect();
      `
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  let errors = "";
  child.stderr.on("data", (bytes) => {
    errors += bytes;
  });
  exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const unexpectedExit = exited.then(({ code, signal }) => {
    throw new Error(`recovery process exited before release: ${code}/${signal}: ${errors}`);
  });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", resolve);
  });
  assert.equal(await Promise.race([ready, unexpectedExit]), "locked");

  let blocked;
  const waitingForLock = new Promise((resolve) => {
    blocked = resolve;
  });
  const originalMkdir = fs.mkdir;
  fs.mkdir = async (path, ...args) => {
    try {
      return await originalMkdir(path, ...args);
    } catch (error) {
      if (String(path) === `${transactionPath}.lock` && error.code === "EEXIST") blocked();
      throw error;
    }
  };
  syncBuiltinESMExports();
  let payload;
  try {
    const pending = directory.globalTaskPayload();
    await Promise.race([waitingForLock, unexpectedExit]);
    child.send("recover");
    payload = await pending;
  } finally {
    fs.mkdir = originalMkdir;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await exited, { code: 0, signal: null }, errors);
  const listed = payload.tasks.find((task) => task.taskId === "task");
  const recovered = await store.readTask("task");
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.activeRunId, "old-run");
  assert.equal(listed.status, recovered.status);
  assert.equal(listed.activeRunId, recovered.activeRunId);
  assert.equal(listed.version, recovered.version);
});
