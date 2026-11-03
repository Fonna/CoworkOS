import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import {
  macUpdateArtifacts,
  macUpdateFeed,
  verifyDeveloperIdApplication,
  writeMacUpdateFeed
} from "../scripts/update-feed.mjs";

const metadata = {
  version: "1.2.3",
  lockVersion: "1.2.3",
  tag: "v1.2.3",
  repository: "example/atria"
};
const publication = {
  ...metadata,
  sha256: "a".repeat(64),
  size: 100,
  pubDate: "2026-01-01T00:00:00.000Z",
  notes: "Fixture release notes"
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atria-update-feed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, macUpdateArtifacts(metadata).zipName);
  return { directory, archive };
}

test("Mac feed uses Squirrel's static JSON schema and version-bound GitHub asset", () => {
  const feed = macUpdateFeed(publication);
  assert.deepEqual(feed, {
    currentRelease: "1.2.3",
    releases: [
      {
        version: "1.2.3",
        updateTo: {
          version: "1.2.3",
          url: "https://github.com/example/atria/releases/download/v1.2.3/CoworkOS-1.2.3-mac-arm64.zip",
          name: "CoworkOS 1.2.3",
          notes: publication.notes,
          pub_date: publication.pubDate,
          sha256: publication.sha256,
          size: publication.size
        }
      }
    ]
  });
  const preview = macUpdateArtifacts({
    version: "1.3.0-beta.1+fixture",
    repository: { url: "git+https://github.com/example/atria-next.git" }
  });
  assert.equal(preview.repository, "example/atria-next");
  assert.equal(
    preview.zipUrl,
    "https://github.com/example/atria-next/releases/download/v1.3.0-beta.1%2Bfixture/CoworkOS-1.3.0-beta.1%2Bfixture-mac-arm64.zip"
  );
});

test("Mac feed refuses mismatched versions/tags and unsafe repository inputs", () => {
  for (const changes of [
    { version: "../1.2.3" },
    { version: "1.2.3-01", lockVersion: "1.2.3-01", tag: "v1.2.3-01" },
    { version: "1.2.3\n" },
    { lockVersion: "1.2.2" },
    { tag: "v1.2.4" },
    { repository: "https://untrusted.invalid/example/atria" },
    { repository: "example/atria?token=fixture" },
    { repository: "example/../atria" }
  ]) {
    assert.throws(() => macUpdateArtifacts({ ...metadata, ...changes }));
  }
});

test("Mac feed rejects invalid hash, archive bounds, date and unbounded notes", () => {
  for (const changes of [
    { sha256: "a".repeat(63) },
    { sha256: "g".repeat(64) },
    { sha256: "A".repeat(64) },
    { sha256: null },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: "100" },
    { size: 2 * 1024 ** 3 + 1 },
    { pubDate: "2026-01-01" },
    { pubDate: "2026-01-01Tinvalid" },
    { pubDate: new Date("invalid") },
    { pubDate: 0 },
    { notes: "bad\0notes" },
    { notes: "a".repeat(10001) },
    { notes: {} }
  ]) {
    assert.throws(() => macUpdateFeed({ ...publication, ...changes }));
  }
  const atLimit = macUpdateFeed({ ...publication, size: 2 * 1024 ** 3 });
  assert.equal(atLimit.releases[0].updateTo.size, 2 * 1024 ** 3);
});

test("feed and checksum are derived from the real archive bytes", async (t) => {
  const { directory, archive } = await fixture(t);
  const zip = new JSZip();
  zip.file("CoworkOS.app/Contents/fixture.txt", "Isolated archive fixture");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(archive, bytes);
  const result = await writeMacUpdateFeed({ archive, ...metadata, pubDate: publication.pubDate });
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(result.sha256, expected);
  assert.equal(result.size, bytes.length);
  assert.equal(await readFile(result.checksum, "utf8"), `${expected}  CoworkOS-1.2.3-mac-arm64.zip\n`);
  const feed = JSON.parse(await readFile(result.feed, "utf8"));
  assert.equal(feed.currentRelease, metadata.version);
  assert.equal(feed.releases[0].updateTo.sha256, expected);
  assert.equal(feed.releases[0].updateTo.size, bytes.length);
  assert.equal(feed.releases[0].updateTo.notes, "CoworkOS 1.2.3");
  assert.deepEqual((await readdir(directory)).sort(), [
    "CoworkOS-1.2.3-mac-arm64.zip",
    "CoworkOS-1.2.3-mac-arm64.zip.sha256",
    "atria-update-mac-arm64.json"
  ]);
  zip.file("CoworkOS.app/Contents/fixture.txt", "Changed archive bytes");
  const changed = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(archive, changed);
  const next = await writeMacUpdateFeed({ archive, ...metadata, pubDate: publication.pubDate });
  assert.notEqual(next.sha256, expected);
  assert.equal(next.sha256, createHash("sha256").update(changed).digest("hex"));
});

