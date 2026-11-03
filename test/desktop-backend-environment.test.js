import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { desktopBackendEnvironment } = createRequire(import.meta.url)("../desktop/backend-environment.cjs");
const finderPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const posixFixture = { skip: process.platform === "win32" && "macOS PATH fixtures need POSIX directories" };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "atria-desktop-env-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const localBin = join(home, ".local/bin");
  const officeBin = join(home, "Applications/LibreOffice.app/Contents/MacOS");
  await mkdir(localBin, { recursive: true });
  await mkdir(officeBin, { recursive: true });
  return { home, localBin, officeBin };
}

test(
  "Finder PATH discovers local executables before system Python and preserves other variables",
  posixFixture,
  async (t) => {
    const f = await fixture(t);
    for (const tool of ["node", "python3", "fc-list"]) {
      await writeFile(join(f.localBin, tool), `#!/bin/sh\nprintf '${tool}-fixture\\n'\n`, {
        mode: 0o700
      });
    }
    await writeFile(join(f.officeBin, "atria-office-fixture"), "#!/bin/sh\nprintf 'soffice-fixture\\n'\n", {
      mode: 0o700
    });
    const source = { HOME: f.home, PATH: finderPath, COWORK_PYTHON_PATH: "/explicit/python" };
    const environment = desktopBackendEnvironment(source, "darwin");
    assert.deepEqual(source, {
      HOME: f.home,
      PATH: finderPath,
      COWORK_PYTHON_PATH: "/explicit/python"
    });
    assert.equal(environment.COWORK_PYTHON_PATH, "/explicit/python");
    assert.ok(environment.PATH.startsWith(`${f.localBin}:`));
    assert.ok(environment.PATH.endsWith(`:${finderPath}`));
    for (const directory of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      const installed = await stat(directory).then(
        (entry) => entry.isDirectory(),
        () => false
      );
      if (installed) {
        const entries = environment.PATH.split(":");
        assert.ok(entries.includes(directory));
        assert.ok(entries.indexOf(directory) < entries.indexOf("/usr/bin"));
      }
    }
    if (process.platform !== "win32") {
      const command = spawnSync("/bin/sh", ["-c", "node; python3; fc-list; atria-office-fixture"], {
        env: environment,
        encoding: "utf8"
      });
      assert.equal(command.status, 0, command.stderr);
      assert.equal(command.stdout, "node-fixture\npython3-fixture\nfc-list-fixture\nsoffice-fixture\n");
    }
  }
);

test(
  "an explicit custom PATH retains interpreter precedence, separators and existing entries",
  posixFixture,
  async (t) => {
    const f = await fixture(t);
    const customBin = join(f.home, "chosen-bin");
    await mkdir(customBin);
    await writeFile(join(customBin, "python3"), "#!/bin/sh\nprintf 'chosen-python\\n'\n", {
      mode: 0o700
    });
    await writeFile(join(f.localBin, "python3"), "#!/bin/sh\nprintf 'fallback-python\\n'\n", {
      mode: 0o700
    });
    const explicitPath = `${customBin}:${finderPath}::${f.localBin}`;
    const environment = desktopBackendEnvironment({ HOME: f.home, PATH: explicitPath }, "darwin");
    assert.ok(environment.PATH.startsWith(`${explicitPath}:`));
    assert.equal(environment.PATH.split(":").filter((directory) => directory === f.localBin).length, 1);
    if (process.platform !== "win32") {
      const command = spawnSync("python3", [], { env: environment, encoding: "utf8" });
      assert.equal(command.status, 0, command.stderr);
      assert.equal(command.stdout, "chosen-python\n");
    }
    const systemFirstPath = `${finderPath}:${customBin}`;
    assert.ok(
      desktopBackendEnvironment({ HOME: f.home, PATH: systemFirstPath }, "darwin").PATH.startsWith(
        `${systemFirstPath}:`
      )
    );
  }
);

test(
  "missing installs do not prevent launch and absent PATH receives system fallback",
  posixFixture,
  async (t) => {
    const f = await fixture(t);
    const home = join(f.home, "no-installs");
    // A file with a known directory's name is not a usable PATH entry.
    await mkdir(join(home, ".local"), { recursive: true });
    await writeFile(join(home, ".local/bin"), "not a directory");
    const environment = desktopBackendEnvironment({ HOME: home }, "darwin");
    assert.ok(environment.PATH.endsWith(finderPath));
    assert.ok(!environment.PATH.split(":").includes(join(home, ".local/bin")));
    assert.ok(
      !environment.PATH.split(":").includes(join(home, "Applications/LibreOffice.app/Contents/MacOS"))
    );
  }
);

test("desktop PATH discovery leaves non-macOS environments untouched", () => {
  const source = { HOME: "/fixture/home", PATH: "/explicit/bin", Path: "C:\\explicit" };
  for (const platform of ["linux", "win32"]) {
    const environment = desktopBackendEnvironment(source, platform);
    assert.deepEqual(environment, source);
    assert.notEqual(environment, source);
    assert.deepEqual(desktopBackendEnvironment({}, platform), {});
  }
});
