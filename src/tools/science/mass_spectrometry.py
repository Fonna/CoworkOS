# SPDX-License-Identifier: Apache-2.0
# Adapted from CMarsRover/SciAgentGYM e9dbbea4369d67694e38bf8be67bedbcaf9e9300.
# CoworkOS modifications: bounded stdlib-only centroid processing, real Cl/C
# convolution, explicit nominal-mass/charge assumptions and ambiguous-match errors.
# Sources and modifications are recorded in vendor/sciagentgym/NOTICE.
"""Three offline mass-spectrum calculations, without file or network operations."""

import inspect
import math

VERSION = "sciagentgym-e9dbbea-mass-spec-v6"
MAX_POINTS = 8192
MAX_RETAINED_PEAKS = 1024
CL37_ABUNDANCE = 0.2424
C13_ABUNDANCE = 0.0107


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


def _integer(value, name, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ScienceError("invalid_arguments", name + " must be an integer in the supported range")
    return value


def _spectrum(mz_values, intensities):
    if not isinstance(mz_values, list) or not isinstance(intensities, list):
        raise ScienceError("invalid_arguments", "m/z values and intensities must be arrays")
    if not 1 <= len(mz_values) <= MAX_POINTS or len(mz_values) != len(intensities):
        raise ScienceError("invalid_arguments", "Spectrum arrays must have equal lengths from 1 to 8192")
    mz = [_number(value, "m/z", 1e-100, 1e6) for value in mz_values]
    if mz[0] <= 0 or any(mz[index] <= mz[index - 1] for index in range(1, len(mz))):
        raise ScienceError("invalid_arguments", "m/z values must be positive and strictly increasing without duplicates")
    intensity = [_number(value, "intensity", 0, 1e100) for value in intensities]
    if max(intensity) <= 0:
        raise ScienceError("invalid_arguments", "At least one spectrum intensity must be positive")
    return mz, intensity


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


def parse_mass_spectrum_peaks(mz_values, intensities, intensity_threshold=1):
    mz, intensity = _spectrum(mz_values, intensities)
    threshold = _number(intensity_threshold, "intensity_threshold", 0, 100)
    maximum = max(intensity)
    peaks = []
    for mass, raw in zip(mz, intensity):
        # The input ceiling makes raw*100 safe; multiply first to avoid an
        # avoidable underflow when division alone would round to zero.
        relative = (raw * 100) / maximum
        if raw > 0 and relative == 0:
            raise ScienceError("numeric_range", "A positive relative intensity is too small to represent")
        if relative >= threshold:
            peaks.append({"mz": mass, "raw_intensity": raw, "relative_intensity": relative})
            if len(peaks) > MAX_RETAINED_PEAKS:
                raise ScienceError("result_too_large", "More than 1024 centroid peaks pass the threshold; increase the threshold or reduce the input")
    # At threshold <= 100, a positive base peak always survives.
    base_peak = max(peaks, key=lambda peak: peak["raw_intensity"])
    return _result({"peaks": peaks, "base_peak": base_peak, "highest_mz_peak": peaks[-1],
                    "total_points": len(mz), "filtered_peaks": len(peaks), "intensity_threshold": threshold},
                   {"mz": "Th (Da/e)", "raw_intensity": "input arbitrary intensity unit",
                    "relative_intensity": "percent of base peak", "intensity_threshold": "percent of base peak",
                    "total_points": "count", "filtered_peaks": "count"},
                   "Input is an already centroided mass-spectrum peak list, not a sampled profile. This only normalizes each input intensity to the input maximum as 100 and retains values greater than or equal to the relative-percent threshold; it does not detect local maxima, centroid a profile, subtract a baseline or integrate peak areas.",
                   "base_peak is the retained peak with greatest raw intensity; ties use the lowest m/z. highest_mz_peak is only the highest retained m/z, not an identified molecular ion, neutral mass or precursor. No charge, adduct, chemical identity, fragmentation or stability inference is performed. More than 1024 retained peaks raises result_too_large without truncation.")


def _binomial(count, heavy_abundance):
    light_abundance = 1 - heavy_abundance
    return [math.comb(count, heavy) * heavy_abundance ** heavy * light_abundance ** (count - heavy)
            for heavy in range(count + 1)]


def calculate_theoretical_isotope_pattern(num_chlorine, num_carbon=0):
    chlorine = _integer(num_chlorine, "num_chlorine", 0, 16)
    carbon = _integer(num_carbon, "num_carbon", 0, 128)
    chlorine_probabilities = _binomial(chlorine, CL37_ABUNDANCE)
    carbon_probabilities = _binomial(carbon, C13_ABUNDANCE)
    probabilities = []
    for shift in range(2 * chlorine + carbon + 1):
        contributions = []
        for heavy_chlorine, probability in enumerate(chlorine_probabilities):
            heavy_carbon = shift - 2 * heavy_chlorine
            if 0 <= heavy_carbon <= carbon:
                contributions.append(probability * carbon_probabilities[heavy_carbon])
        probabilities.append(math.fsum(contributions))
    # Normalize floating-point rounding only; no low-probability bins are pruned.
    total = math.fsum(probabilities)
    probabilities = [probability / total for probability in probabilities]
    maximum = max(probabilities)
    peaks = [{"mass_shift": shift, "probability": probability,
              "relative_intensity": (probability / maximum) * 100}
             for shift, probability in enumerate(probabilities)]
    ratio = probabilities[2] / probabilities[0] if len(probabilities) > 2 else 0.0
    return _result({"peaks": peaks, "M_plus_2_ratio": ratio, "num_chlorine": chlorine, "num_carbon": carbon,
                    "abundances": {"Cl35": 1 - CL37_ABUNDANCE, "Cl37": CL37_ABUNDANCE,
                                   "C12": 1 - C13_ABUNDANCE, "C13": C13_ABUNDANCE},
                    "model": "independent_cl_c_binomial_nominal_mass"},
                   {"mass_shift": "nominal mass-number difference", "probability": "dimensionless probability",
                    "relative_intensity": "percent of largest nominal mass bin", "M_plus_2_ratio": "dimensionless ratio",
                    "num_chlorine": "atom count", "num_carbon": "atom count", "abundances": "isotope amount fraction"},
                   "Independent binomial isotope counts for 35Cl/37Cl and 12C/13C are convolved into integer nominal shifts j+2*k. Probabilities sum to one over this Cl/C model; relative_intensity separately scales the largest nominal bin to 100. M denotes the all-light 35Cl/12C bin, which need not be the base peak. No bins are pruned, including zero-probability bins.",
                   "Fixed isotope amount fractions Cl37=0.2424 and C13=0.0107 (light fractions are complements) are model assumptions, not sample-specific measurements; natural abundance varies and isotope enrichment is outside this interface. Isotopes of H, N, O, S, Br and every other element are excluded, so this is not a complete molecular isotope envelope or an elemental-composition determination.",
                   "mass_shift is a nominal integer mass-number difference, not an exact mass in Da or an exact ion m/z. Different isotopologues are combined in a nominal bin without resolving their exact fine structure; no resolution convolution, ion/adduct formation, charge scaling or intensity-response model is applied. M_plus_2_ratio is the modeled nominal M+2-bin probability divided by the all-light M-bin probability, retaining full calculation precision.")


def find_isotope_cluster(peak_mz, peak_intensity, base_mz, mass_tolerance=0.05, abs_charge=1):
    mz, intensity = _spectrum(peak_mz, peak_intensity)
    requested = _number(base_mz, "base_mz", 1e-100, 1e6)
    if requested <= 0:
        raise ScienceError("invalid_arguments", "base_mz must be positive")
    tolerance = _number(mass_tolerance, "mass_tolerance", 1e-6, 0.25)
    charge = _integer(abs_charge, "abs_charge", 1, 10)
    if tolerance >= 0.5 / charge:
        raise ScienceError("invalid_arguments", "mass_tolerance must be less than 0.5/abs_charge for separate nominal windows")
    labels = ("M", "M+2", "M+4", "M+6")

    def match(target):
        matches = [index for index, mass in enumerate(mz) if abs(mass - target) <= tolerance]
        if len(matches) > 1:
            raise ScienceError("ambiguous_match", "More than one centroid lies in a nominal isotope window; provide resolved data or a narrower tolerance")
        return matches[0] if matches else None

    cluster = []
    missing = []
    first_index = match(requested)
    observed = mz[first_index] if first_index is not None else None
    plus_two_mz = None
    ratio = None
    if first_index is None:
        missing = list(labels)
    else:
        cluster.append({"label": "M", "mz": observed, "intensity": intensity[first_index],
                        "expected_mz": requested, "delta_mz": observed - requested})
        for shift, label in zip((2, 4, 6), labels[1:]):
            target = observed + shift / charge
            index = match(target)
            if index is None:
                missing.append(label)
            else:
                cluster.append({"label": label, "mz": mz[index], "intensity": intensity[index],
                                "expected_mz": target, "delta_mz": mz[index] - target})
                if shift == 2:
                    plus_two_mz = mz[index]
                    if intensity[first_index] > 0:
                        ratio = intensity[index] / intensity[first_index]
                        if intensity[index] > 0 and ratio == 0:
                            raise ScienceError("numeric_range", "A positive M+2/M intensity ratio is too small to represent")
    return _result({"requested_mz": requested, "M_mz": observed, "cluster": cluster,
                    "missing_labels": missing, "M_plus_2_mz": plus_two_mz, "M_plus_2_ratio": ratio,
                    "abs_charge": charge, "nominal_spacing": 2 / charge},
                   {"requested_mz": "Th (Da/e)", "M_mz": "Th (Da/e)", "mz": "Th (Da/e)",
                    "intensity": "input arbitrary intensity unit", "expected_mz": "Th (Da/e)",
                    "delta_mz": "Th (Da/e)", "M_plus_2_mz": "Th (Da/e)",
                    "M_plus_2_ratio": "dimensionless ratio", "abs_charge": "absolute charge number",
                    "nominal_spacing": "Th (Da/e)"},
                   "This searches an already centroided peak list for nominal M, M+2, M+4 and M+6 candidates at a user-supplied absolute charge; it does not infer charge, Cl count, molecular-ion identity, structure or even establish a common isotope origin. The nominal step 2/abs_charge approximates mass-number spacing, not exact isotope mass differences or fine structure.",
                   "The initial M window is centered on requested_mz. After a unique M is found, later windows are anchored to observed M_mz plus 2, 4 or 6 divided by abs_charge; every inclusive absolute-tolerance window must contain at most one centroid or ambiguous_match is raised. mass_tolerance must be smaller than 0.5/abs_charge; this window policy is not a physical resolution or calibration guarantee.",
                   "A missing M returns an empty cluster and all labels missing; missing M or M+2 and zero M intensity give a null M_plus_2_ratio, not evidence of zero isotope content. Supplied nonnegative intensities are used unchanged in the ratio without background correction, saturation correction or integration. A zero M+2 intensity, when its centroid is present and M is positive, gives an observed ratio of zero.")


TOOLS = {function.__name__: function for function in (parse_mass_spectrum_peaks, calculate_theoretical_isotope_pattern, find_isotope_cluster)}


def run(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        raise ScienceError("invalid_request", "Expected only version, tool and arguments")
    if request["version"] != VERSION:
        raise ScienceError("version_mismatch", "The requested scientific catalog version is unavailable")
    name, arguments = request["tool"], request["arguments"]
    if not isinstance(name, str) or name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested function is not in the mass-spectrometry catalog")
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
