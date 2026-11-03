import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScienceRuntime } from "../scripts/build-science.mjs";

test("built science Python assets execute outside the source checkout without installing a runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-science-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "src", "tools", "science");
  await mkdir(source, { recursive: true });
  for (const name of [
    "runner.py",
    "pilot.py",
    "analysis.py",
    "astronomy.py",
    "chemistry.py",
    "materials.py",
    "mass_spectrometry.py",
    "mass-chemistry.py",
    "statistics.py",
    "environment-probe.py",
    "requirements.txt",
    "requirements-chemistry.txt"
  ])
    await copyFile(new URL(`../src/tools/science/${name}`, import.meta.url), join(source, name));
  await buildScienceRuntime(root);
  const built = join(root, "dist", "src", "tools", "science");
  for (const name of [
    "runner.py",
    "pilot.py",
    "analysis.py",
    "astronomy.py",
    "chemistry.py",
    "materials.py",
    "mass_spectrometry.py",
    "mass-chemistry.py",
    "statistics.py",
    "environment-probe.py",
    "requirements.txt",
    "requirements-chemistry.txt"
  ])
    assert.deepEqual(await readFile(join(built, name)), await readFile(join(source, name)));
  await rm(join(root, "src"), { recursive: true });
  const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
  const call = (request, { executable = python, noSite = true } = {}) => {
    const result = spawnSync(executable, ["-I", "-B", ...(noSite ? ["-S"] : []), join(built, "runner.py")], {
      cwd: root,
      env: {
        LANG: "C.UTF-8",
        OMP_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {})
      },
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 30_000
    });
    if (result.error?.code === "ENOENT") {
      t.skip("Python unavailable; asset copying verified, external execution unverified");
      return undefined;
    }
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
  };
  for (const example of [
    {
      version: "sciagentgym-e9dbbea-pilot-v1",
      tool: "eV_to_nm",
      arguments: { energy_eV: 2 },
      expected: 619.9209921660013,
      units: "nm"
    },
    {
      version: "sciagentgym-e9dbbea-analysis-v2",
      tool: "eV_to_nm",
      arguments: { energy_eV: 2 },
      expected: 619.9209921660013,
      units: "nm"
    },
    {
      version: "sciagentgym-e9dbbea-analysis-v2",
      tool: "bragg_law_d_spacing",
      arguments: { two_theta: 60 },
      expected: 1.5406,
      units: "angstrom"
    },
    {
      version: "sciagentgym-e9dbbea-astronomy-v3",
      tool: "eV_to_nm",
      arguments: { energy_eV: 2 },
      expected: 619.9209921660013,
      units: "nm"
    },
    {
      version: "sciagentgym-e9dbbea-astronomy-v3",
      tool: "bragg_law_d_spacing",
      arguments: { two_theta: 60 },
      expected: 1.5406,
      units: "angstrom"
    },
    {
      version: "sciagentgym-e9dbbea-astronomy-v3",
      tool: "distance_from_modulus",
      arguments: { mu: 10 },
      expected: 1000,
      units: "pc"
    },
    {
      version: "atria-rdkit-chemistry-v4",
      tool: "distance_from_modulus",
      arguments: { mu: 10 },
      expected: 1000,
      units: "pc"
    },
    {
      version: "sciagentgym-e9dbbea-materials-v5",
      tool: "cubic_lattice_parameter",
      arguments: { d_spacing: 2, hkl: [1, 1, 1] },
      expected: Math.sqrt(12),
      units: "angstrom"
    },
    {
      version: "sciagentgym-e9dbbea-materials-v5",
      tool: "eV_to_nm",
      arguments: { energy_eV: 2 },
      expected: 619.9209921660013,
      units: "nm"
    },
    {
      version: "sciagentgym-e9dbbea-materials-v5",
      tool: "bragg_law_d_spacing",
      arguments: { two_theta: 60 },
      expected: 1.5406,
      units: "angstrom"
    },
    {
      version: "sciagentgym-e9dbbea-mass-spec-v6",
      tool: "eV_to_nm",
      arguments: { energy_eV: 2 },
      expected: 619.9209921660013,
      units: "nm"
    },
    {
      version: "sciagentgym-e9dbbea-mass-spec-v6",
      tool: "bragg_law_d_spacing",
      arguments: { two_theta: 60 },
      expected: 1.5406,
      units: "angstrom"
    },
    {
      version: "sciagentgym-e9dbbea-mass-spec-v6",
      tool: "distance_from_modulus",
      arguments: { mu: 10 },
      expected: 1000,
      units: "pc"
    },
    {
      version: "sciagentgym-e9dbbea-mass-spec-v6",
      tool: "cubic_lattice_parameter",
      arguments: { d_spacing: 2, hkl: [1, 1, 1] },
      expected: Math.sqrt(12),
      units: "angstrom"
    }
  ]) {
    const { expected, units, ...request } = example;
    const value = call(request);
    if (!value) return;
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.ok(Math.abs(value.result - expected) < 1e-9);
    assert.equal(value.units, units);
  }
  const newVersionRetained = call({
    version: "atria-statistics-v7",
    tool: "eV_to_nm",
    arguments: { energy_eV: 2 }
  });
  assert.equal(newVersionRetained.ok, true, JSON.stringify(newVersionRetained));
  assert.ok(Math.abs(newVersionRetained.result - 619.9209921660013) < 1e-9);
  for (const oldVersion of [
    "sciagentgym-e9dbbea-pilot-v1",
    "sciagentgym-e9dbbea-analysis-v2",
    "sciagentgym-e9dbbea-astronomy-v3",
    "atria-rdkit-chemistry-v4",
    "sciagentgym-e9dbbea-materials-v5",
    "sciagentgym-e9dbbea-mass-spec-v6"
  ]) {
    for (const tool of ["summarize_numeric_data", "pearson_correlation", "welch_t_test"])
      assert.equal(
        call({ version: oldVersion, tool, arguments: {} }).error.code,
        "unknown_tool",
        "v1-v6 reject statistics before loading its dependencies"
      );
  }
  const missingStatistics = call({
    version: "atria-statistics-v7",
    tool: "summarize_numeric_data",
    arguments: { values: [1, 2, 3] }
  });
  assert.equal(missingStatistics.error.code, "dependency_unavailable");
  await t.test(
    "copied v7 statistical assets compute with the separate real general Python",
    { skip: !process.env.COWORK_SCIENCE_TEST_PYTHON },
    () => {
      const summary = call(
        {
          version: "atria-statistics-v7",
          tool: "summarize_numeric_data",
          arguments: { values: [1, 2, 3, 4] }
        },
        { noSite: false }
      );
      assert.equal(summary.ok, true, JSON.stringify(summary));
      assert.equal(summary.result.mean, 2.5);
      assert.equal(summary.result.q1, 1.75);
      const welch = call(
        {
          version: "atria-statistics-v7",
          tool: "welch_t_test",
          arguments: { sample_a: [1, 2, 3], sample_b: [2, 4, 6] }
        },
        { noSite: false }
      );
      assert.equal(welch.ok, true, JSON.stringify(welch));
      assert.ok(Math.abs(welch.result.degrees_of_freedom - 50 / 17) < 1e-12);
    }
  );
  await rm(join(built, "statistics.py"));
  const massSpectrometry = call({
    version: "sciagentgym-e9dbbea-mass-spec-v6",
    tool: "calculate_theoretical_isotope_pattern",
    arguments: { num_chlorine: 2 }
  });
  assert.equal(massSpectrometry.ok, true, JSON.stringify(massSpectrometry));
  assert.ok(Math.abs(massSpectrometry.result.M_plus_2_ratio - 0.6399155227032735) < 1e-12);
  for (const version of [
    "sciagentgym-e9dbbea-pilot-v1",
    "sciagentgym-e9dbbea-analysis-v2",
    "sciagentgym-e9dbbea-astronomy-v3",
    "atria-rdkit-chemistry-v4",
    "sciagentgym-e9dbbea-materials-v5"
  ]) {
    for (const tool of [
      "parse_mass_spectrum_peaks",
      "calculate_theoretical_isotope_pattern",
      "find_isotope_cluster",
      "rdkit_exact_mass_and_formula"
    ]) {
      const rejected = call({ version, tool, arguments: {} });
      assert.equal(rejected.error.code, "unknown_tool", "v1-v5 remain closed to all mass additions");
    }
  }
  for (const version of ["sciagentgym-e9dbbea-pilot-v1", "sciagentgym-e9dbbea-analysis-v2"]) {
    const rejected = call({ version, tool: "distance_from_modulus", arguments: { mu: 10 } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "unknown_tool");
  }
  for (const version of [
    "sciagentgym-e9dbbea-pilot-v1",
    "sciagentgym-e9dbbea-analysis-v2",
    "sciagentgym-e9dbbea-astronomy-v3",
    "atria-rdkit-chemistry-v4"
  ]) {
    const rejected = call({
      version,
      tool: "cubic_lattice_parameter",
      arguments: { d_spacing: 2, hkl: [1, 1, 1] }
    });
    assert.equal(rejected.error.code, "unknown_tool", "older catalogs remain closed to materials additions");
  }
  for (const version of [
    "atria-rdkit-chemistry-v4",
    "sciagentgym-e9dbbea-materials-v5",
    "sciagentgym-e9dbbea-mass-spec-v6"
  ]) {
    const missingDependency = call({ version, tool: "rdkit_validate_smiles", arguments: { smiles: "CCO" } });
    assert.equal(missingDependency.error.code, "dependency_unavailable");
    await t.test(
      `copied ${version} chemistry executes against the separately configured real RDKit runtime`,
      { skip: !process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON },
      () => {
        const value = call(
          {
            version,
            tool: "rdkit_molecular_descriptors",
            arguments: { smiles: "OCC" }
          },
          { executable: process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON, noSite: false }
        );
        assert.equal(value.ok, true, JSON.stringify(value));
        assert.equal(value.result.canonical_smiles, "CCO");
        assert.ok(Math.abs(value.result.molecular_weight - 46.069) < 1e-9);
        assert.equal(value.result.rdkit_version, "2026.09.1");
        assert.equal(value.units.molecular_weight, "g/mol");
      }
    );
  }
  const missingMassDependency = call({
    version: "sciagentgym-e9dbbea-mass-spec-v6",
    tool: "rdkit_exact_mass_and_formula",
    arguments: { smiles: "CCO" }
  });
  assert.equal(missingMassDependency.error.code, "dependency_unavailable");
  await rm(join(built, "mass_spectrometry.py"));
  await t.test(
    "copied v6 exact mass executes without the optional mass-spectrometry module",
    { skip: !process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON },
    () => {
      const value = call(
        {
          version: "sciagentgym-e9dbbea-mass-spec-v6",
          tool: "rdkit_exact_mass_and_formula",
          arguments: { smiles: "CCO" }
        },
        { executable: process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON, noSite: false }
      );
      assert.equal(value.ok, true, JSON.stringify(value));
      assert.equal(value.result.canonical_smiles, "CCO");
      assert.equal(value.result.formula, "C2H6O");
      assert.ok(Math.abs(value.result.exact_mass_da - 46.041864812) < 1e-9);
      assert.equal(value.result.rdkit_version, "2026.09.1");
      assert.equal(value.units.exact_mass_da, "Da");
    }
  );
  await copyFile(
    new URL("../src/tools/science/mass_spectrometry.py", import.meta.url),
    join(built, "mass_spectrometry.py")
  );
  await rm(join(built, "mass-chemistry.py"));
  const retainedMass = call({
    version: "sciagentgym-e9dbbea-mass-spec-v6",
    tool: "calculate_theoretical_isotope_pattern",
    arguments: { num_chlorine: 2 }
  });
  assert.equal(retainedMass.ok, true, "stdlib mass tools never load the RDKit wrapper");
  assert.ok(Math.abs(retainedMass.result.M_plus_2_ratio - 0.6399155227032735) < 1e-12);
  await rm(join(built, "mass_spectrometry.py"));
  for (const version of [
    "atria-rdkit-chemistry-v4",
    "sciagentgym-e9dbbea-materials-v5",
    "sciagentgym-e9dbbea-mass-spec-v6"
  ]) {
    const retained = call({
      version,
      tool: "cubic_lattice_parameter",
      arguments: { d_spacing: 2, hkl: [1, 1, 1] }
    });
    if (version === "atria-rdkit-chemistry-v4") assert.equal(retained.error.code, "unknown_tool");
    else {
      assert.equal(retained.ok, true, "retained materials never load either mass module");
      assert.ok(Math.abs(retained.result - Math.sqrt(12)) < 1e-12);
    }
  }
  await rm(join(built, "materials.py"));
  for (const version of ["atria-rdkit-chemistry-v4", "sciagentgym-e9dbbea-materials-v5"]) {
    const retained = call({ version, tool: "distance_from_modulus", arguments: { mu: 10 } });
    assert.equal(retained.ok, true, "earlier functions do not load the new materials module");
    assert.equal(retained.result, 1000);
  }
  await rm(join(built, "chemistry.py"));
  for (const [version, tool, args, expected] of [
    ["sciagentgym-e9dbbea-pilot-v1", "eV_to_nm", { energy_eV: 2 }, 619.9209921660013],
    ["sciagentgym-e9dbbea-analysis-v2", "bragg_law_d_spacing", { two_theta: 60 }, 1.5406],
    ["sciagentgym-e9dbbea-astronomy-v3", "distance_from_modulus", { mu: 10 }, 1000]
  ]) {
    const retained = call({ version, tool, arguments: args });
    assert.equal(retained.ok, true, "v1-v3 must not load the new chemistry module");
    assert.ok(Math.abs(retained.result - expected) < 1e-9);
    const rejected = call({ version, tool: "rdkit_validate_smiles", arguments: { smiles: "CCO" } });
    assert.equal(
      rejected.error.code,
      "unknown_tool",
      "old catalogs reject chemistry without loading its module"
    );
  }
  await rm(join(built, "astronomy.py"));
  for (const [version, tool, args, expected] of [
    ["sciagentgym-e9dbbea-pilot-v1", "eV_to_nm", { energy_eV: 2 }, 619.9209921660013],
    ["sciagentgym-e9dbbea-analysis-v2", "bragg_law_d_spacing", { two_theta: 60 }, 1.5406]
  ]) {
    const retained = call({ version, tool, arguments: args });
    assert.equal(retained.ok, true, "older versions do not load the new astronomy module");
    assert.ok(Math.abs(retained.result - expected) < 1e-9);
  }
  const unsupported = call({
    version: "future-version",
    tool: "distance_from_modulus",
    arguments: { mu: 10 }
  });
  assert.equal(unsupported.error.code, "version_mismatch");
});
