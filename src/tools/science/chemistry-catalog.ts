import type { ScienceCatalogEntry, ScienceSchema } from "./catalog.js";

const implementationVersion = "atria-rdkit-chemistry-v4";
const parameters = (): ScienceSchema => ({
  type: "object",
  properties: {
    smiles: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
      description:
        "One ASCII molecular SMILES without whitespace, a name or CXSMILES; at most 256 input atoms including explicit hydrogen."
    }
  },
  required: ["smiles"],
  additionalProperties: false
});

const scope =
  "Atria-native wrapper around pinned RDKit, informed by the upstream descriptor selection; this is not an extracted SciAgentGYM function. One connected closed-shell molecule using H, B, C, N, O, F, Si, P, S, Cl, Br or I. Isotope labels must have tabulated RDKit masses; unknown-isotope mass-number fallback is rejected. Raw explicit bracket H counts and per-atom charge magnitudes must not exceed 8, including numeric and repeated-sign charge forms. No atom maps, query/dummy atoms, salts, mixtures or non-covalent bond extensions; invalid syntax/valence returns invalid_smiles, while valid structures outside this scope return unsupported_molecule.";

const dependency =
  "Requires rdkit==2026.9.1 (RDKit version 2026.09.1) in the selected chemistry Python environment; a different RDKit version returns dependency_version_mismatch. No installation or download occurs during search, describe or execution.";

function source(documentation: string): ScienceCatalogEntry["source"] {
  return {
    kind: "atria-native",
    path: "src/tools/science/chemistry.py",
    documentation,
    implementationVersion
  };
}

/** Native, fixed RDKit wrappers; the prior SciAgentGYM catalog entries are unchanged. */
export const CHEMISTRY_ENTRIES: ScienceCatalogEntry[] = [
  {
    name: "rdkit_validate_smiles",
    domain: "chemistry",
    group: "smiles_validation",
    runtime: "chemistry",
    description:
      "Parse and sanitize one bounded molecular SMILES with pinned RDKit, returning its canonical form, graph counts and formal charge.",
    keywords: ["RDKit", "SMILES", "validate", "sanitize", "化学结构", "校验", "价态", "分子"],
    parameters: parameters(),
    units: {
      smiles: "SMILES",
      valid: "boolean",
      canonical_smiles: "RDKit canonical isomeric SMILES",
      atom_count: "count",
      heavy_atom_count: "count",
      formal_charge: "elementary charge",
      rdkit_version: "version"
    },
    assumptions: [
      scope,
      dependency,
      "valid=true means RDKit parsing/sanitization within the supported scope, not experimental existence, stability, identity or complete stereochemical correctness. Invalid input returns an error rather than valid=false.",
      "Charged single molecules may be validated. atom_count describes the normalized RDKit graph after ordinary explicit-H removal, excludes implicit hydrogens and retains isotope-labelled H; the 256-atom input limit is checked before H removal."
    ],
    dependencies: ["rdkit==2026.9.1"],
    example: { smiles: "OCC" },
    source: source("https://www.rdkit.org/docs/RDKit_Book.html#molecular-sanitization")
  },
  {
    name: "rdkit_canonicalize_smiles",
    domain: "chemistry",
    group: "smiles_canonicalization",
    runtime: "chemistry",
    description:
      "Serialize one sanitized molecule as RDKit canonical isomeric SMILES without tautomer, charge or protonation-state standardization.",
    keywords: ["RDKit", "SMILES", "canonical", "isomeric", "规范化", "标准化", "立体化学", "同位素"],
    parameters: parameters(),
    units: {
      smiles: "SMILES",
      canonical_smiles: "RDKit canonical isomeric SMILES",
      rdkit_version: "version"
    },
    assumptions: [
      scope,
      dependency,
      "Canonical isomeric serialization retains RDKit-supported isotope and stereochemical information; unspecified stereochemistry is not invented or enumerated. Canonical SMILES depends on toolkit and version, and is not a universal chemical identifier.",
      "Uses RDKit sanitization/aromaticity perception and ordinary explicit-H removal. Does not standardize tautomers, select protonation state, neutralize charges, remove salts or infer experimental identity."
    ],
    dependencies: ["rdkit==2026.9.1"],
    example: { smiles: "OCC" },
    source: source("https://www.rdkit.org/docs/GettingStartedInPython.html#writing-molecules")
  },
  {
    name: "rdkit_molecular_descriptors",
    domain: "chemistry",
    group: "molecular_descriptors",
    runtime: "chemistry",
    description:
      "Calculate MolWt, Wildman-Crippen logP, Lipinski HBD/HBA and N/O-only TPSA for one zero-net-formal-charge molecular structure.",
    keywords: [
      "RDKit",
      "molecular weight",
      "LogP",
      "HBD",
      "HBA",
      "TPSA",
      "分子量",
      "氢键",
      "极性表面积",
      "描述符"
    ],
    parameters: parameters(),
    units: {
      smiles: "SMILES",
      canonical_smiles: "RDKit canonical isomeric SMILES",
      molecular_weight: "g/mol",
      logp_crippen: "dimensionless (log10)",
      hydrogen_bond_donors: "count",
      hydrogen_bond_acceptors: "count",
      tpsa: "angstrom^2",
      rdkit_version: "version"
    },
    assumptions: [
      scope,
      dependency,
      "Requires zero net formal charge, with charge-separated representations allowed. No protonation/tautomer state is inferred or neutralized. MolWt uses average atomic weights for unspecified isotopes and tabulated masses for isotope labels; it is not a monoisotopic ExactMolWt.",
      "logp_crippen is the Wildman-Crippen atomic-contribution estimate for the supplied structure, not measured logP or pH-dependent logD. These descriptors do not establish solubility, permeability, safety or drug efficacy.",
      "HBD/HBA use RDKit Lipinski definitions. TPSA uses CalcTPSA(includeSandP=False), the default N/O-only contribution model excluding sulfur/phosphorus contributions, in square angstrom; it is not a 3D surface-area calculation."
    ],
    dependencies: ["rdkit==2026.9.1"],
    example: { smiles: "CCO" },
    source: source("https://www.rdkit.org/docs/source/rdkit.Chem.Crippen.html")
  }
];
