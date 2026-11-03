# SPDX-License-Identifier: Apache-2.0
# Adapted from CMarsRover/SciAgentGYM e9dbbea4369d67694e38bf8be67bedbcaf9e9300.
# CoworkOS modifications: bounded stdlib-only lattice geometry, scaled SPD checks,
# stable linear solves, Gaussian instrumental-width correction and explicit units.
# Sources and modifications are recorded in vendor/sciagentgym/NOTICE.
"""Four offline crystallographic calculations; no optional package imports."""

import inspect
import math

VERSION = "sciagentgym-e9dbbea-materials-v5"
CONDITION_LIMIT = 1e10
PIVOT_MINIMUM = 1e-12


class ScienceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _number(value, name, minimum, maximum):
    if type(value) not in (int, float):
        raise ScienceError("invalid_arguments", name + " must be a finite number")
    try:
        valid = math.isfinite(value) and minimum <= value <= maximum
    except OverflowError:
        valid = False
    if not valid:
        raise ScienceError("invalid_arguments", name + " is outside the supported numeric range")
    return float(value)


def _hkl(h, k, l):
    if any(type(value) is not int or not -1000 <= value <= 1000 for value in (h, k, l)):
        raise ScienceError("invalid_arguments", "Miller indices must be integers from -1000 to 1000")
    if h == k == l == 0:
        raise ScienceError("invalid_arguments", "Miller indices must not all be zero")
    return (h, k, l)


