import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createScienceTools,
  scienceCatalog,
  SCIENCE_STATISTICS_CATALOG_VERSION,
  SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION
} from "../dist/src/tools/science-tools.js";

const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const runner = fileURLToPath(new URL("../src/tools/science/runner.py", import.meta.url));
const version = "atria-statistics-v7";
const names = ["summarize_numeric_data", "pearson_correlation", "welch_t_test"];
const previous = [
  "sciagentgym-e9dbbea-pilot-v1",
  "sciagentgym-e9dbbea-analysis-v2",
  "sciagentgym-e9dbbea-astronomy-v3",
  "atria-rdkit-chemistry-v4",
  "sciagentgym-e9dbbea-materials-v5",
  "sciagentgym-e9dbbea-mass-spec-v6"
];

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atria-science-statistics-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    call(tool, args, { noSite = false, catalogVersion = version } = {}) {
      const child = spawnSync(python, ["-I", "-B", ...(noSite ? ["-S"] : []), runner], {
        cwd,
        input: JSON.stringify({ version: catalogVersion, tool, arguments: args }),
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          LANG: "C.UTF-8",
          OMP_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {})
        }
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(child.stderr, /Traceback|RuntimeWarning/);
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
function failure(response, code) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, code, JSON.stringify(response));
}
function near(actual, expected, tolerance = 1e-11) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(Math.abs(expected), 1e-300),
    `${actual} differs from ${expected}`
  );
}
function dependencies(t, science) {
  const probe = science.call("welch_t_test", { sample_a: [1, 2, 3], sample_b: [2, 4, 6] });
  if (probe.error?.code === "dependency_unavailable") {
    t.skip("Set COWORK_SCIENCE_TEST_PYTHON to the pinned NumPy/SciPy environment");
    return false;
  }
  success(probe);
  return true;
}

test("v7 appends three native statistics entries and metadata-only discovery preserves old catalogs", async (t) => {
  assert.equal(SCIENCE_STATISTICS_CATALOG_VERSION, version);
  const catalog = scienceCatalog(version);
  assert.equal(catalog.length, 40);
  assert.deepEqual(catalog.slice(0, 37), scienceCatalog(SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION));
  assert.deepEqual(
    catalog.slice(37).map((entry) => entry.name),
    names
  );
  const tools = createScienceTools(
    { enabled: true, catalogVersion: version, pythonExecutable: "/missing/science-python" },
    { workingDirectory: fixture(t).cwd }
  );
  for (const [query, name] of [
    ["请帮我做这组测量数据的描述统计", names[0]],
    ["计算皮尔逊相关系数", names[1]],
    ["比较两组均值，方差可能不同", names[2]]
  ]) {
    const found = await tools.get("science_search").execute({ query, domain: "statistics", limit: 1 });
    assert.equal(found.tools[0].name, name);
    const description = await tools.get("science_describe").execute({ name });
    assert.equal(description.source.kind, "atria-native");
    assert.equal(description.source.implementationVersion, version);
    assert.equal(description.parameters.additionalProperties, false);
  }
  for (const oldVersion of previous) {
    const old = createScienceTools(
      { enabled: true, catalogVersion: oldVersion },
      { workingDirectory: fixture(t).cwd }
    );
    assert.equal((await old.get("science_search").execute({ domain: "statistics" })).total, 0);
    for (const name of names) failure(await old.get("science_describe").execute({ name }), "unknown_tool");
  }
});

