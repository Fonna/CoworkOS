import type { ScienceCatalogEntry, ScienceSchema } from "./catalog.js";

const repository = "https://github.com/CMarsRover/SciAgentGYM";
const commit = "e9dbbea4369d67694e38bf8be67bedbcaf9e9300";
const analyticalPath = "toolkits/chemistry/analytical_chemistry/analytical_chemistry_tools_15080.py";
const analyticalHash = "754ad77282a8f1028faf703ff59f36d6d72bf3d44774ccc4090e7a8a0c53d624";

function source(path: string, line: number, sha256: string): ScienceCatalogEntry["source"] {
  return { repository, commit, path, line, sha256, url: `${repository}/blob/${commit}/${path}#L${line}` };
}

function number(
  description: string,
  minimum = -1e100,
  maximum = 1e100,
  defaultValue?: number
): ScienceSchema {
  return {
    type: "number",
    description,
    minimum,
    maximum,
    ...(defaultValue === undefined ? {} : { default: defaultValue })
  };
}

function integer(
  description: string,
  minimum: number,
  maximum: number,
  defaultValue?: number
): ScienceSchema {
  return {
    type: "integer",
    description,
    minimum,
    maximum,
    ...(defaultValue === undefined ? {} : { default: defaultValue })
  };
}

function samples(description: string, minimum = 3, maximum = 8192, nullable = false): ScienceSchema {
  return {
    type: nullable ? ["array", "null"] : "array",
    description,
    items: number("Finite sample value."),
    minItems: minimum,
    maxItems: maximum,
    ...(nullable ? { default: null } : {})
  };
}

