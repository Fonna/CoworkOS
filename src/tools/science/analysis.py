# SPDX-License-Identifier: Apache-2.0
# Adapted from CMarsRover/SciAgentGYM e9dbbea4369d67694e38bf8be67bedbcaf9e9300.
# CoworkOS modifications: closed schemas, bounded pure calculations, NumPy-only OLS/PCA,
# no plotting/files/network/callables; corrected Nernst reduction-potential sign.
# Exact upstream files and changes are recorded in vendor/sciagentgym/NOTICE.
"""Six optional analysis functions; importing this module needs only the stdlib."""

import inspect
import math

VERSION = "sciagentgym-e9dbbea-analysis-v2"
MAX_POINTS = 8192
MAX_PEAKS = 1024


class ScienceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _number(value, name, minimum=-1e100, maximum=1e100):
    if type(value) not in (int, float):
        raise ScienceError("invalid_arguments", name + " must be a finite number")
    try:
        valid = math.isfinite(value) and minimum <= value <= maximum
    except OverflowError:
        valid = False
    if not valid:
        raise ScienceError("invalid_arguments", name + " is outside the supported numeric range")
    return float(value)


def _integer(value, name, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ScienceError("invalid_arguments", name + " must be an integer within the documented range")
    return value


def _array(values, name, minimum_length=3):
    if not isinstance(values, list) or not minimum_length <= len(values) <= MAX_POINTS:
        raise ScienceError("invalid_arguments", name + " has an unsupported number of samples")
    return [_number(value, name) for value in values]


def _np():
    try:
        import numpy as np
        return np
    except ImportError:
        raise ScienceError("dependency_unavailable", "This analysis requires NumPy in the configured scientific Python environment") from None


def _finite_tree(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ScienceError("numeric_range", "The calculation produced an unrepresentable result")
    if isinstance(value, dict):
        for member in value.values():
            _finite_tree(member)
    if isinstance(value, list):
        for member in value:
            _finite_tree(member)


def _result(value, units, *assumptions):
    _finite_tree(value)
    return {"ok": True, "result": value, "units": units, "assumptions": list(assumptions)}


def baseline_correction(spectrum, method="polynomial", degree=3):
    values = _array(spectrum, "spectrum")
    if method != "polynomial":
        raise ScienceError("invalid_arguments", "Only polynomial baseline correction is enabled")
    degree = _integer(degree, "degree", 0, 5)
    if degree >= len(values):
        raise ScienceError("invalid_arguments", "degree must be smaller than the number of samples")
    np = _np()
    # Fit the same sample-index polynomial in a scaled basis for numerical stability.
    y = np.asarray(values, dtype=float)
    amplitude = float(np.max(np.abs(y)))
    if amplitude == 0:
        baseline = np.zeros_like(y)
    else:
        design = np.polynomial.polynomial.polyvander(np.linspace(-1, 1, len(y)), degree)
        coefficients, _, rank, _ = np.linalg.lstsq(design, y / amplitude, rcond=None)
        if rank != degree + 1:
            raise ScienceError("numeric_range", "The polynomial fit is rank deficient")
        baseline = (design @ coefficients) * amplitude
    return _result({"baseline": baseline.tolist(), "corrected": (y - baseline).tolist(), "degree": degree},
                   {"baseline": "input intensity units", "corrected": "input intensity units"},
                   "A global polynomial is fitted to all sample indices, with uniform sample spacing assumed; real broad peaks can be removed. This does not infer the physical background or preserve peaks automatically.")


def peak_detection(spectrum, x_values=None, threshold=0.1, min_distance=5, prominence=None):
    values = _array(spectrum, "spectrum")
    axis = _array(x_values, "x_values") if x_values is not None else list(range(len(values)))
    if len(axis) != len(values) or any(a >= b for a, b in zip(axis, axis[1:])):
        raise ScienceError("invalid_arguments", "x_values must be equally long and strictly increasing")
    threshold = _number(threshold, "threshold")
    min_distance = _integer(min_distance, "min_distance", 1, MAX_POINTS)
    if prominence is not None:
        prominence = _number(prominence, "prominence", 0)
    np = _np()
    try:
        from scipy.signal import find_peaks, peak_widths
    except ImportError:
        raise ScienceError("dependency_unavailable", "Peak detection requires SciPy in the configured scientific Python environment") from None
    signal = np.asarray(values, dtype=float)
    peaks, _ = find_peaks(signal, height=threshold, distance=min_distance, prominence=prominence)
    if len(peaks) > MAX_PEAKS:
        raise ScienceError("too_many_peaks", "More than 1024 peaks; increase threshold/prominence or narrow the signal")
    widths, _, left, right = peak_widths(signal, peaks, rel_height=0.5)
    return _result({"peak_indices": peaks.tolist(), "heights": signal[peaks].tolist(),
                    "positions": [axis[int(index)] for index in peaks], "widths": widths.tolist(),
                    "left_ips": left.tolist(), "right_ips": right.tolist()},
                   {"heights": "input intensity units", "positions": "x_values units or sample index", "widths": "samples", "left_ips": "fractional sample index", "right_ips": "fractional sample index"},
                   "threshold is an absolute minimum peak height, not a normalized threshold; prominence has input intensity units. Widths are measured at half the peak prominence in sample indices; these are not general FWHM values. Endpoints are not peaks.")


def fit_calibration_curve(concentrations, responses, model="linear", predict_at=None):
    x_values, y_values = _array(concentrations, "concentrations"), _array(responses, "responses")
    if model != "linear":
        raise ScienceError("invalid_arguments", "Only linear calibration is enabled")
    if len(x_values) != len(y_values):
        raise ScienceError("invalid_arguments", "concentrations and responses must have equal lengths")
    if max(x_values) == min(x_values):
        raise ScienceError("invalid_arguments", "Calibration concentrations must not all be identical")
    prediction_values = _array(predict_at, "predict_at", 1) if predict_at is not None else None
    np = _np()
    x, y = np.asarray(x_values, dtype=float), np.asarray(y_values, dtype=float)
    x_offsets, y_offsets = x - x[0], y - y[0]
    x_offset_mean, y_offset_mean = float(np.mean(x_offsets)), float(np.mean(y_offsets))
    x_mean, y_mean = float(x[0]) + x_offset_mean, float(y[0]) + y_offset_mean
    centered_x = x_offsets - x_offset_mean
    centered_y = y_offsets - y_offset_mean
    x_scale = float(np.max(np.abs(centered_x)))
    normalized_x = centered_x / x_scale
    normalized_ss = float(np.dot(normalized_x, normalized_x))
    slope_scaled = float(np.dot(normalized_x, centered_y) / normalized_ss)
    slope = slope_scaled / x_scale
    intercept = y_mean - slope * x_mean
    fitted_offsets = y_offset_mean + slope_scaled * normalized_x
    fitted = float(y[0]) + fitted_offsets
    residuals = y_offsets - fitted_offsets
    ss_res = float(np.dot(residuals, residuals))
    ss_tot = float(np.dot(centered_y, centered_y))
    residual_variance = ss_res / (len(x) - 2)
    ss_x = normalized_ss * x_scale * x_scale
    slope_variance = residual_variance / ss_x
    intercept_variance = residual_variance / len(x) + x_mean * x_mean * slope_variance
    covariance = [[slope_variance, -x_mean * slope_variance], [-x_mean * slope_variance, intercept_variance]]
    predictions = None if prediction_values is None else [y_mean + slope * ((value - float(x[0])) - x_offset_mean) for value in prediction_values]
    return _result({"model": "linear", "parameters": [slope, intercept],
                    "parameter_errors": [math.sqrt(slope_variance), math.sqrt(intercept_variance)],
                    "covariance": covariance, "r_squared": None if max(y_values) == min(y_values) else 1 - ss_res / ss_tot,
                    "residuals": residuals.tolist(), "fitted_values": fitted.tolist(), "predictions": predictions},
                   {"parameters": "[response/concentration, response]", "residuals": "response units", "fitted_values": "response units", "predictions": "response units", "r_squared": "dimensionless"},
                   "Unweighted ordinary least squares with a fitted intercept. Residual noise variance is SSE/(n-2); parameter standard errors assume independent equal-variance errors. R-squared is null for constant responses. No detection limit is inferred without validated blank/noise data; extrapolation is not experimentally validated.")


def multivariate_analysis(data, method="pca", n_components=2):
    if method != "pca":
        raise ScienceError("invalid_arguments", "Only PCA is enabled")
    n_components = _integer(n_components, "n_components", 1, 64)
    if not isinstance(data, list) or not 2 <= len(data) <= 512:
        raise ScienceError("invalid_arguments", "data must contain 2 to 512 sample rows")
    if not isinstance(data[0], list) or not 1 <= len(data[0]) <= 64:
        raise ScienceError("invalid_arguments", "data must have 1 to 64 features")
    features = len(data[0])
    if len(data) * features > MAX_POINTS:
        raise ScienceError("invalid_arguments", "PCA data exceeds the 8192-cell limit")
    if any(not isinstance(row, list) or len(row) != features for row in data):
        raise ScienceError("invalid_arguments", "PCA data must be a rectangular matrix")
    values = [[_number(value, "data") for value in row] for row in data]
    if n_components > min(len(data) - 1, features):
        raise ScienceError("invalid_arguments", "n_components must not exceed min(samples-1, features)")
    np = _np()
    matrix = np.asarray(values, dtype=float)
    origins = matrix[0].copy()
    offsets = matrix - origins
    offset_means = np.mean(offsets, axis=0)
    constant = np.ptp(offsets, axis=0) == 0
    offset_means[constant] = 0
    centered = offsets - offset_means
    means = origins + offset_means
    scales = np.sqrt(np.mean(centered * centered, axis=0))
    scales[constant] = 1
    if np.all(constant):
        raise ScienceError("invalid_arguments", "PCA needs at least one nonconstant feature")
    standardized = centered / scales
    u, singular_values, loadings = np.linalg.svd(standardized, full_matrices=False)
    variances = singular_values * singular_values / (len(data) - 1)
    total_variance = float(np.sum(variances))
    components = loadings[:n_components].copy()
    scores = u[:, :n_components] * singular_values[:n_components]
    # A component's sign is arbitrary; use its first largest absolute loading as positive.
    for index in range(n_components):
        pivot = int(np.argmax(np.abs(components[index])))
        if components[index, pivot] < 0:
            components[index] *= -1
            scores[:, index] *= -1
    return _result({"scores": scores.tolist(), "loadings": components.tolist(),
                    "explained_variance": variances[:n_components].tolist(),
                    "explained_variance_ratio": (variances[:n_components] / total_variance).tolist(),
                    "n_components": n_components, "means": means.tolist(), "scales": scales.tolist(),
                    "centering_origin": origins.tolist(), "centering_offset": offset_means.tolist()},
                   {"scores": "standardized feature coordinates", "loadings": "dimensionless", "explained_variance": "standardized feature variance", "explained_variance_ratio": "dimensionless", "means": "original feature units", "scales": "original feature units", "centering_origin": "original feature units", "centering_offset": "original feature units"},
                   "Rows are samples; columns are features. Features are centered and scaled using population standard deviation (ddof=0); constant features use scale=1. For stable reuse, center as (value - centering_origin) - centering_offset, then divide by scales; means is rounded in original feature units. Explained variance uses n-1. Component signs follow the largest absolute loading; tied eigenspaces have no unique basis. PCA does not establish causal or chemical interpretation.")


def nernst_potential(E0, n, a_oxidized, a_reduced=1, T=298.15):
    standard = _number(E0, "E0", -1e6, 1e6)
    electrons = _integer(n, "n", 1, 1000)
    oxidized = _number(a_oxidized, "a_oxidized", 1e-100)
    reduced = _number(a_reduced, "a_reduced", 1e-100)
    temperature = _number(T, "T", 1e-100, 1e6)
    potential = standard + 8.31446261815324 * temperature / (electrons * 96485.33212) * (math.log(oxidized) - math.log(reduced))
    return _result(potential, "V", "Reduction Ox + n e- -> Red, unit stoichiometry; E = E0 + (RT/nF)*ln(a_oxidized/a_reduced). Activities are positive dimensionless thermodynamic activities, not automatically concentrations. Result uses the same reference as E0 (SHE if E0 is given versus SHE). The upstream sign was corrected to this reduction convention.")


def bragg_law_d_spacing(two_theta, wavelength=1.5406):
    angle = _number(two_theta, "two_theta", 1e-9, 179.999999999)
    wavelength = _number(wavelength, "wavelength", 1e-100)
    spacing = wavelength / (2 * math.sin(math.radians(angle / 2)))
    return _result(spacing, "angstrom", "First-order Bragg diffraction, n=1; two_theta is the measured 2theta angle in degrees; wavelength and resulting d-spacing are in angstrom. No phase identification or structure refinement is performed.")


TOOLS = {function.__name__: function for function in (baseline_correction, peak_detection, fit_calibration_curve, multivariate_analysis, nernst_potential, bragg_law_d_spacing)}


def run(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        raise ScienceError("invalid_request", "Expected only version, tool and arguments")
    if request["version"] != VERSION:
        raise ScienceError("version_mismatch", "The requested scientific catalog version is unavailable")
    name, arguments = request["tool"], request["arguments"]
    if not isinstance(name, str) or name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested function is not in the analysis catalog")
    if not isinstance(arguments, dict):
        raise ScienceError("invalid_arguments", "arguments must be an object")
    function = TOOLS[name]
    try:
        inspect.signature(function).bind(**arguments)
    except TypeError:
        raise ScienceError("invalid_arguments", "Arguments do not match the selected scientific function") from None
    try:
        return function(**arguments)
    except (ArithmeticError, ValueError):
        raise ScienceError("numeric_range", "The calculation is outside the supported numeric range") from None
