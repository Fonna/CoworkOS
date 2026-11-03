import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { prepareDesktopComponents } from "../scripts/prepare-desktop-components.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const configPath = require.resolve("../electron-builder.config.cjs");
const blenderEntry = ".tools/blender-runtime/Blender.app/Contents/MacOS/Blender";
const requiredFiles = [
  ".tools/cadquery-runtime/bin/python3",
  ".tools/cadquery-runtime/atria-runtime.json",
  ".tools/cadquery-runtime/THIRD_PARTY_LICENSES.txt",
  blenderEntry,
  ".tools/blender-runtime/Blender.app/Contents/Resources/text/copyright.txt",
  ".tools/blender-runtime/Blender.app/Contents/Resources/text/license/license.md",
  ".tools/blender-runtime/Blender.app/Contents/Resources/text/license/licenses.json",
  "web/assets/pptist/generated/index.html",
  "web/assets/pptist/generated/LICENSE.txt",
  "web/assets/pptist/generated/source.tar.gz"
];

function config(mode) {
  const previous = process.env.ATRIA_PACKAGE_COMPONENTS;
  try {
    if (mode === undefined) delete process.env.ATRIA_PACKAGE_COMPONENTS;
    else process.env.ATRIA_PACKAGE_COMPONENTS = mode;
    delete require.cache[configPath];
    return require(configPath);
  } finally {
    if (previous === undefined) delete process.env.ATRIA_PACKAGE_COMPONENTS;
    else process.env.ATRIA_PACKAGE_COMPONENTS = previous;
    delete require.cache[configPath];
  }
}

async function fixture(t, { blender = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-full-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of requiredFiles) {
    if (!blender && file.includes("blender-runtime")) continue;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "fixture distribution material", { mode: 0o755 });
  }
  if (blender)
    await writeFile(join(root, blenderEntry), '#!/bin/sh\nprintf "Blender 4.5.11 LTS\\n"\n', { mode: 0o755 });
  return root;
}

test("default desktop keeps the licensed editor and prepares native components; full is explicit", async (t) => {
  const root = await fixture(t);
  const editor = join(root, "web/assets/pptist/generated/index.html");
  const metadata = await stat(editor);
  for (const mode of [undefined, "light"]) {
    const selected = config(mode);
    assert.equal(selected.extraMetadata.atriaBundledComponents, false);
    assert.equal(selected.extraMetadata.atriaBundledPptist, true);
    assert.equal(selected.extraMetadata.atriaAutoInstallComponents, true);
    assert.equal(
      new FileMatcher(root, "output", (pattern) => pattern, selected.files).createFilter()(editor, metadata),
      true
    );
    assert.equal(
      selected.extraResources.some(({ to }) => ["cadquery", "blender"].includes(to)),
      false
    );
    assert.equal(selected.beforePack, undefined);
  }
  const full = config("full");
  assert.equal(full.extraMetadata.atriaBundledComponents, true);
  assert.equal(full.extraMetadata.atriaAutoInstallComponents, false);
  for (const id of ["cadquery", "blender"]) assert.ok(full.extraResources.some(({ to }) => to === id));
  await full.beforePack({ packager: { info: { appDir: root } } });
  const base = config("base");
  assert.equal(base.extraMetadata.atriaBundledComponents, false);
  assert.equal(base.extraMetadata.atriaBundledPptist, false);
  assert.equal(base.extraMetadata.atriaAutoInstallComponents, false);
  assert.equal(
    new FileMatcher(root, "output", (pattern) => pattern, base.files).createFilter()(editor, metadata),
    false
  );
  assert.equal(
    base.extraResources.some(({ to }) => ["cadquery", "blender"].includes(to)),
    false
  );
  assert.equal(base.beforePack, undefined);
});

test("full packaging refuses each missing runtime or required license/source file before copying", async (t) => {
  const root = await fixture(t);
  const selected = config("full");
  for (const file of requiredFiles) {
    const location = join(root, file);
    const original = await readFile(location);
    await rm(location);
    await assert.rejects(selected.beforePack({ packager: { info: { appDir: root } } }), (error) =>
      error.message.includes(file)
    );
    await writeFile(location, original, { mode: 0o755 });
  }
});

test("desktop preparation reuses a pinned Blender runtime without downloading or accessing credentials", async (t) => {
  const root = await fixture(t);
  await prepareDesktopComponents({
    root,
    installer: {
      BLENDER_INSTALL_SOURCE: { file: "blender-4.5.11-macos-arm64.dmg" },
      installBlenderRuntime: async () => assert.fail("the verified runtime must be reused")
    }
  });
  await writeFile(join(root, blenderEntry), '#!/bin/sh\nprintf "Blender 4.4.0\\n"\n', { mode: 0o755 });
  await assert.rejects(
    prepareDesktopComponents({
      root,
      installer: {
        BLENDER_INSTALL_SOURCE: { file: "blender-4.5.11-macos-arm64.dmg" },
        installBlenderRuntime: async () => assert.fail("a cached runtime cannot be replaced silently")
      }
    }),
    /Bundled Blender must be 4.5.11; found 4.4.0/
  );
  assert.match((await execute(join(root, blenderEntry), ["--version"])).stdout, /4.4.0/);
});

test("desktop preparation installs missing Blender into build storage and propagates installation failure", async (t) => {
  const root = await fixture(t, { blender: false });
  const installer = {
    BLENDER_INSTALL_SOURCE: { file: "blender-4.5.11-macos-arm64.dmg" },
    installBlenderRuntime: async () => {
      throw new Error("fixture download failed");
    }
  };
  await assert.rejects(prepareDesktopComponents({ root, installer }), /fixture download failed/);
  let calls = 0;
  installer.installBlenderRuntime = async ({ directory }) => {
    calls++;
    assert.equal(directory, join(root, ".tools/blender-runtime"));
    for (const file of requiredFiles.filter((file) => file.includes("blender-runtime"))) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "fixture material", { mode: 0o755 });
    }
    await writeFile(join(root, blenderEntry), '#!/bin/sh\nprintf "Blender 4.5.11 LTS\\n"\n', { mode: 0o755 });
  };
  await prepareDesktopComponents({ root, installer });
  assert.equal(calls, 1);
});
