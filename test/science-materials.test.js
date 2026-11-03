import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const runner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const version = "sciagentgym-e9dbbea-materials-v5";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-materials-"));
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

function near(actual, expected, tolerance = 1e-11) {
  assert.equal(typeof actual, "number");
  assert.ok(
    Math.abs(actual - expected) <= tolerance * (Math.abs(expected) || 1),
    `${actual} differs from ${expected}`
  );
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

function cell(science, a, b, c, alpha = 90, beta = 90, gamma = 90) {
  return success(science.call("calculate_metric_tensor", { a, b, c, alpha, beta, gamma }));
}

function spacing(science, metric_tensor, h, k, l) {
  const response = science.call("calculate_interplanar_spacing_general", { h, k, l, metric_tensor });
  assert.equal(response.units, "angstrom");
  return success(response);
}

test("cubic lattice conversion preserves signed and higher-order Miller indices without optional packages", (t) => {
  const science = fixture(t);
  const first = science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1, 1] });
  near(success(first), Math.sqrt(12));
  assert.equal(first.units, "angstrom");
  near(success(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [-1, 1, -1] })), Math.sqrt(12));
  near(success(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [2, 0, 0] })), 4);
  near(success(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 0, 0] })), 2);
  // Connect a measured Bragg spacing to a known cubic cell and back through its metric.
  const d = success(science.call("bragg_law_d_spacing", { two_theta: 60, wavelength: 2 }));
  const a = success(science.call("cubic_lattice_parameter", { d_spacing: d, hkl: [1, 1, 1] }));
  near(spacing(science, cell(science, a, a, a).metric_tensor, 1, 1, 1), d);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("orthorhombic cell returns the direct metric and correctly dimensioned cell volume", (t) => {
  const science = fixture(t);
  const response = science.call("calculate_metric_tensor", {
    a: 2,
    b: 3,
    c: 4,
    alpha: 90,
    beta: 90,
    gamma: 90
  });
  const result = success(response);
  near(result.metric_tensor[0][0], 4);
  near(result.metric_tensor[1][1], 9);
  near(result.metric_tensor[2][2], 16);
  near(result.volume_angstrom3, 24);
  assert.deepEqual(response.units, { metric_tensor: "angstrom^2", volume_angstrom3: "angstrom^3" });
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      assert.equal(result.metric_tensor[row][col], result.metric_tensor[col][row]);
      if (row !== col) assert.ok(Math.abs(result.metric_tensor[row][col]) < 1e-12);
    }
  }
  near(spacing(science, result.metric_tensor, 1, 0, 0), 2);
  near(spacing(science, result.metric_tensor, 0, 1, 0), 3);
  near(spacing(science, result.metric_tensor, 0, 0, 1), 4);
  near(spacing(science, result.metric_tensor, 1, 1, 1), 1.5364425591947517);
  near(spacing(science, result.metric_tensor, 2, 2, 2), 1.5364425591947517 / 2);
});

test("oblique-cell spacings use the reciprocal metric with signed cross terms and no 2pi factor", (t) => {
  const science = fixture(t);
  const hexagonal = cell(science, 2, 2, 3, 90, 90, 120);
  near(hexagonal.metric_tensor[0][1], -2);
  near(hexagonal.volume_angstrom3, 6 * Math.sqrt(3));
  near(spacing(science, hexagonal.metric_tensor, 1, 0, 0), Math.sqrt(3));
  near(spacing(science, hexagonal.metric_tensor, 1, 1, 0), 1);
  near(spacing(science, hexagonal.metric_tensor, 1, -1, 0), Math.sqrt(3));
  near(spacing(science, hexagonal.metric_tensor, 0, 0, 1), 3);
  const rhombohedral = cell(science, 2, 2, 2, 60, 60, 60);
  near(rhombohedral.volume_angstrom3, 4 * Math.sqrt(2));
  near(spacing(science, rhombohedral.metric_tensor, 1, 1, 1), Math.sqrt(8 / 3));
  near(spacing(science, rhombohedral.metric_tensor, 1, -1, 0), 1);
});

test("metric conditioning is relative to scale instead of a dimensionful determinant threshold", (t) => {
  const science = fixture(t);
  for (const scale of [1e-4, 1e4]) {
    const result = cell(science, 2 * scale, 3 * scale, 4 * scale);
    near(result.volume_angstrom3, 24 * scale ** 3);
    near(spacing(science, result.metric_tensor, 1, 1, 1), 1.5364425591947517 * scale);
  }
  near(
    spacing(
      science,
      [
        [1e-12, 0, 0],
        [0, 1e-12, 0],
        [0, 0, 1e-12]
      ],
      1,
      0,
      0
    ),
    1e-6
  );
  near(
    spacing(
      science,
      [
        [1e12, 0, 0],
        [0, 1e12, 0],
        [0, 0, 1e12]
      ],
      1,
      0,
      0
    ),
    1e6
  );
  failure(
    science.call("calculate_metric_tensor", { a: 1, b: 1, c: 1, alpha: 0.001, beta: 0.001, gamma: 0.001 }),
    "numeric_range"
  );
  failure(
    science.call("calculate_interplanar_spacing_general", {
      h: 1,
      k: 0,
      l: 0,
      metric_tensor: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1e-11]
      ]
    }),
    "numeric_range"
  );
  failure(
    science.call("calculate_interplanar_spacing_general", {
      h: 1,
      k: 0,
      l: 0,
      metric_tensor: [
        [1, 0.99999999999, 0],
        [0.99999999999, 1, 0],
        [0, 0, 1]
      ]
    }),
    "numeric_range"
  );
});

