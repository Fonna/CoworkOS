import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const runner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const version = "sciagentgym-e9dbbea-pilot-v1";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-kernels-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function raw(input, { noSite = true } = {}) {
    const child = spawnSync(python, ["-I", "-B", ...(noSite ? ["-S"] : []), runner], {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH || "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
      }
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stderr, /Traceback \(most recent call last\)/);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    const response = JSON.parse(child.stdout);
    assert.equal(typeof response.ok, "boolean");
    assert.ok(!/\b(?:NaN|Infinity)\b/.test(child.stdout));
    return response;
  }
  return {
    cwd,
    raw,
    call(tool, args, options) {
      return raw(JSON.stringify({ version, tool, arguments: args }), options);
    }
  };
}

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`
  );
}

function success(response, units) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.units, units);
  assert.ok(response.assumptions.length > 0);
  return response.result;
}

function failure(response, code) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, code);
  assert.ok(response.error.message.length > 0);
}

test("scientific scalar pilot runs all 11 formulas in real Python without site packages", (t) => {
  const science = fixture(t);
  const cases = [
    ["eV_to_nm", { energy_eV: 2 }, 619.9209921660013, "nm"],
    ["nm_to_eV", { wavelength_nm: 500 }, 2.479683968664005, "eV"],
    ["ideal_gas_state", { P: 101325, V: 0.024465403697038124 }, 298.15, "K"],
    ["isothermal_process", { V: 0.01, T: 300, n: 2, R: 8.314 }, 498840, "Pa"],
    ["isobaric_process", { V: 0.01, P: 100000, R: 8.314 }, 120.27904738994467, "K"],
    [
      "clausius_clapeyron_pressure",
      { P1: 100000, T1: 300, T2: 600, delta_H_vap: 2494.2 },
      164872.12707001282,
      "Pa"
    ],
    [
      "clausius_clapeyron_temperature",
      { P1: 100000, T1: 300, P2: 164872.12707001282, delta_H_vap: 2494.2 },
      600,
      "K"
    ],
    ["convert_spl_to_pressure", { spl_db: 100 }, 2, "Pa RMS"],
    ["convert_pressure_to_spl", { pressure_pa: 2 }, 100, "dB SPL"],
    ["add_two_spl_values", { spl1_db: 60, spl2_db: 60 }, 63.01029995663981, "dB SPL"],
    ["calculate_spl_at_distance", { source_spl: 90, source_distance: 1, target_distance: 10 }, 70, "dB SPL"]
  ];
  for (const [tool, args, expected, units] of cases) near(success(science.call(tool, args), units), expected);
  assert.deepEqual(readdirSync(science.cwd), [], "Calculations leave no files in the call directory");
});

test("scientific defaults and units support an actual two-call ideal-gas task", (t) => {
  const science = fixture(t);
  const temperature = success(science.call("ideal_gas_state", { P: 101325, V: 0.024465403697038124 }), "K");
  near(
    success(science.call("isothermal_process", { T: temperature, V: 0.04893080739407625 }), "Pa"),
    50662.5
  );
  near(success(science.call("isobaric_process", { P: 101325, V: 0.024465403697038124 }), "K"), temperature);
  near(success(science.call("ideal_gas_state", { P: 100, V: 3, n: 2, R: 5 }), "K"), 30);
  near(
    success(
      science.call("clausius_clapeyron_temperature", { P1: 1, T1: 100, P2: Math.E, delta_H_vap: 300, R: 1 }),
      "K"
    ),
    150
  );
});

test("sound kernels handle extreme bounded levels without exponential overflow or underflow", (t) => {
  const science = fixture(t);
  near(
    success(science.call("add_two_spl_values", { spl1_db: -1000, spl2_db: -1000 }), "dB SPL"),
    -996.9897000433602
  );
  near(success(science.call("add_two_spl_values", { spl1_db: 1000, spl2_db: -1000 }), "dB SPL"), 1000);
  const pressure = success(science.call("convert_spl_to_pressure", { spl_db: -1000 }), "Pa RMS");
  assert.ok(pressure > 0 && Number.isFinite(pressure));
  near(success(science.call("convert_pressure_to_spl", { pressure_pa: pressure }), "dB SPL"), -1000);
});

test("scientific runner rejects unsupported protocols, arbitrary paths, expressions and duplicate keys", (t) => {
  const science = fixture(t);
  failure(science.raw("not JSON"), "invalid_request");
  failure(science.raw('{"version":"x","version":"y"}'), "invalid_request");
  failure(science.raw("{}\n{}"), "invalid_request");
  failure(
    science.raw(JSON.stringify({ version: "old", tool: "eV_to_nm", arguments: { energy_eV: 1 } })),
    "version_mismatch"
  );
  failure(
    science.raw(JSON.stringify({ version, tool: "eV_to_nm", arguments: {}, path: "pilot.py" })),
    "invalid_request"
  );
  failure(science.call("../pilot.py", {}), "unknown_tool");
  failure(science.call("eval", { expression: "1+1" }), "unknown_tool");
  failure(science.call("eV_to_nm", { energy_eV: "1+1" }), "invalid_arguments");
  failure(science.call("eV_to_nm", { energy_eV: 1, extra: true }), "invalid_arguments");
  failure(science.call("eV_to_nm", {}), "invalid_arguments");
  failure(science.raw(JSON.stringify({ version, tool: "eV_to_nm", arguments: [] })), "invalid_arguments");
  failure(science.raw(" ".repeat(1048577)), "invalid_request");
});

test("scientific numeric and model domains fail explicitly with strict finite JSON", (t) => {
  const science = fixture(t);
  const invalid = [
    ["eV_to_nm", { energy_eV: 0 }],
    ["nm_to_eV", { wavelength_nm: -1 }],
    ["ideal_gas_state", { P: true, V: 1 }],
    ["ideal_gas_state", { P: 1, V: 1, n: 0 }],
    ["isothermal_process", { V: 1, T: 0 }],
    ["isobaric_process", { P: 1, V: [] }],
    ["clausius_clapeyron_pressure", { P1: 1, T1: 300, T2: 400, delta_H_vap: -1 }],
    ["convert_pressure_to_spl", { pressure_pa: 0 }],
    ["convert_spl_to_pressure", { spl_db: 1001 }],
    ["add_two_spl_values", { spl1_db: 1, spl2_db: 2, use_table: true }],
    [
      "calculate_spl_at_distance",
      { source_spl: 1, source_distance: 1, target_distance: 2, environment: "diffuse_field" }
    ],
    ["calculate_spl_at_distance", { source_spl: 1, source_distance: 0, target_distance: 2 }]
  ];
  for (const [tool, args] of invalid) failure(science.call(tool, args), "invalid_arguments");
  failure(
    science.raw(`{"version":"${version}","tool":"eV_to_nm","arguments":{"energy_eV":NaN}}`),
    "invalid_request"
  );
  failure(
    science.raw(`{"version":"${version}","tool":"eV_to_nm","arguments":{"energy_eV":1e999}}`),
    "invalid_arguments"
  );
  failure(science.call("ideal_gas_state", { P: 1e100, V: 1e100, n: 1e-100, R: 1e-100 }), "numeric_range");
  failure(
    science.call("clausius_clapeyron_temperature", { P1: 1, T1: 300, P2: 100, delta_H_vap: 1 }),
    "numeric_range"
  );
  failure(
    science.call("clausius_clapeyron_pressure", { P1: 1, T1: 1, T2: 100, delta_H_vap: 1e100 }),
    "numeric_range"
  );
});

test("spectrum inputs are bounded and checked before loading optional dependencies", (t) => {
  const science = fixture(t);
  for (const args of [
    { wavelengths: [400, 500], intensities: [1, 2] },
    { wavelengths: [400, 400, 500], intensities: [0, 1, 0] },
    { wavelengths: [400, 500, 600], intensities: [0, 0, 0] },
    { wavelengths: [400, 500, 600], intensities: [0, -1, 0] },
    { wavelengths: [400, 500, 600], intensities: [0, 1, 0], prominence: 2 },
    { wavelengths: [400, 500, 600], intensities: [0, 1, 0], width: -1 },
    { wavelengths: Array.from({ length: 8193 }, (_, i) => i + 1), intensities: Array(8193).fill(1) }
  ])
    failure(science.call("analyze_spectrum", args), "invalid_arguments");
  failure(
    science.call("analyze_spectrum", { wavelengths: [400, 500, 600], intensities: [0, 1, 0] }),
    "dependency_unavailable"
  );
});

test("spectrum uses real SciPy peaks, normalized heights and explicit absent widths", (t) => {
  const science = fixture(t);
  const args = { wavelengths: [400, 450, 500, 550, 600], intensities: [0, 2, 0, 1, 0] };
  const response = science.call("analyze_spectrum", args, { noSite: false });
  if (response.ok === false && response.error.code === "dependency_unavailable") {
    t.skip(
      "Configured Python has no NumPy/SciPy; set COWORK_SCIENCE_TEST_PYTHON to the scientific environment for this acceptance check"
    );
    return;
  }
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(response.result, {
    peak_indices: [1, 3],
    peak_wavelengths: [450, 550],
    peak_intensities: [1, 0.5],
    peak_widths: null,
    peak_prominences: [1, 0.5]
  });
  const withWidths = science.call("analyze_spectrum", { ...args, width: 0.5 }, { noSite: false });
  assert.equal(withWidths.ok, true, JSON.stringify(withWidths));
  assert.deepEqual(withWidths.result.peak_widths, [1, 1]);
  const many = Array.from({ length: 8192 }, (_, i) => i % 2);
  failure(
    science.call(
      "analyze_spectrum",
      { wavelengths: many.map((_, i) => i + 1), intensities: many },
      { noSite: false }
    ),
    "too_many_peaks"
  );
  assert.deepEqual(readdirSync(science.cwd), []);
});
