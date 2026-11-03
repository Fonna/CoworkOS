import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execute = promisify(execFile);
const cli = resolve("scripts/atria.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-science-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "python-was-started");
  const python = join(root, "fake-python");
  await writeFile(python, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(COWORK_|ATRIA_|PI_|PYTHON|PIP_)/.test(key))
  );
  Object.assign(env, {
    ATRIA_HOME: join(root, "home"),
    COWORK_CONFIG: join(root, "not-created-config.json"),
    COWORK_SCIENCE_PYTHON: python
  });
  const run = async (...args) => {
    try {
      return { ...(await execute(process.execPath, [cli, "science", ...args], { cwd: root, env })), code: 0 };
    } catch (error) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  return { root, env, marker, run };
}

test("scientific CLI help and status do not run Python, require a model, or save configuration", async (t) => {
  const f = await fixture(t);
  const help = await f.run("--help");
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Python 3\.10\+/);
  assert.match(help.stdout, /never changes system packages/);
  const topicHelp = await execute(process.execPath, [cli, "help", "science"], { cwd: f.root, env: f.env });
  assert.equal(topicHelp.stdout, help.stdout);
  const result = await f.run("status");
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.general.state, "absent");
  assert.equal(status.chemistry.state, "absent");
  await assert.rejects(access(f.marker));
  await assert.rejects(access(f.env.COWORK_CONFIG));
});

test("scientific CLI rejects arbitrary targets and package options before executing Python", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["install", "arbitrary"],
    ["install", "general", "--package", "something"],
    ["status", "general"],
    ["cancel", "general", "--python", "python3"]
  ]) {
    const result = await f.run(...args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid scientific environment command/);
  }
  await assert.rejects(access(f.marker));
  await assert.rejects(access(f.env.COWORK_CONFIG));
});

test("an unavailable installer interpreter returns failure and leaves settings uncreated", async (t) => {
  const f = await fixture(t);
  const result = await f.run("install", "general", "--python", join(f.root, "missing-python"));
  assert.equal(result.code, 1, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.state, "failed");
  assert.ok(state.error?.code);
  assert.equal(state.installedPython, undefined);
  await assert.rejects(access(f.env.COWORK_CONFIG));
  const after = await f.run("status");
  assert.equal(JSON.parse(after.stdout).general.state, "failed");
});
