import type { ScienceCatalogEntry, ScienceSchema } from "./catalog.js";

const repository = "https://github.com/CMarsRover/SciAgentGYM";
const commit = "e9dbbea4369d67694e38bf8be67bedbcaf9e9300";
const upstream = {
  photometry: [
    "toolkits/astronomy/astronomy/astronomy_toolkit_5.py",
    "e302010ac3f21ceec38bc11a26bee424324caa98ed3117832e82fb6b315a6b8c"
  ],
  luminosity: [
    "toolkits/astronomy/astronomy/astronomy_toolkit_6.py",
    "f848442c332557573dea857be155777fab63016bd0a2a69f03c5830356bc7e5b"
  ],
  orbital: [
    "toolkits/astronomy/astronomy/astronomy_toolkit_12.py",
    "6f7c63d4bfc3db1fa9b6ef649664c5a9dd93c418c395962bda57c0f3ed5baf1f"
  ],
  binary: [
    "toolkits/astronomy/astronomy/astrophysics_toolkit_1.py",
    "d983ceeb1860e4c239cd4c83b0feaad1fde621917ad040d3257aef9867d8cc69"
  ]
} as const;

function source(key: keyof typeof upstream, line: number): ScienceCatalogEntry["source"] {
  const [path, sha256] = upstream[key];
  return { repository, commit, path, line, sha256, url: `${repository}/blob/${commit}/${path}#L${line}` };
}

function number(description: string, minimum: number, maximum: number, defaultValue?: number): ScienceSchema {
  return {
    type: "number",
    description,
    minimum,
    maximum,
    ...(defaultValue === undefined ? {} : { default: defaultValue })
  };
}

function parameters(properties: Record<string, ScienceSchema>, required: string[]): ScienceSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const radius = (description: string): ScienceSchema => number(description, 1e-12, 1e6);
const positive = (description: string): ScienceSchema => number(description, 1e-100, 1e100);

