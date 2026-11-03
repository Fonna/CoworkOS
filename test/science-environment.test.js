import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkScienceEnvironment,
  configuredScienceEnvironment,
  publicScienceEnvironmentStatus,
  saveScienceEnvironmentConfig,
  scienceEnvironmentEnv
} from "../dist/src/runtime/science-environment.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-science-environment-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(t, script) {
  const root = await fixture(t);
  const file = join(root, "python-fixture");
  await writeFile(file, `#!${process.execPath}\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}

function response(extra = {}) {
  return {
    python: { available: true, version: "3.11.9" },
    packages: {
      numpy: { available: true, version: "2.2.6" },
      scipy: { available: true, version: "1.15.3" },
      rdkit: { available: true, version: "2026.09.1", selfTestPassed: true }
    },
    ...extra
  };
}

test("science environment defaults and metadata never probe or create files", async (t) => {
  const root = await fixture(t);
  const config = { science: { pythonExecutable: join(root, "not-installed") } };
  const status = publicScienceEnvironmentStatus(config, {});
  assert.equal(status.enabled, false);
  assert.equal(status.pythonExecutable, config.science.pythonExecutable);
  assert.equal(status.chemistryPythonExecutable, config.science.pythonExecutable);
  assert.equal(status.chemistryInheritsGeneral, true);
  assert.equal(status.appliesTo, "new-runs");
  assert.equal(status.enablementAppliesTo, "next-process-start");
  assert.equal(status.managedByEnvironment, false);
  assert.deepEqual(await readdir(root), []);
  assert.equal(configuredScienceEnvironment({}, {}).pythonExecutable, "python3");
});

test("per-field environment overrides saved selections without mutating either", () => {
  const config = {
    science: {
      enabled: false,
      pythonExecutable: "/saved/python",
      chemistryPythonExecutable: "/saved/chemistry"
    }
  };
  const env = { COWORK_SCIENCE_TOOLS: "1", COWORK_SCIENCE_PYTHON: "/host/python" };
  const original = structuredClone({ config, env });
  const selected = configuredScienceEnvironment(config, env);
  assert.equal(selected.enabled, true);
  assert.equal(selected.pythonExecutable, "/host/python");
  assert.equal(selected.chemistryPythonExecutable, "/saved/chemistry");
  assert.deepEqual(selected.managedFields, {
    enabled: true,
    pythonExecutable: true,
    chemistryPythonExecutable: false
  });
  assert.deepEqual(scienceEnvironmentEnv(config, env), {
    COWORK_SCIENCE_TOOLS: "1",
    COWORK_SCIENCE_PYTHON: "/host/python",
    COWORK_SCIENCE_CHEMISTRY_PYTHON: "/saved/chemistry"
  });
  assert.deepEqual({ config, env }, original);
  for (const value of ["0", "off", "true", "invalid"])
    assert.equal(
      configuredScienceEnvironment({ science: { enabled: true } }, { COWORK_SCIENCE_TOOLS: value }).enabled,
      false
    );
});

test("invalid optional settings disable science and saving preserves unrelated config", () => {
  for (const science of [
    null,
    [],
    false,
    { enabled: "yes" },
    { enabled: true, pythonExecutable: "../python" },
    { enabled: true, chemistryPythonExecutable: "python3\n" }
  ]) {
    const selected = configuredScienceEnvironment({ science }, {});
    assert.equal(selected.enabled, false);
    assert.ok(selected.configurationError);
  }
  const config = {
    model: "keep",
    science: { enabled: true, pythonExecutable: "/old/python", chemistryPythonExecutable: "/old/chemistry" }
  };
  const next = saveScienceEnvironmentConfig(config, { chemistryPythonExecutable: "" });
  assert.equal(next.model, "keep");
  assert.equal(next.science.pythonExecutable, "/old/python");
  assert.equal(configuredScienceEnvironment(next, {}).chemistryInheritsGeneral, true);
  assert.equal(config.science.chemistryPythonExecutable, "/old/chemistry");
  for (const input of [
    {},
    { install: true },
    { enabled: "1" },
    { pythonExecutable: "relative/python" },
    { chemistryPythonExecutable: "python3\n" },
    { toString: "bad" }
  ])
    assert.throws(() => saveScienceEnvironmentConfig(config, input));
});

test(
  "explicit diagnostics launch only the fixed isolated script and preserve versions",
  { skip: process.platform === "win32" },
  async (t) => {
    const python = await executable(
      t,
      `
const path=require('node:path');
const invalid=process.argv[2]!=='-I'||process.argv[3]!=='-B'||!process.argv[4].endsWith('/science/environment-probe.py')||!path.isAbsolute(process.argv[4])||process.env.PATH||process.env.PYTHONPATH||process.env.ATRIA_SCIENCE_FAKE_SECRET||Object.keys(process.env).some(k=>/KEY|TOKEN|PROXY/.test(k));
process.stdout.write(JSON.stringify(invalid?{}:${JSON.stringify(response())}));`
    );
    process.env.ATRIA_SCIENCE_FAKE_SECRET = "test-fixture";
    t.after(() => delete process.env.ATRIA_SCIENCE_FAKE_SECRET);
    const result = await checkScienceEnvironment({ target: "chemistry", pythonExecutable: python });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.python.version, "3.11.9");
    assert.equal(result.packages.rdkit.version, "2026.09.1");
    assert.equal(result.packages.rdkit.selfTestPassed, true);
    assert.equal(result.scalarFunctionsAvailable, true);
  }
);

test(
  "diagnostics distinguish dependencies, RDKit versions, self-test and Python support",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const [payload, target, error, scalars] of [
      [
        response({
          packages: { numpy: { available: false }, scipy: { available: false }, rdkit: { available: false } }
        }),
        "general",
        "dependency_unavailable",
        true
      ],
      [response({ python: { available: true, version: "3.9.20" } }), "general", "unsupported_python", true],
      [response({ python: { available: true, version: "3.9.20" } }), "chemistry", "unsupported_python", true],
      [response({ python: { available: true, version: "3.8.20" } }), "general", "unsupported_python", false],
      [
        response({
          packages: {
            ...response().packages,
            rdkit: { available: true, version: "2025.09.1", selfTestPassed: true }
          }
        }),
        "chemistry",
        "dependency_version_mismatch",
        true
      ],
      [
        response({
          packages: {
            ...response().packages,
            rdkit: { available: false, version: "2026.09.1", selfTestPassed: false }
          }
        }),
        "chemistry",
        "dependency_unavailable",
        true
      ]
    ]) {
      const python = await executable(t, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`);
      const checked = await checkScienceEnvironment({ target, pythonExecutable: python });
      assert.equal(checked.ok, false);
      assert.equal(checked.error.code, error, JSON.stringify(checked));
      assert.equal(checked.scalarFunctionsAvailable, scalars);
    }
  }
);

