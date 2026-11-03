import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopSmokeEnvironment, prepareDesktopSmokeComponents } from "../scripts/desktop-smoke-env.mjs";

test("packaged smoke excludes inherited data/model/credential overrides while leaving caller HOME intact", () => {
  const source = {
    HOME: "/fixture/original-home",
    TMPDIR: "/fixture/tmp",
    PATH: "/fixture/node/bin",
    ATRIA_HOME: "/fixture/not-the-smoke",
    ATRIA_DESKTOP_APP: "/fixture/not-the-candidate",
    ATRIA_COMPONENTS_HOME: "/fixture/not-the-components",
    ATRIA_COMPONENTS_RELEASE_ROOT: "https://fixture.invalid/not-the-release",
    ATRIA_COMPONENTS_GITHUB_TOKEN: "fixture-only-component-token",
    COWORK_CONFIG: "/fixture/not-the-config",
    COWORK_API_KEY: "fixture-only-key",
    COWORK_BLENDER_EXECUTABLE: "/fixture/not-the-runtime",
    PI_CODING_AGENT_DIR: "/fixture/not-the-pi",
    PI_MODEL: "fixture-not-the-model",
    OPENAI_API_KEY: "fixture-only-provider",
    ANTHROPIC_AUTH_TOKEN: "fixture-only-token",
    GOOGLE_API_KEY: "fixture-only-speech-key",
    OTHER_API_KEY: "fixture-only-other-key",
    AWS_SHARED_CREDENTIALS_FILE: "/fixture/not-the-credentials",
    CSC_LINK: "fixture-only-certificate",
    APPLE_KEYCHAIN_PROFILE: "fixture-only-profile",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "fixture-only-node-options"
  };
  const original = { ...source };
  const env = desktopSmokeEnvironment({ data: "/fixture/owned-data", source });
  assert.deepEqual(source, original);
  assert.deepEqual(env, {
    HOME: "/fixture/original-home",
    TMPDIR: "/fixture/tmp",
    PATH: "/usr/bin:/bin",
    ATRIA_HOME: "/fixture/owned-data",
    COWORK_DESKTOP_DATA: "/fixture/owned-data",
    PI_CODING_AGENT_DIR: "/fixture/owned-data/pi",
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-smoke-components-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("full packaged smoke keeps bundled components and never creates managed component storage", async (t) => {
  const data = await fixture(t);
  const result = await prepareDesktopSmokeComponents({
    data,
    metadata: { atriaBundledComponents: true, atriaAutoInstallComponents: true, atriaBundledPptist: false }
  });
  assert.deepEqual(result, { mode: "full", nativeComponents: true, pptist: true });
  await assert.rejects(stat(join(data, "components")), { code: "ENOENT" });
});

test("light and base packaged smoke persist disabled native components in their own data directories", async (t) => {
  for (const [metadata, expected] of [
    [
      { atriaBundledComponents: false, atriaAutoInstallComponents: true, atriaBundledPptist: true },
      { mode: "light", nativeComponents: false, pptist: true }
    ],
    [
      { atriaAutoInstallComponents: true, atriaBundledPptist: false },
      { mode: "light", nativeComponents: false, pptist: false }
    ],
    [
      { atriaBundledComponents: false, atriaAutoInstallComponents: false, atriaBundledPptist: false },
      { mode: "base", nativeComponents: false, pptist: false }
    ],
    [
      { atriaAutoInstallComponents: false, atriaBundledPptist: true },
      { mode: "base", nativeComponents: false, pptist: true }
    ],
    [{}, { mode: "base", nativeComponents: false, pptist: false }]
  ]) {
    const data = await fixture(t);
    assert.deepEqual(await prepareDesktopSmokeComponents({ data, metadata }), expected);
    for (const id of ["cadquery", "blender"]) {
      const file = join(data, "components", id, "current.json");
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { enabled: false });
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    await assert.rejects(stat(join(data, "components/pptist")), { code: "ENOENT" });
  }
});

test("smoke component preparation refuses to overwrite existing managed state", async (t) => {
  const data = await fixture(t);
  const directory = join(data, "components/cadquery");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "current.json");
  const original = JSON.stringify({ enabled: true, apiVersion: 1, version: "fixture-existing" });
  await writeFile(file, original, { mode: 0o600 });
  await assert.rejects(
    prepareDesktopSmokeComponents({ data, metadata: { atriaAutoInstallComponents: true } }),
    { code: "EEXIST" }
  );
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("only the explicitly discovered public Blender runtime reaches the child", () => {
  const env = desktopSmokeEnvironment({
    data: "/fixture/owned-data",
    source: { COWORK_BLENDER_EXECUTABLE: "/fixture/inherited-runtime" },
    blenderExecutable: "/fixture/public-runtime/Blender"
  });
  assert.equal(env.COWORK_BLENDER_EXECUTABLE, "/fixture/public-runtime/Blender");
  assert.equal(env.ATRIA_HOME, "/fixture/owned-data");
});
