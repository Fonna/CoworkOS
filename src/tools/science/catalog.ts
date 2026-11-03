import { ANALYSIS_ENTRIES } from "./analysis-catalog.js";
import { ASTRONOMY_ENTRIES } from "./astronomy-catalog.js";
import { CHEMISTRY_ENTRIES } from "./chemistry-catalog.js";
import { MATERIALS_ENTRIES } from "./materials-catalog.js";
import { MASS_SPECTROMETRY_ENTRIES } from "./mass-spectrometry-catalog.js";
import { STATISTICS_ENTRIES } from "./statistics-catalog.js";

/** Static reviewed versions; loading metadata never probes the host runtime. */
export const SCIENCE_PILOT_CATALOG_VERSION = "sciagentgym-e9dbbea-pilot-v1";
export const SCIENCE_ANALYSIS_CATALOG_VERSION = "sciagentgym-e9dbbea-analysis-v2";
export const SCIENCE_ASTRONOMY_CATALOG_VERSION = "sciagentgym-e9dbbea-astronomy-v3";
export const SCIENCE_CHEMISTRY_CATALOG_VERSION = "atria-rdkit-chemistry-v4";
export const SCIENCE_MATERIALS_CATALOG_VERSION = "sciagentgym-e9dbbea-materials-v5";
export const SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION = "sciagentgym-e9dbbea-mass-spec-v6";
export const SCIENCE_STATISTICS_CATALOG_VERSION = "atria-statistics-v7";
export const DEFAULT_SCIENCE_CATALOG_VERSION = SCIENCE_STATISTICS_CATALOG_VERSION;
/** Compatibility alias for callers that explicitly selected the original pilot. */
export const SCIENCE_CATALOG_VERSION = SCIENCE_PILOT_CATALOG_VERSION;
export const SCIENCE_UPSTREAM_COMMIT = "e9dbbea4369d67694e38bf8be67bedbcaf9e9300";

export interface ScienceSchema {
  type: string | readonly string[];
  description?: string;
  properties?: Readonly<Record<string, ScienceSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: ScienceSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  const?: unknown;
}

export interface ScienceCatalogEntry {
  name: string;
  domain:
    | "optics"
    | "thermodynamics"
    | "acoustics"
    | "chemistry"
    | "materials_science"
    | "astronomy"
    | "statistics";
  group: string;
  description: string;
  keywords: readonly string[];
  parameters: ScienceSchema;
  units: Readonly<Record<string, string>>;
  assumptions: readonly string[];
  dependencies: readonly string[];
  runtime?: "chemistry";
  example: Readonly<Record<string, unknown>>;
  source:
    | { repository: string; commit: string; path: string; line: number; sha256: string; url: string }
    | { kind: "atria-native"; path: string; documentation: string; implementationVersion: string };
}

const numeric = (description: string, minimum = 1e-100, maximum = 1e100): ScienceSchema => ({
  type: "number",
  description,
  minimum,
  maximum
});
const positive = (description: string, defaultValue?: number): ScienceSchema => ({
  ...numeric(description),
  ...(defaultValue === undefined ? {} : { default: defaultValue })
});
const db = (description: string): ScienceSchema => numeric(description, -1000, 1000);
const object = (properties: Record<string, ScienceSchema>, required: string[]): ScienceSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
const gas = {
  n: positive("Amount of substance in mol.", 1),
  R: positive("Gas constant in J/(mol K).", 8.31446261815324)
};
const vapor = {
  delta_H_vap: positive("Constant molar enthalpy of vaporization in J/mol."),
  R: positive("Gas constant in J/(mol K).", 8.314)
};
const repository = "https://github.com/CMarsRover/SciAgentGYM";
const upstream = {
  photon: [
    "toolkits/physics/optics/gpqa_physics_chemsirty_63.py",
    "c4f22f1fb0cb42664617f86ffb0b167ea08c1f254b356f60bfc783d4a92867ed"
  ],
  gas: [
    "toolkits/physics/thermodynamics/thermodynamics_solver_215.py",
    "f9b912cab4a8901349437e8eaa29bf703754be5804586b6000cfe4d6eb8f8ac9"
  ],
  vapor: [
    "toolkits/physics/thermodynamics/clausius_clapeyron_temperature.py",
    "1663fe15ff8b65ad20130a9e6d63b3e9bec557082e8a4a547e791e68a75e421b"
  ],
  sound: [
    "toolkits/physics/acoustics/acoustics_toolkit_claude_653.py",
    "9236560318a03425377fa16138911796f01e2482fc7256f6906aaae929e6f9d5"
  ],
  spectrum: [
    "toolkits/physics/optics/optical_wave_propagation_65.py",
    "23646475aaaf369b044262d44e30dbe6d6e0b0288a4229cab70db6e6c7f9314c"
  ]
} as const;