def _finite_tree(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ScienceError("numeric_range", "The calculation produced an unrepresentable result")
    if isinstance(value, dict):
        for item in value.values():
            _finite_tree(item)
    if isinstance(value, list):
        for item in value:
            _finite_tree(item)


def _result(value, units, *assumptions):
    _finite_tree(value)
    return {"ok": True, "result": value, "units": units, "assumptions": list(assumptions)}


def _forward(lower, rhs):
    solution = []
    for row in range(3):
        solution.append((rhs[row] - math.fsum(lower[row][col] * solution[col] for col in range(row))) / lower[row][row])
    return solution


def _backward(lower, rhs):
    solution = [0.0, 0.0, 0.0]
    for row in range(2, -1, -1):
        solution[row] = (rhs[row] - math.fsum(lower[col][row] * solution[col] for col in range(row + 1, 3))) / lower[row][row]
    return solution


def _metric_factor(metric_tensor):
    if not isinstance(metric_tensor, list) or len(metric_tensor) != 3 or any(not isinstance(row, list) or len(row) != 3 for row in metric_tensor):
        raise ScienceError("invalid_arguments", "metric_tensor must be a 3 by 3 matrix")
    metric = [[_number(value, "metric_tensor", -1e12, 1e12) for value in row] for row in metric_tensor]
    for row in range(3):
        if metric[row][row] < 1e-12:
            raise ScienceError("invalid_arguments", "Metric diagonal entries must be at least 1e-12 square angstrom")
        for col in range(row):
            if metric[row][col] != metric[col][row]:
                raise ScienceError("invalid_arguments", "metric_tensor must be strictly symmetric")
    scale = max(metric[index][index] for index in range(3))
    normalized = [[value / scale for value in row] for row in metric]
    lower = [[0.0] * 3 for _ in range(3)]
    for row in range(3):
        for col in range(row + 1):
            value = normalized[row][col] - math.fsum(lower[row][index] * lower[col][index] for index in range(col))
            if row == col:
                if value <= 0:
                    raise ScienceError("invalid_arguments", "The direct-lattice metric must be positive definite")
                if value <= PIVOT_MINIMUM:
                    raise ScienceError("numeric_range", "The metric is too close to singular for this calculation")
                lower[row][col] = math.sqrt(value)
            else:
                lower[row][col] = value / lower[col][col]
    # The small inverse is used only to assess conditioning; d is computed by a solve.
    columns = [_backward(lower, _forward(lower, [float(row == col) for row in range(3)])) for col in range(3)]
    norm = max(math.fsum(abs(value) for value in row) for row in normalized)
    inverse_norm = max(math.fsum(abs(columns[col][row]) for col in range(3)) for row in range(3))
    if norm * inverse_norm > CONDITION_LIMIT:
        raise ScienceError("numeric_range", "The metric condition number exceeds the supported limit of 1e10")
    return metric, lower, scale


def cubic_lattice_parameter(d_spacing, hkl):
    spacing = _number(d_spacing, "d_spacing", 1e-6, 1e6)
    if not isinstance(hkl, list) or len(hkl) != 3:
        raise ScienceError("invalid_arguments", "hkl must be an array of three Miller integers")
    indices = _hkl(*hkl)
    return _result(spacing * math.hypot(*indices), "angstrom",
                   "Cubic metric only: a=d_hkl*sqrt(h^2+k^2+l^2). d_spacing is in angstrom; hkl is the already assigned reflection in the same cell setting. Indices are not reduced by their greatest common divisor, so 200 and 100 are different reflections. This does not establish cubic symmetry, allowed intensities, Miller indexing or phase identity.")


def calculate_metric_tensor(a, b, c, alpha, beta, gamma):
    a, b, c = (_number(value, name, 1e-6, 1e6) for value, name in ((a, "a"), (b, "b"), (c, "c")))
    alpha, beta, gamma = (_number(value, name, 0.001, 179.999) for value, name in ((alpha, "alpha"), (beta, "beta"), (gamma, "gamma")))
    ca, cb, cg = (math.cos(math.radians(angle)) for angle in (alpha, beta, gamma))
    # Reuse the same off-diagonal numbers to preserve exact symmetry in JSON.
    ab, ac, bc = a * b * cg, a * c * cb, b * c * ca
    metric, lower, scale = _metric_factor([[a * a, ab, ac], [ab, b * b, bc], [ac, bc, c * c]])
    volume = scale ** 1.5 * lower[0][0] * lower[1][1] * lower[2][2]
    return _result({"metric_tensor": metric, "volume_angstrom3": volume},
                   {"metric_tensor": "angstrom^2", "volume_angstrom3": "angstrom^3"},
                   "Direct-lattice Gram metric: alpha is the angle between b and c, beta between a and c, gamma between a and b, all in degrees; lengths use angstrom. The three angles must jointly define a positive-definite nondegenerate cell; independent angle ranges are insufficient. Volume is positive sqrt(det(G)), not an orientation sign.",
                   "Finite 3 by 3 metrics are scale-normalized for Cholesky validation. Near-singular pivots and infinity-norm condition numbers above 1e10 are rejected as a numerical policy. The metric does not determine an atomic basis, space group, composition or material identity.")


def calculate_interplanar_spacing_general(h, k, l, metric_tensor):
    indices = _hkl(h, k, l)
    _, lower, scale = _metric_factor(metric_tensor)
    reciprocal_vector = _forward(lower, indices)
    spacing = math.sqrt(scale) / math.hypot(*reciprocal_vector)
    return _result(spacing, "angstrom",
                   "d_hkl=1/sqrt(h^T G^-1 h), using a direct-lattice metric G in square angstrom and the crystallographic reciprocal convention without 2*pi. G must be exactly symmetric and positive definite; near-singular pivots and infinity-norm condition numbers above 1e10 are rejected. The calculation uses a scaled Cholesky solve rather than a determinant-based inverse.",
                   "Miller integers refer to the same cell setting as G. Signed indices and higher-order indices are preserved without gcd reduction. This computes geometric plane spacing only; no reflection intensity, systematic absence, atomic structure, phase or space-group assignment is inferred.")


def calculate_scherrer_grain_size(peak_2theta_deg, fwhm_deg, wavelength_nm=0.15406, shape_factor=0.9, instrument_fwhm_deg=0):
    two_theta = _number(peak_2theta_deg, "peak_2theta_deg", 0.001, 179.999)
    observed = _number(fwhm_deg, "fwhm_deg", 1e-6, 10)
    wavelength = _number(wavelength_nm, "wavelength_nm", 1e-6, 100)
    factor = _number(shape_factor, "shape_factor", 0.1, 2)
    instrument = _number(instrument_fwhm_deg, "instrument_fwhm_deg", 0, 10)
    if instrument >= observed:
        raise ScienceError("invalid_arguments", "instrument_fwhm_deg must be smaller than the observed FWHM")
    # Gaussian widths add in quadrature. Factoring avoids cancellation of squares.
    relative_variance = ((observed - instrument) / observed) * (1 + instrument / observed)
    if relative_variance <= 1e-12:
        raise ScienceError("numeric_range", "Instrumental-width subtraction is too ill-conditioned")
    corrected = observed * math.sqrt(relative_variance)
    beta = math.radians(corrected)
    theta = two_theta / 2
    size = factor * wavelength / (beta * math.cos(math.radians(theta)))
    return _result({"D_nm": size, "theta_deg": theta, "beta_rad": beta,
                    "corrected_fwhm_deg": corrected, "instrument_model": "gaussian"},
                   {"D_nm": "nm", "theta_deg": "degree", "beta_rad": "radian",
                    "corrected_fwhm_deg": "degree", "instrument_model": "line-profile model"},
                   "D=K*lambda/(beta*cos(theta)) estimates an apparent coherent diffraction-domain size along the selected reflection, not general grain or particle size. Widths are FWHM of the 2theta profile in degrees; beta is the corrected width in radians, while theta is half the peak 2theta. Wavelength and D use nm.",
                   "This wrapper explicitly assumes Gaussian observed and instrumental profiles: corrected_FWHM=sqrt(observed_FWHM^2-instrument_FWHM^2). It replaces the upstream unqualified linear subtraction; Lorentzian/Voigt deconvolution is outside this scope. Zero instrument width means no numerical correction, not proof of negligible instrument broadening.",
                   "Size broadening is assumed dominant after the supplied instrument correction; strain, defects, overlapping peaks, shape distributions and other broadening are not separated. K=0.9 is a default shape/profile convention, not a measured constant. Corrected/observed variance ratios at most 1e-12 are rejected numerically. The supplied fitted FWHM is not the half-prominence width returned by general peak_detection. Numeric acceptance does not validate this physical size model.")


TOOLS = {function.__name__: function for function in (cubic_lattice_parameter, calculate_metric_tensor, calculate_interplanar_spacing_general, calculate_scherrer_grain_size)}


def run(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        raise ScienceError("invalid_request", "Expected only version, tool and arguments")
    if request["version"] != VERSION:
        raise ScienceError("version_mismatch", "The requested scientific catalog version is unavailable")
    name, arguments = request["tool"], request["arguments"]
    if not isinstance(name, str) or name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested function is not in the materials catalog")
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
