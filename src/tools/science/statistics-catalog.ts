import type { ScienceCatalogEntry, ScienceSchema } from "./catalog.js";

const version = "atria-statistics-v7";
const vector = (description: string, minItems: number): ScienceSchema => ({
  type: "array",
  description,
  minItems,
  maxItems: 8192,
  items: { type: "number", minimum: -1e100, maximum: 1e100 }
});
const object = (properties: Record<string, ScienceSchema>): ScienceSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false
});
const source = (documentation: string): ScienceCatalogEntry["source"] => ({
  kind: "atria-native",
  path: "src/tools/science/statistics.py",
  documentation,
  implementationVersion: version
});

export const STATISTICS_ENTRIES: ScienceCatalogEntry[] = [
  {
    name: "summarize_numeric_data",
    domain: "statistics",
    group: "descriptive_statistics",
    description:
      "Summarize finite numeric data with mean, type-7 quartiles and sample variance; no inferential test.",
    keywords: [
      "summary",
      "descriptive statistics",
      "mean",
      "median",
      "quartile",
      "variance",
      "描述统计",
      "数据摘要",
      "均值",
      "中位数",
      "四分位",
      "标准差"
    ],
    parameters: object({
      values: vector("Finite observations in one common unit; no missing values or booleans.", 1)
    }),
    units: {
      min: "input unit",
      max: "input unit",
      mean: "input unit",
      median: "input unit",
      q1: "input unit",
      q3: "input unit",
      range: "input unit",
      iqr: "input unit",
      sample_variance: "input unit squared",
      sample_std: "input unit",
      count: "count"
    },
    assumptions: [
      "Descriptive statistics only. All observations must be finite numbers with absolute value at most 1e100; 1 to 8192 values, without missing-value removal.",
      "Quantiles use linear interpolation at (n-1)*q (Hyndman-Fan type 7). Sample variance and standard deviation use ddof=1 and are null, with an explanation, for a single observation; constant samples of size at least two return zero variance.",
      "Stable offset/scale arithmetic computes variation before restoring a common offset; returned float64 means and quartiles can still round. Nonzero unrepresentable results fail with numeric_range."
    ],
    dependencies: ["numpy"],
    example: { values: [1, 2, 3, 4] },
    source: source("https://numpy.org/doc/2.2/reference/generated/numpy.quantile.html")
  },
  {
    name: "pearson_correlation",
    domain: "statistics",
    group: "linear_association",
    description:
      "Calculate Pearson linear correlation and its analytic two-sided p-value for paired finite numeric observations.",
    keywords: ["pearson", "correlation", "linear association", "皮尔逊", "相关系数", "线性相关"],
    parameters: object({
      x: vector("First variable, 3 to 8192 paired observations.", 3),
      y: vector("Second variable; same length as x, in its own consistent unit.", 3)
    }),
    units: { n: "paired observation count", r: "dimensionless", p_value: "dimensionless" },
    assumptions: [
      "Observation pairs must be independent. The analytic two-sided p-value for zero population correlation assumes independent normally distributed variables under the null; arrays do not establish those assumptions.",
      "Both variables must have positive resolvable variation; constant or near-constant inputs are rejected. No missing-value deletion, resampling, confidence interval or automatic significance decision.",
      "Correlation describes linear association, not causation; p-value is not the probability that the null is true. At abs(r) >= 1-1e-12, only an exact affine relation between the supplied binary float64 observations is accepted and returns r=+1 or -1 with p_value=0 and p_value_underflow=false. Other near-endpoint cases and unresolved zero tails return numeric_range rather than claiming underflow."
    ],
    dependencies: ["numpy", "scipy"],
    example: { x: [1, 2, 3, 4, 5, 6, 7], y: [10, 9, 2.5, 6, 4, 3, 2] },
    source: source("https://docs.scipy.org/doc/scipy-1.15.3/reference/generated/scipy.stats.pearsonr.html")
  },
  {
    name: "welch_t_test",
    domain: "statistics",
    group: "independent_group_comparison",
    description:
      "Compare two independent group means using a two-sided Welch t test and a fixed 95% confidence interval for mean_a minus mean_b.",
    keywords: [
      "welch",
      "t test",
      "unequal variance",
      "independent samples",
      "group means",
      "独立样本",
      "两组均值",
      "不等方差",
      "t检验"
    ],
    parameters: object({
      sample_a: vector(
        "First independent group in the same measurement unit as sample_b; at least three observations.",
        3
      ),
      sample_b: vector(
        "Second independent group; positive resolvable sample variance is required in each group.",
        3
      )
    }),
    units: {
      n_a: "count",
      n_b: "count",
      mean_a: "input unit",
      mean_b: "input unit",
      mean_difference: "input unit",
      sample_variance_a: "input unit squared",
      sample_variance_b: "input unit squared",
      t_statistic: "dimensionless",
      degrees_of_freedom: "dimensionless",
      p_value: "dimensionless",
      confidence_interval_95: "input unit; interval for mean_a minus mean_b"
    },
    assumptions: [
      "Independent groups in the same unit, not paired observations, repeated measures or time series. Each group has 3 to 8192 finite observations and positive resolvable sample variance; constant and near-constant groups are rejected.",
      "Two-sided unequal-variance Welch test with Welch-Satterthwaite degrees of freedom and a fixed 95% confidence interval for mean_a minus mean_b. Approximately normal populations are needed for reliable small-sample inference; independence and model suitability cannot be verified from arrays alone.",
      "No missing-value deletion, equal-variance assumption, trimming, resampling, test selection or automatic significance decision. A p-value is not an effect size or the probability that the null is true.",
      "Nonfinite or unrepresentable variance, statistic or interval returns numeric_range. Extreme tails below float64 range return p_value=0 with p_value_underflow=true and an explanation."
    ],
    dependencies: ["numpy", "scipy"],
    example: { sample_a: [1, 2, 3], sample_b: [2, 4, 6] },
    source: source("https://docs.scipy.org/doc/scipy-1.15.3/reference/generated/scipy.stats.ttest_ind.html")
  }
];
