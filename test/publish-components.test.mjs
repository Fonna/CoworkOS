import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishComponents } from "../scripts/publish-components.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-public-components-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "release"),
    sources = join(root, "sources");
  await mkdir(directory);
  await mkdir(sources);
  const artifacts = [];
  for (const id of ["cadquery", "pptist", "blender"]) {
    const file = `${id}.${id === "blender" ? "dmg" : "tar.gz"}`,
      bytes = Buffer.from(`fixture ${id}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, file), bytes);
    await writeFile(join(directory, `${file}.sha256`), `${sha256}  ${file}\n`);
    artifacts.push({
      id,
      apiVersion: 1,
      hostVersion: "*",
      version: "1.0.0",
      platform: id === "pptist" ? "any" : "darwin-arm64",
      file,
      sha256,
      downloadBytes: bytes.length,
      installedBytes: bytes.length
    });
  }
  await writeFile(
    join(directory, "atria-components-darwin-arm64.json"),
    JSON.stringify({ schemaVersion: 1, hostVersion: "*", artifacts })
  );
  const sourceBytes = Buffer.from("fixture corresponding source");
  await writeFile(join(sources, "source.tar.gz"), sourceBytes);
  await writeFile(
    join(sources, "SOURCE_MANIFEST.json"),
    JSON.stringify({
      schemaVersion: 1,
      componentRelease: "components-v1",
      assets: [
        {
          file: "source.tar.gz",
          bytes: sourceBytes.length,
          sha256: createHash("sha256").update(sourceBytes).digest("hex")
        }
      ]
    })
  );
  await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), "fixture third-party notices");
  // A private checkout file must never enter the explicit upload list.
  await writeFile(join(directory, "config.json"), "private fixture");
  return {
    root,
    directory,
    sources,
    target: { COMPONENT_REPOSITORY: "example/components", COMPONENT_RELEASE_TAG: "components-v1" }
  };
}

test("publication verifies runtime and corresponding source before uploading an explicit asset list", async (t) => {
  const f = await fixture(t),
    calls = [];
  const result = await publishComponents({
    ...f,
    commandRunner: async (command, args) => {
      assert.equal(command, "gh");
      calls.push(args);
      return { stdout: args[0] === "api" ? "[]" : "" };
    }
  });
  assert.equal(result, "https://github.com/example/components/releases/tag/components-v1");
  assert.ok(calls.find((args) => args[1] === "create")?.includes("--draft"));
  const uploads = calls.filter((args) => args[1] === "upload");
  assert.equal(uploads.length, 10);
  assert.ok(uploads.every((args) => !args[3].endsWith("config.json")));
  assert.ok(uploads.some((args) => args[3].endsWith("SOURCE_MANIFEST.json")));
  assert.equal(calls.at(-1)[1], "edit");
  assert.ok(calls.at(-1).includes("--draft=false"));
});

test("corrupted archives and missing source materials never make network publication calls", async (t) => {
  const f = await fixture(t);
  const commandRunner = async () => assert.fail("invalid files must be rejected before GitHub access");
  await writeFile(join(f.directory, "cadquery.tar.gz"), "corrupt");
  await assert.rejects(publishComponents({ ...f, commandRunner }), /checksum mismatch/);
  const second = await fixture(t);
  await rm(join(second.sources, "SOURCE_MANIFEST.json"));
  await assert.rejects(publishComponents({ ...second, commandRunner }), /ENOENT/);
});

test("incompatible catalogs, source release mismatches and filename collisions fail before GitHub access", async (t) => {
  const commandRunner = async () => assert.fail("invalid publication must fail before GitHub access");
  for (const patch of [
    { platform: "linux-x64" },
    { version: "../unsafe" },
    { installedBytes: 0 },
    { file: "cadquery.zip" }
  ]) {
    const f = await fixture(t);
    const path = join(f.directory, "atria-components-darwin-arm64.json");
    const catalog = JSON.parse(await readFile(path, "utf8"));
    Object.assign(catalog.artifacts[0], patch);
    await writeFile(path, JSON.stringify(catalog));
    await assert.rejects(publishComponents({ ...f, commandRunner }), /incompatible metadata/);
  }
  const f = await fixture(t);
  const path = join(f.sources, "SOURCE_MANIFEST.json");
  const source = JSON.parse(await readFile(path, "utf8"));
  source.componentRelease = "components-v0";
  await writeFile(path, JSON.stringify(source));
  await assert.rejects(publishComponents({ ...f, commandRunner }), /source materials/);
  source.componentRelease = "components-v1";
  source.assets.push(source.assets[0]);
  await writeFile(path, JSON.stringify(source));
  await assert.rejects(publishComponents({ ...f, commandRunner }), /Duplicate publication filenames/);
});

test("runtime symlinks cannot publish files from outside the prepared directory", async (t) => {
  const f = await fixture(t);
  const archive = join(f.directory, "cadquery.tar.gz");
  const outside = join(f.root, "private-data");
  await writeFile(outside, await readFile(archive));
  await rm(archive);
  await symlink(outside, archive);
  await assert.rejects(
    publishComponents({
      ...f,
      commandRunner: async () => assert.fail("symlinks must fail before GitHub access")
    }),
    /regular file/
  );
});

test("resumed drafts cannot expose stale unrelated assets", async (t) => {
  const f = await fixture(t);
  const calls = [];
  await assert.rejects(
    publishComponents({
      ...f,
      commandRunner: async (_command, args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify([
            { tag_name: "components-v1", draft: true, assets: [{ name: "config.json" }] }
          ])
        };
      }
    }),
    /unexpected assets/
  );
  assert.equal(calls.length, 1);
});

test("published component releases cannot be overwritten", async (t) => {
  const f = await fixture(t),
    calls = [];
  await assert.rejects(
    publishComponents({
      ...f,
      commandRunner: async (_command, args) => {
        calls.push(args);
        return { stdout: JSON.stringify([{ tag_name: "components-v1", draft: false }]) };
      }
    }),
    /already published/
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "api");
});
