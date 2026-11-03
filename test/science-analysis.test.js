import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const runner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const version = "sciagentgym-e9dbbea-analysis-v2";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-analysis-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    call(tool, args, { noSite = false, catalogVersion = version } = {}) {
      const process = spawnSync(python, ["-I", "-B", ...(noSite ? ["-S"] : []), runner], {
        cwd,
        input: JSON.stringify({ version: catalogVersion, tool, arguments: args }),
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        env: { LANG: "C.UTF-8", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" }
      });
      assert.ifError(process.error);
      assert.equal(process.status, 0, process.stderr);
      assert.doesNotMatch(process.stderr, /Traceback \(most recent call last\)/);
      assert.equal(process.stdout.trim().split("\n").length, 1);
      assert.doesNotMatch(process.stdout, /\b(?:NaN|Infinity)\b/);
      return JSON.parse(process.stdout);
    }
  };
}

function near(actual, expected, tolerance = 1e-11) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`
  );
}

function nearArray(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) near(actual[index], expected[index]);
}

function success(response) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.assumptions.length > 0);
  return response.result;
}

function failure(response, code) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, code);
}

function numpy(t, science) {
  const response = science.call("baseline_correction", { spectrum: [1, 2, 3], degree: 1 });
  if (!response.ok && response.error.code === "dependency_unavailable") {
    t.skip("NumPy unavailable; set COWORK_SCIENCE_TEST_PYTHON to the pinned scientific environment");
    return false;
  }
  success(response);
  return true;
}

test("analysis Bragg and corrected Nernst run without optional site packages", (t) => {
  const science = fixture(t);
  const bragg = science.call("bragg_law_d_spacing", { two_theta: 60 }, { noSite: true });
  near(success(bragg), 1.5406);
  assert.equal(bragg.units, "angstrom");
  near(success(science.call("bragg_law_d_spacing", { two_theta: 60, wavelength: 2 }, { noSite: true })), 2);
  near(success(science.call("nernst_potential", { E0: 0.34, n: 2, a_oxidized: 1 }, { noSite: true })), 0.34);
  const increased = science.call("nernst_potential", { E0: 0, n: 1, a_oxidized: 10 }, { noSite: true });
  near(success(increased), 0.05915934968681185);
  assert.equal(increased.units, "V");
  assert.match(increased.assumptions.join(" "), /Reduction Ox/);
  near(
    success(science.call("nernst_potential", { E0: 0, n: 2, a_oxidized: 0.01 }, { noSite: true })),
    -0.05915934968681185
  );
  near(
    success(
      science.call(
        "nernst_potential",
        { E0: -0.2, n: 1, a_oxidized: 1, a_reduced: 10, T: 596.3 },
        { noSite: true }
      )
    ),
    -0.3183186993736237
  );
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("polynomial baseline returns the fitted baseline and corrected data without side effects", (t) => {
  const science = fixture(t);
  if (!numpy(t, science)) return;
  const line = success(science.call("baseline_correction", { spectrum: [3, 5, 7, 9, 11], degree: 1 }));
  nearArray(line.baseline, [3, 5, 7, 9, 11]);
  nearArray(line.corrected, [0, 0, 0, 0, 0]);
  const constant = success(science.call("baseline_correction", { spectrum: [1, 2, 6], degree: 0 }));
  nearArray(constant.baseline, [3, 3, 3]);
  nearArray(constant.corrected, [-2, -1, 3]);
  nearArray(
    success(science.call("baseline_correction", { spectrum: [1, 4, 9, 16, 25], degree: 2 })).corrected,
    [0, 0, 0, 0, 0]
  );
  nearArray(success(science.call("baseline_correction", { spectrum: [0, 0, 0, 0] })).corrected, [0, 0, 0, 0]);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("raw peak detection exposes actual heights and fractional half-prominence widths", (t) => {
  const science = fixture(t);
  const input = { spectrum: [0, 4, 0, 2, 0], x_values: [-2, -1, 0, 1, 2], threshold: 1.5, min_distance: 1 };
  const response = science.call("peak_detection", input);
  if (!response.ok && response.error.code === "dependency_unavailable") {
    t.skip("NumPy/SciPy unavailable; set COWORK_SCIENCE_TEST_PYTHON to the pinned scientific environment");
    return;
  }
  assert.deepEqual(success(response), {
    peak_indices: [1, 3],
    heights: [4, 2],
    positions: [-1, 1],
    widths: [1, 1],
    left_ips: [0.5, 2.5],
    right_ips: [1.5, 3.5]
  });
  assert.deepEqual(success(science.call("peak_detection", { ...input, threshold: 3 })).peak_indices, [1]);
  assert.deepEqual(
    success(science.call("peak_detection", { spectrum: [4, 0, 0, 0, 4], min_distance: 1 })).peak_indices,
    []
  );
  const alternating = Array.from({ length: 8192 }, (_, index) => index % 2);
  failure(science.call("peak_detection", { spectrum: alternating, min_distance: 1 }), "too_many_peaks");
});

test("linear calibration has verified coefficients, uncertainty, predictions and constant-response semantics", (t) => {
  const science = fixture(t);
  if (!numpy(t, science)) return;
  const line = success(
    science.call("fit_calibration_curve", {
      concentrations: [0, 1, 2, 3],
      responses: [1, 3, 5, 7],
      predict_at: [4, -1]
    })
  );
  nearArray(line.parameters, [2, 1]);
  nearArray(line.predictions, [9, -1]);
  nearArray(line.residuals, [0, 0, 0, 0]);
  near(line.r_squared, 1);
  const noisy = success(
    science.call("fit_calibration_curve", { concentrations: [0, 1, 2, 3], responses: [1, 2, 2, 4] })
  );
  nearArray(noisy.parameters, [0.9, 0.9]);
  nearArray(noisy.fitted_values, [0.9, 1.8, 2.7, 3.6]);
  nearArray(noisy.covariance[0], [0.07, -0.105]);
  nearArray(noisy.covariance[1], [-0.105, 0.245]);
  near(noisy.r_squared, 0.8526315789473684);
  const constant = success(
    science.call("fit_calibration_curve", { concentrations: [0, 1, 2], responses: [5, 5, 5] })
  );
  nearArray(constant.parameters, [0, 5]);
  assert.equal(constant.r_squared, null);
  assert.equal(constant.predictions, null);
  assert.equal(Object.hasOwn(constant, "predict"), false);
  assert.equal(Object.hasOwn(constant, "detection_limit"), false);
  const offset = success(
    science.call("fit_calibration_curve", {
      concentrations: [1e15, 1e15 + 1, 1e15 + 2],
      responses: [1, 3, 5],
      predict_at: [1e15 + 3]
    })
  );
  nearArray(offset.parameters, [2, 1 - 2e15]);
  nearArray(offset.predictions, [7]);
});

test("standardized PCA has orthonormal loadings, known variances and no estimator objects", (t) => {
  const science = fixture(t);
  if (!numpy(t, science)) return;
  const result = success(
    science.call("multivariate_analysis", {
      data: [
        [1, 2],
        [2, 4],
        [3, 6]
      ],
      n_components: 1
    })
  );
  nearArray(result.means, [2, 4]);
  nearArray(result.scales, [Math.sqrt(2 / 3), Math.sqrt(8 / 3)]);
  nearArray(result.explained_variance, [3]);
  nearArray(result.explained_variance_ratio, [1]);
  nearArray(result.loadings[0], [Math.SQRT1_2, Math.SQRT1_2]);
  nearArray(
    result.scores.map((row) => row[0]),
    [-Math.sqrt(3), 0, Math.sqrt(3)]
  );
  assert.equal(Object.hasOwn(result, "model"), false);
  assert.equal(Object.hasOwn(result, "scaler"), false);
  const mixed = success(
    science.call("multivariate_analysis", {
      data: [
        [1, 7],
        [2, 7],
        [3, 7]
      ],
      n_components: 2
    })
  );
  nearArray(mixed.scales, [Math.sqrt(2 / 3), 1]);
  nearArray(mixed.explained_variance_ratio, [1, 0]);
  failure(
    science.call("multivariate_analysis", {
      data: [
        [7, 7],
        [7, 7],
        [7, 7]
      ]
    }),
    "invalid_arguments"
  );
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("PCA centers large-offset features before computing scores and variance", (t) => {
  const science = fixture(t);
  if (!numpy(t, science)) return;
  const result = success(
    science.call("multivariate_analysis", {
      data: [[1e16], [1e16], [1e16 + 2]],
      n_components: 1
    })
  );
  const scores = result.scores.map((row) => row[0]);
  const mean = scores.reduce((total, value) => total + value, 0) / scores.length;
  const sampleVariance = scores.reduce((total, value) => total + (value - mean) ** 2, 0) / 2;
  assert.ok(
    Math.abs(mean) < 1e-12 && Math.abs(sampleVariance - result.explained_variance[0]) < 1e-12,
    JSON.stringify({
      scoreMean: mean,
      scoreVariance: sampleVariance,
      reportedVariance: result.explained_variance[0]
    })
  );
  near(mean, 0);
  near(sampleVariance, 1.5);
  near(result.explained_variance[0], sampleVariance);
  nearArray(scores, [-Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT2]);
  nearArray(result.scales, [Math.sqrt(8 / 9)]);
  nearArray(result.centering_origin, [1e16]);
  nearArray(result.centering_offset, [2 / 3]);
  // The displayed mean must round at this magnitude; these two fields preserve
  // the accurate transform (value - centering_origin) - centering_offset.
  assert.equal(result.means[0], 1e16);
  near((1e16 + 2 - result.centering_origin[0] - result.centering_offset[0]) / result.scales[0], scores[2]);
});

test("new analysis domains and dependency errors remain local and strictly JSON", (t) => {
  const science = fixture(t);
  for (const [tool, args] of [
    ["baseline_correction", { spectrum: [1, 2, 3], method: "als" }],
    ["baseline_correction", { spectrum: [1, 2, 3], degree: 3 }],
    ["baseline_correction", { spectrum: [1, 2, 3], degree: true }],
    ["peak_detection", { spectrum: [0, 1, 0], x_values: [0, 0, 2] }],
    ["peak_detection", { spectrum: [0, 1, 0], min_distance: 0 }],
    ["peak_detection", { spectrum: [0, 1, 0], threshold: "1+1" }],
    ["fit_calibration_curve", { concentrations: [1, 1, 1], responses: [1, 2, 3] }],
    ["fit_calibration_curve", { concentrations: [0, 1, 2], responses: [0, 1, 2], model: "quadratic" }],
    ["fit_calibration_curve", { concentrations: [0, 1, 2], responses: [0, 1, 2], function: "x*x" }],
    ["multivariate_analysis", { data: [[1, 2], [3]], n_components: 1 }],
    ["multivariate_analysis", { data: [[1], [2]], n_components: 2 }],
    ["multivariate_analysis", { data: Array.from({ length: 129 }, () => Array(64).fill(1)) }],
    ["nernst_potential", { E0: 0, n: 1.5, a_oxidized: 1 }],
    ["nernst_potential", { E0: 0, n: 1, a_oxidized: 0 }],
    ["nernst_potential", { E0: 0, n: 1, a_oxidized: 1, T: 0 }],
    ["bragg_law_d_spacing", { two_theta: 0 }],
    ["bragg_law_d_spacing", { two_theta: 180 }],
    ["bragg_law_d_spacing", { two_theta: 60, wavelength: -1 }]
  ])
    failure(science.call(tool, args, { noSite: true }), "invalid_arguments");
  for (const [tool, args] of [
    ["baseline_correction", { spectrum: [1, 2, 3], degree: 1 }],
    ["peak_detection", { spectrum: [0, 1, 0] }],
    ["fit_calibration_curve", { concentrations: [0, 1, 2], responses: [1, 3, 5] }],
    ["multivariate_analysis", { data: [[1], [2]], n_components: 1 }]
  ])
    failure(science.call(tool, args, { noSite: true }), "dependency_unavailable");
  // New names remain unavailable through the unchanged v1 protocol.
  failure(
    science.call(
      "nernst_potential",
      { E0: 0, n: 1, a_oxidized: 1 },
      { noSite: true, catalogVersion: "sciagentgym-e9dbbea-pilot-v1" }
    ),
    "unknown_tool"
  );
  near(success(science.call("eV_to_nm", { energy_eV: 2 }, { noSite: true })), 619.9209921660013);
});