function source(key: keyof typeof upstream, line: number): ScienceCatalogEntry["source"] {
  const [path, sha256] = upstream[key];
  return {
    repository,
    commit: SCIENCE_UPSTREAM_COMMIT,
    path,
    line,
    sha256,
    url: `${repository}/blob/${SCIENCE_UPSTREAM_COMMIT}/${path}#L${line}`
  };
}

const entries: ScienceCatalogEntry[] = [
  {
    name: "eV_to_nm",
    domain: "optics",
    group: "photon_conversion",
    description: "Convert photon energy in eV to vacuum wavelength in nm.",
    keywords: ["photon", "energy", "wavelength", "光子", "能量", "波长"],
    parameters: object({ energy_eV: positive("Photon energy in eV.") }, ["energy_eV"]),
    units: { energy_eV: "eV", result: "nm" },
    assumptions: ["Single photon in vacuum; E = hc/lambda."],
    dependencies: [],
    example: { energy_eV: 2 },
    source: source("photon", 118)
  },
  {
    name: "nm_to_eV",
    domain: "optics",
    group: "photon_conversion",
    description: "Convert vacuum photon wavelength in nm to energy in eV.",
    keywords: ["photon", "energy", "wavelength", "光子", "能量", "波长"],
    parameters: object({ wavelength_nm: positive("Vacuum wavelength in nm.") }, ["wavelength_nm"]),
    units: { wavelength_nm: "nm", result: "eV" },
    assumptions: ["Single photon in vacuum; E = hc/lambda."],
    dependencies: [],
    example: { wavelength_nm: 500 },
    source: source("photon", 146)
  },
  {
    name: "ideal_gas_state",
    domain: "thermodynamics",
    group: "ideal_gas",
    description: "Calculate ideal-gas temperature from pressure and volume (scalar inputs).",
    keywords: ["temperature", "pressure", "volume", "gas", "理想气体", "温度"],
    parameters: object({ P: positive("Absolute pressure in Pa."), V: positive("Volume in m^3."), ...gas }, [
      "P",
      "V"
    ]),
    units: { P: "Pa", V: "m^3", n: "mol", R: "J/(mol K)", result: "K" },
    assumptions: ["Ideal gas; PV = nRT; absolute pressure and temperature."],
    dependencies: [],
    example: { P: 101325, V: 0.024, n: 1 },
    source: source("gas", 8)
  },
  {
    name: "isothermal_process",
    domain: "thermodynamics",
    group: "ideal_gas",
    description: "Calculate ideal-gas pressure at a specified constant temperature and volume.",
    keywords: ["pressure", "gas", "isothermal", "等温", "压强"],
    parameters: object({ V: positive("Volume in m^3."), T: positive("Absolute temperature in K."), ...gas }, [
      "V",
      "T"
    ]),
    units: { V: "m^3", T: "K", n: "mol", R: "J/(mol K)", result: "Pa" },
    assumptions: ["Ideal gas at constant temperature; P = nRT/V."],
    dependencies: [],
    example: { V: 0.024, T: 300 },
    source: source("gas", 30)
  },
  {
    name: "isobaric_process",
    domain: "thermodynamics",
    group: "ideal_gas",
    description: "Calculate ideal-gas temperature at a specified constant pressure and volume.",
    keywords: ["temperature", "gas", "isobaric", "等压", "温度"],
    parameters: object({ V: positive("Volume in m^3."), P: positive("Absolute pressure in Pa."), ...gas }, [
      "V",
      "P"
    ]),
    units: { V: "m^3", P: "Pa", n: "mol", R: "J/(mol K)", result: "K" },
    assumptions: ["Ideal gas at constant pressure; T = PV/(nR)."],
    dependencies: [],
    example: { V: 0.024, P: 101325 },
    source: source("gas", 74)
  },
  {
    name: "clausius_clapeyron_temperature",
    domain: "thermodynamics",
    group: "phase_equilibrium",
    description: "Estimate saturation temperature from a reference vapor pressure and a second pressure.",
    keywords: ["vapor", "boiling", "phase", "clausius", "蒸气压", "沸点", "相平衡"],
    parameters: object(
      {
        P1: positive("Reference vapor pressure in Pa."),
        T1: positive("Reference absolute temperature in K."),
        P2: positive("Target vapor pressure in the same units as P1."),
        ...vapor
      },
      ["P1", "T1", "P2", "delta_H_vap"]
    ),
    units: { P1: "Pa", P2: "Pa", T1: "K", delta_H_vap: "J/mol", R: "J/(mol K)", result: "K" },
    assumptions: [
      "Integrated Clausius-Clapeyron approximation; constant vaporization enthalpy over the interval; ideal vapor."
    ],
    dependencies: [],
    example: { P1: 101325, T1: 373.15, P2: 50000, delta_H_vap: 40650 },
    source: source("vapor", 10)
  },
  {
    name: "clausius_clapeyron_pressure",
    domain: "thermodynamics",
    group: "phase_equilibrium",
    description: "Estimate vapor pressure at another temperature from a reference vapor pressure.",
    keywords: ["vapor", "boiling", "phase", "clausius", "蒸气压", "相平衡"],
    parameters: object(
      {
        P1: positive("Reference vapor pressure in Pa."),
        T1: positive("Reference absolute temperature in K."),
        T2: positive("Target absolute temperature in K."),
        ...vapor
      },
      ["P1", "T1", "T2", "delta_H_vap"]
    ),
    units: { P1: "Pa", T1: "K", T2: "K", delta_H_vap: "J/mol", R: "J/(mol K)", result: "Pa" },
    assumptions: [
      "Integrated Clausius-Clapeyron approximation; constant vaporization enthalpy over the interval; ideal vapor."
    ],
    dependencies: [],
    example: { P1: 101325, T1: 373.15, T2: 350, delta_H_vap: 40650 },
    source: source("vapor", 55)
  },
  {
    name: "convert_spl_to_pressure",
    domain: "acoustics",
    group: "spl_conversion",
    description: "Convert sound pressure level to RMS pressure in air.",
    keywords: ["sound", "spl", "pressure", "decibel", "声压级", "声压", "分贝"],
    parameters: object({ spl_db: db("Sound pressure level in dB re 20 microPa.") }, ["spl_db"]),
    units: { spl_db: "dB re 20 microPa", result: "Pa RMS" },
    assumptions: ["Air reference pressure is 20 microPa; unweighted SPL."],
    dependencies: [],
    example: { spl_db: 60 },
    source: source("sound", 45)
  },
  {
    name: "convert_pressure_to_spl",
    domain: "acoustics",
    group: "spl_conversion",
    description: "Convert positive RMS acoustic pressure in Pa to sound pressure level in air.",
    keywords: ["sound", "spl", "pressure", "decibel", "声压级", "声压", "分贝"],
    parameters: object({ pressure_pa: positive("Positive RMS sound pressure in Pa.") }, ["pressure_pa"]),
    units: { pressure_pa: "Pa RMS", result: "dB re 20 microPa" },
    assumptions: ["Air reference pressure is 20 microPa; unweighted SPL."],
    dependencies: [],
    example: { pressure_pa: 0.02 },
    source: source("sound", 77)
  },
  {
    name: "add_two_spl_values",
    domain: "acoustics",
    group: "combine_sound_levels",
    description: "Combine two independent sound levels using exact energy addition.",
    keywords: ["sound", "spl", "combine", "addition", "声级叠加", "分贝"],
    parameters: object(
      {
        spl1_db: db("First sound level in dB."),
        spl2_db: db("Second sound level in dB."),
        use_table: {
          type: "boolean",
          const: false,
          default: false,
          description: "Only exact energy addition is supported; must be false."
        }
      },
      ["spl1_db", "spl2_db"]
    ),
    units: { spl1_db: "dB", spl2_db: "dB", result: "dB" },
    assumptions: [
      "Uncorrelated sources with the same reference pressure; no phase interference; exact logarithmic addition."
    ],
    dependencies: [],
    example: { spl1_db: 60, spl2_db: 60 },
    source: source("sound", 159)
  },
  {
    name: "calculate_spl_at_distance",
    domain: "acoustics",
    group: "free_field_attenuation",
    description: "Estimate SPL at another distance for a point source in a free field.",
    keywords: ["sound", "distance", "attenuation", "声压", "距离", "衰减"],
    parameters: object(
      {
        source_spl: db("Known sound level in dB."),
        source_distance: positive("Reference distance in m."),
        target_distance: positive("Target distance in m."),
        environment: {
          type: "string",
          const: "free_field",
          default: "free_field",
          description: "Only free_field is supported."
        }
      },
      ["source_spl", "source_distance", "target_distance"]
    ),
    units: { source_spl: "dB", source_distance: "m", target_distance: "m", result: "dB" },
    assumptions: [
      "Point source; spherical spreading in a free field; no absorption, reflections, barriers or near-field correction."
    ],
    dependencies: [],
    example: { source_spl: 80, source_distance: 1, target_distance: 2 },
    source: source("sound", 338)
  },
  {
    name: "analyze_spectrum",
    domain: "optics",
    group: "spectrum_peaks",
    description: "Detect local peaks of a sampled spectrum using SciPy; return normalized peak information.",
    keywords: ["spectrum", "peak", "spectral", "光谱", "寻峰", "峰检测"],
    parameters: object(
      {
        wavelengths: {
          type: "array",
          items: positive("Wavelength in nm; strictly increasing."),
          minItems: 3,
          maxItems: 8192,
          description: "Strictly increasing wavelength coordinates in nm."
        },
        intensities: {
          type: "array",
          items: numeric("Nonnegative intensity.", 0),
          minItems: 3,
          maxItems: 8192,
          description:
            "Nonnegative finite intensity samples; same length as wavelengths, with a positive maximum."
        },
        prominence: { ...numeric("Peak prominence relative to the maximum intensity.", 0, 1), default: 0.1 },
        width: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 8192,
          default: null,
          description: "Minimum peak width in sample points, or null."
        },
        height: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
          default: null,
          description: "Minimum peak height relative to the maximum intensity, or null."
        }
      },
      ["wavelengths", "intensities"]
    ),
    units: {
      wavelengths: "nm",
      intensities: "arbitrary nonnegative units",
      width: "sample points",
      result: "peak coordinates in nm; widths in sample points"
    },
    assumptions: [
      "Peak detection only; no baseline subtraction, peak deconvolution or chemical identification.",
      "At most 8192 samples and 1024 detected peaks."
    ],
    dependencies: ["numpy", "scipy"],
    example: { wavelengths: [400, 410, 420, 430, 440], intensities: [0, 1, 0, 0.5, 0] },
    source: source("spectrum", 147)
  }
];

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}

