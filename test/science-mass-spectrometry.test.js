import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const runner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const version = "sciagentgym-e9dbbea-mass-spec-v6";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-mass-spec-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    call(tool, args, catalogVersion = version) {
      const child = spawnSync(python, ["-I", "-B", "-S", runner], {
        cwd,
        input: JSON.stringify({ version: catalogVersion, tool, arguments: args }),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { LANG: "C.UTF-8" }
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(child.stderr, /Traceback \(most recent call last\)/);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      assert.doesNotMatch(child.stdout, /\b(?:NaN|Infinity)\b/);
      return JSON.parse(child.stdout);
    }
  };
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

function near(actual, expected, tolerance = 1e-12) {
  assert.equal(typeof actual, "number");
  assert.ok(
    Math.abs(actual - expected) <= tolerance * (Math.abs(expected) || 1),
    `${actual} differs from ${expected}`
  );
}

function cluster(science, extra = {}) {
  return science.call("find_isotope_cluster", {
    peak_mz: [100, 102, 104],
    peak_intensity: [100, 32, 10],
    base_mz: 100,
    ...extra
  });
}

test("centroid parsing normalizes raw intensities before inclusive filtering without identifying a molecular ion", (t) => {
  const science = fixture(t);
  const response = science.call("parse_mass_spectrum_peaks", {
    mz_values: [100, 150, 200, 250],
    intensities: [20, 200, 10, 0],
    intensity_threshold: 5
  });
  const result = success(response);
  assert.deepEqual(result.peaks, [
    { mz: 100, raw_intensity: 20, relative_intensity: 10 },
    { mz: 150, raw_intensity: 200, relative_intensity: 100 },
    { mz: 200, raw_intensity: 10, relative_intensity: 5 }
  ]);
  assert.deepEqual(result.base_peak, result.peaks[1]);
  assert.deepEqual(result.highest_mz_peak, result.peaks[2]);
  assert.equal(result.total_points, 4);
  assert.equal(result.filtered_peaks, 3);
  assert.equal(result.intensity_threshold, 5);
  assert.equal(Object.hasOwn(result, "molecular_ion"), false);
  assert.equal(response.units.mz, "Th (Da/e)");
  assert.equal(response.units.relative_intensity, "percent of base peak");
  assert.match(response.assumptions.join(" "), /already centroided/);
  const scaled = success(
    science.call("parse_mass_spectrum_peaks", {
      mz_values: [100, 150, 200],
      intensities: [1e99, 1e100, 5e98],
      intensity_threshold: 10
    })
  );
  assert.deepEqual(
    scaled.peaks.map(({ mz, relative_intensity }) => [mz, relative_intensity]),
    [
      [100, 10],
      [150, 100]
    ]
  );
  const ties = success(
    science.call("parse_mass_spectrum_peaks", {
      mz_values: [10, 20, 30],
      intensities: [5, 5, 0],
      intensity_threshold: 0
    })
  );
  assert.equal(ties.base_peak.mz, 10);
  assert.equal(ties.highest_mz_peak.mz, 30);
  assert.equal(ties.highest_mz_peak.relative_intensity, 0);
  const smallest = success(
    science.call("parse_mass_spectrum_peaks", { mz_values: [1e-100], intensities: [1] })
  );
  assert.equal(smallest.base_peak.mz, 1e-100);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("centroid input and output budgets fail explicitly instead of truncating", (t) => {
  const science = fixture(t);
  const mz = Array.from({ length: 8192 }, (_, index) => index + 1);
  const intensities = mz.map((_, index) => (index === 4096 ? 10 : 0));
  const large = success(science.call("parse_mass_spectrum_peaks", { mz_values: mz, intensities }));
  assert.equal(large.total_points, 8192);
  assert.deepEqual(large.peaks, [{ mz: 4097, raw_intensity: 10, relative_intensity: 100 }]);
  const edge = success(
    science.call("parse_mass_spectrum_peaks", {
      mz_values: mz.slice(0, 1024),
      intensities: Array(1024).fill(1)
    })
  );
  assert.equal(edge.filtered_peaks, 1024);
  failure(
    science.call("parse_mass_spectrum_peaks", {
      mz_values: mz.slice(0, 1025),
      intensities: Array(1025).fill(1)
    }),
    "result_too_large"
  );
  failure(
    science.call("parse_mass_spectrum_peaks", {
      mz_values: [...mz, 8193],
      intensities: [...intensities, 1]
    })
  );
  assert.equal(
    success(science.call("parse_mass_spectrum_peaks", { mz_values: [1], intensities: [1] })).filtered_peaks,
    1
  );
});

test("chlorine binomial patterns preserve probabilities and distinguish the all-light M bin from the base peak", (t) => {
  const science = fixture(t);
  const response = science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 2 });
  const result = success(response);
  assert.equal(result.num_carbon, 0);
  assert.equal(result.num_chlorine, 2);
  assert.equal(result.model, "independent_cl_c_binomial_nominal_mass");
  assert.deepEqual(result.abundances, { Cl35: 0.7576, Cl37: 0.2424, C12: 0.9893, C13: 0.0107 });
  assert.deepEqual(
    result.peaks.map((peak) => peak.mass_shift),
    [0, 1, 2, 3, 4]
  );
  for (const [index, expected] of [0.57395776, 0, 0.36728448, 0, 0.05875776].entries()) {
    near(result.peaks[index].probability, expected);
  }
  near(result.peaks[0].relative_intensity, 100);
  near(result.M_plus_2_ratio, 0.6399155227032735);
  assert.equal(response.units.mass_shift, "nominal mass-number difference");
  const five = success(science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 5 }));
  near(five.peaks[2].relative_intensity, 100);
  assert.ok(five.peaks[0].relative_intensity < 100);
  near(five.M_plus_2_ratio, 1.5997888067581836);
  const zero = success(science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 0 }));
  assert.deepEqual(zero.peaks, [{ mass_shift: 0, probability: 1, relative_intensity: 100 }]);
  assert.equal(zero.M_plus_2_ratio, 0);
  assert.match(response.assumptions.join(" "), /not an exact mass/);
});

