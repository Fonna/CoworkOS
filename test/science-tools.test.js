import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  SCIENCE_CATALOG,
  SCIENCE_CATALOG_VERSION,
  SCIENCE_ANALYSIS_CATALOG_VERSION,
  SCIENCE_ASTRONOMY_CATALOG_VERSION,
  SCIENCE_CHEMISTRY_CATALOG_VERSION,
  SCIENCE_MATERIALS_CATALOG_VERSION,
  SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
  SCIENCE_STATISTICS_CATALOG_VERSION,
  DEFAULT_SCIENCE_CATALOG_VERSION,
  scienceCatalog,
  createScienceTools
} from "../dist/src/tools/science-tools.js";
import { runScienceTool } from "../dist/src/tools/science/service.js";

const pythonProbe = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], {
  encoding: "utf8",
  env: {}
});

const python =
  process.env.COWORK_SCIENCE_TEST_PYTHON ??
  (pythonProbe.status === 0 ? pythonProbe.stdout.trim() : undefined);
const chemistryPython = process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON;
const options = (extra = {}) => ({
  enabled: true,
  catalogVersion: SCIENCE_CATALOG_VERSION,
  ...(python ? { pythonExecutable: python } : {}),
  ...extra
});

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "atria-science-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function tools(directory, extra = {}) {
  return createScienceTools(options(extra), { workingDirectory: directory });
}

async function fakePython(t, directory, script, name = "scientific-python") {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${script}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

const fixturePrelude = `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== '-I' || !path.isAbsolute(process.argv[3]) || !process.argv[3].endsWith('/science/runner.py')) process.exit(17);
`;

test("v1 remains the original twelve functions while v2 exposes eighteen reviewed functions", async (t) => {
  const directory = await workspace(t);
  const v1 = tools(directory, { pythonExecutable: join(directory, "missing") });
  const v2 = tools(directory, {
    catalogVersion: SCIENCE_ANALYSIS_CATALOG_VERSION,
    pythonExecutable: join(directory, "missing")
  });
  assert.equal(DEFAULT_SCIENCE_CATALOG_VERSION, SCIENCE_STATISTICS_CATALOG_VERSION);
  assert.equal(scienceCatalog(SCIENCE_CATALOG_VERSION), SCIENCE_CATALOG);
  assert.equal(scienceCatalog(SCIENCE_ANALYSIS_CATALOG_VERSION).length, 18);
  assert.equal(
    new Set(scienceCatalog(SCIENCE_ANALYSIS_CATALOG_VERSION).map((entry) => entry.group)).size,
    10
  );
  assert.deepEqual(scienceCatalog(SCIENCE_ANALYSIS_CATALOG_VERSION).slice(0, 12), SCIENCE_CATALOG);
  assert.equal(scienceCatalog("__proto__"), undefined);
  assert.equal((await v1.get("science_search").execute({ limit: 12 })).total, 12);
  const found = await v2.get("science_search").execute({ limit: 12 });
  assert.equal(found.catalogVersion, SCIENCE_ANALYSIS_CATALOG_VERSION);
  assert.equal(found.total, 18);
  assert.equal(found.tools.length, 12);
  assert.equal((await v2.get("science_search").execute({ domain: "physics" })).total, 12);
  assert.equal((await v2.get("science_search").execute({ domain: "chemistry" })).total, 5);
  assert.equal((await v2.get("science_search").execute({ domain: "materials_science" })).total, 1);
  for (const entry of scienceCatalog(SCIENCE_ANALYSIS_CATALOG_VERSION).slice(12)) {
    const description = await v2.get("science_describe").execute({ name: entry.name });
    assert.equal(description.ok, true, entry.name);
    assert.equal(description.catalogVersion, SCIENCE_ANALYSIS_CATALOG_VERSION);
    for (const [name, input] of [
      ["science_describe", { name: entry.name }],
      ["science_run", { name: entry.name, arguments: entry.example }]
    ]) {
      const rejected = await v1.get(name).execute(input);
      assert.equal(rejected.error.code, "unknown_tool");
      assert.equal(rejected.catalogVersion, SCIENCE_CATALOG_VERSION);
    }
  }
  assert.deepEqual(await readdir(directory), []);
});

test("v1 through v5 published metadata and model-facing definitions remain unchanged", () => {
  const fingerprints = [
    [
      SCIENCE_CATALOG_VERSION,
      "cbe4daa4d02e9151ff80474f22dee6574b9d8b645db9baada5c7694cf5e0d6f3",
      "9f096115545dbd1f7bccd3abfaae1ddb183c5a04690044680b2c00e716eb0e81"
    ],
    [
      SCIENCE_ANALYSIS_CATALOG_VERSION,
      "293957a635f85fce78ebc0f5f24f74c9702974b306ec70c59fbb4ca855515cf2",
      "6cb6a73be207a6eebeb605942d759f0bd09fe2ee6ec42f36c004ed2086d0b085"
    ],
    [
      SCIENCE_ASTRONOMY_CATALOG_VERSION,
      "08395c149d48ffb9074d6feeb7749e76065251f3a02343c06d6fda41b0791024",
      "11a854bf2784c9f939687e573bcc11e37f9f58059059c342c57719b273ae466e"
    ],
    [
      SCIENCE_CHEMISTRY_CATALOG_VERSION,
      "0f81f79d0ebaadab6cdd80c0a7b9f7e4cf8b0d5d3f1b203a85c3ab46a8e9efb5",
      "a820fb40bc47af3181f5a15c061e649f9804a9d48998137f0c686545753878b3"
    ],
    [
      SCIENCE_MATERIALS_CATALOG_VERSION,
      "78b7bd85550dc4fcc7535458dce478019d46d9cacea246c6e8871a01f41a0e4e",
      "a820fb40bc47af3181f5a15c061e649f9804a9d48998137f0c686545753878b3"
    ]
  ];
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const [catalogVersion, metadataHash, definitionsHash] of fingerprints) {
    assert.equal(hash(scienceCatalog(catalogVersion)), metadataHash, catalogVersion);
    const definitions = [
      ...createScienceTools({ enabled: true, catalogVersion }, { workingDirectory: "/unused" })
    ].map(([name, { description, parameters }]) => ({ name, description, parameters }));
    assert.equal(hash(definitions), definitionsHash, catalogVersion);
  }
});

