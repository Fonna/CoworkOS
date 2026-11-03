import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const chemistryPython = process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON;
const originalRunner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const version = "sciagentgym-e9dbbea-mass-spec-v6";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-mass-chemistry-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    call(
      tool,
      args,
      {
        catalogVersion = version,
        executable = chemistryPython || python,
        noSite = false,
        runner = originalRunner
      } = {}
    ) {
      const child = spawnSync(executable, ["-I", "-B", ...(noSite ? ["-S"] : []), runner], {
        cwd,
        input: JSON.stringify({ version: catalogVersion, tool, arguments: args }),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { LANG: "C.UTF-8" }
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(child.stderr, /Traceback \(most recent call last\)/);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      assert.doesNotMatch(child.stdout, /\b(?:NaN|Infinity)\b/);
      return JSON.parse(child.stdout);
    },
    mass(smiles, options) {
      return this.call("rdkit_exact_mass_and_formula", { smiles }, options);
    }
  };
}
function success(value) {
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
}
function failure(value, code) {
  assert.equal(value.ok, false, JSON.stringify(value));
  assert.equal(value.error.code, code);
}
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);
}

test(
  "native neutral mass uses ExactMolWt rather than rounded average molecular weight",
  { skip: !chemistryPython },
  (t) => {
    const science = fixture(t);
    const ethanol = science.mass("OCC");
    const value = success(ethanol);
    assert.equal(value.canonical_smiles, "CCO");
    assert.equal(value.formula, "C2H6O");
    assert.equal(value.rdkit_version, "2026.09.1");
    assert.equal(ethanol.units.exact_mass_da, "Da");
    near(value.exact_mass_da, 46.041864812);
    const benzene = success(science.mass("c1ccccc1"));
    assert.equal(benzene.formula, "C6H6");
    near(benzene.exact_mass_da, 78.046950192);
    const average = success(science.call("rdkit_molecular_descriptors", { smiles: "CCO" }));
    near(average.molecular_weight, 46.069);
    assert.ok(Math.abs(average.molecular_weight - value.exact_mass_da) > 0.02);
    assert.equal(Object.hasOwn(value, "unsaturation"), false);
    assert.equal(Object.hasOwn(value, "ion_mz"), false);
    assert.deepEqual(readdirSync(science.cwd), []);
  }
);

test(
  "mass and formula count implicit hydrogen and retain isotope-labelled carbon and hydrogen",
  { skip: !chemistryPython },
  (t) => {
    const science = fixture(t);
    const ordinary = success(science.mass("CCO"));
    const explicit = success(science.mass("[H]OC([H])([H])C([H])([H])[H]"));
    assert.deepEqual(explicit, ordinary);
    const carbon = success(science.mass("[13CH3]CO"));
    assert.equal(carbon.formula, "C[13C]H6O");
    near(carbon.exact_mass_da, 47.045219652);
    const hydrogen = success(science.mass("[2H]O[2H]"));
    assert.equal(hydrogen.formula, "[2H]2O");
    near(hydrogen.exact_mass_da, 20.023118176);
  }
);

test(
  "mass wrapper retains the bounded v4 parser scope and rejects charged ions without changing structures",
  { skip: !chemistryPython },
  (t) => {
    const science = fixture(t);
    for (const smiles of [
      "[NH4+]",
      "[O-]C=O",
      "C.C",
      "[CH3]",
      "[Na+]",
      "[999CH3]CO",
      "[65549CH3]CO",
      "[CH260]",
      "[CH4+256]",
      "[CH4-256]",
      "[CH4++++++]++"
    ]) {
      const value = science.mass(smiles);
      assert.equal(value.ok, false, smiles);
      assert.ok(["unsupported_molecule", "invalid_smiles"].includes(value.error.code), JSON.stringify(value));
    }
    failure(science.mass("not-a-smiles"), "invalid_smiles");
    failure(science.mass("CCO ethanol"), "invalid_arguments");
    failure(science.mass("C".repeat(257)), "unsupported_molecule");
    failure(science.mass("C".repeat(2049)), "invalid_arguments");
    const neutral = success(science.mass("C[N+](=O)[O-]"));
    assert.equal(neutral.formula, "CH3NO2");
    assert.match(science.mass("CCO").assumptions.join(" "), /Zero net formal charge/);
    near(success(science.mass("CCO")).exact_mass_da, 46.041864812);
  }
);

test("v1 through v5 reject native exact-mass additions without importing RDKit", (t) => {
  const science = fixture(t);
  for (const catalogVersion of [
    "sciagentgym-e9dbbea-pilot-v1",
    "sciagentgym-e9dbbea-analysis-v2",
    "sciagentgym-e9dbbea-astronomy-v3",
    "atria-rdkit-chemistry-v4",
    "sciagentgym-e9dbbea-materials-v5"
  ]) {
    failure(science.mass("CCO", { catalogVersion, executable: python, noSite: true }), "unknown_tool");
  }
  for (const arguments_ of [{}, { smiles: 1 }, { smiles: "CCO", charge: 1 }]) {
    failure(
      science.call("rdkit_exact_mass_and_formula", arguments_, { executable: python, noSite: true }),
      "invalid_arguments"
    );
  }
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("missing RDKit stays local to native mass while v6 stdlib isotope calculations remain available", (t) => {
  const science = fixture(t);
  const isolated = { executable: python, noSite: true };
  failure(science.mass("CCO", isolated), "dependency_unavailable");
  const pattern = success(
    science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 2 }, isolated)
  );
  near(pattern.M_plus_2_ratio, 0.6399155227032735);
  near(success(science.call("distance_from_modulus", { mu: 10 }, isolated)), 1000);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test(
  "native mass honors the fixed RDKit version guard inherited from the unchanged parser",
  { skip: !chemistryPython },
  (t) => {
    const science = fixture(t);
    for (const name of readdirSync(dirname(originalRunner)).filter((name) => name.endsWith(".py"))) {
      copyFileSync(join(dirname(originalRunner), name), join(science.cwd, name));
    }
    const parser = join(science.cwd, "chemistry.py");
    const original = readFileSync(parser, "utf8");
    assert.ok(original.includes('RDKIT_VERSION = "2026.09.1"'));
    writeFileSync(parser, original.replace('RDKIT_VERSION = "2026.09.1"', 'RDKIT_VERSION = "0"'));
    const runner = join(science.cwd, "runner.py");
    failure(science.mass("CCO", { runner }), "dependency_version_mismatch");
    near(
      success(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1, 1] }, { runner })),
      Math.sqrt(12)
    );
  }
);
