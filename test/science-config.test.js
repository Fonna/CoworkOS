import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredScienceTools,
  inheritScienceToolsForRun,
  scienceToolsForRun
} from "../dist/src/runtime/science-config.js";

const catalogVersion = "atria-statistics-v7";
const massVersion = "sciagentgym-e9dbbea-mass-spec-v6";
const materialsVersion = "sciagentgym-e9dbbea-materials-v5";
const chemistryVersion = "atria-rdkit-chemistry-v4";
const astronomyVersion = "sciagentgym-e9dbbea-astronomy-v3";
const analysisVersion = "sciagentgym-e9dbbea-analysis-v2";
const pilotVersion = "sciagentgym-e9dbbea-pilot-v1";

async function fixture(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-science-config-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const scope = { workspaceRoot, taskId: "task", runId: "run" };
  return { scope, path: join(workspaceRoot, "task", "runs", "run", "science-tools.json") };
}

test("science configuration is opt-in and does not probe the selected interpreter", () => {
  for (const value of [undefined, "", "0", "off", "false", "true", "yes", "invalid"])
    assert.equal(configuredScienceTools({ COWORK_SCIENCE_TOOLS: value }), undefined);
  assert.deepEqual(configuredScienceTools({ COWORK_SCIENCE_TOOLS: "1" }), {
    enabled: true,
    pythonExecutable: "python3",
    chemistryPythonExecutable: "python3",
    catalogVersion
  });
  assert.deepEqual(
    configuredScienceTools({ COWORK_SCIENCE_TOOLS: "1", COWORK_SCIENCE_PYTHON: "/missing/runtime/python" }),
    {
      enabled: true,
      pythonExecutable: "/missing/runtime/python",
      chemistryPythonExecutable: "/missing/runtime/python",
      catalogVersion
    }
  );
});

test("malformed science configuration narrows to disabled without changing the caller environment", () => {
  for (const python of [
    "",
    "../python",
    "./python",
    "relative/bin/python",
    "python\n--flag",
    "python3\n",
    "py\0thon",
    "x".repeat(4097)
  ]) {
    const env = { COWORK_SCIENCE_TOOLS: "1", COWORK_SCIENCE_PYTHON: python };
    const original = { ...env };
    assert.equal(configuredScienceTools(env), undefined);
    assert.deepEqual(env, original);
  }
});

test("a disabled Run creates no capability files or directories", async (t) => {
  const f = await fixture(t);
  assert.equal(await scienceToolsForRun(f.scope, {}), undefined);
  for (const id of ["_existing-task", ".existing-task", "-existing-task", "x".repeat(210)]) {
    assert.equal(await scienceToolsForRun({ ...f.scope, taskId: id, runId: id }, {}), undefined);
  }
  assert.deepEqual(await readdir(f.scope.workspaceRoot), []);
});

test("existing workspace identifiers retain their saved scientific selection", async (t) => {
  const f = await fixture(t);
  const scope = { ...f.scope, taskId: "_existing-task", runId: ".existing-run" };
  const enabled = await scienceToolsForRun(scope, { COWORK_SCIENCE_TOOLS: "1" });
  assert.deepEqual(enabled, {
    enabled: true,
    pythonExecutable: "python3",
    chemistryPythonExecutable: "python3",
    catalogVersion
  });
  assert.deepEqual(await scienceToolsForRun(scope, {}), { ...enabled, enabled: false });
});

test("a Run pins its catalog and interpreter before returning enabled tools", async (t) => {
  const f = await fixture(t);
  const first = await scienceToolsForRun(f.scope, {
    COWORK_SCIENCE_TOOLS: "1",
    COWORK_SCIENCE_PYTHON: "/missing/original/python"
  });
  assert.deepEqual(first, {
    enabled: true,
    pythonExecutable: "/missing/original/python",
    chemistryPythonExecutable: "/missing/original/python",
    catalogVersion
  });
  const saved = await readFile(f.path, "utf8");
  assert.deepEqual(JSON.parse(saved), {
    version: 1,
    pythonExecutable: "/missing/original/python",
    chemistryPythonExecutable: "/missing/original/python",
    catalogVersion
  });
  if (process.platform !== "win32") assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const resumed = await scienceToolsForRun(f.scope, {
    COWORK_SCIENCE_TOOLS: "1",
    COWORK_SCIENCE_PYTHON: "/missing/replacement/python"
  });
  assert.deepEqual(resumed, first);
  assert.equal(await readFile(f.path, "utf8"), saved);
  assert.deepEqual(await scienceToolsForRun(f.scope, {}), { ...first, enabled: false });
  assert.equal(await readFile(f.path, "utf8"), saved, "disabling preserves the original recovery record");
  assert.equal(await scienceToolsForRun({ ...f.scope, runId: "fresh" }, {}), undefined);
});

