import type { ScienceCatalogEntry, ScienceSchema } from "./catalog.js";

const repository = "https://github.com/CMarsRover/SciAgentGYM";
const commit = "e9dbbea4369d67694e38bf8be67bedbcaf9e9300";
const version = "sciagentgym-e9dbbea-mass-spec-v6";
const sources = {
  peaks: [
    "toolkits/life_science/mass_spectrometry/mass_spectrometry_toolkit_0070000.py",
    "a5f78e95273ac09fa0c0c12a0b17b3fe019ae29729819634bbb36e2c757c1de6"
  ],
  isotopes: [
    "toolkits/life_science/mass_spectrometry/mass_spectrometry_toolkit_0050000.py",
    "a2b623e3a6fcfc1d2014b42f7c64b7f1abc4e02aba5d3b52b46247e314a911d5"
  ]
} as const;

function source(key: keyof typeof sources, line: number): ScienceCatalogEntry["source"] {
  const [path, sha256] = sources[key];
  return { repository, commit, path, line, sha256, url: `${repository}/blob/${commit}/${path}#L${line}` };
}
const number = (description: string, minimum: number, maximum: number): ScienceSchema => ({
  type: "number",
  description,
  minimum,
  maximum
});
const array = (items: ScienceSchema, description: string): ScienceSchema => ({
  type: "array",
  items,
  minItems: 1,
  maxItems: 8192,
  description
});
const mz = (): ScienceSchema =>
  array(
    number("Positive m/z coordinate in Th (Da/e).", 1e-100, 1e6),
    "Strictly increasing centroid m/z coordinates, at most 8192; no duplicates or profile samples."
  );
const intensity = (): ScienceSchema =>
  array(
    number("Nonnegative finite intensity in a common arbitrary unit.", 0, 1e100),
    "Same length as the m/z array; at least one input intensity must be positive."
  );
const object = (properties: Record<string, ScienceSchema>, required: string[]): ScienceSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