test("invalid archive or publication cannot create checksum/feed files", async (t) => {
  const { directory, archive } = await fixture(t);
  await writeFile(archive, "fixture bytes");
  await assert.rejects(writeMacUpdateFeed({ archive, ...metadata, tag: "v9.9.9" }), /Release tag/);
  await assert.rejects(writeMacUpdateFeed({ archive, ...metadata, pubDate: "invalid" }), /publication date/);
  await assert.rejects(
    writeMacUpdateFeed({ archive: join(directory, "wrong-version.zip"), ...metadata }),
    /filename/
  );
  assert.deepEqual(await readdir(directory), ["CoworkOS-1.2.3-mac-arm64.zip"]);
  await writeFile(archive, "");
  await assert.rejects(writeMacUpdateFeed({ archive, ...metadata }), /regular ZIP/);
  await rm(archive);
  await mkdir(archive);
  await assert.rejects(writeMacUpdateFeed({ archive, ...metadata }), /regular ZIP/);
  await rm(archive, { recursive: true });
  const target = join(directory, "target.zip");
  await writeFile(target, "fixture bytes");
  await symlink(target, archive);
  await assert.rejects(writeMacUpdateFeed({ archive, ...metadata }), /regular ZIP/);
  assert.deepEqual((await readdir(directory)).sort(), ["CoworkOS-1.2.3-mac-arm64.zip", "target.zip"]);
});

test("Developer ID gate requires a successful verification and Apple distribution authority", async () => {
  const calls = [];
  const app = "/fixture/CoworkOS.app";
  const commandRunner = async (command, args) => {
    calls.push({ command, args });
    return args.includes("--display")
      ? { stdout: "", stderr: "Authority=Developer ID Application: Fixture Team (EXAMPLE)\n" }
      : { stdout: "", stderr: "" };
  };
  await verifyDeveloperIdApplication(app, commandRunner);
  assert.deepEqual(calls, [
    { command: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", app] },
    { command: "/usr/bin/codesign", args: ["--display", "--verbose=4", app] }
  ]);
});

test("signature verification failure, ad-hoc and development certificates cannot pass the ZIP gate", async () => {
  let displayCalled = false;
  await assert.rejects(
    verifyDeveloperIdApplication("/fixture/CoworkOS.app", async (_command, args) => {
      if (args.includes("--verify")) throw new Error("fixture tampered signature");
      displayCalled = true;
      return { stderr: "Authority=Developer ID Application: Fixture Team\n" };
    }),
    /valid Developer ID Application signature/
  );
  assert.equal(displayCalled, false);
  for (const certificate of [
    "Signature=adhoc\n",
    "Authority=Apple Development: Fixture Team\n",
    "Authority=Developer ID Installer: Fixture Team\n",
    "untrusted output Authority=Developer ID Application: Fixture Team\n",
    ""
  ]) {
    await assert.rejects(
      verifyDeveloperIdApplication("/fixture/CoworkOS.app", async () => ({ stderr: certificate })),
      /valid Developer ID Application signature/
    );
  }
  await assert.rejects(
    verifyDeveloperIdApplication("/fixture/CoworkOS.app", async (_command, args) => {
      if (args.includes("--display")) throw new Error("fixture display failure");
      return {};
    }),
    /valid Developer ID Application signature/
  );
});

test("builder configuration disables implicit signing and permits explicitly required Developer ID signing", () => {
  const require = createRequire(import.meta.url);
  const configPath = require.resolve("../electron-builder.config.cjs");
  const prior = process.env.CSC_NAME;
  try {
    delete process.env.CSC_NAME;
    delete require.cache[configPath];
    const unsigned = require(configPath);
    assert.equal(unsigned.mac.identity, null);
    assert.equal(unsigned.forceCodeSigning, false);
    process.env.CSC_NAME = "Fixture Team (EXAMPLE)";
    delete require.cache[configPath];
    const signed = require(configPath);
    assert.equal(Object.hasOwn(signed.mac, "identity"), false);
    assert.equal(signed.forceCodeSigning, true);
    assert.equal(signed.publish, null);
  } finally {
    if (prior === undefined) delete process.env.CSC_NAME;
    else process.env.CSC_NAME = prior;
    delete require.cache[configPath];
  }
});