test("v4 adds only three native RDKit wrappers with bounded string schemas and honest provenance", async (t) => {
  const directory = await workspace(t);
  const registry = tools(directory, {
    catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
    pythonExecutable: join(directory, "missing-base"),
    chemistryPythonExecutable: join(directory, "missing-chemistry")
  });
  const catalog = scienceCatalog(SCIENCE_CHEMISTRY_CATALOG_VERSION);
  assert.equal(catalog.length, 29);
  assert.equal(new Set(catalog.map((entry) => entry.name)).size, 29);
  assert.deepEqual(catalog.slice(0, 26), scienceCatalog(SCIENCE_ASTRONOMY_CATALOG_VERSION));
  assert.deepEqual([...registry.keys()], ["science_search", "science_describe", "science_run"]);
  const found = await registry
    .get("science_search")
    .execute({ domain: "chemistry", query: "RDKit", limit: 12 });
  assert.equal(found.catalogVersion, SCIENCE_CHEMISTRY_CATALOG_VERSION);
  assert.equal(found.total, 3);
  assert.equal((await registry.get("science_search").execute({ limit: 12 })).total, 29);
  for (const entry of catalog.slice(26)) {
    const described = await registry.get("science_describe").execute({ name: entry.name });
    assert.equal(described.runtime, "chemistry");
    assert.deepEqual(described.parameters.required, ["smiles"]);
    assert.equal(described.parameters.properties.smiles.minLength, 1);
    assert.equal(described.parameters.properties.smiles.maxLength, 2048);
    assert.equal(described.parameters.additionalProperties, false);
    assert.deepEqual(described.source, {
      kind: "atria-native",
      path: "src/tools/science/chemistry.py",
      documentation: entry.source.documentation,
      implementationVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION
    });
    assert.match(described.source.documentation, /^https:\/\/www\.rdkit\.org\/docs\//);
    assert.equal(Object.hasOwn(described.source, "commit"), false);
    assert.equal(Object.hasOwn(described.source, "sha256"), false);
    for (const catalogVersion of [
      SCIENCE_CATALOG_VERSION,
      SCIENCE_ANALYSIS_CATALOG_VERSION,
      SCIENCE_ASTRONOMY_CATALOG_VERSION
    ]) {
      const old = tools(directory, { catalogVersion });
      for (const [name, input] of [
        ["science_describe", { name: entry.name }],
        ["science_run", { name: entry.name, arguments: entry.example }]
      ]) {
        const rejected = await old.get(name).execute(input);
        assert.equal(rejected.error.code, "unknown_tool");
        assert.equal(rejected.catalogVersion, catalogVersion);
      }
    }
    for (const arguments_ of [
      { smiles: "" },
      { smiles: "C".repeat(2049) },
      { smiles: 1 },
      { smiles: "CCO", filename: "unused" }
    ]) {
      const rejected = await registry.get("science_run").execute({ name: entry.name, arguments: arguments_ });
      assert.equal(rejected.error.code, "invalid_arguments");
    }
  }
  assert.deepEqual(await readdir(directory), []);
});

test("v5 adds four offline materials functions without probing dependencies or changing prior catalogs", async (t) => {
  const directory = await workspace(t);
  const registry = tools(directory, {
    catalogVersion: SCIENCE_MATERIALS_CATALOG_VERSION,
    pythonExecutable: join(directory, "missing-base"),
    chemistryPythonExecutable: join(directory, "missing-chemistry")
  });
  const catalog = scienceCatalog(SCIENCE_MATERIALS_CATALOG_VERSION);
  assert.equal(catalog.length, 33);
  assert.equal(new Set(catalog.map((entry) => entry.name)).size, 33);
  assert.deepEqual(catalog.slice(0, 29), scienceCatalog(SCIENCE_CHEMISTRY_CATALOG_VERSION));
  assert.deepEqual([...registry.keys()], ["science_search", "science_describe", "science_run"]);
  const found = await registry.get("science_search").execute({ domain: "materials_science", limit: 12 });
  assert.equal(found.total, 5);
  assert.equal((await registry.get("science_search").execute({ query: "晶胞" })).total, 1);
  assert.equal((await registry.get("science_search").execute({ query: "Scherrer" })).total, 1);
  for (const entry of catalog.slice(29)) {
    const described = await registry.get("science_describe").execute({ name: entry.name });
    assert.equal(described.ok, true);
    assert.equal(described.catalogVersion, SCIENCE_MATERIALS_CATALOG_VERSION);
    assert.deepEqual(described.dependencies, []);
    assert.equal(described.runtime, undefined);
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.parameters), true);
    assert.equal(entry.parameters.additionalProperties, false);
    assert.match(described.source.url, new RegExp(`#L${described.source.line}$`));
    for (const catalogVersion of [
      SCIENCE_CATALOG_VERSION,
      SCIENCE_ANALYSIS_CATALOG_VERSION,
      SCIENCE_ASTRONOMY_CATALOG_VERSION,
      SCIENCE_CHEMISTRY_CATALOG_VERSION
    ]) {
      const old = tools(directory, { catalogVersion });
      assert.ok(
        !(await old.get("science_search").execute({ query: entry.name, limit: 12 })).tools.some(
          (tool) => tool.name === entry.name
        )
      );
      for (const [name, input] of [
        ["science_describe", { name: entry.name }],
        ["science_run", { name: entry.name, arguments: entry.example }]
      ]) {
        assert.equal((await old.get(name).execute(input)).error.code, "unknown_tool");
      }
    }
  }
  const invalid = [
    ["cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1] }],
    ["cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1, 1.5] }],
    ["calculate_metric_tensor", { a: 4, b: 4, c: 4, alpha: 0, beta: 90, gamma: 90 }],
    ["calculate_interplanar_spacing_general", { h: 1, k: 0, l: 0, metric_tensor: [[1]] }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.2, script: "unused" }]
  ];
  for (const [name, arguments_] of invalid) {
    assert.equal(
      (await registry.get("science_run").execute({ name, arguments: arguments_ })).error.code,
      "invalid_arguments"
    );
  }
  assert.deepEqual(await readdir(directory), [], "search/describe/schema rejection never starts Python");
});

