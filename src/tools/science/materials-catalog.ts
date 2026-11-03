import type { ScienceCatalogEntry, ScienceSchema } from "./catalog.js";

const repository = "https://github.com/CMarsRover/SciAgentGYM";
const commit = "e9dbbea4369d67694e38bf8be67bedbcaf9e9300";
const files = {
  cubic: [
    "toolkits/materials_science/x_ray_diffraction_analysis/xrd_analysis_toolkit_0003.py",
    "d4fdb46206eebf44dc4695483c3210cadf3ad8ce5f569c64f608c7d6be9dd294"
  ],
  metric: [
    "toolkits/materials_science/crystallography/crystallography_toolkit_claude_218.py",
    "77a5d330e14d5b357e22d5adf73e9082b4e624678fd0cd464071e2d150b5d69f"
  ],
  scherrer: [
    "toolkits/materials_science/x_ray_diffraction_analysis/materials_toolkit_M022_0000.py",
    "2bd2931e4abf613caaa8a0e9cd2bfa5b86752cc73f653cffe75461f1d95e7e00"
  ]
} as const;

function source(key: keyof typeof files, line: number): ScienceCatalogEntry["source"] {
  const [path, sha256] = files[key];
  return { repository, commit, path, line, sha256, url: `${repository}/blob/${commit}/${path}#L${line}` };
}

const number = (description: string, minimum: number, maximum: number): ScienceSchema => ({
  type: "number",
  description,
  minimum,
  maximum
});
const index = (): ScienceSchema => ({
  type: "integer",
  minimum: -1000,
  maximum: 1000,
  description: "Signed Miller index; the three indices must not all be zero and are not reduced."
});
const object = (properties: Record<string, ScienceSchema>, required: string[]): ScienceSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
const length = (name: string): ScienceSchema => number(`${name} in angstrom.`, 1e-6, 1e6);
const metricCondition =
  "The direct metric must be symmetric positive definite and have infinity-norm condition number at most 1e10. Degenerate, impossible and ill-conditioned cells are rejected; bounds are computational policy. Reciprocal vectors use the crystallographic convention without a 2*pi factor.";

