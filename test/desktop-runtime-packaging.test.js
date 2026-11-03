import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, realpath, stat, copyFile, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";

const require = createRequire(import.meta.url);
const config = require("../electron-builder.config.cjs");
const source = resolve(".");
const exec = promisify(execFile);

async function stageRuntimeFiles(files, stage) {
  const filter = new FileMatcher(source, stage, (pattern) => pattern, config.files).createFilter();
  const queue = files.map((file) => join(source, file));
  const included = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (included.has(file)) continue;
    const metadata = await stat(file);
    assert.equal(
      filter(file, metadata),
      true,
      `Desktop package excludes runtime dependency: ${relative(source, file)}`
    );
    included.add(file);
    const target = join(stage, relative(source, file));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    queue.push(...localImports(file, await readFile(file, "utf8")));
  }
  const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await writeFile(join(stage, "package.json"), JSON.stringify({ ...metadata, ...config.extraMetadata }));
  return included;
}

function localImports(file, code) {
  const parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const modules = new Set();
  const visit = (node) => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith("."))
      modules.add(resolve(dirname(file), specifier.text));
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return modules;
}

test("desktop file selection includes the complete Pi runtime import closure and loads it outside the checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-runtime-package-"));
  const stage = join(root, "app");
  await mkdir(stage);
  t.after(() => rm(root, { recursive: true, force: true }));
  const included = await stageRuntimeFiles(
    ["scripts/start-pi.mjs", "scripts/main-worker.mjs", ".pi/extensions/cowork.ts"],
    stage
  );
  assert.ok(included.size > 20, "the test must traverse real extension and compiled runtime consumers");
  // Installed production dependencies are shared; all CoworkOS modules are copied
  // exclusively from electron-builder's file selection into an external stage.
  await symlink(
    join(source, "node_modules"),
    join(stage, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
  );
  const probe = `
    import {createRequire} from 'node:module';
    import {pathToFileURL} from 'node:url';
    await import('./scripts/cli-session.mjs');
    await import('./scripts/cli-session-picker.mjs');
    await import('./scripts/cli-branding.mjs');
    await import('./scripts/search-tool-adapter.mjs');
    const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const {createJiti} = require('jiti');
    const entry = ${JSON.stringify(join(stage, ".pi/extensions/cowork.ts"))};
    const jiti = createJiti(pathToFileURL(entry).href, {interopDefault:true});
    await jiti.import(entry, {default:true});
    console.log('desktop-runtime-closure-loaded');
  `;
  const result = await exec(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: stage,
    env: { ...env, PI_CODING_AGENT_DIR: join(root, "pi"), PI_OFFLINE: "1" },
    timeout: 15000
  });
  assert.match(result.stdout, /desktop-runtime-closure-loaded/);
});

test("a relocated desktop app finds its bundled Blender without a user runtime and preserves explicit overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-blender-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "CoworkOS.app/Contents/Resources/app");
  await mkdir(stage, { recursive: true });
  await stageRuntimeFiles(["dist/src/software/blender/engine.js"], stage);
  const metadata = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ ...metadata, atriaBundledComponents: true, atriaAutoInstallComponents: false })
  );
  const bundled = join(stage, "../blender/Blender.app/Contents/MacOS/Blender");
  await mkdir(dirname(bundled), { recursive: true });
  await writeFile(bundled, "fixture Blender executable", { mode: 0o755 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
  );
  const probe = `
    import { blenderExecutable } from './dist/src/software/blender/engine.js';
    console.log(await blenderExecutable());
  `;
  const options = {
    cwd: stage,
    env: {
      ...env,
      ATRIA_COMPONENTS_HOME: join(root, "empty-components"),
      COWORK_BLENDER_RUNTIME: join(root, "empty-user-runtime")
    },
    timeout: 15000
  };
  const result = await exec(process.execPath, ["--input-type=module", "-e", probe], options);
  assert.equal(result.stdout.trim(), await realpath(bundled));
  const explicit = join(root, "explicit-Blender");
  await writeFile(explicit, "fixture explicit executable", { mode: 0o755 });
  options.env.COWORK_BLENDER_EXECUTABLE = explicit;
  const override = await exec(process.execPath, ["--input-type=module", "-e", probe], options);
  assert.equal(override.stdout.trim(), await realpath(explicit));
  options.env.COWORK_BLENDER_EXECUTABLE = join(root, "missing-explicit-Blender");
  await assert.rejects(
    exec(process.execPath, ["--input-type=module", "-e", probe], options),
    /Blender 内置组件暂不可用/
  );
});