test("carbon and chlorine contribute to shared nominal bins with full precision and finite unpruned tails", (t) => {
  const science = fixture(t);
  const carbon = success(
    science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 0, num_carbon: 2 })
  );
  for (const [index, expected] of [0.97871449, 0.02117102, 0.00011449].entries()) {
    near(carbon.peaks[index].probability, expected);
  }
  near(carbon.M_plus_2_ratio, 0.00011697997850220855);
  const combined = success(
    science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 1, num_carbon: 2 })
  );
  const expected = [0.741474097624, 0.016039164752, 0.23732713, 0.005131855248, 0.000027752376];
  for (const [index, probability] of expected.entries()) near(combined.peaks[index].probability, probability);
  near(combined.M_plus_2_ratio, 0.3200747413301389);
  assert.ok(combined.M_plus_2_ratio > 0.3199577613516367);
  const bounded = success(
    science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 16, num_carbon: 128 })
  );
  assert.equal(bounded.peaks.length, 161);
  assert.equal(bounded.peaks.at(-1).mass_shift, 160);
  assert.ok(bounded.peaks.every((peak) => peak.probability > 0 && Number.isFinite(peak.relative_intensity)));
  near(
    bounded.peaks.reduce((sum, peak) => sum + peak.probability, 0),
    1
  );
  near(Math.max(...bounded.peaks.map((peak) => peak.relative_intensity)), 100);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("isotope candidates anchor later windows to observed M and use only the supplied absolute charge", (t) => {
  const science = fixture(t);
  const response = cluster(science, {
    peak_mz: [100.02, 101.025, 102.01, 103.02],
    peak_intensity: [100, 32, 10, 2],
    abs_charge: 2
  });
  const result = success(response);
  assert.equal(result.requested_mz, 100);
  assert.equal(result.M_mz, 100.02);
  assert.equal(result.abs_charge, 2);
  assert.equal(result.nominal_spacing, 1);
  assert.deepEqual(result.missing_labels, []);
  assert.deepEqual(
    result.cluster.map((peak) => peak.label),
    ["M", "M+2", "M+4", "M+6"]
  );
  near(result.cluster[0].delta_mz, 0.02, 1e-10);
  near(result.cluster[1].expected_mz, 101.02);
  near(result.cluster[1].delta_mz, 0.005, 1e-10);
  near(result.cluster[2].expected_mz, 102.02);
  near(result.cluster[2].delta_mz, -0.01, 1e-10);
  near(result.M_plus_2_mz, 101.025);
  near(result.M_plus_2_ratio, 0.32);
  assert.equal(response.units.nominal_spacing, "Th (Da/e)");
  assert.match(response.assumptions.join(" "), /does not infer charge/);
  assert.equal(Object.hasOwn(result, "num_chlorine"), false);
  const ten = success(
    cluster(science, {
      peak_mz: [100, 100.2, 100.4, 100.6],
      peak_intensity: [100, 32, 10, 1],
      abs_charge: 10,
      mass_tolerance: 0.01
    })
  );
  assert.equal(ten.cluster.length, 4);
  near(ten.nominal_spacing, 0.2);
  const chlorineMassDifference = success(
    cluster(science, { peak_mz: [100, 101.99704992], peak_intensity: [100, 32] })
  );
  near(chlorineMassDifference.M_plus_2_ratio, 0.32);
  near(chlorineMassDifference.cluster[1].delta_mz, -0.00295008, 1e-10);
});