test("concurrent initialization returns the same original Run selection", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(
    ["python3", "python3.11"].map((pythonExecutable) =>
      scienceToolsForRun(f.scope, { COWORK_SCIENCE_TOOLS: "1", COWORK_SCIENCE_PYTHON: pythonExecutable })
    )
  );
  assert.deepEqual(results[0], results[1]);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).pythonExecutable, results[0].pythonExecutable);
});

test("a supported saved timeout and runtime survive disable and re-enable", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.path, ".."), { recursive: true });
  const saved = { version: 1, catalogVersion, pythonExecutable: "python3.11", timeoutMs: 10_000 };
  await writeFile(f.path, JSON.stringify(saved));
  const expected = { catalogVersion, pythonExecutable: "python3.11", timeoutMs: 10_000 };
  assert.deepEqual(await scienceToolsForRun(f.scope, {}), { ...expected, enabled: false });
  assert.deepEqual(
    await scienceToolsForRun(f.scope, { COWORK_SCIENCE_TOOLS: "1", COWORK_SCIENCE_PYTHON: "python3" }),
    { ...expected, enabled: true }
  );
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), saved);
});

test("original v1-v6 pins retain their selections after the default advances to v7", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.path, ".."), { recursive: true });
  for (const version of [
    pilotVersion,
    analysisVersion,
    astronomyVersion,
    chemistryVersion,
    materialsVersion,
    massVersion
  ]) {
    const chemistry = [chemistryVersion, materialsVersion, massVersion].includes(version)
      ? { chemistryPythonExecutable: "/original/chemistry" }
      : {};
    const raw = JSON.stringify({
      version: 1,
      catalogVersion: version,
      pythonExecutable: "/original/python",
      timeoutMs: 4567,
      ...chemistry
    });
    await writeFile(f.path, raw);
    for (const enabled of [false, true]) {
      assert.deepEqual(
        await scienceToolsForRun(f.scope, {
          COWORK_SCIENCE_TOOLS: enabled ? "1" : "0",
          COWORK_SCIENCE_PYTHON: "/replacement/python"
        }),
        {
          enabled,
          catalogVersion: version,
          pythonExecutable: "/original/python",
          timeoutMs: 4567,
          ...chemistry
        }
      );
      assert.equal(await readFile(f.path, "utf8"), raw);
    }
  }
  const fresh = await scienceToolsForRun({ ...f.scope, runId: "fresh" }, { COWORK_SCIENCE_TOOLS: "1" });
  assert.equal(fresh.catalogVersion, catalogVersion);
});

test("trusted retry inheritance preserves original bytes, runtime and catalog for all seven versions", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.path, ".."), { recursive: true });
  for (const version of [
    pilotVersion,
    analysisVersion,
    astronomyVersion,
    chemistryVersion,
    materialsVersion,
    massVersion,
    catalogVersion
  ]) {
    const chemistry = [chemistryVersion, materialsVersion, massVersion, catalogVersion].includes(version)
      ? { chemistryPythonExecutable: "/original/chemistry" }
      : {};
    const raw =
      JSON.stringify(
        {
          version: 1,
          catalogVersion: version,
          pythonExecutable: "/original/python",
          timeoutMs: 1234,
          ...chemistry
        },
        null,
        2
      ) + "\n";
    await writeFile(f.path, raw);
    const target = { ...f.scope, runId: version };
    await Promise.all([
      inheritScienceToolsForRun(target, f.scope.runId),
      inheritScienceToolsForRun(target, f.scope.runId)
    ]);
    const destination = join(
      f.scope.workspaceRoot,
      f.scope.taskId,
      "runs",
      target.runId,
      "science-tools.json"
    );
    assert.equal(await readFile(destination, "utf8"), raw);
    if (process.platform !== "win32") assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(await scienceToolsForRun(target, { COWORK_SCIENCE_TOOLS: "1" }), {
      enabled: true,
      catalogVersion: version,
      pythonExecutable: "/original/python",
      timeoutMs: 1234,
      ...chemistry
    });
    assert.equal(await readFile(f.path, "utf8"), raw);
  }
});

