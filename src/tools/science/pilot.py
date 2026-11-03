# SPDX-License-Identifier: Apache-2.0
# Adapted from CMarsRover/SciAgentGYM, commit e9dbbea4369d67694e38bf8be67bedbcaf9e9300.
# Modified by CoworkOS contributors: curated pure kernels, validation, stable arithmetic,
# bounded JSON results, no plotting/files/network. Exact provenance: vendor/sciagentgym/NOTICE.
"""The fixed SciAgentGYM pilot; importing this module needs only Python's stdlib."""

import inspect
import math

VERSION = "sciagentgym-e9dbbea-pilot-v1"
GAS_CONSTANT = 8.31446261815324
REFERENCE_PRESSURE = 20e-6
PHOTON_EV_NM = 6.62607015e-34 * 299792458 / 1.602176634e-19 * 1e9
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


def _positive(value, name):
    return _number(value, name, 1e-100)


def _db(value, name):
    return _number(value, name, -1000, 1000)


def _positive_result(value):
    if not math.isfinite(value) or value <= 0:
        raise ScienceError("numeric_range", "The result is outside the supported finite positive range")
    return value


def _result(value, units, *assumptions):
    return {"ok": True, "result": value, "units": units, "assumptions": list(assumptions)}


def eV_to_nm(energy_eV):
    value = PHOTON_EV_NM / _positive(energy_eV, "energy_eV")
    return _result(_positive_result(value), "nm", "Vacuum photon wavelength; E = h*c/lambda.")


def nm_to_eV(wavelength_nm):
    value = PHOTON_EV_NM / _positive(wavelength_nm, "wavelength_nm")
    return _result(_positive_result(value), "eV", "Vacuum photon energy; E = h*c/lambda.")


def ideal_gas_state(P, V, n=1, R=GAS_CONSTANT):
    pressure, volume = _positive(P, "P"), _positive(V, "V")
    moles, gas_constant = _positive(n, "n"), _positive(R, "R")
    temperature = pressure * volume / (moles * gas_constant)
    return _result(_positive_result(temperature), "K", "Ideal gas; P in Pa, V in m^3, n in mol, R in J/(mol*K).")


def isothermal_process(V, T, n=1, R=GAS_CONSTANT):
    volume, temperature = _positive(V, "V"), _positive(T, "T")
    moles, gas_constant = _positive(n, "n"), _positive(R, "R")
    pressure = moles * gas_constant * temperature / volume
    return _result(_positive_result(pressure), "Pa", "Ideal gas at the given constant temperature; V in m^3, T in K, n in mol, R in J/(mol*K).")


def isobaric_process(V, P, n=1, R=GAS_CONSTANT):
    response = ideal_gas_state(P, V, n, R)
    response["assumptions"] = ["Ideal gas at the given constant pressure; P in Pa, V in m^3, n in mol, R in J/(mol*K)."]
    return response


def clausius_clapeyron_temperature(P1, T1, P2, delta_H_vap, R=8.314):
    pressure1, temperature1 = _positive(P1, "P1"), _positive(T1, "T1")
    pressure2, enthalpy = _positive(P2, "P2"), _positive(delta_H_vap, "delta_H_vap")
    gas_constant = _positive(R, "R")
    denominator = 1 / temperature1 - gas_constant / enthalpy * (math.log(pressure2) - math.log(pressure1))
    if not math.isfinite(denominator) or denominator <= 0:
        raise ScienceError("numeric_range", "The approximation does not give a finite positive temperature")
    return _result(_positive_result(1 / denominator), "K", "Constant positive molar vaporization/sublimation enthalpy in J/mol; ideal vapor; pressures in Pa, T1 in K, R in J/(mol*K).")


def clausius_clapeyron_pressure(P1, T1, T2, delta_H_vap, R=8.314):
    pressure1, temperature1 = _positive(P1, "P1"), _positive(T1, "T1")
    temperature2, enthalpy = _positive(T2, "T2"), _positive(delta_H_vap, "delta_H_vap")
    gas_constant = _positive(R, "R")
    log_pressure = math.log(pressure1) + enthalpy / gas_constant * (1 / temperature1 - 1 / temperature2)
    if not math.isfinite(log_pressure) or not -690 <= log_pressure <= 690:
        raise ScienceError("numeric_range", "The pressure is outside the supported exponential range")
    return _result(_positive_result(math.exp(log_pressure)), "Pa", "Constant positive molar vaporization/sublimation enthalpy in J/mol; ideal vapor; P1 in Pa, temperatures in K, R in J/(mol*K).")


def convert_spl_to_pressure(spl_db):
    pressure = REFERENCE_PRESSURE * 10 ** (_db(spl_db, "spl_db") / 20)
    return _result(_positive_result(pressure), "Pa RMS", "Sound pressure level referenced to 20 microPa RMS in air.")


def convert_pressure_to_spl(pressure_pa):
    level = 20 * (math.log10(_positive(pressure_pa, "pressure_pa")) - math.log10(REFERENCE_PRESSURE))
    return _result(level, "dB SPL", "Input is RMS sound pressure in Pa; reference 20 microPa RMS in air.")


