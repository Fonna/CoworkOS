# SPDX-License-Identifier: Apache-2.0
# Adapted from CMarsRover/SciAgentGYM e9dbbea4369d67694e38bf8be67bedbcaf9e9300.
# CoworkOS modifications: stdlib-only bounded scalar calculations, closed schemas,
# explicit approximation/units, fixed nominal constants and no import side effects.
# Exact upstream files and changes are recorded in vendor/sciagentgym/NOTICE.
"""Eight offline astronomy calculations; no optional dependencies or discovery."""

import inspect
import math

VERSION = "sciagentgym-e9dbbea-astronomy-v3"
SPEED_OF_LIGHT = 299792458.0  # m/s, exact SI conversion.
GRAVITATIONAL_CONSTANT = 6.67430e-11  # m^3 kg^-1 s^-2, CODATA 2018.
SOLAR_RADIUS = 6.957e8  # m, IAU 2015 nominal conversion, not a measured radius.
SOLAR_LUMINOSITY = 3.828e26  # W, IAU 2015 nominal conversion.
STEFAN_BOLTZMANN_CONSTANT = 5.670374419e-8  # W m^-2 K^-4.


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


def _finite_tree(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ScienceError("numeric_range", "The calculation produced an unrepresentable result")
    if isinstance(value, dict):
        for member in value.values():
            _finite_tree(member)


def _result(value, units, *assumptions):
    _finite_tree(value)
    return {"ok": True, "result": value, "units": units, "assumptions": list(assumptions)}


def calculate_extinction(e_bv, rv=3.1):
    color_excess = _number(e_bv, "e_bv", 0, 5)
    ratio = _number(rv, "rv", 0.1, 10)
    return _result(ratio * color_excess, "mag",
                   "V-band extinction A_V = R_V * E(B-V). E(B-V) is a nonnegative color excess in magnitudes; R_V is dimensionless. The default R_V=3.1 is a typical diffuse Milky Way value, not a universal dust law or a correction for other bands. Supported ranges are computational policy, not universal astrophysical bounds.")


def calculate_distance_modulus(m_obs, M_abs, a_v=0):
    apparent = _number(m_obs, "m_obs", -100, 100)
    absolute = _number(M_abs, "M_abs", -100, 100)
    extinction = _number(a_v, "a_v", 0, 100)
    return _result(apparent - absolute - extinction, "mag",
                   "The true extinction-corrected distance modulus is mu = m_obs - M_abs - A_V; m_obs and M_abs must use the same V band and magnitude system, with A_V in that band. This does not infer absolute magnitude, extinction, a K-correction or a cosmological distance.")


def distance_from_modulus(mu):
    modulus = _number(mu, "mu", -10, 30)
    return _result(10 ** ((modulus + 5) / 5), "pc",
                   "d = 10^((mu+5)/5) parsecs, with an extinction-corrected distance modulus. The supported mu range [-10,30] maps to [0.1,10000000] pc. No redshift, cosmological model, K-correction or uncertainty propagation is applied; interpreting this as a geometric distance requires the corresponding nearby-source assumptions.")


def calculate_stellar_luminosity(radius, temperature, radius_unit="solar"):
    radius = _number(radius, "radius", 1e-12, 1e6)
    temperature = _number(temperature, "temperature", 2000, 50000)
    if radius_unit != "solar":
        raise ScienceError("invalid_arguments", "Only radius_unit='solar' is enabled")
    radius_meters = radius * SOLAR_RADIUS
    watts = 4 * math.pi * radius_meters ** 2 * STEFAN_BOLTZMANN_CONSTANT * temperature ** 4
    return _result({"luminosity_solar": watts / SOLAR_LUMINOSITY,
                    "luminosity_watts": watts, "radius_meters": radius_meters,
                    "temperature_K": temperature},
                   {"luminosity_solar": "nominal solar luminosity", "luminosity_watts": "W",
                    "radius_meters": "m", "temperature_K": "K"},
                   "Bolometric luminosity L=4*pi*R^2*sigma*T_eff^4 for a spherical star; temperature must be its effective temperature, not a color temperature or a band brightness. radius is in IAU nominal solar radii (6.957e8 m); one nominal solar luminosity is 3.828e26 W. sigma=5.670374419e-8 W m^-2 K^-4. These nominal solar conversions are not measured present-day solar properties.")


def calculate_transit_depth(planet_radius, star_radius, star_luminosity, companion_luminosity=0):
    planet = _number(planet_radius, "planet_radius", 1e-12, 1e6)
    star = _number(star_radius, "star_radius", 1e-12, 1e6)
    luminosity = _number(star_luminosity, "star_luminosity", 1e-100)
    companion = _number(companion_luminosity, "companion_luminosity", 0)
    if planet > star:
        raise ScienceError("invalid_arguments", "planet_radius must not exceed star_radius")
    area = (planet / star) ** 2
    loss = luminosity * area
    total = luminosity + companion
    depth = (luminosity / total) * area
    return _result({"remaining_luminosity": luminosity * (1 - area) + companion,
                    "transit_depth_fraction": depth, "transit_depth_percent": depth * 100,
                    "blocked_area_fraction": area, "light_loss": loss,
                    "total_luminosity_before": total},
                   {"remaining_luminosity": "nominal solar luminosity", "transit_depth_fraction": "dimensionless",
                    "transit_depth_percent": "%", "blocked_area_fraction": "dimensionless",
                    "light_loss": "nominal solar luminosity", "total_luminosity_before": "nominal solar luminosity"},
                   "Ideal fully overlapping transit of an opaque non-emitting planet in front of a uniform-brightness stellar disk; no limb darkening, grazing geometry, ingress/egress or time model. Both radii are in solar radii. Star and unresolved constant companion luminosities use the same band (or both bolometric), the same solar-luminosity normalization and distance; their ratio represents the observed out-of-transit flux ratio. The scalar convention from upstream is retained as remaining_luminosity, while transit_depth_fraction is the diluted relative flux loss.")


def wavelength_shift_to_velocity(delta_lambda, lambda_0):
    shift = _number(delta_lambda, "delta_lambda")
    rest = _number(lambda_0, "lambda_0", 1e-100)
    ratio = shift / rest
    if abs(ratio) > 1e-3:
        raise ScienceError("invalid_arguments", "The first-order Doppler approximation requires abs(delta_lambda/lambda_0) <= 0.001")
    velocity = SPEED_OF_LIGHT * ratio
    if shift != 0 and velocity == 0:
        raise ScienceError("numeric_range", "The velocity is too small to represent")
    return _result(velocity, "m/s",
                   "First-order line-of-sight Doppler approximation v=c*delta_lambda/lambda_0, c=299792458 m/s. Both wavelengths use angstrom and the same air/vacuum convention; delta_lambda is observed minus rest, with positive velocity receding. Restricted to abs(delta_lambda/lambda_0)<=0.001; this is not a relativistic, cosmological, gravitational or precision barycentric radial-velocity correction.")


def kepler_third_law(a, M_star):
    axis = _number(a, "a", 1e-100)
    mass = _number(M_star, "M_star", 1e-100)
    # Equivalent to sqrt(4*pi^2*a^3/(G*M)), avoiding an overflowing intermediate.
    period = 2 * math.pi * axis * math.sqrt(axis / (GRAVITATIONAL_CONSTANT * mass))
    return _result(period, "s",
                   "Newtonian Kepler period P=2*pi*sqrt(a^3/(G*M_star)), G=6.67430e-11 m^3 kg^-1 s^-2. a is the relative orbital semimajor axis in meters and M_star the central mass in kilograms; companion mass is assumed negligible. Assumes an isolated bound orbit in the weak-field nonrelativistic regime; these conditions and a physically possible orbit are not established from a and M_star alone. No eccentricity, ephemeris or orbit integration is inferred.")


def calculate_mass_ratio_from_rv(k1, k2):
    first = _number(k1, "k1", 1e-100)
    second = _number(k2, "k2", 1e-100)
    return _result(second / first, "dimensionless",
                   "Returns m1/m2 = k2/k1, preserving the upstream ordering; it does not use the often-seen q=m2/m1 convention. k1 and k2 are positive fitted radial-velocity semiamplitudes in km/s for the two stars of the same Newtonian spectroscopic binary, not instantaneous or systemic velocities. Common inclination and eccentricity factors cancel; this does not determine either absolute mass or inclination, or model relativistic binaries.")


TOOLS = {function.__name__: function for function in (calculate_extinction, calculate_distance_modulus, distance_from_modulus, calculate_stellar_luminosity, calculate_transit_depth, wavelength_shift_to_velocity, kepler_third_law, calculate_mass_ratio_from_rv)}


def run(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        raise ScienceError("invalid_request", "Expected only version, tool and arguments")
    if request["version"] != VERSION:
        raise ScienceError("version_mismatch", "The requested scientific catalog version is unavailable")
    name, arguments = request["tool"], request["arguments"]
    if not isinstance(name, str) or name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested function is not in the astronomy catalog")
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