export const MASS_SPECTROMETRY_ENTRIES: ScienceCatalogEntry[] = [
  {
    name: "parse_mass_spectrum_peaks",
    domain: "chemistry",
    group: "mass_spectrum_centroids",
    description:
      "Normalize a bounded centroid mass-spectrum peak list to its base peak and filter by relative intensity, without assigning a molecular ion.",
    keywords: ["mass spectrum", "centroid", "base peak", "m/z", "质谱", "峰表", "基峰", "相对强度"],
    parameters: object(
      {
        mz_values: mz(),
        intensities: intensity(),
        intensity_threshold: {
          ...number("Inclusive minimum relative intensity as percent of the input base peak.", 0, 100),
          default: 1
        }
      },
      ["mz_values", "intensities"]
    ),
    units: {
      mz: "Th (Da/e)",
      raw_intensity: "input arbitrary intensity unit",
      relative_intensity: "% of input base peak",
      intensity_threshold: "% of input base peak",
      total_points: "count",
      filtered_peaks: "count"
    },
    assumptions: [
      "Input is an already centroided, strictly increasing positive m/z peak list. This is not profile peak detection, centroiding, smoothing, baseline removal or deconvolution.",
      "Each raw intensity is divided by the positive input maximum and multiplied by 100 before inclusive threshold filtering. Returned peaks retain raw_intensity and relative_intensity; ties for base peak select the first (lowest-m/z) input peak. highest_mz_peak means only the highest retained m/z, not a molecular ion or molecular mass.",
      "At most 8192 input centroids and 1024 retained centroids; exceeding the retained budget returns result_too_large without truncation. Positive normalized intensities outside the representable floating-point range return numeric_range. No charge, fragment, isotope, structure or stability assignment is made."
    ],
    dependencies: [],
    example: { mz_values: [100, 102, 150], intensities: [1000, 320, 5], intensity_threshold: 1 },
    source: source("peaks", 37)
  },
  {
    name: "calculate_theoretical_isotope_pattern",
    domain: "chemistry",
    group: "mass_spectrum_isotopes",
    description:
      "Calculate a bounded independent Cl/C binomial isotope distribution in nominal mass bins, including carbon contributions.",
    keywords: ["isotope", "chlorine", "carbon", "binomial", "M+2", "同位素", "氯", "碳", "二项分布", "质谱"],
    parameters: object(
      {
        num_chlorine: {
          type: "integer",
          minimum: 0,
          maximum: 16,
          description: "Number of chlorine atoms, 0 to 16."
        },
        num_carbon: {
          type: "integer",
          minimum: 0,
          maximum: 128,
          default: 0,
          description: "Number of carbon atoms, 0 to 128; actually contributes to the distribution."
        }
      },
      ["num_chlorine"]
    ),
    units: {
      mass_shift: "nominal mass-number difference",
      probability: "fraction (sum over bins is 1)",
      relative_intensity: "% of the largest nominal bin",
      M_plus_2_ratio: "dimensionless",
      abundances: "fixed isotope fractions",
      num_chlorine: "atom count",
      num_carbon: "atom count",
      model: "model name"
    },
    assumptions: [
      "Independent binomial model with fixed isotope fractions: Cl35=0.7576, Cl37=0.2424, C12=0.9893, C13=0.0107. Natural sample compositions vary; these values are model assumptions, not a measurement of the sample.",
      "A state containing j carbon-13 atoms and k chlorine-37 atoms contributes to nominal mass shift j+2*k. The distribution includes all integer nominal bins, including zero-probability bins. probability is not base-peak-normalized; relative_intensity sets the largest bin to 100 and the all-light M bin need not be that base peak.",
      "M_plus_2_ratio is the nominal-bin probability at shift 2 divided by that at shift 0, including two-carbon-13 contributions. This is not exact isotopologue masses, ion m/z or fine structure. Isotopes of H/N/O/S/Br and all other elements are omitted; no compound formula or identity is inferred. Counts are bounded to keep the full distribution representable."
    ],
    dependencies: [],
    example: { num_chlorine: 2, num_carbon: 2 },
    source: source("isotopes", 44)
  },
  {
    name: "find_isotope_cluster",
    domain: "chemistry",
    group: "mass_spectrum_isotopes",
    description:
      "Find unambiguous centroid candidates at a supplied reference and nominal M+2/M+4/M+6 offsets for a known absolute charge.",
    keywords: ["isotope cluster", "M+2", "charge", "mass tolerance", "质谱", "同位素簇", "电荷", "匹配容差"],
    parameters: object(
      {
        peak_mz: mz(),
        peak_intensity: intensity(),
        base_mz: number(
          "Requested reference M coordinate in Th; it need not be the most intense peak.",
          1e-100,
          1e6
        ),
        mass_tolerance: {
          ...number("Inclusive matching tolerance in Th; must also be less than 0.5/abs_charge.", 1e-6, 0.25),
          default: 0.05
        },
        abs_charge: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 1,
          description: "Known absolute ion charge, supplied by the caller; never inferred from the spectrum."
        }
      },
      ["peak_mz", "peak_intensity", "base_mz"]
    ),
    units: {
      peak_mz: "Th (Da/e)",
      base_mz: "Th (Da/e)",
      requested_mz: "Th (Da/e)",
      M_mz: "Th (Da/e)",
      M_plus_2_mz: "Th (Da/e)",
      expected_mz: "Th (Da/e)",
      delta_mz: "Th (Da/e)",
      mass_tolerance: "Th (Da/e)",
      nominal_spacing: "Th (Da/e)",
      intensity: "input arbitrary intensity unit",
      M_plus_2_ratio: "dimensionless",
      abs_charge: "elementary-charge count"
    },
    assumptions: [
      "The caller supplies a reference M and known absolute charge 1..10. Search positions are nominal M, M+2, M+4 and M+6, with m/z spacing 2/abs_charge. This is a nominal candidate search, not exact isotope-mass/fine-structure matching; tight tolerances can exclude real isotope peaks whose exact mass differences depart from nominal integers.",
      "The reference is first matched within the inclusive tolerance; subsequent targets are anchored to the observed M coordinate. Each matching window must contain at most one centroid; multiple candidates return ambiguous_match without choosing one. The tolerance must be less than 0.5/abs_charge, so search windows cannot overlap.",
      "M_mz is observed rather than requested. Missing M returns an empty cluster; missing M or M+2, or zero reference intensity, returns M_plus_2_ratio=null rather than zero. Intensities are not renormalized; ratios use the supplied common scale. Unrepresentable positive ratios return numeric_range. At most 8192 strictly increasing centroids, with at least one positive input intensity.",
      "A matching cluster does not establish chlorine count, isotope origin, ion charge, molecular ion, formula, structure or confidence. Nominal-bin theory and narrow-window centroid ratios are comparable only when the same isotope contributions and measurement resolution are represented."
    ],
    dependencies: [],
    example: { peak_mz: [100, 102, 104], peak_intensity: [100, 64, 10], base_mz: 100 },
    source: source("isotopes", 195)
  },
  {
    name: "rdkit_exact_mass_and_formula",
    domain: "chemistry",
    group: "mass_spectrum_molecular_formula",
    runtime: "chemistry",
    description:
      "Calculate an isotope-labelled molecular formula and neutral ExactMolWt in Da for one bounded sanitized molecular SMILES.",
    keywords: [
      "RDKit",
      "exact mass",
      "monoisotopic",
      "molecular formula",
      "精确质量",
      "单同位素质量",
      "分子式",
      "质谱"
    ],
    parameters: object(
      {
        smiles: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          description:
            "One ASCII molecular SMILES without whitespace/name/CXSMILES; at most 256 input atoms including explicit hydrogen."
        }
      },
      ["smiles"]
    ),
    units: {
      canonical_smiles: "RDKit canonical isomeric SMILES",
      formula: "isotope-labelled molecular formula",
      exact_mass_da: "Da",
      rdkit_version: "version"
    },
    assumptions: [
      "Atria-native wrapper using the unchanged v4 molecular parser and fixed rdkit==2026.9.1 (2026.09.1) in the selected chemistry Python environment. One connected closed-shell molecule using H/B/C/N/O/F/Si/P/S/Cl/Br/I. Isotopes require tabulated masses; raw isotope labels above 65535 and per-atom H counts/charge magnitudes above 8 are rejected to avoid parser narrowing. No names, whitespace, CXSMILES, atom maps, query/dummy atoms, salts, mixtures or non-ordinary covalent bonds.",
      "Zero net formal charge is required; charge-separated representations may remain. ExactMolWt uses the most abundant isotope for unspecified labels and tabulated masses for explicit labels. Full floating-point output is retained; this is distinct from average MolWt, a measured mass, a complete isotope distribution or a charged-ion/adduct m/z. No ionization or protonation state is inferred.",
      "Formula uses CalcMolFormula(separateIsotopes=True,abbreviateHIsotopes=False), preserving labels such as [13C] and [2H] and including implicit hydrogen. No DBE, fragmentation, confidence or structure identification is returned. Missing/mismatched RDKit affects only the selected chemistry calculation; no package is installed or downloaded."
    ],
    dependencies: ["rdkit==2026.9.1"],
    example: { smiles: "CCO" },
    source: {
      kind: "atria-native",
      path: "src/tools/science/mass-chemistry.py",
      documentation:
        "https://www.rdkit.org/docs/source/rdkit.Chem.Descriptors.html#rdkit.Chem.Descriptors.ExactMolWt",
      implementationVersion: version
    }
  }
];
