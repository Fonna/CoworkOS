# SPDX-License-Identifier: MIT
"""Bounded native statistical summaries and inference; no files or network access."""

import math
import warnings
from fractions import Fraction

VERSION = "atria-statistics-v7"
TOOLS = ("summarize_numeric_data", "pearson_correlation", "welch_t_test")
MAX_SAMPLES = 8192
MAX_VALUE = 1e100


class ScienceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _vector(value, name, minimum):
    if not isinstance(value, list) or not minimum <= len(value) <= MAX_SAMPLES:
        raise ScienceError("invalid_arguments", name + " must contain " + str(minimum) + " to 8192 finite numbers")
    result = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ScienceError("invalid_arguments", name + " must contain real numbers, not booleans")
        try:
            converted = float(item)
        except (OverflowError, ValueError):
            raise ScienceError("invalid_arguments", name + " contains an out-of-range number")
        if not math.isfinite(converted) or abs(converted) > MAX_VALUE:
            raise ScienceError("invalid_arguments", name + " values must be finite with absolute value at most 1e100")
        result.append(converted)
    return result


def _float(value, label):
    """Do not silently turn a nonzero exact intermediate into zero."""
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise ScienceError("numeric_range", label + " is outside the supported floating-point range")
    if not math.isfinite(result) or (value != 0 and result == 0):
        raise ScienceError("numeric_range", label + " is outside the supported floating-point range")
    return result


def _dependencies(inference=False):
    try:
        import numpy as np
        if inference:
            from scipy import stats
            return np, stats
        return np, None
    except ImportError:
        raise ScienceError("dependency_unavailable", "The configured general Python needs NumPy and, for inference, SciPy")


def _moments(values, np):
    # Subtract an observed origin before scaling. Large common offsets never
    # enter the sum of squares, and tiny values are scaled before squaring.
    array = np.asarray(values, dtype=np.float64)
    offsets = array - array[0]
    scale = float(np.max(np.abs(offsets)))
    exact_mean = sum((Fraction.from_float(value) for value in values), Fraction()) / len(values)
    mean = _float(exact_mean, "Mean")
    if scale == 0:
        return {"mean": mean, "exact_mean": exact_mean, "scale": 0.0,
                "centered": offsets, "sum_squares": 0.0, "n": len(values)}
    normalized = offsets / scale
    normalized_mean = math.fsum(float(value) for value in normalized) / len(values)
    centered = normalized - normalized_mean
    sum_squares = math.fsum(float(value) * float(value) for value in centered)
    if not math.isfinite(sum_squares) or sum_squares <= 0:
        raise ScienceError("numeric_range", "Variation cannot be resolved in floating-point arithmetic")
    return {"mean": mean, "exact_mean": exact_mean, "scale": scale,
            "centered": centered, "sum_squares": sum_squares, "n": len(values)}


def _variance(moments):
    if moments["n"] < 2:
        return None, None
    if moments["scale"] == 0:
        return 0.0, 0.0
    normalized_variance = moments["sum_squares"] / (moments["n"] - 1)
    mantissa, exponent = math.frexp(moments["scale"])
    try:
        variance = math.ldexp(normalized_variance * mantissa * mantissa, 2 * exponent)
    except OverflowError:
        raise ScienceError("numeric_range", "Sample variance exceeds the supported floating-point range")
    std = moments["scale"] * math.sqrt(normalized_variance)
    if not math.isfinite(variance) or variance <= 0 or not math.isfinite(std) or std <= 0:
        raise ScienceError("numeric_range", "Positive sample variance or standard deviation is not representable")
    return variance, std


def _inferable(moments, np, label):
    if moments["scale"] == 0:
        raise ScienceError("invalid_arguments", label + " must have positive variation; constant samples are unsupported")
    # Use the original units for SciPy's conservative near-constant criterion,
    # rather than hiding an ill-resolved offset by scaling before this check.
    norm = moments["scale"] * math.sqrt(moments["sum_squares"])
    if norm < float(np.finfo(np.float64).eps ** 0.75) * abs(moments["mean"]):
        raise ScienceError("numeric_range", label + " is nearly constant relative to its mean; inference would lose precision")


def _quantile(ordered, numerator, denominator):
    position = Fraction((len(ordered) - 1) * numerator, denominator)
    index = position.numerator // position.denominator
    fraction = position - index
    left = Fraction.from_float(ordered[index])
    if fraction == 0:
        return left
    return left + (Fraction.from_float(ordered[index + 1]) - left) * fraction


