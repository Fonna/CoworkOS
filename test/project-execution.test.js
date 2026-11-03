import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beginProjectExecution, projectExecutionIsAlive } from "../dist/src/workspace/project-execution.js";
import { withFileLock } from "../dist/src/storage/file-lock.js";

test("project execution leases protect startup, release ownership and reject duplicate launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-project-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await projectExecutionIsAlive(root, "task"), false);
  const lease = await beginProjectExecution(root, "task");
  assert.equal(await projectExecutionIsAlive(root, "task"), true);
  await assert.rejects(beginProjectExecution(root, "task"), /已在运行/);
  await lease.refresh();
  await lease.release();
  assert.equal(await projectExecutionIsAlive(root, "task"), false);
  const replacement = await beginProjectExecution(root, "task");
  await lease.release();
  assert.equal(
    await projectExecutionIsAlive(root, "task"),
    true,
    "an old owner cannot release a newer lease"
  );
  await replacement.release();
  await assert.rejects(beginProjectExecution(root, "../escape"), /invalid task ID/);
});

test("stale launch leases can recover while malformed records are preserved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-project-lease-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = await beginProjectExecution(root, "task");
  const path = join(root, "task", "agents", "main", "project-execution.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...value, updatedAt: new Date(0).toISOString() }));
  assert.equal(await projectExecutionIsAlive(root, "task"), false);
  const replacement = await beginProjectExecution(root, "task");
  await initial.refresh();
  await initial.release();
  assert.equal(await projectExecutionIsAlive(root, "task"), true);
  await replacement.release();
  await writeFile(path, "{damaged");
  await assert.rejects(projectExecutionIsAlive(root, "task"), SyntaxError);
  await assert.rejects(beginProjectExecution(root, "task"), SyntaxError);
  assert.equal(await readFile(path, "utf8"), "{damaged");
});

test(
  "SIGKILL during lease acquisition releases the nested lock for the next launch",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-project-lease-crash-"));
    const path = join(root, "task", "agents", "main", "project-execution.json");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const writeFile = fs.writeFile;
    fs.writeFile = async (path, ...args) => {
      if (String(path).includes('project-execution.json.tmp-')) {
        console.log('LOCK_HELD');
        await new Promise(() => setInterval(() => {}, 1000));
      }
      return writeFile(path, ...args);
    };
    syncBuiltinESMExports();
    const { beginProjectExecution } = await import(${JSON.stringify(new URL("../dist/src/workspace/project-execution.js", import.meta.url).href)});
    await beginProjectExecution(${JSON.stringify(root)}, 'task');
  `
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    let output = "",
      errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    await new Promise((done, fail) => {
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("LOCK_HELD")) done();
      });
      child.once("error", fail);
      child.once("exit", (code) => {
        if (!output.includes("LOCK_HELD")) fail(new Error(`lease holder exited ${code}: ${errors}`));
      });
    });
    const ownerPath = `${path}.lock/owner.json`;
    const ownerBefore = await readFile(ownerPath, "utf8");
    const owner = JSON.parse(ownerBefore);
    assert.equal(owner.pid, child.pid);
    assert.equal(owner.host, hostname());
    await assert.rejects(
      withFileLock(path, async () => assert.fail("live lease lock must stay owned"), {
        recoverDeadOwner: true,
        staleMs: 0,
        retryMs: 5,
        timeoutMs: 80
      }),
      /timed out acquiring file lock/
    );
    assert.equal(await readFile(ownerPath, "utf8"), ownerBefore);
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    const replacement = await beginProjectExecution(root, "task");
    assert.equal(await projectExecutionIsAlive(root, "task"), true);
    await replacement.refresh();
    await replacement.release();
    assert.equal(await projectExecutionIsAlive(root, "task"), false);
  }
);