def add_two_spl_values(spl1_db, spl2_db, use_table=False):
    level1, level2 = _db(spl1_db, "spl1_db"), _db(spl2_db, "spl2_db")
    if use_table is not False:
        raise ScienceError("invalid_arguments", "use_table must be false; only exact logarithmic addition is enabled")
    high, low = max(level1, level2), min(level1, level2)
    total = high + 10 * math.log1p(10 ** ((low - high) / 10)) / math.log(10)
    return _result(total, "dB SPL", "Incoherent independent sound sources, same measurement position and reference; exact intensity addition.")


def calculate_spl_at_distance(source_spl, source_distance, target_distance, environment="free_field"):
    level = _db(source_spl, "source_spl")
    source, target = _positive(source_distance, "source_distance"), _positive(target_distance, "target_distance")
    if environment != "free_field":
        raise ScienceError("invalid_arguments", "Only environment=free_field is enabled")
    target_level = level - 20 * (math.log10(target) - math.log10(source))
    return _result(target_level, "dB SPL", "Free-field point source, inverse-square spreading, distances in m; no absorption, reflection or near-field correction.")


def _array(values, name, minimum):
    if not isinstance(values, list) or not 3 <= len(values) <= MAX_POINTS:
        raise ScienceError("invalid_arguments", name + " must contain 3 to 8192 numbers")
    return [_number(value, name, minimum) for value in values]


def analyze_spectrum(wavelengths, intensities, prominence=0.1, width=None, height=None):
    axis = _array(wavelengths, "wavelengths", 1e-100)
    signal = _array(intensities, "intensities", 0)
    if len(axis) != len(signal):
        raise ScienceError("invalid_arguments", "wavelengths and intensities must have equal lengths")
    if any(left >= right for left, right in zip(axis, axis[1:])):
        raise ScienceError("invalid_arguments", "wavelengths must be strictly increasing")
    maximum = max(signal)
    if maximum <= 0:
        raise ScienceError("invalid_arguments", "intensities must include a positive value")
    prominence = _number(prominence, "prominence", 0, 1)
    if width is not None:
        width = _number(width, "width", 0, MAX_POINTS)
    if height is not None:
        height = _number(height, "height", 0, 1)
    try:
        import numpy as np
        from scipy.signal import find_peaks
    except ImportError:
        raise ScienceError("dependency_unavailable", "Spectrum analysis requires NumPy and SciPy in the configured scientific Python environment") from None
    normalized = np.asarray(signal, dtype=float) / maximum
    peaks, properties = find_peaks(normalized, prominence=prominence, width=width, height=height)
    if len(peaks) > MAX_PEAKS:
        raise ScienceError("too_many_peaks", "More than 1024 peaks; increase prominence or narrow the input spectrum")
    widths = properties.get("widths")
    result = {
        "peak_indices": peaks.tolist(),
        "peak_wavelengths": [axis[int(index)] for index in peaks],
        "peak_intensities": normalized[peaks].tolist(),
        "peak_widths": widths.tolist() if widths is not None else None,
        "peak_prominences": properties["prominences"].tolist(),
    }
    return _result(result, {"peak_wavelengths": "nm", "peak_intensities": "relative to maximum input intensity", "peak_widths": "samples", "peak_prominences": "relative to maximum input intensity"}, "Peak intensity and prominence use normalization by the positive maximum input intensity; widths are null unless requested, and are measured in sample indices even for a nonuniform wavelength axis.")


TOOLS = {
    "eV_to_nm": eV_to_nm,
    "nm_to_eV": nm_to_eV,
    "ideal_gas_state": ideal_gas_state,
    "isothermal_process": isothermal_process,
    "isobaric_process": isobaric_process,
    "clausius_clapeyron_temperature": clausius_clapeyron_temperature,
    "clausius_clapeyron_pressure": clausius_clapeyron_pressure,
    "convert_spl_to_pressure": convert_spl_to_pressure,
    "convert_pressure_to_spl": convert_pressure_to_spl,
    "add_two_spl_values": add_two_spl_values,
    "calculate_spl_at_distance": calculate_spl_at_distance,
    "analyze_spectrum": analyze_spectrum,
}


def run(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        raise ScienceError("invalid_request", "Expected only version, tool and arguments")
    if request["version"] != VERSION:
        raise ScienceError("version_mismatch", "The requested scientific catalog version is unavailable")
    name, arguments = request["tool"], request["arguments"]
    if not isinstance(name, str) or name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested tool is not in the scientific pilot")
    if not isinstance(arguments, dict):
        raise ScienceError("invalid_arguments", "arguments must be an object")
    function = TOOLS[name]
    try:
        inspect.signature(function).bind(**arguments)
    except TypeError:
        raise ScienceError("invalid_arguments", "Arguments do not match the selected scientific tool") from None
    try:
        return function(**arguments)
    except (OverflowError, ZeroDivisionError, ValueError):
        raise ScienceError("numeric_range", "The calculation is outside the supported numeric range") from None