def _exact_affine_sign(x, y):
    """Only exact relations between the supplied binary floats justify r=+/-1."""
    origin_x, origin_y = Fraction.from_float(x[0]), Fraction.from_float(y[0])
    pivot = next(index for index, value in enumerate(x) if value != x[0])
    dx = Fraction.from_float(x[pivot]) - origin_x
    dy = Fraction.from_float(y[pivot]) - origin_y
    for first, second in zip(x, y):
        if (Fraction.from_float(second) - origin_y) * dx != (Fraction.from_float(first) - origin_x) * dy:
            return None
    return 1.0 if dx * dy > 0 else -1.0


def _summary(values):
    np, _ = _dependencies()
    moments = _moments(values, np)
    variance, std = _variance(moments)
    ordered = sorted(values)
    q1 = _quantile(ordered, 1, 4)
    median = _quantile(ordered, 1, 2)
    q3 = _quantile(ordered, 3, 4)
    result = {
        "count": len(values), "min": ordered[0], "max": ordered[-1], "mean": moments["mean"],
        "median": _float(median, "Median"), "q1": _float(q1, "First quartile"),
        "q3": _float(q3, "Third quartile"),
        "range": _float(Fraction.from_float(ordered[-1]) - Fraction.from_float(ordered[0]), "Range"),
        "iqr": _float(q3 - q1, "Interquartile range"),
        "sample_variance": variance, "sample_std": std,
        "quantile_method": "linear", "ddof": 1
    }
    assumptions = [
        "Descriptive statistics only; input order is irrelevant and no missing values are removed.",
        "Quartiles use linear interpolation at (n-1)*q (Hyndman-Fan type 7); sample variance uses divisor n-1.",
        "Means and quantiles are returned as float64 and can round at a large common offset; variation is computed before restoring that offset."
    ]
    if len(values) == 1:
        assumptions.append("With one observation, sample variance and sample standard deviation are undefined and returned as null.")
    return result, {"min": "input unit", "max": "input unit", "mean": "input unit", "median": "input unit",
                    "q1": "input unit", "q3": "input unit", "range": "input unit", "iqr": "input unit",
                    "sample_variance": "input unit squared", "sample_std": "input unit", "count": "count"}, assumptions


def _pearson(x, y):
    np, stats = _dependencies(True)
    first, second = _moments(x, np), _moments(y, np)
    _inferable(first, np, "x")
    _inferable(second, np, "y")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            coefficient, probability = stats.pearsonr(first["centered"], second["centered"], alternative="two-sided")
        except Warning:
            raise ScienceError("numeric_range", "Pearson correlation raised a numerical precision warning")
    coefficient, probability = float(coefficient), float(probability)
    if not math.isfinite(coefficient) or not -1 <= coefficient <= 1 or not math.isfinite(probability) or not 0 <= probability <= 1:
        raise ScienceError("numeric_range", "Pearson correlation did not produce a finite bounded result")
    exact_endpoint = False
    if abs(coefficient) >= 1 - 1e-12:
        exact_sign = _exact_affine_sign(x, y)
        if exact_sign is None:
            raise ScienceError("numeric_range", "Pearson correlation is too close to an endpoint for a reliable tail probability; inputs are not exactly affine")
        coefficient, probability, exact_endpoint = exact_sign, 0.0, True
    elif probability == 0:
        # A library CDF/SF returning zero does not establish actual float64
        # underflow. Refuse the unresolved tail instead of inventing its cause.
        raise ScienceError("numeric_range", "Pearson tail probability cannot be reliably represented by this computation")
    assumptions = [
        "Paired observations of two variables, with independent observation pairs; no missing-value deletion or resampling.",
        "The analytic two-sided p-value tests zero population correlation under independent normally distributed variables. Small samples and outliers can make this model unsuitable.",
        "Correlation measures linear association, not causation; the p-value is not the probability that the null hypothesis is true. Constant or near-constant inputs are rejected.",
        "For abs(r) >= 1-1e-12, only an exact affine relation between the supplied binary float64 observations is accepted; other near-endpoint cases and unresolved zero tails return numeric_range."
    ]
    if exact_endpoint:
        assumptions.append("The supplied binary float64 observations are exactly affine with positive variation, so r is exactly +1 or -1 and the analytic two-sided null tail is zero; this is not numerical underflow.")
    return {"n": len(x), "r": coefficient, "p_value": probability, "alternative": "two-sided",
            "p_value_underflow": False}, {"n": "paired observation count", "r": "dimensionless", "p_value": "dimensionless"}, assumptions