test("missing centroids and zero denominator produce null ratios while inclusive windows preserve boundary peaks", (t) => {
  const science = fixture(t);
  const missingM = success(cluster(science, { base_mz: 99 }));
  assert.equal(missingM.M_mz, null);
  assert.equal(missingM.M_plus_2_mz, null);
  assert.equal(missingM.M_plus_2_ratio, null);
  assert.deepEqual(missingM.cluster, []);
  assert.deepEqual(missingM.missing_labels, ["M", "M+2", "M+4", "M+6"]);
  const missingPlusTwo = success(cluster(science, { peak_mz: [100, 104], peak_intensity: [100, 10] }));
  assert.equal(missingPlusTwo.M_plus_2_ratio, null);
  assert.equal(missingPlusTwo.M_plus_2_mz, null);
  assert.deepEqual(missingPlusTwo.missing_labels, ["M+2", "M+6"]);
  const zeroM = success(cluster(science, { peak_mz: [100, 102], peak_intensity: [0, 32] }));
  assert.equal(zeroM.M_plus_2_ratio, null);
  assert.equal(zeroM.M_plus_2_mz, 102);
  const zeroPlusTwo = success(cluster(science, { peak_mz: [100, 102], peak_intensity: [100, 0] }));
  assert.equal(zeroPlusTwo.M_plus_2_ratio, 0);
  const boundary = success(
    cluster(science, { peak_mz: [100.125, 102.25], peak_intensity: [100, 32], mass_tolerance: 0.125 })
  );
  assert.deepEqual(
    boundary.cluster.map((peak) => peak.mz),
    [100.125, 102.25]
  );
  assert.equal(boundary.cluster[0].delta_mz, 0.125);
  assert.equal(boundary.cluster[1].expected_mz, 102.125);
  assert.equal(boundary.cluster[1].delta_mz, 0.125);
  const smallest = success(cluster(science, { peak_mz: [1e-100], peak_intensity: [1], base_mz: 1e-100 }));
  assert.equal(smallest.M_mz, 1e-100);
});

