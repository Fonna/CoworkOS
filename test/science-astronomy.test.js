import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const runner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const version = "sciagentgym-e9dbbea-astronomy-v3";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-astronomy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    request(input) {
      const child = spawnSync(python, ["-I", "-B", "-S", runner], {
        cwd,
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: { LANG: "C.UTF-8" }
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(child.stderr, /Traceback \(most recent call last\)/);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      assert.doesNotMatch(child.stdout, /\b(?:NaN|Infinity)\b/);
      return JSON.parse(child.stdout);
    },
    call(tool, args, catalogVersion = version) {
      return this.request({ version: catalogVersion, tool, arguments: args });
    }
  };
}

function near(actual, expected, tolerance = 1e-12) {
  assert.equal(typeof actual, "number");
  const scale = Math.abs(expected) || 1;
  assert.ok(Math.abs(actual - expected) <= tolerance * scale, `${actual} differs from ${expected}`);
}

function success(response) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.assumptions.length > 0);
  return response.result;
}

function failure(response, code = "invalid_arguments") {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, code);
}

test("offline stellar photometry corrects V-band extinction before distance inversion", (t) => {
  const science = fixture(t);
  const extinction = science.call("calculate_extinction", { e_bv: 0.2 });
  near(success(extinction), 0.62);
  assert.equal(extinction.units, "mag");
  near(success(science.call("calculate_extinction", { e_bv: 0 })), 0);
  near(success(science.call("calculate_extinction", { e_bv: 0.2, rv: 5 })), 1);
  const modulus = science.call("calculate_distance_modulus", { m_obs: 7, M_abs: 8, a_v: extinction.result });
  near(success(modulus), -1.62);
  assert.equal(modulus.units, "mag");
  const distance = science.call("distance_from_modulus", { mu: modulus.result });
  near(success(distance), 4.742419852602448);
  assert.equal(distance.units, "pc");
  near(success(science.call("calculate_distance_modulus", { m_obs: 8, M_abs: 8 })), 0);
  for (const [mu, pc] of [
    [-10, 0.1],
    [-5, 1],
    [0, 10],
    [10, 1000],
    [30, 10000000]
  ]) {
    near(success(science.call("distance_from_modulus", { mu })), pc);
  }
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("stellar luminosity uses effective temperature and fixed nominal solar conversions", (t) => {
  const science = fixture(t);
  const response = science.call("calculate_stellar_luminosity", { radius: 1, temperature: 5772 });
  const solar = success(response);
  near(solar.luminosity_watts, 3.827990903152591e26);
  near(solar.luminosity_solar, 0.999997623603102);
  assert.equal(solar.radius_meters, 695700000);
  assert.equal(solar.temperature_K, 5772);
  assert.deepEqual(response.units, {
    luminosity_solar: "nominal solar luminosity",
    luminosity_watts: "W",
    radius_meters: "m",
    temperature_K: "K"
  });
  const doubledRadius = success(
    science.call("calculate_stellar_luminosity", { radius: 2, temperature: 5772, radius_unit: "solar" })
  );
  const doubledTemperature = success(
    science.call("calculate_stellar_luminosity", { radius: 1, temperature: 11544 })
  );
  near(doubledRadius.luminosity_solar / solar.luminosity_solar, 4);
  near(doubledTemperature.luminosity_solar / solar.luminosity_solar, 16);
  near(
    success(science.call("calculate_stellar_luminosity", { radius: 1, temperature: 6000 })).luminosity_solar,
    1.1676123496165691
  );
  assert.match(response.assumptions.join(" "), /effective temperature/);
});

test("ideal transit reports diluted depth separately from remaining system luminosity", (t) => {
  const science = fixture(t);
  const response = science.call("calculate_transit_depth", {
    planet_radius: 0.1,
    star_radius: 1,
    star_luminosity: 20,
    companion_luminosity: 1
  });
  const transit = success(response);
  near(transit.remaining_luminosity, 20.8);
  near(transit.blocked_area_fraction, 0.01);
  near(transit.light_loss, 0.2);
  near(transit.total_luminosity_before, 21);
  near(transit.transit_depth_fraction, 0.009523809523809525);
  near(transit.transit_depth_percent, 0.9523809523809526);
  assert.equal(response.units.remaining_luminosity, "nominal solar luminosity");
  assert.equal(response.units.transit_depth_fraction, "dimensionless");
  assert.equal(response.units.transit_depth_percent, "%");
  const isolated = success(
    science.call("calculate_transit_depth", { planet_radius: 0.1, star_radius: 1, star_luminosity: 1 })
  );
  near(isolated.remaining_luminosity, 0.99);
  near(isolated.transit_depth_fraction, 0.01);
  const total = success(
    science.call("calculate_transit_depth", {
      planet_radius: 1,
      star_radius: 1,
      star_luminosity: 1,
      companion_luminosity: 2
    })
  );
  near(total.remaining_luminosity, 2);
  near(total.transit_depth_fraction, 1 / 3);
  assert.match(response.assumptions.join(" "), /no limb darkening/);
});

test("Doppler conversion preserves red/blue signs within its explicit low-shift range", (t) => {
  const science = fixture(t);
  const receding = science.call("wavelength_shift_to_velocity", { delta_lambda: 5, lambda_0: 5000 });
  near(success(receding), 299792.458);
  assert.equal(receding.units, "m/s");
  near(
    success(science.call("wavelength_shift_to_velocity", { delta_lambda: -5, lambda_0: 5000 })),
    -299792.458
  );
  near(success(science.call("wavelength_shift_to_velocity", { delta_lambda: 0, lambda_0: 5000 })), 0);
  near(
    success(science.call("wavelength_shift_to_velocity", { delta_lambda: 0.005, lambda_0: 5000 })),
    299.792458
  );
  // A ratio computed before angstrom-to-meter conversion stays representable at these limits.
  near(
    success(science.call("wavelength_shift_to_velocity", { delta_lambda: 1e-100, lambda_0: 1e100 })),
    2.99792458e-192
  );
  failure(science.call("wavelength_shift_to_velocity", { delta_lambda: 5.000001, lambda_0: 5000 }));
  failure(science.call("wavelength_shift_to_velocity", { delta_lambda: -5.000001, lambda_0: 5000 }));
  assert.match(receding.assumptions.join(" "), /positive velocity receding/);
});

test("Kepler period and binary mass ratio preserve the documented units and mass ordering", (t) => {
  const science = fixture(t);
  const earth = science.call("kepler_third_law", { a: 149597870700, M_star: 1.988409870698051e30 });
  near(success(earth), 31558196.02038122);
  assert.equal(earth.units, "s");
  const largeOrbit = success(
    science.call("kepler_third_law", { a: 598391482800, M_star: 1.988409870698051e30 })
  );
  near(largeOrbit / earth.result, 8);
  const massiveStar = success(
    science.call("kepler_third_law", { a: 149597870700, M_star: 7.953639482792204e30 })
  );
  near(massiveStar / earth.result, 0.5);
  assert.ok(Number.isFinite(success(science.call("kepler_third_law", { a: 1e100, M_star: 1e-100 }))));
  assert.ok(success(science.call("kepler_third_law", { a: 1e-100, M_star: 1e100 })) > 0);
  const binary = science.call("calculate_mass_ratio_from_rv", { k1: 30, k2: 60 });
  near(success(binary), 2);
  assert.equal(binary.units, "dimensionless");
  near(success(science.call("calculate_mass_ratio_from_rv", { k1: 10, k2: 5 })), 0.5);
  near(success(science.call("calculate_mass_ratio_from_rv", { k1: 1e100, k2: 1e-100 })), 1e-200);
  assert.match(binary.assumptions.join(" "), /m1\/m2 = k2\/k1/);
  assert.match(binary.assumptions.join(" "), /semiamplitudes/);
});

test("astronomy rejects unsupported types, domains, variants and request fields then recovers", (t) => {
  const science = fixture(t);
  const invalid = [
    ["calculate_extinction", { e_bv: -0.1 }],
    ["calculate_extinction", { e_bv: 5.01 }],
    ["calculate_extinction", { e_bv: 0.1, rv: 0 }],
    ["calculate_extinction", { e_bv: 0.1, rv: 10.01 }],
    ["calculate_extinction", { e_bv: true }],
    ["calculate_distance_modulus", { m_obs: 101, M_abs: 0 }],
    ["calculate_distance_modulus", { m_obs: 10, M_abs: -101 }],
    ["calculate_distance_modulus", { m_obs: 10, M_abs: 5, a_v: -1 }],
    ["distance_from_modulus", { mu: -10.01 }],
    ["distance_from_modulus", { mu: 30.01 }],
    ["distance_from_modulus", { mu: "10" }],
    ["distance_from_modulus", { mu: null }],
    ["distance_from_modulus", { mu: 10, file: "unused" }],
    ["distance_from_modulus", {}],
    ["calculate_stellar_luminosity", { radius: 0, temperature: 5772 }],
    ["calculate_stellar_luminosity", { radius: 1, temperature: 1999 }],
    ["calculate_stellar_luminosity", { radius: 1, temperature: 50001 }],
    ["calculate_stellar_luminosity", { radius: 1, temperature: 5772, radius_unit: "meters" }],
    ["calculate_transit_depth", { planet_radius: 2, star_radius: 1, star_luminosity: 1 }],
    ["calculate_transit_depth", { planet_radius: 0.1, star_radius: 1, star_luminosity: 0 }],
    [
      "calculate_transit_depth",
      { planet_radius: 0.1, star_radius: 1, star_luminosity: 1, companion_luminosity: -1 }
    ],
    ["wavelength_shift_to_velocity", { delta_lambda: 0, lambda_0: 0 }],
    ["wavelength_shift_to_velocity", { delta_lambda: 1, lambda_0: 0.001 }],
    ["kepler_third_law", { a: 0, M_star: 1 }],
    ["kepler_third_law", { a: 1, M_star: -1 }],
    ["kepler_third_law", { a: 1e101, M_star: 1 }],
    ["calculate_mass_ratio_from_rv", { k1: 0, k2: 1 }],
    ["calculate_mass_ratio_from_rv", { k1: 1, k2: -1 }]
  ];
  for (const [name, args] of invalid) failure(science.call(name, args));
  failure(science.call("distance_from_modulus", []));
  failure(science.call("fetch_exoplanet_data", { planet_name: "anything" }), "unknown_tool");
  failure(
    science.request({ version, tool: "distance_from_modulus", arguments: { mu: 10 }, extra: true }),
    "invalid_request"
  );
  failure(science.call("distance_from_modulus", { mu: 10 }, "unrecognized-version"), "version_mismatch");
  near(success(science.call("distance_from_modulus", { mu: 10 })), 1000);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("v1/v2 stay closed while the v3 catalog retains earlier scalar implementations", (t) => {
  const science = fixture(t);
  for (const oldVersion of ["sciagentgym-e9dbbea-pilot-v1", "sciagentgym-e9dbbea-analysis-v2"]) {
    failure(science.call("distance_from_modulus", { mu: 10 }, oldVersion), "unknown_tool");
  }
  near(success(science.call("eV_to_nm", { energy_eV: 2 })), 619.9209921660013);
  near(success(science.call("bragg_law_d_spacing", { two_theta: 60 })), 1.5406);
  assert.deepEqual(readdirSync(science.cwd), []);
});
