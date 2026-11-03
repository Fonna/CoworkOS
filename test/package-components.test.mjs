import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const script = new URL("../scripts/package-components.mjs", import.meta.url).pathname;
test("component packaging counts the archived source root through a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-components-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifests = [];
  for (const linked of [false, true]) {
    const cwd = join(root, linked ? "linked" : "direct");
    const runtime = linked ? join(root, "runtime") : join(cwd, ".tools/cadquery-runtime");
    await mkdir(join(cwd, ".tools"), { recursive: true });
    await mkdir(join(runtime, "bin"), { recursive: true });
    await writeFile(join(runtime, "bin/python3"), "real fixture bytes");
    await symlink("python3", join(runtime, "bin/python"));
    if (linked) await symlink(runtime, join(cwd, ".tools/cadquery-runtime"));
    await mkdir(join(cwd, "web/assets/pptist/generated"), { recursive: true });
    await writeFile(join(cwd, "web/assets/pptist/generated/index.html"), "editor fixture");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ version: "0.1.2-beta.9" }));
    execFileSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, ATRIA_PACKAGE_DIR: join(cwd, "output") }
    });
    const manifest = JSON.parse(
      await readFile(join(cwd, "output/atria-components-darwin-arm64.json"), "utf8")
    );
    manifests.push(manifest);
    const cad = manifest.artifacts.find((a) => a.id === "cadquery");
    assert.equal(cad.installedBytes, Buffer.byteLength("real fixture bytes") + Buffer.byteLength("python3"));
    const extracted = join(cwd, "extracted");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", join(cwd, "output", cad.file), "-C", extracted]);
    assert.equal(await readFile(join(extracted, "bin/python"), "utf8"), "real fixture bytes");
  }
  assert.deepEqual(
    manifests[0].artifacts.map((a) => a.installedBytes),
    manifests[1].artifacts.map((a) => a.installedBytes)
  );
});
