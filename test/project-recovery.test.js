import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GlobalProjectCatalog } from "../dist/src/workspace/project-catalog.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { withFileLock } from "../dist/src/storage/file-lock.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-project-crash-"));
  const storageRoot = join(root, "workspace"),
    first = join(root, "first"),
    second = join(root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const catalog = new GlobalProjectCatalog(join(root, "runtime", "projects.json"));
  const project = await catalog.create({ projectName: "Crash recovery", projectDirectory: first });
  const store = new LocalWorkspaceStore(storageRoot);
  for (const taskId of ["one", "two"])
    await store.createTask(taskId, {
      projectId: project.projectId,
      projectCatalogPath: catalog.filePath,
      projectDirectory: first
    });
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const spawnHolder = async (source) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.add(child);
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
        if (!output.includes("LOCK_HELD")) fail(new Error(`lock holder exited ${code}: ${errors}`));
      });
    });
    return child;
  };
  const hold = async (pending = false) =>
    spawnHolder(`
      import {readFile,writeFile} from 'node:fs/promises';
      import {GlobalProjectCatalog} from ${JSON.stringify(new URL("../dist/src/workspace/project-catalog.js", import.meta.url).href)};
      import {LocalWorkspaceStore} from ${JSON.stringify(new URL("../dist/src/workspace/workspace-store.js", import.meta.url).href)};
      const catalog = new GlobalProjectCatalog(${JSON.stringify(catalog.filePath)});
      await catalog.withProjectLock(${JSON.stringify(project.projectId)}, async () => {
        ${
          pending
            ? `
          const document = JSON.parse(await readFile(catalog.filePath,'utf8'));
          document.pending = {projectId:${JSON.stringify(project.projectId)},next:{...document.projects[0],projectDirectory:${JSON.stringify(second)}},tasks:[{storageRoot:${JSON.stringify(storageRoot)},taskId:'one'},{storageRoot:${JSON.stringify(storageRoot)},taskId:'two'}]};
          await writeFile(catalog.filePath,JSON.stringify(document));
          await new LocalWorkspaceStore(${JSON.stringify(storageRoot)}).updateTask('one',{projectDirectory:${JSON.stringify(second)}});
        `
            : ""
        }
        console.log('LOCK_HELD');
        await new Promise(() => setInterval(() => {},1000));
      });
    `);
  const claimPath = `${catalog.filePath}.operation.lock/.dead-owner-recovery`;
  const holdRecoveryClaim = () =>
    spawnHolder(`
      import {mkdir,writeFile} from 'node:fs/promises';
      import {hostname} from 'node:os';
      import {randomUUID} from 'node:crypto';
      const claimPath = ${JSON.stringify(claimPath)};
      await mkdir(claimPath);
      const token = randomUUID();
      await writeFile(claimPath + '/' + token,token,{flag:'wx'});
      await writeFile(claimPath + '/owner.json',JSON.stringify({token,pid:process.pid,host:hostname()}),{flag:'wx'});
      console.log('LOCK_HELD');
      await new Promise(() => setInterval(() => {},1000));
    `);
  const holdTaskSnapshot = () =>
    spawnHolder(`
      import {readFile} from 'node:fs/promises';
      import {hostname} from 'node:os';
      import {GlobalProjectCatalog} from ${JSON.stringify(new URL("../dist/src/workspace/project-catalog.js", import.meta.url).href)};
      import {LocalWorkspaceStore} from ${JSON.stringify(new URL("../dist/src/workspace/workspace-store.js", import.meta.url).href)};
      const catalog = new GlobalProjectCatalog(${JSON.stringify(catalog.filePath)});
      const readTask = LocalWorkspaceStore.prototype.readTask;
      LocalWorkspaceStore.prototype.readTask = async function(taskId) {
        const current = await readTask.call(this,taskId);
        if(taskId === 'two') {
          const owner = JSON.parse(await readFile(${JSON.stringify(join(storageRoot, "two", "task.json.lock", "owner.json"))},'utf8'));
          if(owner.pid !== process.pid || owner.host !== hostname()) throw new Error('snapshot must hold a recoverable task lock');
          console.log('LOCK_HELD');
          await new Promise(() => setInterval(() => {},1000));
        }
        return current;
      };
      await catalog.update(
        ${JSON.stringify(project.projectId)},
        {projectDirectory:${JSON.stringify(second)}},
        async (_previous,_next,commit) => commit([
          {storageRoot:${JSON.stringify(storageRoot)},taskId:'one'},
          {storageRoot:${JSON.stringify(storageRoot)},taskId:'two'}
        ])
      );
    `);
  return {
    root,
    storageRoot,
    first,
    second,
    catalog,
    project,
    store,
    hold,
    holdRecoveryClaim,
    holdTaskSnapshot,
    claimPath
  };
}

async function killHolder(child) {
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

test(
  "SIGKILL during a project directory commit is recovered immediately by competing catalog callers",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const memory = join(f.storageRoot, "one", "agents", "main", "context", "memory.md");
    await writeFile(memory, "Retain original history\n");
    const child = await f.hold(true);
    const staged = await readFile(join(f.storageRoot, "one", "task.json"), "utf8");
    assert.equal((await f.store.readTask("one")).projectDirectory, f.first);
    await killHolder(child);
    await Promise.all([
      new GlobalProjectCatalog(f.catalog.filePath).recover(),
      new GlobalProjectCatalog(f.catalog.filePath).recover()
    ]);
    assert.equal((await f.store.readTask("one")).projectDirectory, f.second);
    assert.equal((await f.store.readTask("two")).projectDirectory, f.second);
    assert.equal(await readFile(join(f.storageRoot, "one", "task.json"), "utf8"), staged);
    assert.equal(JSON.parse(await readFile(f.catalog.filePath, "utf8")).pending, undefined);
    assert.equal(await readFile(memory, "utf8"), "Retain original history\n");
  }
);