test("v5 materials execute with a missing chemistry environment while inherited RDKit uses its selected interpreter", async (t) => {
  if (!python) return t.skip("Python is unavailable");
  const directory = await workspace(t);
  const registry = tools(directory, {
    catalogVersion: SCIENCE_MATERIALS_CATALOG_VERSION,
    chemistryPythonExecutable: join(directory, "missing-chemistry")
  });
  const cell = await registry.get("science_run").execute({
    name: "calculate_metric_tensor",
    arguments: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 }
  });
  assert.equal(cell.ok, true, JSON.stringify(cell));
  assert.ok(Math.abs(cell.result.volume_angstrom3 - 64) < 1e-10);
  const spacing = await registry.get("science_run").execute({
    name: "calculate_interplanar_spacing_general",
    arguments: { h: 1, k: 1, l: 0, metric_tensor: cell.result.metric_tensor }
  });
  assert.equal(spacing.ok, true, JSON.stringify(spacing));
  assert.ok(Math.abs(spacing.result - Math.sqrt(8)) < 1e-10);
  assert.equal(spacing.units, "angstrom");
  assert.equal(spacing.metadata.catalogVersion, SCIENCE_MATERIALS_CATALOG_VERSION);
  const scherrer = await registry.get("science_run").execute({
    name: "calculate_scherrer_grain_size",
    arguments: { peak_2theta_deg: 60, fwhm_deg: 0.2, instrument_fwhm_deg: 0.1 }
  });
  assert.equal(scherrer.ok, true, JSON.stringify(scherrer));
  assert.equal(scherrer.result.instrument_model, "gaussian");
  assert.ok(scherrer.result.D_nm > 52 && scherrer.result.D_nm < 54);
  assert.equal(
    (
      await registry
        .get("science_run")
        .execute({ name: "rdkit_validate_smiles", arguments: { smiles: "CCO" } })
    ).error.code,
    "unavailable"
  );
  if (chemistryPython) {
    const chemistry = tools(directory, {
      catalogVersion: SCIENCE_MATERIALS_CATALOG_VERSION,
      pythonExecutable: join(directory, "missing-base"),
      chemistryPythonExecutable: chemistryPython
    });
    const result = await chemistry
      .get("science_run")
      .execute({ name: "rdkit_molecular_descriptors", arguments: { smiles: "CCO" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(Math.abs(result.result.molecular_weight - 46.069) < 1e-10);
    assert.equal(result.metadata.catalogVersion, SCIENCE_MATERIALS_CATALOG_VERSION);
  }
});

test("v6 adds three offline mass-spectrum adaptations and one separately declared native mass wrapper", async (t) => {
  const directory = await workspace(t);
  const registry = tools(directory, {
    catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
    pythonExecutable: join(directory, "missing-base"),
    chemistryPythonExecutable: join(directory, "missing-chemistry")
  });
  const catalog = scienceCatalog(SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION);
  assert.equal(catalog.length, 37);
  assert.equal(new Set(catalog.map((entry) => entry.name)).size, 37);
  assert.deepEqual(catalog.slice(0, 33), scienceCatalog(SCIENCE_MATERIALS_CATALOG_VERSION));
  assert.deepEqual([...registry.keys()], ["science_search", "science_describe", "science_run"]);
  const found = await registry
    .get("science_search")
    .execute({ query: "质谱", domain: "chemistry", limit: 12 });
  assert.equal(found.total, 4);
  for (const entry of catalog.slice(33)) {
    const described = await registry.get("science_describe").execute({ name: entry.name });
    assert.equal(described.ok, true);
    assert.equal(described.catalogVersion, SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION);
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.parameters), true);
    assert.equal(described.parameters.additionalProperties, false);
    if (entry.name === "rdkit_exact_mass_and_formula") {
      assert.equal(described.runtime, "chemistry");
      assert.deepEqual(described.dependencies, ["rdkit==2026.9.1"]);
      assert.equal(described.source.kind, "atria-native");
      assert.equal(described.source.path, "src/tools/science/mass-chemistry.py");
      assert.equal(described.source.implementationVersion, SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION);
      assert.equal(Object.hasOwn(described.source, "commit"), false);
    } else {
      assert.equal(described.runtime, undefined);
      assert.deepEqual(described.dependencies, []);
      assert.match(described.source.url, new RegExp(`#L${described.source.line}$`));
    }
    for (const catalogVersion of [
      SCIENCE_CATALOG_VERSION,
      SCIENCE_ANALYSIS_CATALOG_VERSION,
      SCIENCE_ASTRONOMY_CATALOG_VERSION,
      SCIENCE_CHEMISTRY_CATALOG_VERSION,
      SCIENCE_MATERIALS_CATALOG_VERSION
    ]) {
      const old = tools(directory, { catalogVersion });
      for (const [name, input] of [
        ["science_describe", { name: entry.name }],
        ["science_run", { name: entry.name, arguments: entry.example }]
      ]) {
        assert.equal((await old.get(name).execute(input)).error.code, "unknown_tool");
      }
    }
  }
  for (const [name, arguments_] of [
    ["parse_mass_spectrum_peaks", { mz_values: [100], intensities: [1], intensity_threshold: 101 }],
    ["parse_mass_spectrum_peaks", { mz_values: Array(8193).fill(100), intensities: [1] }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: true }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 1, num_carbon: 129 }],
    ["find_isotope_cluster", { peak_mz: [100], peak_intensity: [1], base_mz: 100, abs_charge: 1.5 }],
    ["rdkit_exact_mass_and_formula", { smiles: "CCO", adduct: "H+" }]
  ]) {
    assert.equal(
      (await registry.get("science_run").execute({ name, arguments: arguments_ })).error.code,
      "invalid_arguments"
    );
  }
  assert.deepEqual(await readdir(directory), [], "metadata and schema checks never start Python");
});

