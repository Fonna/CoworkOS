import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScienceTools,
  scienceCatalog,
  SCIENCE_PILOT_CATALOG_VERSION,
  SCIENCE_ANALYSIS_CATALOG_VERSION,
  SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION
} from "../dist/src/tools/science-tools.js";

test("v6 published metadata and the three model-facing definitions stay unchanged", () => {
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(
    hash(scienceCatalog(SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION)),
    "246ee63695d4edb43b8d212115b276131f4310237613b84194b843fa7c0b3188"
  );
  const tools = createScienceTools(
    { enabled: true, catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION },
    { workingDirectory: "/unused" }
  );
  assert.equal(
    hash([...tools].map(([name, { description, parameters }]) => ({ name, description, parameters }))),
    "a820fb40bc47af3181f5a15c061e649f9804a9d48998137f0c686545753878b3"
  );
});

test("task-style bilingual discovery ranks reviewed functions without probing Python", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atria-science-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = createScienceTools(
    {
      enabled: true,
      catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
      pythonExecutable: join(directory, "missing-python")
    },
    { workingDirectory: directory }
  );
  for (const [query, expected] of [
    ["帮我给这组测量数据扣背景", "baseline_correction"],
    ["Please remove drift from these observations", "baseline_correction"],
    ["我需要从数据建立标准曲线", "fit_calibration_curve"],
    ["dimensionality reduction of observations", "multivariate_analysis"],
    ["分析这个分子的脂溶性", "rdkit_molecular_descriptors"],
    ["Give the chemical formula and monoisotopic mass", "rdkit_exact_mass_and_formula"],
    ["用峰表匹配同位素峰", "find_isotope_cluster"],
    ["用衍射展宽估算衍射畴尺寸", "calculate_scherrer_grain_size"],
    ["计算恒星测距", "distance_from_modulus"],
    ["ＦＩＴ＿ＣＡＬＩＢＲＡＴＩＯＮ＿ＣＵＲＶＥ", "fit_calibration_curve"]
  ]) {
    const found = await tools.get("science_search").execute({ query, limit: 1 });
    assert.equal(found.ok, true, query);
    assert.equal(found.tools[0]?.name, expected, query);
  }
  const description = await tools.get("science_describe").execute({ name: "fit_calibration_curve" });
  assert.equal(description.parameters.additionalProperties, false);
  assert.deepEqual(await readdir(directory), [], "discovery and description do not start Python");
});

test("discovery retains catalog boundaries, physics alias, stable empty listing and no-match behavior", async () => {
  const search = (catalogVersion) =>
    createScienceTools({ enabled: false, catalogVersion }, { workingDirectory: "/unused" }).get(
      "science_search"
    );
  const pilot = search(SCIENCE_PILOT_CATALOG_VERSION);
  const v2 = search(SCIENCE_ANALYSIS_CATALOG_VERSION);
  const current = search(SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION);
  for (const [tool, query] of [
    [pilot, "remove drift"],
    [pilot, "monoisotopic mass"],
    [v2, "chemical formula"]
  ]) {
    const result = await tool.execute({ query });
    assert.equal(result.total, 0, query);
  }
  assert.equal((await pilot.execute({ limit: 12 })).total, 12);
  assert.equal((await pilot.execute({ limit: 12 })).tools[0].name, "eV_to_nm");
  assert.equal((await current.execute({ domain: "physics", limit: 12 })).total, 12);
  assert.equal((await current.execute({ query: "chemical formula", domain: "astronomy" })).total, 0);
  for (const query of [
    "帮我整理今天的会议日程",
    "please calculate",
    "change the webpage background colour"
  ]) {
    const result = await current.execute({ query });
    assert.equal(result.total, 0, query);
  }
});