/** Eight offline scalar astronomy additions; earlier catalog entries retain their metadata. */
export const ASTRONOMY_ENTRIES: ScienceCatalogEntry[] = [
  {
    name: "calculate_extinction",
    domain: "astronomy",
    group: "stellar_photometry",
    description: "Calculate visual extinction A_V = R_V E(B-V) in magnitudes.",
    keywords: ["extinction", "reddening", "photometry", "color excess", "消光", "红化", "色余", "测光"],
    parameters: parameters(
      {
        e_bv: number("Nonnegative B-V color excess E(B-V), in magnitudes.", 0, 5),
        rv: number("Positive ratio of total to selective extinction R_V; dimensionless.", 0.1, 10, 3.1)
      },
      ["e_bv"]
    ),
    units: { e_bv: "mag", rv: "dimensionless", result: "mag (A_V)" },
    assumptions: [
      "Uses the visual-band extinction relation A_V = R_V E(B-V); R_V = 3.1 is a configurable convention, not a fitted extinction law.",
      "Accepts E(B-V) from 0 to 5 mag and R_V from 0.1 to 10; negative reddening and wavelength-dependent extinction curves are not modeled."
    ],
    dependencies: [],
    example: { e_bv: 0.2, rv: 3.1 },
    source: source("photometry", 40)
  },
  {
    name: "calculate_distance_modulus",
    domain: "astronomy",
    group: "stellar_photometry",
    description: "Calculate the extinction-corrected distance modulus mu = m_obs - M_abs - a_v.",
    keywords: ["distance modulus", "magnitude", "photometry", "距离模数", "星等", "绝对星等", "测光"],
    parameters: parameters(
      {
        m_obs: number("Observed apparent magnitude in the same band as M_abs and a_v.", -100, 100),
        M_abs: number("Absolute magnitude in the same band as m_obs and a_v.", -100, 100),
        a_v: number("Nonnegative extinction in the matching visual band, in magnitudes.", 0, 100, 0)
      },
      ["m_obs", "M_abs"]
    ),
    units: { m_obs: "mag", M_abs: "mag", a_v: "mag", result: "mag (true distance modulus)" },
    assumptions: [
      "Apparent magnitude, absolute magnitude and extinction must refer to the same photometric band; the default extinction is zero.",
      "Returns the true, extinction-corrected modulus, not a distance. No cosmological redshift, K correction or uncertainty propagation is included.",
      "A modulus returned here can fall outside distance_from_modulus's supported interval of -10 to 30 mag."
    ],
    dependencies: [],
    example: { m_obs: 10, M_abs: 5, a_v: 0 },
    source: source("photometry", 91)
  },
  {
    name: "distance_from_modulus",
    domain: "astronomy",
    group: "stellar_photometry",
    description: "Convert a true distance modulus to distance in parsecs: d = 10^((mu + 5) / 5).",
    keywords: ["distance modulus", "parsec", "stellar distance", "距离模数", "秒差距", "恒星距离", "测距"],
    parameters: parameters({ mu: number("Extinction-corrected distance modulus, in magnitudes.", -10, 30) }, [
      "mu"
    ]),
    units: { mu: "mag", result: "pc" },
    assumptions: [
      "The supplied modulus must already be corrected for extinction; no extinction is subtracted by this function.",
      "Accepts -10 to 30 mag, corresponding to 0.1 to 10000000 pc. The upstream prose misstated this range; the distance formula is preserved.",
      "This magnitude-distance relation does not supply a cosmological distance model or redshift correction."
    ],
    dependencies: [],
    example: { mu: 5 },
    source: source("photometry", 143)
  },
  {
    name: "calculate_stellar_luminosity",
    domain: "astronomy",
    group: "stellar_luminosity",
    description:
      "Calculate spherical bolometric luminosity from solar radius and effective temperature using the Stefan-Boltzmann law.",
    keywords: ["stellar luminosity", "Stefan Boltzmann", "blackbody", "恒星光度", "光度", "有效温度", "黑体"],
    parameters: parameters(
      {
        radius: radius("Stellar radius in solar radii; only solar units are enabled."),
        temperature: number("Stellar effective temperature in kelvin.", 2000, 50000),
        radius_unit: {
          type: "string",
          const: "solar",
          default: "solar",
          description: "Radius unit is fixed to solar radii; meter input is unavailable."
        }
      },
      ["radius", "temperature"]
    ),
    units: {
      radius: "nominal R_sun",
      temperature: "K",
      luminosity_solar: "nominal L_sun",
      luminosity_watts: "W",
      radius_meters: "m",
      temperature_K: "K"
    },
    assumptions: [
      "Uses L = 4 pi R^2 sigma T_eff^4 for a spherical surface with bolometric effective temperature, not a passband luminosity.",
      "Constants: nominal R_sun = 6.957e8 m, nominal L_sun = 3.828e26 W, sigma = 5.670374419e-8 W/(m^2 K^4).",
      "Radius is restricted to 1e-12 to 1e6 solar radii and temperature to 2000 to 50000 K; numerical bounds do not establish a physically viable stellar model."
    ],
    dependencies: [],
    example: { radius: 1, temperature: 5772 },
    source: source("luminosity", 32)
  },
  {
    name: "calculate_transit_depth",
    domain: "astronomy",
    group: "transit_photometry",
    description:
      "Calculate remaining system luminosity and diluted transit depth for a fully overlapping dark planet on a uniformly bright star.",
    keywords: ["transit", "depth", "exoplanet", "dilution", "凌星", "凌星深度", "系外行星", "光度变化"],
    parameters: parameters(
      {
        planet_radius: radius("Opaque planet radius in solar radii; cannot exceed star_radius."),
        star_radius: radius("Transited stellar radius in solar radii."),
        star_luminosity: positive("Unocculted stellar luminosity in solar luminosities."),
        companion_luminosity: number("Unocculted companion luminosity in solar luminosities.", 0, 1e100, 0)
      },
      ["planet_radius", "star_radius", "star_luminosity"]
    ),
    units: {
      planet_radius: "R_sun",
      star_radius: "R_sun",
      star_luminosity: "L_sun",
      companion_luminosity: "L_sun",
      remaining_luminosity: "L_sun",
      transit_depth_fraction: "dimensionless",
      transit_depth_percent: "%",
      blocked_area_fraction: "dimensionless",
      light_loss: "L_sun",
      total_luminosity_before: "L_sun"
    },
    assumptions: [
      "Both radii use solar units. The opaque dark planet must fit entirely within the stellar disk; planet_radius must not exceed star_radius.",
      "Assumes a uniformly bright stellar disk and full overlap; no limb darkening, grazing geometry, impact parameter or time-dependent light curve is modeled.",
      "remaining_luminosity is the remaining system light in L_sun, not transit depth. The lost fraction and percent use the total star-plus-companion luminosity before transit.",
      "Star and companion light must use the same band, or both be bolometric, at the same distance and with the same solar-luminosity normalization so their luminosity ratio represents the observed flux ratio.",
      "Companion light remains unocculted and dilutes the observed depth; blocked_area_fraction = (planet_radius/star_radius)^2."
    ],
    dependencies: [],
    example: { planet_radius: 0.1, star_radius: 1, star_luminosity: 20, companion_luminosity: 1 },
    source: source("luminosity", 161)
  },
  {
    name: "wavelength_shift_to_velocity",
    domain: "astronomy",
    group: "radial_velocity",
    description:
      "Convert a small signed wavelength shift to first-order radial velocity v = c delta_lambda / lambda_0.",
    keywords: ["Doppler", "radial velocity", "redshift", "blueshift", "多普勒", "径向速度", "红移", "蓝移"],
    parameters: parameters(
      {
        delta_lambda: number("Signed observed-minus-reference wavelength shift, in angstrom.", -1e100, 1e100),
        lambda_0: positive(
          "Positive rest/reference wavelength in angstrom; require abs(delta_lambda/lambda_0) <= 0.001."
        )
      },
      ["delta_lambda", "lambda_0"]
    ),
    units: { delta_lambda: "angstrom", lambda_0: "angstrom", result: "m/s" },
    assumptions: [
      "Uses the first-order nonrelativistic Doppler relation with c = 299792458 m/s; |delta_lambda/lambda_0| must not exceed 0.001.",
      "Positive shift means recession; negative shift means approach. Both wavelengths must use the same air/vacuum convention and reference frame.",
      "No relativistic, cosmological, gravitational or barycentric correction is applied; this approximation is not a precision radial-velocity pipeline."
    ],
    dependencies: [],
    example: { delta_lambda: 1, lambda_0: 5000 },
    source: source("orbital", 32)
  },
  {
    name: "kepler_third_law",
    domain: "astronomy",
    group: "orbital_period",
    description:
      "Calculate a Newtonian orbital period from semimajor axis in meters and dominant stellar mass in kilograms.",
    keywords: ["Kepler", "orbital period", "semimajor axis", "开普勒", "轨道周期", "半长轴", "公转"],
    parameters: parameters(
      {
        a: positive("Positive orbital semimajor axis in meters, not instantaneous separation."),
        M_star: positive("Positive dominant stellar mass in kilograms; companion mass is neglected.")
      },
      ["a", "M_star"]
    ),
    units: { a: "m", M_star: "kg", result: "s" },
    assumptions: [
      "Uses P = 2 pi sqrt(a^3/(G M_star)), G = 6.67430e-11 m^3/(kg s^2), in the negligible-companion-mass limit.",
      "Requires a bound Newtonian two-body orbit in a weak gravitational field; does not check collision, stellar size or relativistic validity.",
      "Numerical inputs are bounded to 1e-100 to 1e100; a representable period is required. These arithmetic bounds are not an astrophysical validity range."
    ],
    dependencies: [],
    example: { a: 149597870700, M_star: 1.988409870698051e30 },
    source: source("orbital", 147)
  },
  {
    name: "calculate_mass_ratio_from_rv",
    domain: "astronomy",
    group: "binary_mass_ratio",
    description:
      "Calculate binary mass ratio m1/m2 = k2/k1 from two positive radial-velocity semi-amplitudes.",
    keywords: [
      "binary",
      "mass ratio",
      "radial velocity",
      "semi amplitude",
      "双星",
      "质量比",
      "径向速度",
      "半振幅"
    ],
    parameters: parameters(
      {
        k1: positive("Positive radial-velocity semi-amplitude of component 1, in km/s."),
        k2: positive("Positive radial-velocity semi-amplitude of component 2, in km/s.")
      },
      ["k1", "k2"]
    ),
    units: { k1: "km/s", k2: "km/s", result: "dimensionless (m1/m2)" },
    assumptions: [
      "The result is explicitly m1/m2 = k2/k1, not the frequently used inverse convention q = m2/m1.",
      "Inputs are positive fitted radial-velocity semi-amplitudes of the same double-lined binary, not signed instantaneous velocities; their shared inclination cancels.",
      "Assumes the classical binary velocity interpretation; no absolute masses, inclination, orbital fit or relativistic corrections are inferred."
    ],
    dependencies: [],
    example: { k1: 10, k2: 5 },
    source: source("binary", 42)
  }
];