test("v6 centroid-to-cluster workflow keeps raw intensities and isolates the chemistry environment", async (t) => {
  if (!python) return t.skip("Python is unavailable");
  const directory = await workspace(t);
  const registry = tools(directory, {
    catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
    chemistryPythonExecutable: join(directory, "missing-chemistry")
  });
  const run = async (name, arguments_) =>
    registry.get("science_run").execute({ name, arguments: arguments_ });
  const parsed = await run("parse_mass_spectrum_peaks", {
    mz_values: [100, 102, 150],
    intensities: [1000, 320, 5]
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.result.filtered_peaks, 2);
  assert.deepEqual(parsed.result.base_peak, { mz: 100, raw_intensity: 1000, relative_intensity: 100 });
  assert.equal(parsed.result.highest_mz_peak.mz, 102);
  assert.equal(Object.hasOwn(parsed.result, "molecular_ion"), false);
  const cluster = await run("find_isotope_cluster", {
    peak_mz: parsed.result.peaks.map((p) => p.mz),
    peak_intensity: parsed.result.peaks.map((p) => p.raw_intensity),
    base_mz: 100
  });
  assert.equal(cluster.ok, true, JSON.stringify(cluster));
  assert.ok(Math.abs(cluster.result.M_plus_2_ratio - 0.32) < 1e-12);
  assert.equal(cluster.metadata.catalogVersion, SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION);
  assert.deepEqual(cluster.result.missing_labels, ["M+4", "M+6"]);
  const pattern = await run("calculate_theoretical_isotope_pattern", { num_chlorine: 2, num_carbon: 2 });
  assert.equal(pattern.ok, true, JSON.stringify(pattern));
  assert.ok(pattern.result.M_plus_2_ratio > 0.6399);
  assert.ok(Math.abs(pattern.result.peaks.reduce((sum, p) => sum + p.probability, 0) - 1) < 1e-12);
  assert.equal((await run("rdkit_exact_mass_and_formula", { smiles: "CCO" })).error.code, "unavailable");
  if (chemistryPython) {
    const chemistry = tools(directory, {
      catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
      pythonExecutable: join(directory, "missing-base"),
      chemistryPythonExecutable: chemistryPython
    });
    const exact = await chemistry
      .get("science_run")
      .execute({ name: "rdkit_exact_mass_and_formula", arguments: { smiles: "CCO" } });
    assert.equal(exact.ok, true, JSON.stringify(exact));
    assert.equal(exact.result.formula, "C2H6O");
    assert.ok(Math.abs(exact.result.exact_mass_da - 46.041864812) < 1e-9);
    assert.equal(exact.metadata.catalogVersion, SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION);
  }
});

test(
  "v4 selects only the registry-owned dependency pack and contains a missing selected interpreter",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await workspace(t);
    const general = await fakePython(
      t,
      directory,
      `${fixturePrelude}\nprocess.stdout.write(JSON.stringify({ok:true,result:"general"}));`,
      "general-python"
    );
    const chemistry = await fakePython(
      t,
      directory,
      `${fixturePrelude}\nprocess.stdout.write(JSON.stringify({ok:true,result:"chemistry"}));`,
      "chemistry-python"
    );
    const registry = tools(directory, {
      catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
      pythonExecutable: general,
      chemistryPythonExecutable: chemistry
    });
    assert.equal(
      (await registry.get("science_run").execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } })).result,
      "general"
    );
    assert.equal(
      (
        await registry
          .get("science_run")
          .execute({ name: "rdkit_validate_smiles", arguments: { smiles: "CCO" } })
      ).result,
      "chemistry"
    );
    const forged = await runScienceTool(
      options({
        catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
        pythonExecutable: general,
        chemistryPythonExecutable: chemistry
      }),
      directory,
      { ...scienceCatalog(SCIENCE_CHEMISTRY_CATALOG_VERSION)[0], runtime: "chemistry" },
      { energy_eV: 2 }
    );
    assert.equal(
      forged.result,
      "general",
      "the registry owns interpreter selection, not a caller-provided entry"
    );
    const chemistryMissing = tools(directory, {
      catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
      pythonExecutable: general,
      chemistryPythonExecutable: join(directory, "missing")
    }).get("science_run");
    assert.equal(
      (await chemistryMissing.execute({ name: "rdkit_validate_smiles", arguments: { smiles: "CCO" } })).error
        .code,
      "unavailable"
    );
    assert.equal(
      (await chemistryMissing.execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } })).result,
      "general"
    );
    const generalInvalid = tools(directory, {
      catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
      pythonExecutable: "relative/python3",
      chemistryPythonExecutable: chemistry
    }).get("science_run");
    assert.equal(
      (await generalInvalid.execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } })).error.code,
      "unavailable"
    );
    assert.equal(
      (await generalInvalid.execute({ name: "rdkit_validate_smiles", arguments: { smiles: "CCO" } })).result,
      "chemistry"
    );
  }
);