test(
  "a live project lock owner is preserved even when the stale deadline has elapsed",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const child = await f.hold();
    const target = `${f.catalog.filePath}.operation`;
    const ownerPath = `${target}.lock/owner.json`;
    const before = await readFile(ownerPath, "utf8");
    await assert.rejects(
      withFileLock(target, async () => assert.fail("must not enter another live owner's lock"), {
        recoverDeadOwner: true,
        staleMs: 0,
        retryMs: 5,
        timeoutMs: 80
      }),
      /timed out acquiring file lock/
    );
    assert.equal(await readFile(ownerPath, "utf8"), before);
    await killHolder(child);
    await f.catalog.recover();
    assert.equal((await f.catalog.get(f.project.projectId)).projectDirectory, f.first);
  }
);

test(
  "SIGKILL inside a task snapshot lock recovers the whole project commit and retains existing history",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.store.updateTask("two", { goal: "Keep the goal", title: "Keep the title" });
    const memory = join(f.storageRoot, "two", "agents", "main", "context", "memory.md");
    await writeFile(memory, "Keep this conversation history\n");
    const attachment = join(f.storageRoot, "one", "artifacts", "retained.bin");
    const contents = Buffer.from([0, 1, 127, 255]);
    await writeFile(attachment, contents);
    const taskFile = join(f.storageRoot, "two", "task.json");
    const original = await readFile(taskFile, "utf8");
    const eventsPath = join(f.storageRoot, "two", "task_events.jsonl");
    const events = await readFile(eventsPath, "utf8");
    const child = await f.holdTaskSnapshot();
    const ownerPath = `${taskFile}.lock/owner.json`;
    const before = await readFile(ownerPath, "utf8");
    assert.equal(JSON.parse(before).pid, child.pid);
    assert.equal(
      JSON.parse(await readFile(`${f.catalog.filePath}.operation.lock/owner.json`, "utf8")).pid,
      child.pid
    );
    const staged = await readFile(join(f.storageRoot, "one", "task.json"), "utf8");
    assert.equal(JSON.parse(staged).projectDirectory, f.second);
    assert.equal(await readFile(taskFile, "utf8"), original);
    for (const taskId of ["one", "two"])
      assert.equal((await f.store.readTask(taskId)).projectDirectory, f.first);
    await assert.rejects(
      withFileLock(taskFile, async () => assert.fail("must not steal a live task snapshot lock"), {
        recoverDeadOwner: true,
        staleMs: 0,
        retryMs: 5,
        timeoutMs: 80
      }),
      /timed out acquiring file lock/
    );
    assert.equal(await readFile(ownerPath, "utf8"), before);
    await killHolder(child);
    await Promise.all([f.catalog.recover(), new GlobalProjectCatalog(f.catalog.filePath).recover()]);
    for (const taskId of ["one", "two"])
      assert.equal((await f.store.readTask(taskId)).projectDirectory, f.second);
    assert.equal(await readFile(join(f.storageRoot, "one", "task.json"), "utf8"), staged);
    const recovered = await f.store.readTask("two");
    assert.equal(recovered.goal, "Keep the goal");
    assert.equal(recovered.title, "Keep the title");
    assert.equal((await readFile(eventsPath, "utf8")).startsWith(events), true);
    assert.equal(await readFile(memory, "utf8"), "Keep this conversation history\n");
    assert.deepEqual(await readFile(attachment), contents);
    assert.equal(JSON.parse(await readFile(f.catalog.filePath, "utf8")).pending, undefined);
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });
  }
);

test(
  "SIGKILL of a recovery claimant can be recovered while live claimants stay protected",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await killHolder(await f.hold(true));
    const claimant = await f.holdRecoveryClaim();
    const ownerPath = `${f.claimPath}/owner.json`;
    const before = await readFile(ownerPath, "utf8");
    await assert.rejects(
      withFileLock(
        `${f.catalog.filePath}.operation`,
        async () => assert.fail("must not steal a live recovery claim"),
        {
          recoverDeadOwner: true,
          staleMs: 0,
          retryMs: 5,
          timeoutMs: 80
        }
      ),
      /timed out acquiring file lock/
    );
    assert.equal(await readFile(ownerPath, "utf8"), before);
    await killHolder(claimant);
    await Promise.all([f.catalog.recover(), new GlobalProjectCatalog(f.catalog.filePath).recover()]);
    assert.equal((await f.store.readTask("one")).projectDirectory, f.second);
    assert.equal((await f.store.readTask("two")).projectDirectory, f.second);
  }
);

test(
  "unfinished or corrupt recovery claims wait for TTL and then permit catalog recovery",
  { timeout: 10000 },
  async (t) => {
    for (const corrupt of [false, true]) {
      const f = await fixture(t);
      await killHolder(await f.hold());
      await mkdir(f.claimPath);
      if (corrupt) await writeFile(`${f.claimPath}/owner.json`, "broken owner");
      await assert.rejects(
        withFileLock(
          `${f.catalog.filePath}.operation`,
          async () => assert.fail("unknown recovery claim must wait for TTL"),
          {
            recoverDeadOwner: true,
            staleMs: 5 * 60_000,
            retryMs: 5,
            timeoutMs: 80
          }
        ),
        /timed out acquiring file lock/
      );
      const old = new Date(Date.now() - 6 * 60_000);
      await utimes(f.claimPath, old, old);
      await f.catalog.recover();
      assert.equal((await f.catalog.get(f.project.projectId)).projectDirectory, f.first);
    }
  }
);
