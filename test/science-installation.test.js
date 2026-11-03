import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  createScienceInstallation,
  SCIENCE_INSTALLATION_SPECS
} from "../dist/src/runtime/science-installation.js";
import { createScienceSettings } from "../dist/src/dashboard/science-settings.js";
import { handleScienceSettingsRequest } from "../dist/src/dashboard/science-settings-routes.js";
import { localRequestUrl, sendJson } from "../dist/src/dashboard/http.js";

const supportedPlatform = process.platform !== "win32";
async function fixture(t, behavior = {}, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-science-install-test-"));
  const managedRoot = join(root, "managed");
  const audit = join(root, "commands.jsonl");
  const childMarker = join(root, "worker.pid");
  const source = join(root, "host-python");
  const script = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2), behavior=${JSON.stringify(behavior)};
const audit=${JSON.stringify(audit)}, childMarker=${JSON.stringify(childMarker)};
const code=args[args.indexOf('-c')+1]||'';
const stage=code.includes('ATRIA_SCIENCE_HOST')?'host':code.includes('ATRIA_SCIENCE_VERIFY')?'verify':args.includes('venv')?'venv':args.includes('pip')?'pip':'unexpected';
fs.appendFileSync(audit,JSON.stringify({stage,command:process.argv[1],args,env:process.env})+String.fromCharCode(10));
if(stage===behavior.actualStage){
  fs.writeFileSync(childMarker,String(process.pid));
  const forwarded=[...args], index=forwarded.indexOf('-c')+1;
  forwarded[index]=forwarded[index].replace('import json,sys','import json,sys;time.sleep(30)').replace('if sys.prefix == sys.base_prefix:','time.sleep(30)'+String.fromCharCode(10)+'if sys.prefix == sys.base_prefix:');
  process.execve(behavior.actualPython,[behavior.actualPython,...forwarded],process.env);
}
if(stage===behavior.failStage){process.stderr.write('fixture-only-private-error');process.exit(1);}
if(stage===behavior.readOnlyFailureStage){
  fs.chmodSync(path.join(path.dirname(audit),'managed','general','generations'),0o500);
  process.stderr.write('fixture-only-private-error');process.exit(1);
}
if(stage===behavior.floodStage){process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);}
else if(stage===behavior.hangStage){
  const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.writeFileSync(childMarker,String(child.pid));setInterval(()=>{},1000);
}
else if(stage==='host')process.stdout.write(JSON.stringify({version:behavior.version||[3,11,9]}));
else if(stage==='venv'){
  const destination=args.at(-1),bin=path.join(destination,'bin');fs.mkdirSync(bin,{recursive:true});
  const python=path.join(bin,'python');fs.writeFileSync(python,fs.readFileSync(__filename));fs.chmodSync(python,0o755);
  fs.writeFileSync(path.join(destination,'pyvenv.cfg'),'fixture venv');
}
else if(stage==='verify'){
  const target=args.at(-1),versions=target==='general'?{numpy:'2.2.6',scipy:'1.15.3'}:{numpy:'2.2.6',rdkit:'2026.09.1',Pillow:'11.3.0'};
  if(behavior.badDependency)versions.numpy='0.0.0';
  process.stdout.write(behavior.invalidJson?'bad json':JSON.stringify({version:[3,11,9],versions}));
}
else if(stage!=='pip')process.exit(2);
`;
  await writeFile(source, script);
  await chmod(source, 0o755);
  const manager = createScienceInstallation({ root: managedRoot, ...limits });
  t.after(async () => {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, managedRoot, manager, source, audit, childMarker, script };
}
async function waitFor(manager, target, predicate = (state) => state.state !== "installing") {
  const deadline = Date.now() + 15_000;
  do {
    const state = (await manager.status())[target];
    if (predicate(state)) return state;
    await new Promise((done) => setTimeout(done, 25));
  } while (Date.now() < deadline);
  assert.fail(`Installation ${target} did not reach its expected state`);
}
async function commands(f) {
  try {
    return (await readFile(f.audit, "utf8")).trim().split("\n").map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "close");
  return child.pid;
}

test("managed environment status is read-only and unavailable Python remains a local prerequisite", async (t) => {
  const f = await fixture(t);
  const initial = await f.manager.status();
  assert.equal(initial.general.state, "absent");
  assert.equal(initial.chemistry.state, "absent");
  await assert.rejects(access(f.managedRoot), { code: "ENOENT" });
  assert.deepEqual(await commands(f), []);
  await f.manager.install({ target: "general", pythonExecutable: join(f.root, "missing-python") });
  const failed = await waitFor(f.manager, "general");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "python_unavailable");
  assert.match(failed.error.message, /Python 3\.10/);
  assert.equal(failed.installedPython, undefined);
  assert.equal((await f.manager.status()).chemistry.state, "absent");
});

test("installation accepts only fixed targets and valid Python selections", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { target: "shell", pythonExecutable: f.source },
    { target: "general", pythonExecutable: "../python" },
    { target: "general", pythonExecutable: "python\n--evil" }
  ])
    await assert.rejects(f.manager.install(input), (error) => error.code === "invalid_arguments");
  assert.deepEqual(await commands(f), []);
  await assert.rejects(access(f.managedRoot), { code: "ENOENT" });
});

test(
  "PATH command selection resolves an executable before starting sanitized installation workers",
  { skip: !supportedPlatform },
  async (t) => {
    const f = await fixture(t);
    const command = "atria-science-fixture-python";
    const blocked = join(f.root, "not-executable");
    const directory = join(f.root, "directory");
    const bin = join(f.root, "selected python bin");
    for (const folder of [blocked, directory, bin]) await mkdir(folder);
    await writeFile(join(blocked, command), f.script, { mode: 0o600 });
    await mkdir(join(directory, command));
    const selected = join(bin, command);
    await writeFile(selected, f.script, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = [blocked, directory, bin].join(delimiter);
    process.env.ATRIA_SCIENCE_PATH_FIXTURE_SECRET = "fixture-only-private-value";
    try {
      await f.manager.install({ target: "general", pythonExecutable: command });
      const ready = await waitFor(f.manager, "general");
      assert.equal(ready.state, "ready", JSON.stringify(ready));
      const calls = await commands(f);
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["host", "venv", "pip", "verify"]
      );
      assert.equal(calls[0].command, selected);
      assert.equal(calls[1].command, selected);
      for (const call of calls) {
        assert.equal(Object.hasOwn(call.env, "PATH"), false);
        assert.equal(Object.hasOwn(call.env, "ATRIA_SCIENCE_PATH_FIXTURE_SECRET"), false);
      }
      const reference = JSON.parse(await readFile(join(f.managedRoot, "general", "ready.json"), "utf8"));
      assert.equal(reference.sourcePython, command, "reuse preserves the user's interpreter selection");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      delete process.env.ATRIA_SCIENCE_PATH_FIXTURE_SECRET;
    }
  }
);

test(
  "an absolute Python selection ignores a different executable with the same name on PATH",
  { skip: !supportedPlatform },
  async (t) => {
    const f = await fixture(t);
    const bin = join(f.root, "shadow-bin");
    const marker = join(f.root, "wrong-interpreter-ran");
    await mkdir(bin);
    await writeFile(
      join(bin, "host-python"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(1);`,
      { mode: 0o700 }
    );
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      await f.manager.install({ target: "general", pythonExecutable: f.source });
      assert.equal((await waitFor(f.manager, "general")).state, "ready");
      assert.equal((await commands(f))[0].command, f.source);
      await assert.rejects(access(marker), { code: "ENOENT" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }
);