test(
  "missing runtimes, malformed output, timeout, cancellation and output limits stay local",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await fixture(t);
    assert.equal(
      (await checkScienceEnvironment({ target: "general", pythonExecutable: join(root, "missing") })).error
        .code,
      "unavailable"
    );
    for (const [script, limits, error] of [
      ["process.stdout.write('not-json');", {}, "invalid_response"],
      [
        "process.stdout.write(JSON.stringify({python:{available:true,version:'bad\\nsecret'},packages:{}}));",
        {},
        "invalid_response"
      ],
      ["process.stderr.write('private diagnostic');process.exitCode=4;", {}, "probe_failed"],
      ["process.stdout.write('x'.repeat(10000));", { maxOutputBytes: 4096 }, "output_too_large"],
      ["process.stderr.write('x'.repeat(10000));", { maxOutputBytes: 4096 }, "output_too_large"],
      ["setInterval(()=>{},1000);", { timeoutMs: 100 }, "timeout"]
    ]) {
      const python = await executable(t, script);
      const checked = await checkScienceEnvironment({ target: "general", pythonExecutable: python }, limits);
      assert.equal(checked.error.code, error, JSON.stringify(checked));
      assert.doesNotMatch(JSON.stringify(checked), /private diagnostic|secret/);
    }
    const python = await executable(t, "setInterval(()=>{},1000);");
    const controller = new AbortController();
    const pending = checkScienceEnvironment(
      { target: "general", pythonExecutable: python },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).error.code, "cancelled");
    assert.equal(
      (
        await checkScienceEnvironment(
          { target: "general", pythonExecutable: python },
          { signal: controller.signal }
        )
      ).error.code,
      "cancelled"
    );
  }
);

test("real Python diagnostics report installed metadata without installing dependencies", async (t) => {
  const probe = spawnSync("python3", ["-I", "-c", "import sys;print(sys.executable)"], {
    encoding: "utf8",
    env: {}
  });
  const python =
    process.env.COWORK_SCIENCE_TEST_PYTHON || (probe.status === 0 ? probe.stdout.trim() : undefined);
  if (!python) return t.skip("Python unavailable");
  const checked = await checkScienceEnvironment({ target: "chemistry", pythonExecutable: python });
  assert.equal(checked.python.available, true, JSON.stringify(checked));
  assert.match(checked.python.version, /^\d+\.\d+\.\d+/);
  for (const name of ["numpy", "scipy", "rdkit"])
    assert.equal(typeof checked.packages[name].available, "boolean");
  if (checked.ok) {
    assert.equal(checked.packages.rdkit.version, "2026.09.1");
    assert.equal(checked.packages.rdkit.selfTestPassed, true);
  } else
    assert.ok(
      ["unsupported_python", "dependency_version_mismatch", "dependency_unavailable"].includes(
        checked.error.code
      ),
      JSON.stringify(checked)
    );
});