function parameters(properties: Record<string, ScienceSchema>, required: string[]): ScienceSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Six reviewed additions; the v1 catalog remains unchanged for already pinned Runs. */
export const ANALYSIS_ENTRIES: ScienceCatalogEntry[] = [
  {
    name: "baseline_correction",
    domain: "chemistry",
    group: "experimental_data_analysis",
    description:
      "Remove a fitted low-degree polynomial trend from one-dimensional experimental samples; return the trend and corrected samples.",
    keywords: ["baseline", "polynomial", "detrend", "spectrum", "基线校正", "基线", "去趋势", "光谱"],
    parameters: parameters(
      {
        spectrum: samples("Finite signal samples; at least 3 samples and more samples than degree."),
        method: {
          type: "string",
          const: "polynomial",
          default: "polynomial",
          description: "Only polynomial detrending is enabled; ALS and rubberband are unavailable."
        },
        degree: integer("Polynomial degree, strictly less than the number of samples.", 0, 5, 3)
      },
      ["spectrum"]
    ),
    units: {
      spectrum: "user-supplied signal units",
      baseline: "same as input signal",
      corrected: "same as input signal",
      independent_axis: "sample index"
    },
    assumptions: [
      "Fits the entire signal against equally spaced sample indices; a physical coordinate axis is not accepted.",
      "Polynomial detrending can remove broad signal features. It is not peak separation or a scientifically identified background.",
      "Degree 0 to 5; 3 to 8192 samples; sample count must exceed degree."
    ],
    dependencies: ["numpy"],
    example: { spectrum: [1, 3, 3, 4, 5], degree: 1 },
    source: source(analyticalPath, 90, analyticalHash)
  },
  {
    name: "peak_detection",
    domain: "chemistry",
    group: "experimental_data_analysis",
    description:
      "Find local peaks using absolute signal thresholds; return original heights, coordinates and half-prominence widths.",
    keywords: ["peak", "signal", "prominence", "spectrum", "寻峰", "峰检测", "峰位", "光谱", "信号"],
    parameters: parameters(
      {
        spectrum: samples("Finite raw signal samples; values are not normalized and may be negative."),
        x_values: samples(
          "Optional strictly increasing coordinates of the same length; null uses sample indices.",
          3,
          8192,
          true
        ),
        threshold: number(
          "Minimum peak height in original signal units, not a relative fraction.",
          -1e100,
          1e100,
          0.1
        ),
        min_distance: integer(
          "Minimum spacing between detected peaks, measured in sample points.",
          1,
          8192,
          5
        ),
        prominence: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1e100,
          default: null,
          description: "Minimum prominence in original signal units; null applies no prominence threshold."
        }
      },
      ["spectrum"]
    ),
    units: {
      spectrum: "user-supplied signal units",
      x_values: "user-supplied coordinate units",
      heights: "same as input signal",
      positions: "input coordinate units, or sample indices",
      widths: "sample points at half prominence",
      left_ips: "fractional sample index",
      right_ips: "fractional sample index"
    },
    assumptions: [
      "Local peak detection on raw values; unlike analyze_spectrum, thresholds and returned heights are not normalized.",
      "Widths are measured at half prominence, not generally at half the absolute peak maximum; widths and distance stay in sample points for a nonuniform coordinate axis.",
      "No baseline subtraction, smoothing or chemical identification; 3 to 8192 samples and at most 1024 peaks."
    ],
    dependencies: ["numpy", "scipy"],
    example: {
      spectrum: [0, 5, 0, 3, 0],
      x_values: [400, 410, 420, 430, 440],
      threshold: 1,
      min_distance: 1
    },
    source: source(analyticalPath, 154, analyticalHash)
  },
  {
    name: "fit_calibration_curve",
    domain: "chemistry",
    group: "experimental_data_analysis",
    description:
      "Fit an ordinary least-squares line to paired concentration and response samples; optionally predict responses at specified concentrations.",
    keywords: [
      "calibration",
      "linear",
      "regression",
      "least squares",
      "标定",
      "校准",
      "标准曲线",
      "线性回归",
      "最小二乘"
    ],
    parameters: parameters(
      {
        concentrations: samples(
          "Concentration or independent-variable samples in consistent units; must not be constant."
        ),
        responses: samples("Response samples, same length as concentrations, in consistent units."),
        model: {
          type: "string",
          const: "linear",
          default: "linear",
          description:
            "Only an intercept-plus-slope linear model is enabled; no quadratic or custom callable."
        },
        predict_at: samples(
          "Optional independent-variable values at which to predict responses; null omits prediction.",
          1,
          8192,
          true
        )
      },
      ["concentrations", "responses"]
    ),
    units: {
      concentrations: "user-supplied concentration or independent-variable units",
      responses: "user-supplied response units",
      slope: "response units / independent-variable units",
      intercept: "response units",
      residuals: "response units",
      fitted_values: "response units",
      predictions: "response units",
      r_squared: "dimensionless"
    },
    assumptions: [
      "Unweighted ordinary least squares with an intercept; independent variable treated as known without measurement error.",
      "3 to 8192 paired samples with nonconstant independent variable; R-squared is null when responses are constant.",
      "Parameter uncertainty assumes the linear model and residual error assumptions. Extrapolated predictions have no experimental validity guarantee.",
      "No Python callable or detection limit is returned; assay detection limits require separate blank/noise validation."
    ],
    dependencies: ["numpy"],
    example: { concentrations: [0, 1, 2, 3], responses: [1, 3, 5, 7], predict_at: [1.5] },
    source: source(analyticalPath, 258, analyticalHash)
  },
  {
    name: "multivariate_analysis",
    domain: "chemistry",
    group: "experimental_data_analysis",
    description:
      "Perform PCA of a finite samples-by-features matrix after centering and population-standard-deviation scaling; return numerical scores and loadings.",
    keywords: [
      "pca",
      "principal component",
      "multivariate",
      "dimensionality",
      "主成分",
      "降维",
      "多变量",
      "实验数据"
    ],
    parameters: parameters(
      {
        data: {
          type: "array",
          minItems: 2,
          maxItems: 512,
          items: { type: "array", minItems: 1, maxItems: 64, items: number("Finite feature value.") },
          description:
            "Rectangular rows=samples, columns=features; 2 to 512 rows, 1 to 64 columns, at most 8192 total cells; not all columns may be constant."
        },
        method: {
          type: "string",
          const: "pca",
          default: "pca",
          description: "Only standardized PCA is enabled."
        },
        n_components: integer(
          "Component count, no greater than min(number of samples - 1, number of features).",
          1,
          64,
          2
        )
      },
      ["data"]
    ),
    units: {
      data: "consistent units within each input feature",
      scores: "dimensionless standardized coordinates",
      loadings: "dimensionless",
      explained_variance: "variance of standardized coordinates, sample denominator n-1",
      explained_variance_ratio: "dimensionless fraction",
      means: "original units per feature",
      scales: "original units per feature",
      centering_origin: "original units per feature",
      centering_offset: "original units per feature"
    },
    assumptions: [
      "Each feature is centered and scaled by its population standard deviation (ddof=0); constant features use scale 1.",
      "For stable reuse, center each feature as (x - centering_origin) - centering_offset, then divide by scales and multiply by the transpose of loadings. means is a rounded summary and can lose small variations at large offsets.",
      "Explained variance uses the sample denominator n-1 after standardization. Signs are fixed by the largest absolute loading being positive; tied eigenspaces have no unique basis.",
      "Rectangular input only, at most 8192 cells; no missing-value imputation, weighting or returned estimator objects.",
      "Component count is at most min(samples-1, features); the default 2 therefore requires at least 3 samples and 2 features."
    ],
    dependencies: ["numpy"],
    example: {
      data: [
        [1, 2],
        [2, 3],
        [3, 5],
        [4, 7]
      ],
      n_components: 2
    },
    source: source(analyticalPath, 208, analyticalHash)
  },
  {
    name: "nernst_potential",
    domain: "chemistry",
    group: "electrochemistry",
    description:
      "Calculate the equilibrium reduction potential for Ox + n e- -> Red using dimensionless activities and an explicitly stated electrode reference.",
    keywords: [
      "nernst",
      "electrochemistry",
      "potential",
      "reduction",
      "能斯特",
      "电化学",
      "电极电位",
      "还原电位"
    ],
    parameters: parameters(
      {
        E0: number(
          "Standard reduction potential in V; use the same reference electrode for E0 and the result (SHE by convention).",
          -1e6,
          1e6
        ),
        n: integer(
          "Positive integer number of transferred electrons for the stated reduction half-reaction.",
          1,
          1000
        ),
        a_oxidized: number("Positive dimensionless activity of the oxidized species.", 1e-100, 1e100),
        a_reduced: number(
          "Positive dimensionless activity of the reduced species; 1 for a pure solid in its standard state.",
          1e-100,
          1e100,
          1
        ),
        T: number("Absolute temperature in K.", 1e-100, 1e6, 298.15)
      },
      ["E0", "n", "a_oxidized"]
    ),
    units: {
      E0: "V relative to the specified reference electrode",
      n: "electron count",
      a_oxidized: "dimensionless activity",
      a_reduced: "dimensionless activity",
      T: "K",
      result: "V relative to the same reference electrode as E0"
    },
    assumptions: [
      "Reduction convention: Ox + n e- -> Red; E = E0 + (R T / n F) ln(a_oxidized / a_reduced). This corrects the sign in the selected upstream implementation.",
      "Activities are dimensionless; substituting concentration requires a justified standard-state/ideal-solution approximation.",
      "Equilibrium reduction potential only; no kinetic overpotential, reference-electrode conversion or general reaction stoichiometry solver."
    ],
    dependencies: [],
    example: { E0: 0.34, n: 2, a_oxidized: 0.01, a_reduced: 1, T: 298.15 },
    source: source(
      "toolkits/chemistry/physical_chemistry/nernst_potential.py",
      87,
      "06e2fe1c8a63c035916cf7b81aa5480c05981d95938f22d89fc50f3a6e28fd0c"
    )
  },
  {
    name: "bragg_law_d_spacing",
    domain: "materials_science",
    group: "bragg_diffraction",
    description:
      "Calculate lattice-plane spacing from a diffraction angle 2-theta and an X-ray wavelength using first-order Bragg diffraction.",
    keywords: ["bragg", "xrd", "diffraction", "d spacing", "布拉格", "晶面间距", "衍射", "X射线"],
    parameters: parameters(
      {
        two_theta: number(
          "Diffraction angle 2-theta in degrees, strictly between 0 and 180.",
          1e-9,
          179.999999999
        ),
        wavelength: number(
          "X-ray wavelength in angstrom; default Cu K-alpha = 1.5406 angstrom.",
          1e-100,
          1e100,
          1.5406
        )
      },
      ["two_theta"]
    ),
    units: { two_theta: "degrees (2 theta)", wavelength: "angstrom", result: "angstrom" },
    assumptions: [
      "First diffraction order n=1; d = wavelength / (2 sin(two_theta/2)).",
      "Input is 2-theta in degrees, not theta or radians; wavelength and result use angstrom.",
      "Plane spacing only; no phase identification, Miller-index assignment, database lookup or instrumental correction."
    ],
    dependencies: [],
    example: { two_theta: 60, wavelength: 1.5406 },
    source: source(
      "toolkits/materials_science/x_ray_diffraction_analysis/xrd_analysis_toolkit_0003.py",
      33,
      "d4fdb46206eebf44dc4695483c3210cadf3ad8ce5f569c64f608c7d6be9dd294"
    )
  }
];
