import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { isSignedMacApplication } = createRequire(import.meta.url)("../desktop/update-signature.cjs");
const executable = "/Applications/CoworkOS Fixture.app/Contents/MacOS/CoworkOS";
const bundle = "/Applications/CoworkOS Fixture.app";
const developerId =
  "Authority=Developer ID Application: CoworkOS Fixture (FIXTURE123)\nAuthority=Developer ID Certification Authority\n";

test("only a verified Developer ID application enables the native update path", async () => {
  const calls = [];
  const result = await isSignedMacApplication(executable, {
    platform: "darwin",
    async commandRunner(input) {
      calls.push(input);
      return input.args[0] === "--display" ? { stdout: "", stderr: developerId } : { stdout: "", stderr: "" };
    }
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [
    { command: "/usr/bin/codesign", args: ["--display", "--verbose=4", bundle] },
    { command: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", bundle] }
  ]);
});

test("ad-hoc and other certificate types preserve the verified DMG fallback", async (t) => {
  const descriptions = [
    "Signature=adhoc\n",
    "Authority=Apple Development: Fixture (FIXTURE123)\n",
    "Authority=Developer ID Installer: Fixture (FIXTURE123)\n",
    "Authority=Developer ID Application:\n",
    "note: Authority=Developer ID Application: untrusted text\n",
    ""
  ];
  for (const [index, stderr] of descriptions.entries()) {
    await t.test(`certificate ${index}`, async () => {
      let commands = 0;
      assert.equal(
        await isSignedMacApplication(executable, {
          platform: "darwin",
          commandRunner: async () => {
            commands++;
            return { stderr };
          }
        }),
        false
      );
      assert.equal(commands, 1, "unsupported certificates do not enable verification or updates");
    });
  }
});

test("failed display or strict signature verification never enables automatic installation", async (t) => {
  for (const failAt of ["--display", "--verify"]) {
    await t.test(failAt, async () => {
      assert.equal(
        await isSignedMacApplication(executable, {
          platform: "darwin",
          commandRunner: async ({ args }) => {
            if (args[0] === failAt) throw new Error("codesign failed");
            return { stderr: developerId };
          }
        }),
        false
      );
    });
  }
});

test("unsupported platforms and invalid executable paths never invoke host commands", async (t) => {
  for (const [index, options] of [
    { platform: "linux", executable },
    { platform: "win32", executable },
    { platform: "darwin", executable: "relative/CoworkOS" },
    { platform: "darwin", executable: "/fixture/CoworkOS" },
    { platform: "darwin", executable: "/fixture/Other/Contents/MacOS/CoworkOS" },
    { platform: "darwin", executable: "/fixture/CoworkOS.app/Resources/MacOS/CoworkOS" },
    { platform: "darwin", executable: "" },
    { platform: "darwin", executable: undefined },
    { platform: "darwin", executable: `${executable}\0other` }
  ].entries()) {
    await t.test(`invalid platform or path ${index}`, async () => {
      let calls = 0;
      assert.equal(
        await isSignedMacApplication(options.executable, {
          platform: options.platform,
          commandRunner: async () => calls++
        }),
        false
      );
      assert.equal(calls, 0);
    });
  }
});