export const SCIENCE_CATALOG: readonly ScienceCatalogEntry[] = freeze(entries);
const analysisCatalog: readonly ScienceCatalogEntry[] = freeze([...SCIENCE_CATALOG, ...ANALYSIS_ENTRIES]);
const astronomyCatalog: readonly ScienceCatalogEntry[] = freeze([...analysisCatalog, ...ASTRONOMY_ENTRIES]);
const chemistryCatalog: readonly ScienceCatalogEntry[] = freeze([...astronomyCatalog, ...CHEMISTRY_ENTRIES]);
const materialsCatalog: readonly ScienceCatalogEntry[] = freeze([...chemistryCatalog, ...MATERIALS_ENTRIES]);
const massSpectrometryCatalog: readonly ScienceCatalogEntry[] = freeze([
  ...materialsCatalog,
  ...MASS_SPECTROMETRY_ENTRIES
]);
const statisticsCatalog: readonly ScienceCatalogEntry[] = freeze([
  ...massSpectrometryCatalog,
  ...STATISTICS_ENTRIES
]);
const catalogs: Readonly<Record<string, readonly ScienceCatalogEntry[]>> = Object.freeze({
  [SCIENCE_PILOT_CATALOG_VERSION]: SCIENCE_CATALOG,
  [SCIENCE_ANALYSIS_CATALOG_VERSION]: analysisCatalog,
  [SCIENCE_ASTRONOMY_CATALOG_VERSION]: astronomyCatalog,
  [SCIENCE_CHEMISTRY_CATALOG_VERSION]: chemistryCatalog,
  [SCIENCE_MATERIALS_CATALOG_VERSION]: materialsCatalog,
  [SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION]: massSpectrometryCatalog,
  [SCIENCE_STATISTICS_CATALOG_VERSION]: statisticsCatalog
});

export function scienceCatalog(version: string): readonly ScienceCatalogEntry[] | undefined {
  return Object.hasOwn(catalogs, version) ? catalogs[version] : undefined;
}

export function findScienceTool(
  name: string,
  version: string = SCIENCE_CATALOG_VERSION
): ScienceCatalogEntry | undefined {
  return scienceCatalog(version)?.find((entry) => entry.name === name);
}