test(
  "empty and relative PATH entries use the host working directory while a missing PATH does not",
  { skip: !supportedPlatform },
  async (t) => {
    const f = await fixture(t);
    const command = "atria-science-fixture-python";
    await writeFile(join(f.root, command), f.script, { mode: 0o700 });
    const moduleUrl = pathToFileURL(resolve("dist/src/runtime/science-installation.js")).href;
    for (const [index, path] of ["", ".", undefined].entries()) {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import {createScienceInstallation} from ${JSON.stringify(moduleUrl)};
const manager=createScienceInstallation({root:${JSON.stringify(join(f.root, `managed-${index}`))}});
try {
  let state=await manager.install({target:'general',pythonExecutable:${JSON.stringify(command)}});
  while(state.state==='installing') {
    await new Promise(r=>setTimeout(r,25));
    state=(await manager.status()).general;
  }
  console.log(JSON.stringify(state));
} finally { await manager.stop(); }
`
        ],
        { cwd: f.root, env: path === undefined ? {} : { PATH: path }, stdio: ["ignore", "pipe", "pipe"] }
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      const [code] = await once(child, "close");
      assert.equal(code, 0, errors);
      const state = JSON.parse(output);
      assert.equal(state.state, path === undefined ? "failed" : "ready", JSON.stringify(state));
      if (path === undefined) assert.equal(state.error.code, "python_unavailable");
    }
    for (const call of await commands(f)) assert.equal(Object.hasOwn(call.env, "PATH"), false);
  }
);

test(
  "installation refuses a managed target symlink before writing outside its root",
  { skip: !supportedPlatform },
  async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await mkdir(f.managedRoot);
    await symlink(outside, join(f.managedRoot, "general"));
    await assert.rejects(
      f.manager.install({ target: "general", pythonExecutable: f.source }),
      (error) => error.code === "installation_busy"
    );
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await commands(f), []);
  }
);

for (const target of ["general", "chemistry"])
  test(
    `${target} installs fixed wheels into one immutable venv and publishes only after self-test`,
    { skip: !supportedPlatform },
    async (t) => {
      const f = await fixture(t);
      const oldPin = join(f.root, "old-run.json");
      const original = JSON.stringify({ science: { pythonExecutable: "/existing/environment" } });
      await writeFile(oldPin, original);
      const first = await f.manager.install({ target, pythonExecutable: f.source });
      assert.equal(first.state, "installing");
      assert.equal(first.installedPython, undefined);
      const ready = await waitFor(f.manager, target);
      assert.equal(ready.state, "ready", JSON.stringify(ready));
      assert.ok(ready.installedPython.startsWith(join(f.managedRoot, target, "generations")));
      assert.equal((await stat(ready.installedPython)).isFile(), true);
      assert.equal(await readFile(oldPin, "utf8"), original);
      const calls = await commands(f);
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["host", "venv", "pip", "verify"]
      );
      const venv = calls.find((call) => call.stage === "venv");
      assert.equal(
        venv.args.at(-1),
        dirname(dirname(ready.installedPython)),
        "venv is created at its final path without rename"
      );
      const pip = calls.find((call) => call.stage === "pip");
      assert.equal(pip.command, ready.installedPython, "pip never runs against the host interpreter");
      assert.deepEqual(
        pip.args.slice(-SCIENCE_INSTALLATION_SPECS[target].packages.length),
        SCIENCE_INSTALLATION_SPECS[target].packages
      );
      for (const flag of ["--isolated", "--no-input", "--no-deps", "--only-binary=:all:", "--no-cache-dir"])
        assert.ok(pip.args.includes(flag));
      assert.equal(pip.args[pip.args.indexOf("--index-url") + 1], "https://pypi.org/simple");
      for (const call of calls) {
        assert.deepEqual(call.args.slice(0, 3), ["-I", "-B", "-c"]);
        assert.equal(call.env.PIP_CONFIG_FILE, "/dev/null");
        for (const name of Object.keys(call.env))
          assert.doesNotMatch(
            name,
            /KEY|TOKEN|PROXY|^PATH$|PYTHONPATH|PYTHONHOME|NODE_OPTIONS|PIP_INDEX|PIP_EXTRA/u
          );
        assert.ok(call.env.HOME.startsWith(dirname(dirname(ready.installedPython))));
      }
      const before = await readFile(f.audit, "utf8");
      const secondManager = createScienceInstallation({ root: f.managedRoot });
      t.after(() => secondManager.stop());
      const reused = await secondManager.install({ target, pythonExecutable: f.source });
      assert.equal(reused.state, "ready");
      assert.equal(reused.installedPython, ready.installedPython);
      assert.equal(
        await readFile(f.audit, "utf8"),
        before,
        "reusing a ready immutable version does not probe or install"
      );
    }
  );

for (const scenario of [
  { behavior: { version: [3, 9, 20] }, code: "unsupported_python", stages: ["host"] },
  { behavior: { failStage: "pip" }, code: "installation_failed", stages: ["host", "venv", "pip"] },
  {
    behavior: { badDependency: true },
    code: "dependency_version_mismatch",
    stages: ["host", "venv", "pip", "verify"]
  },
  {
    behavior: { invalidJson: true },
    code: "invalid_python_response",
    stages: ["host", "venv", "pip", "verify"]
  }
])
  test(
    `failed ${scenario.code} never publishes an incomplete environment`,
    { skip: !supportedPlatform },
    async (t) => {
      const f = await fixture(t, scenario.behavior);
      await f.manager.install({ target: "general", pythonExecutable: f.source });
      const failed = await waitFor(f.manager, "general");
      assert.equal(failed.state, "failed");
      assert.equal(failed.error.code, scenario.code);
      assert.equal(failed.installedPython, undefined);
      assert.doesNotMatch(JSON.stringify(failed), /fixture-only-private-error/);
      assert.deepEqual(
        (await commands(f)).map((call) => call.stage),
        scenario.stages
      );
      assert.deepEqual(await readdir(join(f.managedRoot, "general", "generations")), []);
      await assert.rejects(access(join(f.managedRoot, "general", "ready.json")), { code: "ENOENT" });
    }
  );

test(
  "explicit same-source reinstall creates a fresh UUID and failure preserves the old published environment",
  { skip: !supportedPlatform },
  async (t) => {
    const f = await fixture(t);
    await f.manager.install({ target: "general", pythonExecutable: f.source });
    const old = await waitFor(f.manager, "general");
    const oldContents = await readFile(old.installedPython, "utf8");
    await f.manager.install({ target: "general", pythonExecutable: f.source, reinstall: true });
    const replacement = await waitFor(f.manager, "general");
    assert.equal(replacement.state, "ready");
    assert.notEqual(replacement.installedPython, old.installedPython);
    assert.equal(await readFile(old.installedPython, "utf8"), oldContents);
    await writeFile(f.source, f.script.replace("behavior={}", 'behavior={"failStage":"pip"}'));
    await f.manager.install({ target: "general", pythonExecutable: f.source, reinstall: true });
    const failed = await waitFor(f.manager, "general");
    assert.equal(failed.state, "failed");
    assert.equal(failed.installedPython, replacement.installedPython);
    assert.equal(await readFile(old.installedPython, "utf8"), oldContents);
    assert.deepEqual(
      new Set(await readdir(join(f.managedRoot, "general", "generations"))),
      new Set([old.operationId, replacement.operationId])
    );
  }
);

test(
  "cleanup I/O failure reports a stopped local installation and explicitly retries after permissions recover",
  { skip: !supportedPlatform || process.getuid?.() === 0, timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, { readOnlyFailureStage: "pip" });
    const generations = join(f.managedRoot, "general", "generations");
    try {
      await f.manager.install({ target: "general", pythonExecutable: f.source });
      const failure = await waitFor(f.manager, "general");
      assert.equal(failure.state, "failed");
      assert.equal(failure.error.code, "installation_io_failed");
      assert.equal(failure.installedPython, undefined);
      await assert.rejects(writeFile(join(generations, "permission-probe"), "blocked"), { code: "EACCES" });
      const operationPath = join(f.managedRoot, "general", "operation.json");
      const original = await readFile(operationPath, "utf8");
      const evidence = JSON.parse(original);
      assert.equal(evidence.state, "installing", "failed cleanup must preserve the last durable evidence");
      assert.equal(evidence.owner.pid, process.pid, "the owning application remains alive");
      assert.equal((await f.manager.status()).general.state, "failed");
      assert.equal(await readFile(operationPath, "utf8"), original, "status does not repair durable state");
      assert.deepEqual(
        (await commands(f)).map((call) => call.stage),
        ["host", "venv", "pip"]
      );
      await chmod(generations, 0o700);
      await writeFile(f.source, f.script.replace(/behavior=\{[^;]+\};/u, "behavior={};"));
      await f.manager.install({ target: "general", pythonExecutable: f.source });
      const ready = await waitFor(f.manager, "general");
      assert.equal(ready.state, "ready", JSON.stringify(ready));
      assert.notEqual(ready.operationId, evidence.operationId);
      await assert.rejects(access(join(generations, evidence.operationId)), { code: "ENOENT" });
    } finally {
      await chmod(generations, 0o700).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
);

test(
  "HTTP installation stays explicit, validates its closed input and never saves configuration",
  { skip: !supportedPlatform },
  async (t) => {
    const f = await fixture(t);
    const config = {
      model: "fixture-model",
      apiKey: "fixture-only-config-secret",
      science: { enabled: false, pythonExecutable: f.source }
    };
    const configPath = join(f.root, "config.json");
    const original = JSON.stringify(config);
    await writeFile(configPath, original);
    const settings = createScienceSettings(f.root, config, {
      env: { ATRIA_HOME: f.root, COWORK_CONFIG: configPath },
      installation: f.manager
    });
    let base;
    const server = createServer(async (request, response) => {
      try {
        const url = localRequestUrl(request, base);
        if (!(await handleScienceSettingsRequest(request, response, url, settings)))
          sendJson(response, 404, {});
      } catch (error) {
        sendJson(response, error.status || 400, { error: error.message });
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      await settings.stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const call = async (path, body) => {
      const response = await fetch(
        base + "/api/science-settings/" + path,
        body === undefined
          ? {}
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      );
      return { status: response.status, value: await response.json() };
    };
    assert.equal((await call("environments")).value.general.state, "absent");
    assert.deepEqual(await commands(f), []);
    assert.equal((await call("install")).status, 405);
    assert.equal((await call("environments", {})).status, 405);
    for (const body of [
      { target: "general", packages: ["unreviewed"] },
      { target: "general", reinstall: "yes" },
      { target: "other" },
      { target: "general", pythonExecutable: "../python" }
    ])
      assert.equal((await call("install", body)).status, 400);
    const installed = await call("install", { target: "general" });
    assert.equal(installed.status, 202);
    assert.equal(installed.value.state, "installing");
    assert.equal((await waitFor(f.manager, "general")).state, "ready");
    const read = await call("environments");
    assert.equal(read.value.general.state, "ready");
    assert.equal(read.value.chemistry.state, "absent");
    assert.doesNotMatch(JSON.stringify(read.value), /fixture-only-config-secret/);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.deepEqual(config.science, { enabled: false, pythonExecutable: f.source });
    assert.equal((await call("cancel", { target: "general", operationId: "not-accepted" })).status, 400);
    assert.equal((await call("cancel", { target: "general" })).value.state, "ready");
  }
);

for (const mode of ["cancel", "timeout", "stop", "output"])
  test(
    `${mode} terminates the installer process group and leaves no published partial venv`,
    { skip: !supportedPlatform, timeout: 20000 },
    async (t) => {
      const f = await fixture(
        t,
        mode === "output" ? { floodStage: "pip" } : { hangStage: "pip" },
        // Leave room for worker startup under the full suite's concurrent load;
        // the timeout must still stop the deliberately hung pip process group.
        mode === "timeout" ? { timeoutMs: 5000 } : mode === "output" ? { maxOutputBytes: 1024 } : {}
      );
      await f.manager.install({ target: "general", pythonExecutable: f.source });
      if (mode !== "output") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            await access(f.childMarker);
            break;
          } catch {
            await new Promise((done) => setTimeout(done, 25));
          }
        }
        const pid = Number(await readFile(f.childMarker, "utf8"));
        assert.ok(pid > 0);
        if (mode === "cancel") assert.equal((await f.manager.cancel("general")).state, "cancelled");
        if (mode === "stop") await f.manager.stop();
        const final = await waitFor(f.manager, "general");
        assert.equal(final.error.code, mode === "timeout" ? "timeout" : "cancelled");
        await new Promise((done) => setTimeout(done, 50));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } else assert.equal((await waitFor(f.manager, "general")).error.code, "output_too_large");
      assert.equal((await f.manager.status()).general.installedPython, undefined);
      assert.deepEqual(await readdir(join(f.managedRoot, "general", "generations")), []);
    }
  );

test(
  "cross-process lock deduplicates installation and another manager can explicitly cancel the live owner",
  { skip: !supportedPlatform, timeout: 25000 },
  async (t) => {
    const f = await fixture(t, { hangStage: "pip" });
    const moduleUrl = pathToFileURL(resolve("dist/src/runtime/science-installation.js")).href;
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import {createScienceInstallation} from ${JSON.stringify(moduleUrl)};
const manager=createScienceInstallation({root:${JSON.stringify(f.managedRoot)}});
await manager.install({target:'general',pythonExecutable:${JSON.stringify(f.source)}});
while((await manager.status()).general.state==='installing') await new Promise(r=>setTimeout(r,25));
await manager.stop();
`
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    t.after(async () => {
      owner.kill("SIGKILL");
    });
    const closed = once(owner, "close");
    const active = await waitFor(f.manager, "general", (state) => state.phase === "installing_dependencies");
    const duplicate = await f.manager.install({ target: "general", pythonExecutable: f.source });
    assert.equal(duplicate.operationId, active.operationId);
    assert.equal(duplicate.state, "installing", "status never marks a different live owner interrupted");
    const cancelled = await f.manager.cancel("general");
    assert.equal(cancelled.state, "cancelled");
    assert.equal((await closed)[0], 0);
    assert.equal((await commands(f)).filter((call) => call.stage === "venv").length, 1);
  }
);

test(
  "dead-owner residue is reported without a probe and a new explicit install recovers its lock",
  { skip: !supportedPlatform },
  async (t) => {
    const f = await fixture(t);
    const generation = randomUUID(),
      pid = await deadPid();
    const targetRoot = join(f.managedRoot, "general");
    const candidate = join(targetRoot, "generations", generation);
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, "partial"), "unfinished");
    const operation = {
      version: 1,
      target: "general",
      state: "installing",
      specVersion: SCIENCE_INSTALLATION_SPECS.general.version,
      operationId: generation,
      sourcePython: f.source,
      owner: { pid, host: hostname() }
    };
    await writeFile(join(targetRoot, "operation.json"), JSON.stringify(operation));
    const lock = join(targetRoot, "operation.json.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: randomUUID(), pid, host: hostname() }));
    assert.equal((await f.manager.status()).general.state, "interrupted");
    assert.deepEqual(await commands(f), []);
    await f.manager.install({ target: "general", pythonExecutable: f.source });
    const ready = await waitFor(f.manager, "general");
    assert.equal(ready.state, "ready");
    assert.notEqual(ready.operationId, generation);
    await assert.rejects(access(candidate), { code: "ENOENT" });
  }
);