test("Scherrer reports coherent-domain size with Gaussian quadrature correction and angle units", (t) => {
  const science = fixture(t);
  const uncorrected = science.call("calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.2 });
  const first = success(uncorrected);
  near(first.D_nm, 45.866373999487884);
  near(first.theta_deg, 30);
  near(first.corrected_fwhm_deg, 0.2);
  near(first.beta_rad, 0.003490658503988659);
  assert.equal(first.instrument_model, "gaussian");
  assert.equal(uncorrected.units.D_nm, "nm");
  assert.equal(uncorrected.units.beta_rad, "radian");
  const corrected = success(
    science.call("calculate_scherrer_grain_size", {
      peak_2theta_deg: 60,
      fwhm_deg: 0.2,
      instrument_fwhm_deg: 0.1
    })
  );
  near(corrected.D_nm, 52.96192675071276);
  near(corrected.corrected_fwhm_deg, 0.17320508075688776);
  near(corrected.beta_rad, 0.003022998940390363);
  assert.ok(corrected.D_nm > first.D_nm);
  near(
    success(
      science.call("calculate_scherrer_grain_size", {
        peak_2theta_deg: 60,
        fwhm_deg: 0.2,
        wavelength_nm: 0.30812
      })
    ).D_nm,
    first.D_nm * 2
  );
  near(
    success(science.call("calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.4 })).D_nm,
    first.D_nm / 2
  );
  assert.match(uncorrected.assumptions.join(" "), /coherent diffraction-domain/);
  assert.match(uncorrected.assumptions.join(" "), /not.*particle size/);
  assert.match(uncorrected.assumptions.join(" "), /half-prominence/);
  failure(
    science.call("calculate_scherrer_grain_size", {
      peak_2theta_deg: 60,
      fwhm_deg: 0.2,
      instrument_fwhm_deg: 0.2 * (1 - 1e-14)
    }),
    "numeric_range"
  );
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("materials reject malformed inputs and nonphysical cells then allow an independent valid request", (t) => {
  const science = fixture(t);
  const metric = { a: 2, b: 3, c: 4, alpha: 90, beta: 90, gamma: 90 };
  const identity = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
  const invalid = [
    ["cubic_lattice_parameter", { d_spacing: 2, hkl: [0, 0, 0] }],
    ["cubic_lattice_parameter", { d_spacing: 2, hkl: [1.5, 1, 1] }],
    ["cubic_lattice_parameter", { d_spacing: 2, hkl: [true, 1, 1] }],
    ["cubic_lattice_parameter", { d_spacing: 2, hkl: [1001, 1, 1] }],
    ["cubic_lattice_parameter", { d_spacing: 0, hkl: [1, 1, 1] }],
    ["cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1] }],
    ["calculate_metric_tensor", { ...metric, a: 0 }],
    ["calculate_metric_tensor", { ...metric, alpha: 180 }],
    ["calculate_metric_tensor", { ...metric, alpha: 1, beta: 1, gamma: 179 }],
    ["calculate_metric_tensor", { ...metric, alpha: 60, beta: 60, gamma: 120 }],
    [
      "calculate_interplanar_spacing_general",
      {
        h: 1,
        k: 0,
        l: 0,
        metric_tensor: [
          [1, 0],
          [0, 1]
        ]
      }
    ],
    [
      "calculate_interplanar_spacing_general",
      {
        h: 1,
        k: 0,
        l: 0,
        metric_tensor: [
          [1, 0.1, 0],
          [0, 1, 0],
          [0, 0, 1]
        ]
      }
    ],
    [
      "calculate_interplanar_spacing_general",
      {
        h: 1,
        k: 0,
        l: 0,
        metric_tensor: [
          [1, 2, 0],
          [2, 1, 0],
          [0, 0, 1]
        ]
      }
    ],
    [
      "calculate_interplanar_spacing_general",
      {
        h: 1,
        k: 0,
        l: 0,
        metric_tensor: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, -1]
        ]
      }
    ],
    ["calculate_interplanar_spacing_general", { h: 0, k: 0, l: 0, metric_tensor: identity }],
    ["calculate_interplanar_spacing_general", { h: 1, k: true, l: 0, metric_tensor: identity }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0 }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 180, fwhm_deg: 0.2 }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.2, instrument_fwhm_deg: 0.2 }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.2, instrument_fwhm_deg: -1 }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.2, shape_factor: 0 }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.2, wavelength_nm: 0 }],
    ["calculate_scherrer_grain_size", { peak_2theta_deg: 60, fwhm_deg: 0.2, profile: "lorentzian" }]
  ];
  for (const [name, args] of invalid) failure(science.call(name, args));
  near(success(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 0, 0] })), 2);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("old catalogs reject v5 additions and v5 scalar paths work without RDKit or numerical dependencies", (t) => {
  const science = fixture(t);
  for (const old of [
    "sciagentgym-e9dbbea-pilot-v1",
    "sciagentgym-e9dbbea-analysis-v2",
    "sciagentgym-e9dbbea-astronomy-v3",
    "atria-rdkit-chemistry-v4"
  ])
    failure(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1, 1] }, old), "unknown_tool");
  near(success(science.call("eV_to_nm", { energy_eV: 2 })), 619.9209921660013);
  near(success(science.call("bragg_law_d_spacing", { two_theta: 60 })), 1.5406);
  near(success(science.call("distance_from_modulus", { mu: 10 })), 1000);
  failure(science.call("rdkit_validate_smiles", { smiles: "CCO" }), "dependency_unavailable");
  near(success(science.call("cubic_lattice_parameter", { d_spacing: 2, hkl: [1, 1, 1] })), Math.sqrt(12));
});