def _welch(sample_a, sample_b):
    np, stats = _dependencies(True)
    first, second = _moments(sample_a, np), _moments(sample_b, np)
    _inferable(first, np, "sample_a")
    _inferable(second, np, "sample_b")
    variance_a, std_a = _variance(first)
    variance_b, std_b = _variance(second)
    difference = _float(first["exact_mean"] - second["exact_mean"], "Mean difference")
    se_a, se_b = std_a / math.sqrt(len(sample_a)), std_b / math.sqrt(len(sample_b))
    scale = max(se_a, se_b)
    first_term, second_term = (se_a / scale) ** 2, (se_b / scale) ** 2
    total = first_term + second_term
    standard_error = scale * math.sqrt(total)
    degrees = total * total / (first_term * first_term / (len(sample_a) - 1) + second_term * second_term / (len(sample_b) - 1))
    statistic = difference / standard_error
    if not math.isfinite(statistic) or (difference != 0 and statistic == 0):
        raise ScienceError("numeric_range", "Welch t statistic is outside the supported floating-point range")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            probability = float(2 * stats.t.sf(abs(statistic), degrees))
            critical = float(stats.t.ppf(0.975, degrees))
        except Warning:
            raise ScienceError("numeric_range", "Welch inference raised a numerical precision warning")
    margin = critical * standard_error
    low, high = difference - margin, difference + margin
    if (not all(math.isfinite(value) for value in (degrees, probability, margin, low, high))
            or not 0 <= probability <= 1 or degrees <= 0 or margin <= 0 or low >= high):
        raise ScienceError("numeric_range", "Welch confidence interval or probability is not representable")
    underflow = probability == 0
    assumptions = [
        "Independent groups in the same measurement unit; this is not a paired, repeated-measures or time-series test. Each group must contain at least three observations and positive resolvable sample variance.",
        "Two-sided Welch t test with unequal variances and Welch-Satterthwaite degrees of freedom; the fixed 95% confidence interval estimates mean_a minus mean_b.",
        "Approximate normality is needed for reliable small-sample inference; independence and distributional suitability cannot be established from these arrays alone. No missing-value deletion, trimming or automatic test selection.",
        "The p-value is not an effect size or the probability that the null hypothesis is true; no automatic significance decision is returned."
    ]
    if underflow:
        assumptions.append("p_value is below the representable floating-point range and is reported as 0 with p_value_underflow=true; it is not an exact zero probability.")
    return {
        "n_a": len(sample_a), "n_b": len(sample_b), "mean_a": first["mean"], "mean_b": second["mean"],
        "mean_difference": difference, "sample_variance_a": variance_a, "sample_variance_b": variance_b,
        "t_statistic": statistic, "degrees_of_freedom": degrees, "p_value": probability,
        "confidence_interval_95": {"low": low, "high": high}, "alternative": "two-sided", "method": "welch",
        "p_value_underflow": underflow
    }, {"n_a": "count", "n_b": "count", "mean_a": "input unit", "mean_b": "input unit",
        "mean_difference": "input unit", "sample_variance_a": "input unit squared", "sample_variance_b": "input unit squared",
        "t_statistic": "dimensionless", "degrees_of_freedom": "dimensionless", "p_value": "dimensionless",
        "confidence_interval_95": "input unit; interval for mean_a minus mean_b"}, assumptions


def run(request):
    if request.get("version") != VERSION:
        raise ScienceError("version_mismatch", "The requested statistical implementation is unavailable")
    name = request.get("tool")
    if name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested scientific function is not in this catalog")
    arguments = request.get("arguments")
    keys = {"summarize_numeric_data": {"values"}, "pearson_correlation": {"x", "y"},
            "welch_t_test": {"sample_a", "sample_b"}}[name]
    if not isinstance(arguments, dict) or set(arguments) != keys:
        raise ScienceError("invalid_arguments", "Expected only the required array arguments")
    if name == "summarize_numeric_data":
        result, units, assumptions = _summary(_vector(arguments["values"], "values", 1))
    elif name == "pearson_correlation":
        x, y = _vector(arguments["x"], "x", 3), _vector(arguments["y"], "y", 3)
        if len(x) != len(y):
            raise ScienceError("invalid_arguments", "x and y must have the same length")
        result, units, assumptions = _pearson(x, y)
    else:
        result, units, assumptions = _welch(_vector(arguments["sample_a"], "sample_a", 3),
                                           _vector(arguments["sample_b"], "sample_b", 3))
    return {"ok": True, "result": result, "units": units, "assumptions": assumptions}