test(
  "v4 missing RDKit remains local to chemistry while real stdlib kernels recover",
  { skip: !python || process.platform === "win32" },
  async (t) => {
    const directory = await workspace(t);
    const withoutSite = await fakePython(
      t,
      directory,
      `${fixturePrelude}
const {spawnSync}=require('node:child_process');
const child=spawnSync(${JSON.stringify(python)},['-S',...process.argv.slice(2)],{env:process.env,stdio:'inherit'});
process.exitCode=child.status??1;`,
      "python-without-site"
    );
    const run = tools(directory, {
      catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
      pythonExecutable: python,
      chemistryPythonExecutable: withoutSite
    }).get("science_run");
    const absent = await run.execute({ name: "rdkit_molecular_descriptors", arguments: { smiles: "CCO" } });
    assert.equal(absent.error.code, "dependency_unavailable", JSON.stringify(absent));
    const retained = await run.execute({ name: "distance_from_modulus", arguments: { mu: 10 } });
    assert.equal(retained.ok, true, JSON.stringify(retained));
    assert.equal(retained.result, 1000);
    assert.equal(retained.metadata.catalogVersion, SCIENCE_CHEMISTRY_CATALOG_VERSION);
  }
);

test(
  "v4 real RDKit descriptors and native provenance survive service decoding in an independent environment",
  { skip: !chemistryPython },
  async (t) => {
    const directory = await workspace(t);
    const run = tools(directory, {
      catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
      pythonExecutable: join(directory, "missing-general-python"),
      chemistryPythonExecutable: chemistryPython
    }).get("science_run");
    const result = await run.execute({ name: "rdkit_molecular_descriptors", arguments: { smiles: "OCC" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.canonical_smiles, "CCO");
    assert.ok(Math.abs(result.result.molecular_weight - 46.069) < 1e-9);
    assert.ok(Math.abs(result.result.logp_crippen + 0.0014) < 1e-9);
    assert.equal(result.result.hydrogen_bond_donors, 1);
    assert.equal(result.result.hydrogen_bond_acceptors, 1);
    assert.equal(result.result.rdkit_version, "2026.09.1");
    assert.equal(result.units.molecular_weight, "g/mol");
    assert.equal(result.units.tpsa, "angstrom^2");
    assert.equal(result.metadata.source.kind, "atria-native");
    assert.equal(result.metadata.source.implementationVersion, SCIENCE_CHEMISTRY_CATALOG_VERSION);
    assert.equal(result.metadata.catalogVersion, SCIENCE_CHEMISTRY_CATALOG_VERSION);
    assert.match(result.assumptions.join(" "), /Wildman-Crippen/);
    const invalid = await run.execute({
      name: "rdkit_molecular_descriptors",
      arguments: { smiles: "CN(C)(C)C" }
    });
    assert.equal(invalid.error.code, "invalid_smiles");
    const recovered = await run.execute({ name: "rdkit_canonicalize_smiles", arguments: { smiles: "OCC" } });
    assert.equal(recovered.result.canonical_smiles, "CCO");
    assert.notEqual(recovered.metadata.executionDirectory, result.metadata.executionDirectory);
  }
);

test("v3 adds eight astronomy functions without widening either earlier catalog", async (t) => {
  const directory = await workspace(t);
  const registry = tools(directory, {
    catalogVersion: SCIENCE_ASTRONOMY_CATALOG_VERSION,
    pythonExecutable: join(directory, "missing")
  });
  const catalog = scienceCatalog(SCIENCE_ASTRONOMY_CATALOG_VERSION);
  assert.equal(catalog.length, 26);
  assert.equal(new Set(catalog.map((entry) => entry.name)).size, 26);
  assert.deepEqual(catalog.slice(0, 18), scienceCatalog(SCIENCE_ANALYSIS_CATALOG_VERSION));
  assert.deepEqual([...registry.keys()], ["science_search", "science_describe", "science_run"]);
  const search = registry.get("science_search");
  const found = await search.execute({ domain: "astronomy", limit: 12 });
  assert.equal(found.ok, true);
  assert.equal(found.catalogVersion, SCIENCE_ASTRONOMY_CATALOG_VERSION);
  assert.equal(found.total, 8);
  assert.equal(found.tools.length, 8);
  assert.equal((await search.execute({ domain: "physics", limit: 12 })).total, 12);
  assert.equal((await search.execute({ limit: 12 })).total, 26);
  for (const entry of catalog.slice(18)) {
    const described = await registry.get("science_describe").execute({ name: entry.name });
    assert.equal(described.ok, true, entry.name);
    assert.equal(described.catalogVersion, SCIENCE_ASTRONOMY_CATALOG_VERSION);
    for (const catalogVersion of [SCIENCE_CATALOG_VERSION, SCIENCE_ANALYSIS_CATALOG_VERSION]) {
      const old = tools(directory, { catalogVersion });
      assert.equal((await old.get("science_search").execute({ domain: "astronomy" })).total, 0);
      for (const [name, input] of [
        ["science_describe", { name: entry.name }],
        ["science_run", { name: entry.name, arguments: entry.example }]
      ]) {
        const rejected = await old.get(name).execute(input);
        assert.equal(rejected.error.code, "unknown_tool");
        assert.equal(rejected.catalogVersion, catalogVersion);
      }
    }
  }
  assert.deepEqual(await readdir(directory), []);
});

test("v2 validates integer schemas and reports the selected version without starting Python", async (t) => {
  const directory = await workspace(t);
  const run = tools(directory, {
    catalogVersion: SCIENCE_ANALYSIS_CATALOG_VERSION,
    pythonExecutable: join(directory, "missing")
  }).get("science_run");
  for (const arguments_ of [
    { E0: 0, n: 1.5, a_oxidized: 10 },
    { E0: 0, n: true, a_oxidized: 10 },
    { E0: 0, n: 0, a_oxidized: 10 }
  ]) {
    const rejected = await run.execute({ name: "nernst_potential", arguments: arguments_ });
    assert.equal(rejected.error.code, "invalid_arguments");
    assert.equal(rejected.catalogVersion, SCIENCE_ANALYSIS_CATALOG_VERSION);
  }
  assert.deepEqual(await readdir(directory), []);
  const disabled = await tools(directory, {
    enabled: false,
    catalogVersion: SCIENCE_ANALYSIS_CATALOG_VERSION
  })
    .get("science_run")
    .execute({ name: "bragg_law_d_spacing", arguments: { two_theta: 60 } });
  assert.equal(disabled.error.code, "unavailable");
  assert.equal(disabled.catalogVersion, SCIENCE_ANALYSIS_CATALOG_VERSION);
  assert.deepEqual(await readdir(directory), []);
});

test(
  "v2 real Python routes both retained v1 kernels and new stdlib kernels by selected version",
  { skip: !python },
  async (t) => {
    const directory = await workspace(t);
    const run = tools(directory, { catalogVersion: SCIENCE_ANALYSIS_CATALOG_VERSION }).get("science_run");
    for (const [name, arguments_, expected] of [
      ["eV_to_nm", { energy_eV: 2 }, 619.9209921660013],
      ["bragg_law_d_spacing", { two_theta: 60, wavelength: 1.5406 }, 1.5406],
      ["nernst_potential", { E0: 0, n: 1, a_oxidized: 10 }, 0.05915934968478112]
    ]) {
      const result = await run.execute({ name, arguments: arguments_ });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(Math.abs(result.result - expected) < 1e-9, JSON.stringify(result));
      assert.equal(result.catalogVersion, SCIENCE_ANALYSIS_CATALOG_VERSION);
      assert.equal(result.metadata.catalogVersion, SCIENCE_ANALYSIS_CATALOG_VERSION);
    }
    const malformed = await run.execute({ name: "bragg_law_d_spacing", arguments: { two_theta: 180 } });
    assert.equal(malformed.error.code, "invalid_arguments");
    assert.equal(malformed.catalogVersion, SCIENCE_ANALYSIS_CATALOG_VERSION);
  }
);

test(
  "v3 real Python preserves older kernels and object result units through the execution service",
  { skip: !python },
  async (t) => {
    const directory = await workspace(t);
    const run = tools(directory, { catalogVersion: SCIENCE_ASTRONOMY_CATALOG_VERSION }).get("science_run");
    for (const [name, arguments_, expected] of [
      ["eV_to_nm", { energy_eV: 2 }, 619.9209921660013],
      ["bragg_law_d_spacing", { two_theta: 60 }, 1.5406],
      ["distance_from_modulus", { mu: 10 }, 1000]
    ]) {
      const computed = await run.execute({ name, arguments: arguments_ });
      assert.equal(computed.ok, true, JSON.stringify(computed));
      assert.ok(Math.abs(computed.result - expected) < 1e-9, JSON.stringify(computed));
      assert.equal(computed.catalogVersion, SCIENCE_ASTRONOMY_CATALOG_VERSION);
      assert.equal(computed.metadata.catalogVersion, SCIENCE_ASTRONOMY_CATALOG_VERSION);
    }
    const transit = await run.execute({
      name: "calculate_transit_depth",
      arguments: { planet_radius: 0.1, star_radius: 1, star_luminosity: 20, companion_luminosity: 1 }
    });
    assert.equal(transit.ok, true, JSON.stringify(transit));
    assert.ok(Math.abs(transit.result.remaining_luminosity - 20.8) < 1e-12);
    assert.ok(Math.abs(transit.result.transit_depth_fraction - 0.2 / 21) < 1e-12);
    assert.ok(Math.abs(transit.result.transit_depth_percent - 20 / 21) < 1e-12);
    assert.equal(transit.units.transit_depth_fraction, "dimensionless");
    assert.equal(transit.units.transit_depth_percent, "%");
    assert.equal(transit.units.remaining_luminosity, "nominal solar luminosity");
    assert.ok(transit.assumptions.length > 0);
    assert.equal(transit.metadata.tool, "calculate_transit_depth");
    assert.equal(transit.metadata.catalogVersion, SCIENCE_ASTRONOMY_CATALOG_VERSION);
  }
);

test("science discovery is fixed, read-only metadata even with a disabled or missing Python runtime", async (t) => {
  const directory = await workspace(t);
  const registry = tools(directory, { enabled: false, pythonExecutable: join(directory, "not-installed") });
  assert.deepEqual([...registry.keys()], ["science_search", "science_describe", "science_run"]);
  const found = await registry
    .get("science_search")
    .execute({ query: "声压", domain: "acoustics", limit: 12 });
  assert.equal(found.ok, true);
  assert.ok(found.tools.some((tool) => tool.name === "convert_spl_to_pressure"));
  const described = await registry.get("science_describe").execute({ name: "analyze_spectrum" });
  assert.equal(described.catalogVersion, SCIENCE_CATALOG_VERSION);
  assert.equal(described.parameters.additionalProperties, false);
  assert.equal(described.parameters.properties.wavelengths.maxItems, 8192);
  assert.deepEqual(described.dependencies, ["numpy", "scipy"]);
  assert.match(described.source.url, /blob\/e9dbbea[0-9a-f]{33}\//u);
  assert.match(described.source.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(SCIENCE_CATALOG.length, 12);
  assert.equal(new Set(SCIENCE_CATALOG.map((entry) => entry.group)).size, 7);
  assert.equal(new Set(SCIENCE_CATALOG.map((entry) => entry.name)).size, 12);
  assert.ok(SCIENCE_CATALOG.every((entry) => entry.units && entry.assumptions.length && entry.example));
  assert.deepEqual(await readdir(directory), []);
  const blocked = await registry
    .get("science_run")
    .execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.error.code, "unavailable");
  assert.deepEqual(await readdir(directory), []);
});

test("unknown catalog pins and unsupported tool names do not fall through to arbitrary execution", async (t) => {
  const directory = await workspace(t);
  const wrong = tools(directory, { catalogVersion: "future-unreviewed-version" });
  for (const [name, input] of [
    ["science_search", {}],
    ["science_describe", { name: "eV_to_nm" }],
    ["science_run", { name: "eV_to_nm", arguments: { energy_eV: 1 } }]
  ]) {
    const result = await wrong.get(name).execute(input);
    assert.equal(result.isError, true);
    assert.equal(result.error.code, "version_unavailable");
    assert.equal(result.catalogVersion, "future-unreviewed-version");
  }
  const registry = tools(directory);
  for (const name of ["../runner.py", "__import__", "os.system", "main", "fetch_structure_from_mp"]) {
    assert.equal(
      (await registry.get("science_run").execute({ name, arguments: {} })).error.code,
      "unknown_tool"
    );
  }
  assert.deepEqual(await readdir(directory), []);
});

test("scientific search finds embedded Chinese domain terms without matching unrelated natural language", async (t) => {
  const directory = await workspace(t);
  const search = tools(directory, { pythonExecutable: join(directory, "not-installed") }).get(
    "science_search"
  );
  for (const query of ["帮我分析光谱的峰位", "光谱分析", "spectral peak"]) {
    const result = await search.execute({ query, domain: "optics", limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, "analyze_spectrum");
  }
  const unrelated = await search.execute({ query: "帮我整理今天的会议日程" });
  assert.equal(unrelated.total, 0);
  assert.deepEqual(unrelated.tools, []);
  const otherDomain = await search.execute({ query: "帮我分析光谱的峰位", domain: "acoustics" });
  assert.equal(otherDomain.total, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("argument rejection happens before process creation and cannot poison later calls", async (t) => {
  const directory = await workspace(t);
  const run = tools(directory).get("science_run");
  const invalidInputs = [
    { name: "eV_to_nm", arguments: { energy_eV: 2, filename: "outside.json" } },
    { name: "eV_to_nm", arguments: { energy_eV: NaN } },
    { name: "eV_to_nm", arguments: { energy_eV: 0 } },
    { name: "eV_to_nm", arguments: { energy_eV: true } },
    { name: "eV_to_nm", arguments: { energy_eV: "2" } },
    { name: "eV_to_nm", arguments: { energy_eV: 2 }, pythonExecutable: "arbitrary" },
    { name: "isothermal_process", arguments: { V: [1, 2], T: 300 } },
    { name: "add_two_spl_values", arguments: { spl1_db: 60, spl2_db: 60, use_table: true } },
    {
      name: "calculate_spl_at_distance",
      arguments: { source_spl: 60, source_distance: 1, target_distance: 2, environment: "room" }
    },
    { name: "analyze_spectrum", arguments: { wavelengths: [1, 3, 2], intensities: [0, 1, 0] } },
    { name: "analyze_spectrum", arguments: { wavelengths: [1, 2, 3], intensities: [0, 0, 0] } },
    { name: "analyze_spectrum", arguments: { wavelengths: [1, 2, 3], intensities: [0, 1] } },
    {
      name: "analyze_spectrum",
      arguments: {
        wavelengths: Array.from({ length: 8193 }, (_, index) => index + 1),
        intensities: Array(8193).fill(1)
      }
    }
  ];
  for (const input of invalidInputs) {
    const result = await run.execute(input);
    assert.equal(result.error.code, "invalid_arguments");
    assert.equal(result.isError, true);
  }
  assert.deepEqual(await readdir(directory), []);
});

test(
  "real Python kernels execute in independent directories and a failed calculation recovers",
  { skip: !python },
  async (t) => {
    const directory = await workspace(t);
    const run = tools(directory).get("science_run");
    const wavelength = await run.execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } });
    assert.equal(wavelength.ok, true, JSON.stringify(wavelength));
    assert.ok(Math.abs(wavelength.result - 619.9209921660013) < 1e-8);
    assert.equal(wavelength.units, "nm");
    const energy = await run.execute({ name: "nm_to_eV", arguments: { wavelength_nm: wavelength.result } });
    assert.ok(Math.abs(energy.result - 2) < 1e-12);
    assert.notEqual(wavelength.metadata.executionDirectory, energy.metadata.executionDirectory);
    assert.ok(
      wavelength.metadata.executionDirectory.startsWith(join(await realpath(directory), "work", "science"))
    );
    assert.equal(wavelength.metadata.source.commit, "e9dbbea4369d67694e38bf8be67bedbcaf9e9300");
    const failed = await run.execute({
      name: "clausius_clapeyron_temperature",
      arguments: { P1: 1, T1: 300, P2: 1e100, delta_H_vap: 1 }
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.error.code, "numeric_range");
    const recovered = await run.execute({
      name: "add_two_spl_values",
      arguments: { spl1_db: 60, spl2_db: 60 }
    });
    assert.ok(Math.abs(recovered.result - 63.01029995663981) < 1e-10);
  }
);

test(
  "spectrum produces real SciPy peaks or an explicit isolated dependency error",
  { skip: !python },
  async (t) => {
    const directory = await workspace(t);
    const run = tools(directory).get("science_run");
    const result = await run.execute({
      name: "analyze_spectrum",
      arguments: { wavelengths: [400, 410, 420, 430, 440], intensities: [0, 10, 0, 5, 0], width: null }
    });
    if (!result.ok) {
      assert.equal(result.error.code, "dependency_unavailable", JSON.stringify(result));
      assert.equal(result.isError, true);
    } else {
      assert.deepEqual(result.result.peak_indices, [1, 3]);
      assert.deepEqual(result.result.peak_wavelengths, [410, 430]);
      assert.deepEqual(result.result.peak_intensities, [1, 0.5]);
      assert.equal(result.result.peak_widths, null);
    }
    assert.equal(
      (await run.execute({ name: "convert_spl_to_pressure", arguments: { spl_db: 60 } })).ok,
      true
    );
  }
);

test(
  "worker launch strips ambient credentials, proxy, PATH and Python injection variables",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await workspace(t);
    const executable = await fakePython(
      t,
      directory,
      `${fixturePrelude}
let input=''; process.stdin.on('data', b=>input+=b); process.stdin.on('end', ()=>{
  const request=JSON.parse(input);
  const forbidden=Object.keys(process.env).filter(k=>/KEY|TOKEN|PROXY|^PATH$|^NODE_OPTIONS$|^PYTHONPATH$|^PYTHONHOME$/i.test(k));
  const safe=request.version==='${SCIENCE_CATALOG_VERSION}' && request.tool==='eV_to_nm' && forbidden.length===0 && fs.realpathSync(process.env.TMPDIR)===fs.realpathSync(process.cwd());
  process.stdout.write(JSON.stringify({ok:true,result:safe?123:0}));
});`
    );
    const inherited = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      PYTHONPATH: process.env.PYTHONPATH
    };
    t.after(() => {
      for (const [key, value] of Object.entries(inherited))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
    });
    process.env.OPENAI_API_KEY = "test-only-do-not-inherit";
    process.env.HTTPS_PROXY = "http://test-only.invalid";
    process.env.PYTHONPATH = directory;
    const result = await tools(directory, { pythonExecutable: executable })
      .get("science_run")
      .execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } });
    assert.equal(result.result, 123, JSON.stringify(result));
  }
);

