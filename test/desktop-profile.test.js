import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
const { desktopProfile } = createRequire(import.meta.url)("../desktop/profile.cjs");

test("source, Finder development and release apps share one user home and instance lock", () => {
  const source = desktopProfile({ isPackaged: false, appRoot: "/checkout", appData: "/profiles", env: {} });
  const finder = desktopProfile({
    isPackaged: true,
    appRoot: "/dev-bootstrap",
    appData: "/profiles",
    env: {
      COWORK_DESKTOP_DEV: "1",
      COWORK_DESKTOP_SOURCE_ROOT: "/checkout"
    }
  });
  assert.deepEqual(source, finder);
  assert.equal(source.name, "CoworkOS Dev");
  assert.equal(source.userData, join(homedir(), ".atria"));
  assert.equal(source.canMigrateLegacy, true);
  assert.equal(source.legacyUserData, "/profiles/Atria Dev");
  const release = desktopProfile({
    isPackaged: true,
    appRoot: "/release",
    appData: "/profiles",
    env: { COWORK_DESKTOP_SOURCE_ROOT: "/checkout" }
  });
  assert.equal(release.name, "CoworkOS");
  assert.equal(source.encryptionName, release.encryptionName);
  assert.equal(release.encryptionName, "Atria");
  assert.equal(release.userData, source.userData);
  assert.equal(release.canMigrateLegacy, true);
  assert.equal(release.legacyUserData, "/profiles/Atria");
  assert.equal(release.appRoot, "/release");
});

test("ATRIA_HOME moves release and development together, while explicit desktop test data wins", () => {
  const base = { appRoot: "/checkout", appData: "/profiles" };
  assert.equal(
    desktopProfile({ ...base, isPackaged: true, env: { ATRIA_HOME: "/shared" } }).userData,
    "/shared"
  );
  assert.equal(
    desktopProfile({ ...base, isPackaged: false, env: { ATRIA_HOME: "/shared" } }).userData,
    "/shared"
  );
  assert.equal(
    desktopProfile({
      ...base,
      isPackaged: false,
      env: { ATRIA_HOME: "/shared", COWORK_DESKTOP_DATA: "/fixture" }
    }).userData,
    "/fixture"
  );
});

test("explicit desktop data overrides remain available to isolated native tests", () => {
  const profile = desktopProfile({
    isPackaged: false,
    appRoot: "/checkout",
    appData: "/profiles",
    env: { COWORK_DESKTOP_DATA: "/fixture" }
  });
  assert.equal(profile.userData, "/fixture");
  assert.equal(profile.canMigrateLegacy, false);
});

test("explicit home overrides leave legacy profiles untouched", () => {
  const base = { appRoot: "/checkout", appData: "/profiles" };
  for (const isPackaged of [true, false]) {
    for (const env of [
      { ATRIA_HOME: "/isolated-home" },
      { COWORK_DESKTOP_DATA: "/isolated-desktop" },
      { ATRIA_HOME: "/isolated-home", COWORK_DESKTOP_DATA: "/isolated-desktop" }
    ]) {
      const profile = desktopProfile({ ...base, isPackaged, env });
      assert.equal(profile.canMigrateLegacy, false);
      assert.equal(profile.legacyUserData, isPackaged ? "/profiles/Atria" : "/profiles/Atria Dev");
    }
  }
});