for (const stage of ["host", "verify"])
  test(
    `the real Python ${stage} watchdog exits after owner SIGKILL and an explicit retry recovers`,
    { skip: !supportedPlatform, timeout: 25000 },
    async (t) => {
      if (typeof process.execve !== "function")
        return t.skip("Node execve is required to forward the fixed Python worker without another parent");
      const probe = spawnSync(
        process.env.COWORK_SCIENCE_TEST_PYTHON || "python3",
        ["-I", "-c", "import sys;print(sys.executable)"],
        { encoding: "utf8", timeout: 5000, env: {} }
      );
      if (probe.status !== 0) return t.skip("A real Python is required for owner-death watchdog acceptance");
      const f = await fixture(t, { actualStage: stage, actualPython: probe.stdout.trim() });
      const moduleUrl = pathToFileURL(resolve("dist/src/runtime/science-installation.js")).href;
      const owner = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import {createScienceInstallation} from ${JSON.stringify(moduleUrl)};
const manager=createScienceInstallation({root:${JSON.stringify(f.managedRoot)}});
await manager.install({target:'general',pythonExecutable:${JSON.stringify(f.source)}});
while((await manager.status()).general.state==='installing') await new Promise(r=>setTimeout(r,25));
await manager.stop();
`
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const closed = once(owner, "close");
      t.after(async () => {
        owner.kill("SIGKILL");
      });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await access(f.childMarker);
          break;
        } catch {
          await new Promise((done) => setTimeout(done, 25));
        }
      }
      const workerPid = Number(await readFile(f.childMarker, "utf8"));
      const original = (await f.manager.status()).general;
      assert.equal(original.state, "installing");
      process.kill(workerPid, 0);
      // The marker precedes execve; allow the real Python watchdog to start.
      await new Promise((done) => setTimeout(done, 150));
      owner.kill("SIGKILL");
      assert.equal((await closed)[1], "SIGKILL");
      const exitedBy = Date.now() + 5000;
      while (Date.now() < exitedBy) {
        try {
          process.kill(workerPid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
      assert.equal((await f.manager.status()).general.state, "interrupted");
      await writeFile(f.source, f.script.replace(/behavior=\{[^;]+\};/u, "behavior={};"));
      await f.manager.install({ target: "general", pythonExecutable: f.source });
      const ready = await waitFor(f.manager, "general");
      assert.equal(ready.state, "ready", JSON.stringify(ready));
      assert.notEqual(ready.operationId, original.operationId);
      await assert.rejects(access(join(f.managedRoot, "general", "generations", original.operationId)), {
        code: "ENOENT"
      });
    }
  );