test("ambiguous windows and unrepresentable positive intensity ratios are rejected without silent guesses or zeros", (t) => {
  const science = fixture(t);
  failure(
    cluster(science, { peak_mz: [99.99, 100.01, 102], peak_intensity: [10, 100, 32] }),
    "ambiguous_match"
  );
  failure(
    cluster(science, { peak_mz: [100, 101.99, 102.01], peak_intensity: [100, 1, 32] }),
    "ambiguous_match"
  );
  failure(
    cluster(science, { peak_mz: [100, 102, 103.99, 104.01], peak_intensity: [100, 32, 1, 10] }),
    "ambiguous_match"
  );
  // The supplied peaks do not magically establish which one is an isotopologue.
  const narrower = success(
    cluster(science, { peak_mz: [100, 101.99, 102.01], peak_intensity: [100, 1, 32], mass_tolerance: 0.005 })
  );
  assert.equal(narrower.M_plus_2_ratio, null);
  failure(cluster(science, { peak_mz: [100, 102], peak_intensity: [5e-324, 1e100] }), "numeric_range");
  failure(cluster(science, { peak_mz: [100, 102], peak_intensity: [1e100, 5e-324] }), "numeric_range");
  const rescued = success(
    science.call("parse_mass_spectrum_peaks", {
      mz_values: [100, 102],
      intensities: [5e-324, 100],
      intensity_threshold: 0
    })
  );
  assert.equal(rescued.peaks[0].raw_intensity, 5e-324);
  assert.equal(rescued.peaks[0].relative_intensity, 5e-324);
  failure(
    science.call("parse_mass_spectrum_peaks", {
      mz_values: [100, 102],
      intensities: [5e-324, 1e100],
      intensity_threshold: 0
    }),
    "numeric_range"
  );
  near(success(cluster(science)).M_plus_2_ratio, 0.32);
});

test("mass-spectrum kernels reject malformed spectra, unsupported counts and numeric arguments then recover", (t) => {
  const science = fixture(t);
  const parseArgs = { mz_values: [100, 102], intensities: [100, 32] };
  const invalid = [
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [100] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [102, 100] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [100, 100] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [0, 102] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [1e-101, 102] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [100, 1e6 + 1] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, mz_values: [true, 102] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, intensities: [0, 0] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, intensities: [-1, 32] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, intensities: [1e101, 32] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, intensities: [true, 32] }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, intensity_threshold: -1 }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, intensity_threshold: 101 }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, intensity_threshold: true }],
    ["parse_mass_spectrum_peaks", { ...parseArgs, profile: true }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: -1 }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 17 }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: true }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 1.5 }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 1, num_carbon: 129 }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 1, num_carbon: -1 }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 1, num_carbon: true }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 1, num_carbon: 0.5 }],
    ["calculate_theoretical_isotope_pattern", { num_chlorine: 1, isotope_abundance: 0.5 }]
  ];
  for (const [tool, args] of invalid) failure(science.call(tool, args));
  for (const extra of [
    { peak_mz: [100, 100, 104] },
    { peak_intensity: [0, 0, 0] },
    { base_mz: 0 },
    { base_mz: 1e-101 },
    { base_mz: 1e6 + 1 },
    { base_mz: true },
    { mass_tolerance: 0 },
    { mass_tolerance: 0.25001 },
    { mass_tolerance: 0.05, abs_charge: 10 },
    { abs_charge: 0 },
    { abs_charge: 11 },
    { abs_charge: 1.5 },
    { abs_charge: true },
    { infer_charge: true }
  ])
    failure(cluster(science, extra));
  const recovered = success(science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 1 }));
  near(recovered.M_plus_2_ratio, 0.3199577613516367);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("v6 stdlib tools work with site packages disabled while every older version rejects their names", (t) => {
  const science = fixture(t);
  for (const old of [
    "sciagentgym-e9dbbea-pilot-v1",
    "sciagentgym-e9dbbea-analysis-v2",
    "sciagentgym-e9dbbea-astronomy-v3",
    "atria-rdkit-chemistry-v4",
    "sciagentgym-e9dbbea-materials-v5"
  ]) {
    failure(science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 1 }, old), "unknown_tool");
  }
  failure(science.call("rdkit_exact_mass_and_formula", { smiles: "CCO" }), "dependency_unavailable");
  near(success(science.call("eV_to_nm", { energy_eV: 2 })), 619.9209921660013);
  near(success(science.call("bragg_law_d_spacing", { two_theta: 60 })), 1.5406);
  near(success(science.call("distance_from_modulus", { mu: 10 })), 1000);
  near(success(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1, 1] })), Math.sqrt(12));
  near(
    success(science.call("calculate_theoretical_isotope_pattern", { num_chlorine: 2 })).M_plus_2_ratio,
    0.6399155227032735
  );
});