test("a legacy retry without science keeps explicit absence across later enabled retries", async (t) => {
  const f = await fixture(t);
  const first = { ...f.scope, runId: "first-retry" };
  const second = { ...f.scope, runId: "second-retry" };
  await inheritScienceToolsForRun(first, f.scope.runId);
  await inheritScienceToolsForRun(second, first.runId);
  for (const target of [first, second]) {
    const path = join(f.scope.workspaceRoot, f.scope.taskId, "runs", target.runId, "science-tools.json");
    const raw = await readFile(path, "utf8");
    assert.deepEqual(JSON.parse(raw), { version: 1, scope: "none" });
    for (const env of [{}, { COWORK_SCIENCE_TOOLS: "1" }])
      assert.equal(await scienceToolsForRun(target, env), undefined);
    assert.equal(await readFile(path, "utf8"), raw);
  }
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("a same-Run ordinary retry keeps science absent after the host opts in", async (t) => {
  const f = await fixture(t);
  await inheritScienceToolsForRun(f.scope, f.scope.runId);
  assert.equal(
    await scienceToolsForRun(f.scope, { COWORK_SCIENCE_TOOLS: "1" }),
    undefined,
    "replaying an ordinary request cannot add the newly enabled catalog"
  );
  const raw = await readFile(f.path);
  assert.deepEqual(JSON.parse(raw.toString("utf8")), { version: 1, scope: "none" });
  if (process.platform !== "win32") assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await Promise.all([
    inheritScienceToolsForRun(f.scope, f.scope.runId),
    inheritScienceToolsForRun(f.scope, f.scope.runId)
  ]);
  assert.deepEqual(await readFile(f.path), raw);
  assert.equal(await scienceToolsForRun(f.scope, {}), undefined);
});

test("same-Run inheritance preserves every existing pin byte without upgrading or repairing it", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.path, ".."), { recursive: true });
  for (const raw of [
    ...[
      pilotVersion,
      analysisVersion,
      astronomyVersion,
      chemistryVersion,
      materialsVersion,
      massVersion,
      catalogVersion
    ].map((version) =>
      Buffer.from(
        JSON.stringify(
          { version: 1, catalogVersion: version, pythonExecutable: "/original/python" },
          null,
          2
        ) + "\n"
      )
    ),
    Buffer.from("invalid \xff pin", "binary"),
    Buffer.from(JSON.stringify({ version: 1, catalogVersion: "unknown", pythonExecutable: "python3" })),
    Buffer.from(JSON.stringify({ version: 1, scope: "none" }))
  ]) {
    await writeFile(f.path, raw);
    await inheritScienceToolsForRun(f.scope, f.scope.runId);
    assert.deepEqual(await readFile(f.path), raw);
  }
});

test("retry inheritance preserves invalid evidence and never overwrites a different destination", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.path, ".."), { recursive: true });
  for (const [index, raw] of [
    Buffer.from("corrupt \xff pin", "binary"),
    Buffer.from(JSON.stringify({ version: 1, catalogVersion: "future-version", pythonExecutable: "python3" }))
  ].entries()) {
    await writeFile(f.path, raw);
    const target = { ...f.scope, runId: `invalid-${index}` };
    await inheritScienceToolsForRun(target, f.scope.runId);
    const path = join(f.scope.workspaceRoot, f.scope.taskId, "runs", target.runId, "science-tools.json");
    assert.deepEqual(await readFile(path), raw);
    assert.deepEqual(await scienceToolsForRun(target, { COWORK_SCIENCE_TOOLS: "1" }), {
      enabled: false,
      catalogVersion: "unavailable"
    });
  }
  const target = { ...f.scope, runId: "conflict" };
  await scienceToolsForRun(target, { COWORK_SCIENCE_TOOLS: "1" });
  const path = join(f.scope.workspaceRoot, f.scope.taskId, "runs", target.runId, "science-tools.json");
  const original = await readFile(path);
  await assert.rejects(inheritScienceToolsForRun(target, f.scope.runId), /different scientific scope/);
  assert.deepEqual(await readFile(path), original);
  await assert.rejects(inheritScienceToolsForRun(target, "../outside"), /Invalid scientific Run identity/);
  await rm(f.path);
  await mkdir(f.path);
  const unreadable = { ...f.scope, runId: "unreadable-source" };
  await assert.rejects(
    inheritScienceToolsForRun(unreadable, f.scope.runId),
    /Unable to read the original scientific Run scope/
  );
  await assert.rejects(
    readFile(join(f.scope.workspaceRoot, f.scope.taskId, "runs", unreadable.runId, "science-tools.json")),
    { code: "ENOENT" }
  );
});

