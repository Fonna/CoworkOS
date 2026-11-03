import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureCliBranding, ensureCliStartupSettings } from "../scripts/cli-branding.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-branding-"));
  const piPackageDir = join(root, "readonly-pi");
  const agentDir = join(root, "profile");
  await mkdir(join(piPackageDir, "dist/modes/interactive/theme"), { recursive: true });
  await mkdir(join(piPackageDir, "dist/modes/interactive/assets"), { recursive: true });
  await mkdir(join(piPackageDir, "dist/core/export-html"), { recursive: true });
  await mkdir(join(piPackageDir, "docs"));
  await mkdir(join(piPackageDir, "examples"));
  const original = {
    name: "@earendil-works/pi-coding-agent",
    version: "0.87.1",
    piConfig: { configDir: ".pi" },
    license: "MIT"
  };
  await writeFile(join(piPackageDir, "package.json"), JSON.stringify(original));
  await writeFile(join(piPackageDir, "README.md"), "Upstream README");
  await writeFile(join(piPackageDir, "CHANGELOG.md"), "Upstream changes");
  await writeFile(join(piPackageDir, "dist/modes/interactive/theme/dark.json"), "original theme");
  await writeFile(join(piPackageDir, "dist/modes/interactive/assets/logo.txt"), "original asset");
  await writeFile(join(piPackageDir, "dist/core/export-html/template.html"), "original export template");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, piPackageDir, agentDir, original };
}

test("concurrent branding overlays preserve upstream assets and Pi's configured profile", async (t) => {
  const f = await fixture(t);
  const input = { ...f, version: "0.1.1" };
  const [first, second] = await Promise.all([ensureCliBranding(input), ensureCliBranding(input)]);
  assert.deepEqual(first, second);
  assert.equal(first.ATRIA_CODING_AGENT_DIR, f.agentDir);
  const configUrl = new URL("./config.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(PI_|COWORK_|ATRIA_)/.test(name))
  );
  const source = `const p=await import(${JSON.stringify(configUrl)});console.log(JSON.stringify({name:p.APP_NAME,title:p.APP_TITLE,profile:p.getAgentDir(),themes:p.getThemesDir(),assets:p.getInteractiveAssetsDir(),exports:p.getExportTemplateDir(),docs:p.getDocsPath()}));`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...env, ...first, PI_OFFLINE: "1" }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.name, "coworkos");
  assert.equal(result.title, "coworkos");
  assert.equal(result.profile, f.agentDir);
  assert.equal(await readFile(join(result.themes, "dark.json"), "utf8"), "original theme");
  assert.equal(await readFile(join(result.assets, "logo.txt"), "utf8"), "original asset");
  assert.equal(await readFile(join(result.exports, "template.html"), "utf8"), "original export template");
  assert.deepEqual(JSON.parse(await readFile(join(f.piPackageDir, "package.json"), "utf8")), f.original);
  assert.equal(await readFile(join(first.PI_PACKAGE_DIR, "README.md"), "utf8"), "Upstream README");
  const changes = await readFile(join(first.PI_PACKAGE_DIR, "CHANGELOG.md"), "utf8");
  const { parseChangelog } = await import(
    new URL("./utils/changelog.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
  );
  assert.deepEqual(parseChangelog(changes), []);
  assert.match(changes, /coworkos update --check/);
  assert.equal(await readFile(join(f.piPackageDir, "CHANGELOG.md"), "utf8"), "Upstream changes");
  assert.equal((await readdir(join(f.agentDir, ".atria-runtime"))).length, 1);
});

test("a corrupt immutable overlay is rejected and retained rather than rewritten", async (t) => {
  const f = await fixture(t),
    input = { ...f, version: "0.1.2" };
  const env = await ensureCliBranding(input);
  const path = join(env.PI_PACKAGE_DIR, "CHANGELOG.md");
  await writeFile(path, "Corrupted retained resource");
  await assert.rejects(ensureCliBranding(input), /资源校验失败/);
  assert.equal(await readFile(path, "utf8"), "Corrupted retained resource");
});

test("upgrading CoworkOS or relocating Pi creates a new overlay without mutating active sessions", async (t) => {
  const f = await fixture(t);
  const first = await ensureCliBranding({ ...f, version: "0.1.1" });
  const upgraded = await ensureCliBranding({ ...f, version: "0.1.2" });
  assert.notEqual(upgraded.PI_PACKAGE_DIR, first.PI_PACKAGE_DIR);
  assert.equal(
    JSON.parse(await readFile(join(first.PI_PACKAGE_DIR, "package.json"), "utf8")).version,
    "0.1.1"
  );
  assert.equal(
    JSON.parse(await readFile(join(upgraded.PI_PACKAGE_DIR, "package.json"), "utf8")).version,
    "0.1.2"
  );
  const other = await fixture(t);
  const relocated = await ensureCliBranding({
    agentDir: f.agentDir,
    piPackageDir: other.piPackageDir,
    version: "0.1.2"
  });
  assert.notEqual(relocated.PI_PACKAGE_DIR, upgraded.PI_PACKAGE_DIR);
  assert.equal(
    await readFile(join(first.PI_PACKAGE_DIR, "dist/modes/interactive/theme/dark.json"), "utf8"),
    "original theme"
  );
});

test("CLI quiet startup seeds only a missing preference and retains other settings", async (t) => {
  const f = await fixture(t);
  const projectDirectory = join(f.root, "project");
  await mkdir(projectDirectory);
  await mkdir(f.agentDir);
  const path = join(f.agentDir, "settings.json");
  await writeFile(path, JSON.stringify({ retry: { maxRetries: 5 }, theme: "dark" }));
  assert.equal(await ensureCliStartupSettings({ ...f, projectDirectory }), true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    retry: { maxRetries: 5 },
    theme: "dark",
    quietStartup: true
  });
  await writeFile(path, JSON.stringify({ quietStartup: false, retry: { maxRetries: 2 } }));
  assert.equal(await ensureCliStartupSettings({ ...f, projectDirectory }), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    quietStartup: false,
    retry: { maxRetries: 2 }
  });
});

test("CLI quiet startup preserves malformed settings instead of replacing them", async (t) => {
  const f = await fixture(t);
  const projectDirectory = join(f.root, "project");
  await mkdir(projectDirectory);
  await mkdir(f.agentDir);
  const path = join(f.agentDir, "settings.json");
  await writeFile(path, "{ broken preference");
  await assert.rejects(ensureCliStartupSettings({ ...f, projectDirectory }), /已保留原文件/);
  assert.equal(await readFile(path, "utf8"), "{ broken preference");
});

test("CLI quiet startup preserves an explicit project preference without adding a global override", async (t) => {
  const f = await fixture(t);
  const projectDirectory = join(f.root, "project");
  await mkdir(join(projectDirectory, ".pi"), { recursive: true });
  await mkdir(f.agentDir);
  const global = join(f.agentDir, "settings.json");
  const local = join(projectDirectory, ".pi/settings.json");
  await writeFile(global, JSON.stringify({ retry: { maxRetries: 2 } }));
  await writeFile(local, JSON.stringify({ quietStartup: false }));
  assert.equal(await ensureCliStartupSettings({ ...f, projectDirectory }), false);
  assert.deepEqual(JSON.parse(await readFile(global, "utf8")), { retry: { maxRetries: 2 } });
  assert.deepEqual(JSON.parse(await readFile(local, "utf8")), { quietStartup: false });
});