/** Reviewed stdlib adaptations; the v1–v4 catalog objects remain unchanged. */
export const MATERIALS_ENTRIES: ScienceCatalogEntry[] = [
  {
    name: "cubic_lattice_parameter",
    domain: "materials_science",
    group: "crystal_geometry",
    description: "Calculate a cubic lattice parameter from one indexed interplanar spacing.",
    keywords: ["cubic", "lattice", "Miller", "XRD", "立方", "晶格参数", "米勒指数"],
    parameters: object(
      {
        d_spacing: length("Interplanar spacing"),
        hkl: {
          type: "array",
          items: index(),
          minItems: 3,
          maxItems: 3,
          description: "Exactly three integer Miller indices [h,k,l], not all zero."
        }
      },
      ["d_spacing", "hkl"]
    ),
    units: { d_spacing: "angstrom", hkl: "dimensionless integer indices", result: "angstrom" },
    assumptions: [
      "Cubic metric only: a=d*sqrt(h^2+k^2+l^2). The supplied indices and cubic symmetry are assumed; no automatic indexing, systematic-absence test, phase identification or refinement. Indices are not reduced: (200) and (100) describe different plane spacings."
    ],
    dependencies: [],
    example: { d_spacing: 2, hkl: [1, 1, 1] },
    source: source("cubic", 65)
  },
  {
    name: "calculate_metric_tensor",
    domain: "materials_science",
    group: "crystal_geometry",
    description: "Construct the direct crystallographic metric and cell volume from six lattice parameters.",
    keywords: ["metric tensor", "unit cell", "volume", "crystallography", "晶胞", "度规张量", "体积", "晶格"],
    parameters: object(
      {
        a: length("Cell length a"),
        b: length("Cell length b"),
        c: length("Cell length c"),
        alpha: number("Angle between b and c in degrees.", 0.001, 179.999),
        beta: number("Angle between a and c in degrees.", 0.001, 179.999),
        gamma: number("Angle between a and b in degrees.", 0.001, 179.999)
      },
      ["a", "b", "c", "alpha", "beta", "gamma"]
    ),
    units: {
      a: "angstrom",
      b: "angstrom",
      c: "angstrom",
      alpha: "degree",
      beta: "degree",
      gamma: "degree",
      metric_tensor: "angstrom^2",
      volume_angstrom3: "angstrom^3"
    },
    assumptions: [
      "G_ij is the dot product of the direct lattice basis vectors. alpha=(b,c), beta=(a,c), gamma=(a,b); V=sqrt(det G). A valid metric does not determine the atomic basis, crystal system or space group.",
      metricCondition
    ],
    dependencies: [],
    example: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 },
    source: source("metric", 38)
  },
  {
    name: "calculate_interplanar_spacing_general",
    domain: "materials_science",
    group: "crystal_geometry",
    description: "Calculate indexed interplanar spacing from a direct metric for any valid crystal cell.",
    keywords: ["interplanar", "d spacing", "reciprocal", "Miller", "晶面间距", "倒易", "米勒指数", "晶体"],
    parameters: object(
      {
        h: index(),
        k: index(),
        l: index(),
        metric_tensor: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: number("Direct metric entry in square angstrom.", -1e12, 1e12)
          },
          description:
            "Exactly 3x3 symmetric positive-definite direct metric in angstrom^2; diagonal entries at least 1e-12. May use calculate_metric_tensor's result.metric_tensor."
        }
      },
      ["h", "k", "l", "metric_tensor"]
    ),
    units: {
      h: "dimensionless integer index",
      k: "dimensionless integer index",
      l: "dimensionless integer index",
      metric_tensor: "angstrom^2",
      result: "angstrom"
    },
    assumptions: [
      "d=1/sqrt(h^T G^-1 h) for integer h=(h,k,l), not all zero. Indices are not reduced. This computes geometry only and does not establish whether a reflection is allowed or present.",
      metricCondition
    ],
    dependencies: [],
    example: {
      h: 1,
      k: 1,
      l: 0,
      metric_tensor: [
        [16, 0, 0],
        [0, 16, 0],
        [0, 0, 16]
      ]
    },
    source: source("metric", 146)
  },
  {
    name: "calculate_scherrer_grain_size",
    domain: "materials_science",
    group: "xrd_line_broadening",
    description:
      "Estimate a coherent diffraction-domain size using Scherrer broadening with an explicit Gaussian instrumental correction.",
    keywords: ["Scherrer", "XRD", "FWHM", "crystallite", "broadening", "谢乐", "衍射畴", "晶粒尺寸", "展宽"],
    parameters: object(
      {
        peak_2theta_deg: number("Peak position 2theta in degrees.", 0.001, 179.999),
        fwhm_deg: number("Measured peak FWHM on the 2theta axis in degrees.", 1e-6, 10),
        wavelength_nm: { ...number("X-ray wavelength in nm (not angstrom).", 1e-6, 100), default: 0.15406 },
        shape_factor: {
          ...number("Assumed Scherrer shape factor K; not inferred from data.", 0.1, 2),
          default: 0.9
        },
        instrument_fwhm_deg: {
          ...number(
            "Gaussian instrumental FWHM at this peak in 2theta degrees; must be less than fwhm_deg.",
            0,
            10
          ),
          default: 0
        }
      },
      ["peak_2theta_deg", "fwhm_deg"]
    ),
    units: {
      peak_2theta_deg: "degree (2theta)",
      fwhm_deg: "degree (2theta)",
      wavelength_nm: "nm",
      shape_factor: "dimensionless",
      instrument_fwhm_deg: "degree (2theta)",
      D_nm: "nm",
      theta_deg: "degree (theta)",
      beta_rad: "radian (2theta FWHM)",
      corrected_fwhm_deg: "degree (2theta)",
      instrument_model: "model name"
    },
    assumptions: [
      "D=K*lambda/(beta*cos(theta)), theta=peak_2theta_deg/2. beta is the specimen FWHM on the 2theta axis converted to radians, not a half-width or integral breadth.",
      "Assumes Gaussian measured and instrumental profiles: specimen FWHM=sqrt(observed^2-instrument^2), replacing upstream's direct subtraction. No Lorentzian, Voigt or pseudo-Voigt deconvolution. The corrected variance must exceed 1e-12 of the observed variance; near-resolution-limited peaks are rejected.",
      "Returns an apparent coherent diffraction-domain size, not measured particle size or a general grain size. Assumes size broadening dominates; no strain separation, K-alpha doublet removal, background/peak fitting, shape-factor inference, uncertainty propagation or reliability claim from one peak."
    ],
    dependencies: [],
    example: { peak_2theta_deg: 60, fwhm_deg: 0.2, instrument_fwhm_deg: 0.1 },
    source: source("scherrer", 50)
  }
];
