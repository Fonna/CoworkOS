import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const { backendExecutable } = createRequire(import.meta.url)("../desktop/backend-executable.cjs");

test("Mac workers select the accessory helper and leave ordinary Node executables alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-worker-policy-"));
  try {
    const executable = join(root, "CoworkOS.app/Contents/MacOS/CoworkOS");
    const contents = join(root, "CoworkOS.app/Contents/Frameworks/CoworkOS Helper.app/Contents");
    const helper = join(contents, "MacOS/CoworkOS Helper");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await writeFile(helper, "fixture", { mode: 0o700 });
    await writeFile(join(contents, "Info.plist"), "<dict><key>LSUIElement</key><true/></dict>");
    assert.equal(backendExecutable(executable, "darwin"), helper);
    assert.equal(backendExecutable(executable, "linux"), executable);
    assert.equal(backendExecutable("/usr/local/bin/node", "darwin"), "/usr/local/bin/node");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken or regular helper cannot silently launch a second foreground application", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-worker-missing-"));
  try {
    const executable = join(root, "CoworkOS.app/Contents/MacOS/CoworkOS");
    assert.throws(() => backendExecutable(executable, "darwin"), /后台运行时/);
    assert.equal(backendExecutable(executable, "darwin", join(root, "development")), executable);
    assert.throws(
      () => backendExecutable(executable, "darwin", join(root, "CoworkOS.app/Contents/Resources/app")),
      /后台运行时/
    );
    const contents = join(root, "CoworkOS.app/Contents/Frameworks/CoworkOS Helper.app/Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await writeFile(join(contents, "MacOS/CoworkOS Helper"), "fixture", { mode: 0o700 });
    await writeFile(join(contents, "Info.plist"), "<dict><key>LSUIElement</key><false/></dict>");
    assert.throws(() => backendExecutable(executable, "darwin"), /后台运行时/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