test("corrupt or unsupported scientific pins stay unavailable and preserve recovery evidence", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.path, ".."), { recursive: true });
  for (const raw of [
    "not JSON",
    "null",
    "[]",
    JSON.stringify({ version: 2, catalogVersion, pythonExecutable: "python3" }),
    JSON.stringify({ version: 1, catalogVersion: "unknown-catalog", pythonExecutable: "python3" }),
    JSON.stringify({ version: 1, catalogVersion, pythonExecutable: "../python" }),
    JSON.stringify({ version: 1, catalogVersion, pythonExecutable: "python3", timeoutMs: -1 }),
    JSON.stringify({ version: 1, catalogVersion, pythonExecutable: "python3", timeoutMs: 120_001 })
  ]) {
    await writeFile(f.path, raw);
    for (const env of [{}, { COWORK_SCIENCE_TOOLS: "1" }]) {
      assert.deepEqual(await scienceToolsForRun(f.scope, env), {
        enabled: false,
        catalogVersion: "unavailable"
      });
      assert.equal(await readFile(f.path, "utf8"), raw);
    }
  }
});

test("science pin filesystem failures and invalid identities never block generic startup", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.scope.workspaceRoot, "task"), "blocking file");
  assert.deepEqual(await scienceToolsForRun(f.scope, { COWORK_SCIENCE_TOOLS: "1" }), {
    enabled: false,
    catalogVersion: "unavailable"
  });
  assert.equal(await scienceToolsForRun({ ...f.scope, taskId: "../outside" }, {}), undefined);
  assert.deepEqual(
    await scienceToolsForRun({ ...f.scope, taskId: "../outside" }, { COWORK_SCIENCE_TOOLS: "1" }),
    {
      enabled: false,
      catalogVersion: "unavailable"
    }
  );
  assert.deepEqual(await readdir(f.scope.workspaceRoot), ["task"]);
});

test("settings select two environments for new Runs while existing and inherited selections stay fixed", async (t) => {
  const f = await fixture(t);
  const settings = {
    science: {
      enabled: true,
      pythonExecutable: "/general/python",
      chemistryPythonExecutable: "/chemistry/python"
    }
  };
  const selected = await scienceToolsForRun(f.scope, {}, settings);
  assert.deepEqual(selected, {
    enabled: true,
    catalogVersion,
    pythonExecutable: "/general/python",
    chemistryPythonExecutable: "/chemistry/python"
  });
  const original = await readFile(f.path, "utf8");
  const replacement = {
    science: {
      ...settings.science,
      pythonExecutable: "/new/general",
      chemistryPythonExecutable: "/new/chemistry"
    }
  };
  assert.deepEqual(await scienceToolsForRun(f.scope, {}, replacement), selected);
  assert.equal(await readFile(f.path, "utf8"), original);
  const retry = { ...f.scope, runId: "retry-chemistry" };
  await inheritScienceToolsForRun(retry, f.scope.runId);
  assert.deepEqual(await scienceToolsForRun(retry, {}, replacement), selected);
  assert.deepEqual(await scienceToolsForRun({ ...f.scope, runId: "fresh-chemistry" }, {}, replacement), {
    enabled: true,
    catalogVersion,
    pythonExecutable: "/new/general",
    chemistryPythonExecutable: "/new/chemistry"
  });
  assert.equal(
    await scienceToolsForRun({ ...f.scope, runId: "env-disabled" }, { COWORK_SCIENCE_TOOLS: "0" }, settings),
    undefined
  );
  assert.deepEqual(await scienceToolsForRun(f.scope, {}, { science: { enabled: false } }), {
    ...selected,
    enabled: false
  });
});

test("v4-v7 retain the pinned chemistry interpreter through restart and revocation", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.path, ".."), { recursive: true });
  for (const version of [chemistryVersion, materialsVersion, massVersion, catalogVersion]) {
    const saved = {
      version: 1,
      catalogVersion: version,
      pythonExecutable: "/pinned/general",
      chemistryPythonExecutable: "/pinned/chemistry"
    };
    const raw = JSON.stringify(saved, null, 2) + "\n";
    await writeFile(f.path, raw);
    for (const enabled of [true, false, true]) {
      const selected = await scienceToolsForRun(f.scope, {
        COWORK_SCIENCE_TOOLS: enabled ? "1" : "0",
        COWORK_SCIENCE_PYTHON: "/changed/general",
        COWORK_SCIENCE_CHEMISTRY_PYTHON: "/changed/chemistry"
      });
      assert.deepEqual(selected, {
        enabled,
        catalogVersion: version,
        pythonExecutable: saved.pythonExecutable,
        chemistryPythonExecutable: saved.chemistryPythonExecutable
      });
      assert.equal(await readFile(f.path, "utf8"), raw);
    }
  }
});
