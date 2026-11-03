import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const configuredPython = process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON;
const python = configuredPython || process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const runner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const chemistry = fileURLToPath(new URL("../src/tools/science/chemistry.py", import.meta.url));
const version = "atria-rdkit-chemistry-v4";
const rdkitVersion = "2026.09.1";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-chemistry-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    execute(args, input) {
      const child = spawnSync(python, ["-I", "-B", ...args], {
        cwd,
        input: input === undefined ? undefined : JSON.stringify(input),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { LANG: "C.UTF-8", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" }
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(child.stderr, /Traceback \(most recent call last\)/);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      assert.doesNotMatch(child.stdout, /\b(?:NaN|Infinity)\b/);
      return JSON.parse(child.stdout);
    },
    call(tool, args, { noSite = false, catalogVersion = version } = {}) {
      return this.execute([...(noSite ? ["-S"] : []), runner], {
        version: catalogVersion,
        tool,
        arguments: args
      });
    }
  };
}

function success(response) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.assumptions.length > 0);
  assert.equal(response.result.rdkit_version, rdkitVersion);
  return response.result;
}

function failure(response, code) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, code);
}

function near(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`
  );
}

function rdkit(t, science) {
  const response = science.call("rdkit_validate_smiles", { smiles: "CCO" });
  if (
    !configuredPython &&
    !response.ok &&
    ["dependency_unavailable", "dependency_version_mismatch"].includes(response.error.code)
  ) {
    t.skip("Set COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON to the pinned RDKit chemistry environment");
    return false;
  }
  success(response);
  return true;
}

test("chemistry metadata import is lazy and missing RDKit affects only its selected tools", (t) => {
  const science = fixture(t);
  const imported = science.execute([
    "-S",
    "-c",
    `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("chemistry", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({"version":module.VERSION,"tools":sorted(module.TOOLS),"rdkit_loaded":"rdkit" in sys.modules}))
`,
    chemistry
  ]);
  assert.equal(imported.version, version);
  assert.deepEqual(imported.tools, [
    "rdkit_canonicalize_smiles",
    "rdkit_molecular_descriptors",
    "rdkit_validate_smiles"
  ]);
  assert.equal(imported.rdkit_loaded, false);
  failure(
    science.call("rdkit_validate_smiles", { smiles: "CCO" }, { noSite: true }),
    "dependency_unavailable"
  );
  const oldScalar = science.call("distance_from_modulus", { mu: 10 }, { noSite: true });
  assert.equal(oldScalar.ok, true);
  assert.equal(oldScalar.result, 1000);
  assert.equal(oldScalar.units, "pc");
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("SMILES validation returns bounded sanitized graph counts and preserves charged single species", (t) => {
  const science = fixture(t);
  if (!rdkit(t, science)) return;
  assert.deepEqual(success(science.call("rdkit_validate_smiles", { smiles: "OCC" })), {
    valid: true,
    canonical_smiles: "CCO",
    atom_count: 3,
    heavy_atom_count: 3,
    formal_charge: 0,
    rdkit_version: rdkitVersion
  });
  const ammonium = success(science.call("rdkit_validate_smiles", { smiles: "[NH4+]" }));
  assert.equal(ammonium.formal_charge, 1);
  assert.equal(ammonium.canonical_smiles, "[NH4+]");
  const hydrogens = success(science.call("rdkit_validate_smiles", { smiles: "[H]OC([H])([H])C" }));
  assert.equal(hydrogens.canonical_smiles, "CCO");
  assert.equal(hydrogens.atom_count, 3);
  const deuterated = success(science.call("rdkit_validate_smiles", { smiles: "[2H]C" }));
  assert.equal(deuterated.atom_count, 2);
  assert.equal(deuterated.heavy_atom_count, 1);
  assert.match(deuterated.canonical_smiles, /\[2H\]/);
  assert.equal(success(science.call("rdkit_validate_smiles", { smiles: "C".repeat(256) })).atom_count, 256);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("canonical isomeric SMILES retain isotope and stereo information without merging tautomers", (t) => {
  const science = fixture(t);
  if (!rdkit(t, science)) return;
  const canonical = (smiles) =>
    success(science.call("rdkit_canonicalize_smiles", { smiles })).canonical_smiles;
  assert.equal(canonical("OCC"), "CCO");
  assert.equal(canonical("C1=CC=CC=C1"), "c1ccccc1");
  const first = canonical("F[C@H](Cl)Br");
  const second = canonical("F[C@@H](Cl)Br");
  assert.notEqual(first, second);
  assert.equal(canonical(first), first);
  assert.notEqual(canonical("F/C=C/F"), canonical("F/C=C\\F"));
  assert.equal(canonical("[13CH3]CO"), "[13CH3]CO");
  assert.notEqual(canonical("CC(=O)C"), canonical("CC(O)=C"));
  assert.equal(canonical("[CH3][NH3+]"), "C[NH3+]");
});

test("real RDKit descriptors have known ethanol, aspirin and benzene values and explicit units", (t) => {
  const science = fixture(t);
  if (!rdkit(t, science)) return;
  const response = science.call("rdkit_molecular_descriptors", { smiles: "CCO" });
  const ethanol = success(response);
  assert.equal(ethanol.canonical_smiles, "CCO");
  near(ethanol.molecular_weight, 46.069);
  near(ethanol.logp_crippen, -0.0014);
  assert.equal(ethanol.hydrogen_bond_donors, 1);
  assert.equal(ethanol.hydrogen_bond_acceptors, 1);
  near(ethanol.tpsa, 20.23);
  assert.equal(response.units.molecular_weight, "g/mol");
  assert.equal(response.units.logp_crippen, "dimensionless (log10)");
  assert.equal(response.units.tpsa, "angstrom^2");
  const aspirin = success(science.call("rdkit_molecular_descriptors", { smiles: "CC(=O)Oc1ccccc1C(=O)O" }));
  near(aspirin.molecular_weight, 180.159);
  near(aspirin.logp_crippen, 1.3101);
  assert.equal(aspirin.hydrogen_bond_donors, 1);
  assert.equal(aspirin.hydrogen_bond_acceptors, 3);
  near(aspirin.tpsa, 63.6);
  const benzene = success(science.call("rdkit_molecular_descriptors", { smiles: "c1ccccc1" }));
  near(benzene.molecular_weight, 78.114);
  near(benzene.logp_crippen, 1.6866);
  assert.equal(benzene.hydrogen_bond_donors, 0);
  assert.equal(benzene.hydrogen_bond_acceptors, 0);
  assert.equal(benzene.tpsa, 0);
  const labelled = success(science.call("rdkit_molecular_descriptors", { smiles: "[13CH3]CO" }));
  near(labelled.molecular_weight, 47.06135484);
  const deuterated = success(science.call("rdkit_molecular_descriptors", { smiles: "[2H]C" }));
  near(deuterated.molecular_weight, 17.049101778);
  const sulfur = science.call("rdkit_molecular_descriptors", { smiles: "CS" });
  assert.equal(success(sulfur).tpsa, 0);
  assert.match(sulfur.assumptions.join(" "), /includeSandP=False/);
  const nitro = success(science.call("rdkit_molecular_descriptors", { smiles: "[O-][N+](=O)c1ccccc1" }));
  near(nitro.molecular_weight, 123.111);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("chemistry rejects invalid valence, syntax, unsupported species and oversized graphs then recovers", (t) => {
  const science = fixture(t);
  if (!rdkit(t, science)) return;
  for (const smiles of ["not-a-smiles", "C1CC", "CN(C)(C)C", "c1cccc1", "CC>>CO"]) {
    failure(science.call("rdkit_validate_smiles", { smiles }), "invalid_smiles");
  }
  for (const smiles of [
    "CCO.O",
    "[Na+]",
    "*",
    "[CH3:1]O",
    "[CH3:0]O",
    "[CH3]",
    "[999CH3]CO",
    "[999H]C",
    "[65549CH3]CO",
    "[65536CH3]CO",
    "[CH4+256]",
    "[CH4-256]",
    "[NH4+257]",
    "[CH260]",
    "[CH65540]",
    `[CH4${"+".repeat(256)}]`,
    `[CH4${"-".repeat(256)}]`,
    "C~C",
    "C".repeat(257),
    "C([H])([H])".repeat(86)
  ]) {
    failure(science.call("rdkit_validate_smiles", { smiles }), "unsupported_molecule");
  }
  failure(science.call("rdkit_molecular_descriptors", { smiles: "[NH4+]" }), "unsupported_molecule");
  for (const name of ["rdkit_canonicalize_smiles", "rdkit_molecular_descriptors"])
    failure(science.call(name, { smiles: "[999CH3]CO" }), "unsupported_molecule");
  failure(science.call("rdkit_canonicalize_smiles", { smiles: "[CH260]" }), "unsupported_molecule");
  failure(science.call("rdkit_molecular_descriptors", { smiles: "[CH4+256]" }), "unsupported_molecule");
  near(success(science.call("rdkit_molecular_descriptors", { smiles: "[CH4]" })).molecular_weight, 16.043);
  assert.equal(
    success(science.call("rdkit_molecular_descriptors", { smiles: "CCO" })).hydrogen_bond_donors,
    1
  );
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("chemistry input contracts reject extra fields and non-molecular text before loading dependencies", (t) => {
  const science = fixture(t);
  for (const smiles of [
    "",
    " ",
    "CCO ethanol",
    "CCO\n",
    "CO |$C2;O1$|",
    "乙醇",
    "C".repeat(2049),
    null,
    1,
    true,
    ["CCO"]
  ]) {
    failure(science.call("rdkit_validate_smiles", { smiles }, { noSite: true }), "invalid_arguments");
  }
  failure(science.call("rdkit_validate_smiles", {}, { noSite: true }), "invalid_arguments");
  failure(
    science.call("rdkit_validate_smiles", { smiles: "CCO", path: "anything" }, { noSite: true }),
    "invalid_arguments"
  );
  failure(
    science.call("rdkit_validate_smiles", { smiles: "CCO", temperature: 298.15 }, { noSite: true }),
    "invalid_arguments"
  );
  failure(science.call("predict_logP_from_structure", { smiles: "CCO" }, { noSite: true }), "unknown_tool");
  for (const catalogVersion of [
    "sciagentgym-e9dbbea-pilot-v1",
    "sciagentgym-e9dbbea-analysis-v2",
    "sciagentgym-e9dbbea-astronomy-v3"
  ]) {
    failure(
      science.call("rdkit_validate_smiles", { smiles: "CCO" }, { noSite: true, catalogVersion }),
      "unknown_tool"
    );
  }
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("a real RDKit module reporting another version is rejected without changing the parent environment", (t) => {
  const science = fixture(t);
  if (!rdkit(t, science)) return;
  // Fault-inject only package-version drift; all descriptor/SMILES tests use the real pinned library.
  const result = science.execute(
    [
      "-c",
      `
import importlib.util, json, sys, rdkit
rdkit.__version__ = "2025.09.3"
spec = importlib.util.spec_from_file_location("runner", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module._execute(json.load(sys.stdin)), allow_nan=False))
`,
      runner
    ],
    { version, tool: "rdkit_validate_smiles", arguments: { smiles: "CCO" } }
  );
  failure(result, "dependency_version_mismatch");
  assert.equal(success(science.call("rdkit_validate_smiles", { smiles: "CCO" })).valid, true);
});