test("statistics reports missing dependencies locally while all six earlier catalogs remain closed", (t) => {
  const science = fixture(t);
  for (const name of names) {
    const args =
      name === names[0]
        ? { values: [1, 2, 3] }
        : name === names[1]
          ? { x: [1, 2, 3], y: [3, 2, 1] }
          : { sample_a: [1, 2, 3], sample_b: [2, 4, 6] };
    failure(science.call(name, args, { noSite: true }), "dependency_unavailable");
    for (const oldVersion of previous)
      failure(science.call(name, args, { catalogVersion: oldVersion, noSite: true }), "unknown_tool");
  }
  near(success(science.call("eV_to_nm", { energy_eV: 2 }, { noSite: true })), 619.9209921660013);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("summary returns known type-7 quartiles and sample variance with explicit single-observation behavior", (t) => {
  const science = fixture(t);
  if (!dependencies(t, science)) return;
  const response = science.call(names[0], { values: [4, 1, 3, 2] });
  const data = success(response);
  assert.deepEqual(
    { ...data, sample_std: undefined },
    {
      count: 4,
      min: 1,
      max: 4,
      mean: 2.5,
      median: 2.5,
      q1: 1.75,
      q3: 3.25,
      range: 3,
      iqr: 1.5,
      sample_variance: 5 / 3,
      sample_std: undefined,
      quantile_method: "linear",
      ddof: 1
    }
  );
  near(data.sample_std, Math.sqrt(5 / 3));
  assert.equal(response.units.sample_variance, "input unit squared");
  const single = science.call(names[0], { values: [9] });
  assert.equal(success(single).sample_variance, null);
  assert.equal(single.result.sample_std, null);
  assert.match(single.assumptions.join(" "), /one observation.*undefined/);
  const constant = success(science.call(names[0], { values: [7, 7, 7] }));
  assert.equal(constant.sample_variance, 0);
  assert.equal(constant.sample_std, 0);
});

test("summary resolves variation at large offsets and tiny scales without silent positive-variance underflow", (t) => {
  const science = fixture(t);
  if (!dependencies(t, science)) return;
  const offset = 2 ** 52;
  const large = success(science.call(names[0], { values: [offset, offset + 1, offset + 2] }));
  assert.equal(large.sample_variance, 1);
  assert.equal(large.iqr, 1);
  near(success(science.call(names[0], { values: [1e-150, 2e-150, 3e-150] })).sample_variance, 1e-300);
  failure(science.call(names[0], { values: [1e-200, 2e-200, 3e-200] }), "numeric_range");
  const largeMagnitude = success(science.call(names[0], { values: [-1e100, 0, 1e100] }));
  near(largeMagnitude.sample_variance, 1e200);
  assert.deepEqual(readdirSync(science.cwd), []);
});

test("Pearson matches the official example and exact zero-correlation case", (t) => {
  const science = fixture(t);
  if (!dependencies(t, science)) return;
  const correlation = success(
    science.call(names[1], { x: [1, 2, 3, 4, 5, 6, 7], y: [10, 9, 2.5, 6, 4, 3, 2] })
  );
  near(correlation.r, -0.8285038835884277);
  near(correlation.p_value, 0.021280260007523352);
  assert.equal(correlation.n, 7);
  assert.equal(correlation.alternative, "two-sided");
  assert.equal(correlation.p_value_underflow, false);
  const orthogonal = success(science.call(names[1], { x: [-1, -1, 1, 1], y: [-1, 1, -1, 1] }));
  assert.equal(orthogonal.r, 0);
  assert.equal(orthogonal.p_value, 1);
});

test("Pearson is scale invariant even when raw variance would underflow, and rejects unresolved constant data", (t) => {
  const science = fixture(t);
  if (!dependencies(t, science)) return;
  const x = [-2, -1, 0, 1, 2],
    y = [1, 0, 3, 2, 5];
  const ordinary = success(science.call(names[1], { x, y }));
  const scaled = success(
    science.call(names[1], { x: x.map((value) => value * 1e-250), y: y.map((value) => value * 1e99) })
  );
  near(scaled.r, ordinary.r);
  near(scaled.p_value, ordinary.p_value);
  failure(science.call(names[1], { x: [1, 1, 1], y: [1, 2, 3] }), "invalid_arguments");
  failure(science.call(names[1], { x: [1e16, 1e16 + 2, 1e16 + 4], y: [1, 2, 3] }), "numeric_range");
});

test("Pearson rejects unresolved endpoint tails rather than misreporting a representable p-value as underflow", (t) => {
  const science = fixture(t);
  if (!dependencies(t, science)) return;
  // For these exact float64 observations, high-precision arithmetic gives
  // 1-r about 4.166666574e-18 and the n=3 two-sided p-value about
  // 1.837762964e-9. SciPy's rounded endpoint CDF can instead return zero.
  for (const sign of [1, -1]) {
    const response = science.call(names[1], {
      x: [-1, 0, 1],
      y: [-1, 0, 1.00000001].map((value) => value * sign)
    });
    failure(response, "numeric_range");
    assert.match(response.error.message, /endpoint|tail/i);
  }
  for (const sign of [1, -1]) {
    const exact = success(
      science.call(names[1], {
        x: [-1, 0, 1],
        y: [-1, 0, 1].map((value) => 2 + value * sign * 3)
      })
    );
    assert.equal(exact.r, sign);
    assert.equal(exact.p_value, 0);
    assert.equal(exact.p_value_underflow, false);
  }
  const repeated = success(science.call(names[1], { x: [0, 0, 1, 2], y: [5, 5, 2, -1] }));
  assert.equal(repeated.r, -1);
  assert.equal(repeated.p_value, 0);
  assert.equal(repeated.p_value_underflow, false);
});

test("Welch returns the known unequal-variance statistic, Satterthwaite df and 95% mean-difference interval", (t) => {
  const science = fixture(t);
  if (!dependencies(t, science)) return;
  const response = science.call(names[2], { sample_a: [1, 2, 3], sample_b: [2, 4, 6] });
  const value = success(response);
  assert.equal(value.mean_difference, -2);
  assert.equal(value.sample_variance_a, 1);
  assert.equal(value.sample_variance_b, 4);
  near(value.t_statistic, -1.5491933384829668);
  near(value.degrees_of_freedom, 50 / 17);
  near(value.p_value, 0.2208808404940958);
  near(value.confidence_interval_95.low, -6.155399503183473);
  near(value.confidence_interval_95.high, 2.1553995031834727);
  assert.equal(value.method, "welch");
  assert.match(response.assumptions.join(" "), /not a paired/);
  assert.match(response.units.confidence_interval_95, /mean_a minus mean_b/);
});

test("Welch preserves direction, common offsets and rescaling, and explains underflowed tails", (t) => {
  const science = fixture(t);
  if (!dependencies(t, science)) return;
  const sample_a = [1, 2, 3],
    sample_b = [2, 4, 6];
  const ordinary = success(science.call(names[2], { sample_a, sample_b }));
  const reversed = success(science.call(names[2], { sample_a: sample_b, sample_b: sample_a }));
  near(reversed.t_statistic, -ordinary.t_statistic);
  near(reversed.p_value, ordinary.p_value);
  near(reversed.confidence_interval_95.low, -ordinary.confidence_interval_95.high);
  const shifted = success(
    science.call(names[2], {
      sample_a: sample_a.map((value) => value + 1e9),
      sample_b: sample_b.map((value) => value + 1e9)
    })
  );
  near(shifted.t_statistic, ordinary.t_statistic);
  assert.equal(shifted.mean_difference, -2);
  const scaled = success(
    science.call(names[2], {
      sample_a: sample_a.map((value) => value * 1e-150),
      sample_b: sample_b.map((value) => value * 1e-150)
    })
  );
  near(scaled.t_statistic, ordinary.t_statistic);
  near(scaled.p_value, ordinary.p_value);
  near(scaled.mean_difference, -2e-150);
  const equal = success(science.call(names[2], { sample_a, sample_b: sample_a }));
  assert.equal(equal.t_statistic, 0);
  assert.equal(equal.p_value, 1);
  const extreme = science.call(names[2], {
    sample_a: Array.from({ length: 100 }, (_, i) => 1000 + (i % 2)),
    sample_b: Array.from({ length: 100 }, (_, i) => i % 2)
  });
  assert.equal(success(extreme).p_value, 0);
  assert.equal(extreme.result.p_value_underflow, true);
  assert.match(extreme.assumptions.join(" "), /not an exact zero/);
});

test("statistics rejects nonfinite, boolean, missing, oversized or degenerate inputs without poisoning later work", (t) => {
  const science = fixture(t);
  for (const values of [[], [true, 1, 2], [null, 1, 2], ["1", 2, 3], [1e101], Array(8193).fill(1)])
    failure(science.call(names[0], { values }), "invalid_arguments");
  failure(science.call(names[0], { values: [1, 2, 3], ddof: 0 }), "invalid_arguments");
  failure(science.call(names[1], { x: [1, 2], y: [1, 2] }), "invalid_arguments");
  failure(science.call(names[1], { x: [1, 2, 3], y: [1, 2, 3, 4] }), "invalid_arguments");
  failure(science.call(names[2], { sample_a: [1, 2], sample_b: [1, 2, 3] }), "invalid_arguments");
  failure(
    science.call(names[2], { sample_a: [1, 2, 3], sample_b: [1, 2, 3], alternative: "less" }),
    "invalid_arguments"
  );
  if (!dependencies(t, science)) return;
  failure(science.call(names[2], { sample_a: [1, 1, 1], sample_b: [1, 2, 3] }), "invalid_arguments");
  failure(
    science.call(names[2], { sample_a: [1e16, 1e16 + 2, 1e16 + 4], sample_b: [1, 2, 3] }),
    "numeric_range"
  );
  failure(
    science.call(names[2], { sample_a: [1e-200, 2e-200, 3e-200], sample_b: [2e-200, 4e-200, 6e-200] }),
    "numeric_range"
  );
  assert.equal(success(science.call(names[0], { values: Array(8192).fill(5) })).mean, 5);
  near(success(science.call("eV_to_nm", { energy_eV: 2 }, { noSite: true })), 619.9209921660013);
  assert.deepEqual(readdirSync(science.cwd), []);
});
