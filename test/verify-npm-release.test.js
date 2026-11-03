import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyNpmRelease } from "../scripts/verify-npm-release.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "coworkos-npm-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = "0.1.3";
  const packages = ["coworkos-desktop-darwin-arm64", "coworkos-app"];
  const metadata = new Map();
  for (const name of packages) {
    const bytes = Buffer.from(`archive for ${name}`);
    await writeFile(join(directory, `${name}-${version}.tgz`), bytes);
    metadata.set(name, {
      name,
      version,
      dist: { integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") }
    });
  }
  return { directory, version, metadata };
}

test("npm verification waits for processing and checks exact archive integrity", async (t) => {
  const f = await fixture(t);
  let round = 0;
  await verifyNpmRelease({
    ...f,
    attempts: 2,
    wait: async () => {
      round++;
    },
    fetchImpl: async (url) => {
      if (!round) return { status: 404 };
      const name = new URL(url).pathname.split("/")[1];
      return { status: 200, ok: true, json: async () => f.metadata.get(name) };
    }
  });
  assert.equal(round, 1);
});

test("npm verification rejects different published content without retrying", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyNpmRelease({
      ...f,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          name: "coworkos-desktop-darwin-arm64",
          version: f.version,
          dist: { integrity: "wrong" }
        })
      }),
      wait: () => assert.fail("integrity failures must stop immediately")
    }),
    /differs from the verified candidate/
  );
});

test("npm processing exhaustion points to verification-only recovery", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyNpmRelease({ ...f, attempts: 1, fetchImpl: async () => ({ status: 404 }) }),
    /verify_only=true/
  );
});