test(
  "missing interpreter, malformed response, nonzero exit and excessive output are contained",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await workspace(t);
    const request = { name: "eV_to_nm", arguments: { energy_eV: 2 } };
    const missing = await tools(directory, { pythonExecutable: join(directory, "missing") })
      .get("science_run")
      .execute(request);
    assert.equal(missing.error.code, "unavailable");
    for (const [script, expected] of [
      ["process.stdout.write('not-json');", "invalid_runner_response"],
      ["process.stdout.write(JSON.stringify({ok:true}));", "invalid_runner_response"],
      ['process.stdout.write(\'{"ok":true,"result":1e999}\');', "invalid_runner_response"],
      ["process.stderr.write('sensitive diagnostic'); process.exitCode=3;", "runner_failed"],
      ["process.stdout.write('x'.repeat(1100000));", "output_too_large"],
      ["process.stderr.write('x'.repeat(1100000));", "output_too_large"]
    ]) {
      const executable = await fakePython(t, directory, `${fixturePrelude}\n${script}`);
      const result = await tools(directory, { pythonExecutable: executable })
        .get("science_run")
        .execute(request);
      assert.equal(result.error.code, expected, JSON.stringify(result));
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes("sensitive diagnostic"));
    }
  }
);

async function waitForFile(path) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(10);
    }
  }
  throw new Error("Scientific fixture did not start");
}