test("packaged runtime, component status and PPT assets use the host's components while source installs retain managed versions", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atria-desktop-components-selection-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "CoworkOS.app/Contents/Resources/app");
  await mkdir(stage, { recursive: true });
  await stageRuntimeFiles(["dist/src/dashboard/routes.js", "dist/src/software/components/service.js"], stage);
  await symlink(join(source, "node_modules"), join(stage, "node_modules"), "dir");
  const metadata = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
  const home = join(root, "components");
  const bundled = {},
    managed = {},
    external = {};
  for (const [id, entry, version] of [
    ["cadquery", "bin/python3", "2.6.1"],
    ["blender", "Blender.app/Contents/MacOS/Blender", "Blender 4.5.11"],
    ["pptist", "index.html", "bundled PPT editor"]
  ]) {
    const directory = id === "pptist" ? join(stage, "web/assets/pptist/generated") : resolve(stage, "..", id);
    bundled[id] = join(directory, entry);
    managed[id] = join(home, id, "versions/old", entry);
    for (const [file, text] of [
      [bundled[id], version],
      [managed[id], `old ${id}`]
    ]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, id === "pptist" ? text : `#!/bin/sh\necho '${text}'\n`, { mode: 0o755 });
    }
    await writeFile(
      join(home, id, "current.json"),
      JSON.stringify({
        apiVersion: 1,
        enabled: true,
        platform: `${process.platform}-${process.arch}`,
        version: "old",
        runtimeVersion: `old ${id}`
      })
    );
    await writeFile(
      join(home, id, "install.json"),
      JSON.stringify({ phase: "failed", message: "old installation failure" })
    );
    if (id === "pptist") {
      for (const name of ["LICENSE.txt", "source.tar.gz"])
        await writeFile(join(directory, name), "bundled distribution fixture");
    } else {
      external[id] = join(root, `external-${id}`);
      await writeFile(external[id], `#!/bin/sh\necho '${id === "blender" ? "Blender 4.4.0" : "2.5.0"}'\n`, {
        mode: 0o755
      });
    }
  }
  await mkdir(join(stage, "web/assets/pptist"), { recursive: true });
  await writeFile(join(stage, "web/assets/pptist/missing.html"), "bundled recovery");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
  );
  const probe = `
    import { join } from 'node:path';
    import { createDashboardHandler } from './dist/src/dashboard/routes.js';
    import { createComponentService } from './dist/src/software/components/service.js';
    import { cadQueryPython } from './dist/src/software/cad/cadquery-engine.js';
    import { blenderExecutable } from './dist/src/software/blender/engine.js';
    const components = createComponentService();
    let blender, blenderError;
    try { blender = await blenderExecutable(); } catch(error) { blenderError = error.message; }
    const states = await components.list(false, true);
    const blocked = [];
    if (states.find(state => state.id === 'pptist').bundled) {
      for (const operation of ['install', 'upgrade', 'uninstall']) {
        try { await components.action('pptist', operation); }
        catch { blocked.push(operation); }
      }
    }
    const handler = createDashboardHandler({ dashboardUrl: 'http://127.0.0.1:3880', uiRoot: join(process.cwd(), 'web') });
    let status, ppt;
    await handler({method:'GET',url:'/assets/pptist/generated/index.html',headers:{host:'127.0.0.1:3880'}}, {
      writeHead(code){status=code},end(body){ppt=String(body)}
    });
    await components.stop();
    console.log(JSON.stringify({cad:cadQueryPython(),blender,blenderError,states,status,ppt,blocked}));
  `;
  const options = {
    cwd: stage,
    env: { ...env, ATRIA_COMPONENTS_HOME: home, COWORK_BLENDER_RUNTIME: join(root, "empty-runtime") },
    timeout: 15000
  };
  const run = async (bundledMode = true, overrides = {}, bundledPptist = bundledMode) => {
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify({ ...metadata, atriaBundledComponents: bundledMode, atriaBundledPptist: bundledPptist })
    );
    const result = await exec(process.execPath, ["--input-type=module", "-e", probe], {
      ...options,
      env: { ...options.env, ...overrides }
    });
    return JSON.parse(result.stdout);
  };
  const packaged = await run();
  assert.equal(packaged.cad, bundled.cadquery);
  assert.equal(packaged.blender, await realpath(bundled.blender));
  assert.equal(packaged.status, 200);
  assert.equal(packaged.ppt, "bundled PPT editor");
  assert.deepEqual(packaged.blocked, ["install", "upgrade", "uninstall"]);
  assert.ok(packaged.states.every((state) => state.bundled));
  for (const id of ["cadquery", "pptist", ...(process.platform === "darwin" ? ["blender"] : [])]) {
    const state = packaged.states.find((state) => state.id === id);
    assert.equal(state.available, true);
    assert.equal(state.managed, false);
    assert.equal(state.phase, "ready", "an old managed install failure cannot override bundled availability");
    assert.notEqual(state.version, `old ${id}`);
  }
  const development = await run(false);
  assert.equal(await realpath(development.cad), await realpath(managed.cadquery));
  assert.equal(development.blender, await realpath(managed.blender));
  assert.equal(development.ppt, "old pptist");
  assert.ok(development.states.every((state) => state.managed));
  assert.ok(development.states.every((state) => !state.bundled));
  const light = await run(false, {}, true);
  assert.equal(await realpath(light.cad), await realpath(managed.cadquery));
  assert.equal(light.blender, await realpath(managed.blender));
  assert.equal(
    light.ppt,
    "bundled PPT editor",
    "light upgrades must use their new editor instead of an old managed PPT component"
  );
  assert.deepEqual(light.blocked, ["install", "upgrade", "uninstall"]);
  assert.equal(light.states.find((state) => state.id === "pptist").bundled, true);
  assert.ok(
    light.states.filter((state) => state.id !== "pptist").every((state) => state.managed && !state.bundled)
  );
  const explicit = await run(true, {
    COWORK_CADQUERY_PYTHON: external.cadquery,
    COWORK_BLENDER_EXECUTABLE: external.blender
  });
  assert.equal(explicit.cad, external.cadquery);
  assert.equal(explicit.blender, await realpath(external.blender));
  assert.equal(explicit.states.find((state) => state.id === "cadquery").version, "2.5.0");
  if (process.platform === "darwin")
    assert.equal(explicit.states.find((state) => state.id === "blender").version, "4.4.0");
  for (const file of Object.values(bundled)) await rm(file);
  const damaged = await run();
  assert.equal(damaged.cad, bundled.cadquery);
  assert.match(damaged.blenderError, /Blender 内置组件暂不可用/);
  assert.equal(damaged.status, 409);
  assert.equal(damaged.ppt, "bundled recovery");
  assert.ok(damaged.states.every((state) => !state.available && !state.managed));
  assert.ok(damaged.states.every((state) => state.phase === "missing"));
});