async function assertStopped(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    if (state.status !== 0 || !state.stdout.trim() || state.stdout.trim().startsWith("Z")) return;
    await delay(20);
  }
  assert.fail(`Scientific fixture process ${pid} is still running`);
}

for (const cancellation of [false, true]) {
  test(
    `scientific ${cancellation ? "cancellation" : "timeout"} terminates the actual process group and permits recovery`,
    { skip: process.platform === "win32", timeout: 20000 },
    async (t) => {
      const directory = await workspace(t);
      const pidFile = join(directory, "pids.json");
      const executable = await fakePython(
        t,
        directory,
        `${fixturePrelude}
const {spawn}=require('node:child_process');
const child=spawn(${JSON.stringify(process.execPath)},['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'inherit'});
process.on('SIGTERM',()=>{});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`
      );
      const controller = new AbortController();
      const run = tools(directory, {
        pythonExecutable: executable,
        timeoutMs: cancellation ? 15000 : 4000
      }).get("science_run");
      const pending = run.execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } }, controller.signal);
      t.after(async () => {
        controller.abort();
        await pending;
      });
      const pids = JSON.parse(await waitForFile(pidFile));
      if (cancellation) controller.abort();
      const result = await pending;
      assert.equal(result.error.code, cancellation ? "cancelled" : "timeout");
      assert.equal(result.isError, true);
      await Promise.all(pids.map(assertStopped));
      const recoveryExecutable = await fakePython(
        t,
        directory,
        `${fixturePrelude}\nprocess.stdout.write(JSON.stringify({ok:true,result:42}));`
      );
      assert.equal(
        (
          await tools(directory, { pythonExecutable: recoveryExecutable })
            .get("science_run")
            .execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } })
        ).result,
        42
      );
    }
  );
}

test("pre-cancelled requests and invalid runtime settings never create worker directories", async (t) => {
  const directory = await workspace(t);
  const controller = new AbortController();
  controller.abort();
  const request = { name: "eV_to_nm", arguments: { energy_eV: 2 } };
  assert.equal(
    (await tools(directory).get("science_run").execute(request, controller.signal)).error.code,
    "cancelled"
  );
  for (const setting of [
    { pythonExecutable: "relative/python3" },
    { pythonExecutable: "python3\ninvalid" },
    { timeoutMs: 0 },
    { timeoutMs: Infinity }
  ]) {
    assert.equal(
      (await tools(directory, setting).get("science_run").execute(request)).error.code,
      "unavailable"
    );
  }
  assert.deepEqual(await readdir(directory), []);
});

test(
  "a scientific work-directory symlink cannot redirect execution outside the task",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await workspace(t);
    const outside = await workspace(t);
    await symlink(outside, join(directory, "work"));
    const result = await tools(directory)
      .get("science_run")
      .execute({ name: "eV_to_nm", arguments: { energy_eV: 2 } });
    assert.equal(result.error.code, "unavailable");
    assert.equal(result.isError, true);
    assert.deepEqual(await readdir(outside), []);
  }
);
