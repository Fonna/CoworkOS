import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import {
  SCIENCE_PILOT_CATALOG_VERSION,
  SCIENCE_ANALYSIS_CATALOG_VERSION,
  SCIENCE_ASTRONOMY_CATALOG_VERSION,
  SCIENCE_CHEMISTRY_CATALOG_VERSION,
  SCIENCE_MATERIALS_CATALOG_VERSION,
  SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION
} from "../dist/src/tools/science-tools.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const original = {
  enabled: true,
  catalogVersion: SCIENCE_PILOT_CATALOG_VERSION,
  pythonExecutable: "python3"
};
const chemistryPython = process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON;
const replacement = {
  enabled: true,
  catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
  pythonExecutable: "/missing/replacement-python",
  chemistryPythonExecutable: "/missing/replacement-chemistry-python"
};
const cases = [
  {
    name: "queued science retains its original catalog and interpreter",
    saved: original,
    current: replacement,
    succeeds: true
  },
  {
    name: "revoked queued science retains schemas while ordinary tools continue",
    saved: original,
    current: { ...replacement, enabled: false },
    succeeds: false,
    verifyRevokedSkill: true
  },
  {
    name: "queued v2 retains its new catalog when the recovery default changes",
    saved: { ...original, catalogVersion: SCIENCE_ANALYSIS_CATALOG_VERSION },
    current: replacement,
    succeeds: true
  },
  {
    name: "revoked queued v2 keeps its scope when the host default is v6",
    saved: { ...original, catalogVersion: SCIENCE_ANALYSIS_CATALOG_VERSION },
    current: { ...replacement, enabled: false },
    succeeds: false
  },
  {
    name: "queued v3 keeps its astronomy catalog and original interpreter when v6 is configured",
    saved: { ...original, catalogVersion: SCIENCE_ASTRONOMY_CATALOG_VERSION },
    current: replacement,
    succeeds: true
  },
  {
    name: "queued v4 retains both interpreter selections and executes native chemistry in its original environment",
    saved: {
      ...original,
      catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
      pythonExecutable: "/missing/original-general-python",
      chemistryPythonExecutable: chemistryPython
    },
    current: { ...replacement, catalogVersion: SCIENCE_ASTRONOMY_CATALOG_VERSION },
    succeeds: true,
    requiresChemistry: true
  },
  {
    name: "revoked queued v4 retains chemistry schema and both interpreter pins without stopping ordinary tools",
    saved: {
      ...original,
      catalogVersion: SCIENCE_CHEMISTRY_CATALOG_VERSION,
      chemistryPythonExecutable: chemistryPython || "/missing/original-chemistry-python"
    },
    current: { ...replacement, enabled: false },
    succeeds: false
  },
  {
    name: "queued v5 stdlib materials keep the general interpreter while chemistry is unavailable",
    saved: {
      ...original,
      catalogVersion: SCIENCE_MATERIALS_CATALOG_VERSION,
      chemistryPythonExecutable: "/missing/original-chemistry-python"
    },
    current: replacement,
    succeeds: true
  },
  {
    name: "queued v5 retained chemistry keeps its separate original interpreter",
    saved: {
      ...original,
      catalogVersion: SCIENCE_MATERIALS_CATALOG_VERSION,
      pythonExecutable: "/missing/original-general-python",
      chemistryPythonExecutable: chemistryPython
    },
    current: replacement,
    succeeds: true,
    requiresChemistry: true
  },
  {
    name: "revoked queued v5 keeps its schemas and both pins while ordinary work continues",
    saved: {
      ...original,
      catalogVersion: SCIENCE_MATERIALS_CATALOG_VERSION,
      chemistryPythonExecutable: "/pinned/original-chemistry-python"
    },
    current: { ...replacement, enabled: false },
    succeeds: false
  },
  {
    name: "queued v6 stdlib mass spectrometry keeps its general interpreter without chemistry",
    saved: {
      ...original,
      catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
      chemistryPythonExecutable: "/missing/original-chemistry-python"
    },
    current: replacement,
    succeeds: true
  },
  {
    name: "queued v6 exact mass keeps its separate original chemistry interpreter",
    saved: {
      ...original,
      catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
      pythonExecutable: "/missing/original-general-python",
      chemistryPythonExecutable: chemistryPython
    },
    current: replacement,
    succeeds: true,
    requiresChemistry: true
  },
  {
    name: "revoked queued v6 keeps both pins and schemas while ordinary work continues",
    saved: {
      ...original,
      catalogVersion: SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
      chemistryPythonExecutable: "/pinned/original-chemistry-python"
    },
    current: { ...replacement, enabled: false },
    succeeds: false
  },
  { name: "legacy queued work never acquires a newly enabled science capability", current: replacement }
];

function retainedKernel(version) {
  if (version === SCIENCE_PILOT_CATALOG_VERSION)
    return { name: "eV_to_nm", arguments: { energy_eV: 2 }, expected: 619.9209921660013 };
  if (version === SCIENCE_ANALYSIS_CATALOG_VERSION)
    return {
      name: "bragg_law_d_spacing",
      arguments: { two_theta: 60, wavelength: 1.5406 },
      expected: 1.5406
    };
  if (version === SCIENCE_ASTRONOMY_CATALOG_VERSION)
    return { name: "distance_from_modulus", arguments: { mu: 10 }, expected: 1000 };
  if (version === SCIENCE_CHEMISTRY_CATALOG_VERSION)
    return { name: "rdkit_molecular_descriptors", arguments: { smiles: "CCO" } };
  return {
    name: "cubic_lattice_parameter",
    arguments: { d_spacing: 2, hkl: [1, 1, 1] },
    expected: Math.sqrt(12)
  };
}

for (const scenario of cases) {
  test(
    `real Pi recovery: ${scenario.name}`,
    { timeout: 20_000, skip: scenario.requiresChemistry && !chemistryPython },
    async (t) => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-science-recovery-"));
      const taskId = "task",
        runId = "run",
        agentId = "recovered",
        callId = "queued";
      const store = new LocalWorkspaceStore(workspaceRoot);
      await store.createTask(taskId, {
        goal: "Recover the original delegated work",
        capabilities: { projectWrite: false, shell: false, longRunning: false }
      });
      await store.createRun(taskId, runId);
      const ordinarySkill = join(workspaceRoot, "ordinary-workflow", "SKILL.md");
      await mkdir(join(workspaceRoot, "ordinary-workflow"));
      await writeFile(
        ordinarySkill,
        "---\nname: ordinary-workflow\ndescription: Ordinary persisted workflow\n---\nOrdinary work survives recovery."
      );
      const scheduler = new DurableScheduler(join(workspaceRoot, taskId, "runs", runId, "queue.json"));
      const payload = {
        task: "Use the available tools and preserve the queued scientific capability scope.",
        api: "openai-completions",
        thinkingLevel: "off",
        supportsReasoningEffort: false,
        supportsImages: false,
        skillRoots: [ordinarySkill],
        skillApplications: [],
        ...(scenario.saved ? { science: scenario.saved } : {})
      };
      await scheduler.enqueue({
        stepId: callId,
        taskId,
        runId,
        agentId,
        importance: "normal",
        payload,
        maxAttempts: 1
      });
      const failures = [];
      let step = 0;
      const provider = await modelProtocolFixture("openai-completions", (body) => {
        try {
          const names = body.tools.map((tool) => tool.function.name);
          for (const name of ["science_search", "science_describe", "science_run"])
            assert.equal(
              names.includes(name),
              Boolean(scenario.saved),
              "recovery must use the original queue scope"
            );
          assert.ok(names.includes("write_file"));
          assert.ok(names.includes("read_file"));
          let current = step++;
          if (current === 0) {
            const prompt = JSON.stringify(body.messages);
            assert.match(prompt, /ordinary-workflow/, "recovery retains the queued ordinary skill scope");
            const guidanceEnabled = scenario.saved?.enabled === true && scenario.current.enabled === true;
            assert.equal(
              prompt.includes("scientific-analysis"),
              guidanceEnabled,
              "workflow metadata follows the original queue scope and current enablement"
            );
            assert.equal(prompt.includes("<scientific_environment>"), guidanceEnabled);
            if (guidanceEnabled) {
              assert.ok(
                prompt.includes(scenario.saved.pythonExecutable),
                "the script guidance retains the queued general interpreter"
              );
              if (scenario.saved.chemistryPythonExecutable)
                assert.ok(
                  prompt.includes(scenario.saved.chemistryPythonExecutable),
                  "the script guidance retains the queued chemistry interpreter"
                );
              assert.ok(
                !prompt.includes(replacement.pythonExecutable),
                "new recovery settings must not leak into the queued environment guidance"
              );
            }
          }
          if (scenario.verifyRevokedSkill) {
            if (current === 0) return { name: "load_skill", arguments: { name: "scientific-analysis" } };
            if (current === 1)
              assert.match(
                body.messages.findLast((message) => message.role === "tool").content,
                /unknown skill: scientific-analysis/,
                "revoked science skills cannot be loaded from the saved ordinary scope"
              );
            current -= 1;
          }
          const v2 = scenario.saved?.catalogVersion === SCIENCE_ANALYSIS_CATALOG_VERSION;
          const v3 = scenario.saved?.catalogVersion === SCIENCE_ASTRONOMY_CATALOG_VERSION;
          const v4 = scenario.saved?.catalogVersion === SCIENCE_CHEMISTRY_CATALOG_VERSION;
          const v5 = scenario.saved?.catalogVersion === SCIENCE_MATERIALS_CATALOG_VERSION;
          const v6 = scenario.saved?.catalogVersion === SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION;
          const extended = v6;
          if (scenario.saved && current === 0) return { name: "science_search", arguments: { limit: 12 } };
          if (scenario.saved && current === 1) {
            const value = JSON.parse(body.messages.findLast((message) => message.role === "tool").content);
            assert.equal(value.total, v6 ? 37 : v5 ? 33 : v4 ? 29 : v3 ? 26 : v2 ? 18 : 12);
            assert.equal(value.catalogVersion, scenario.saved.catalogVersion);
            return {
              name: "science_describe",
              arguments: { name: "calculate_theoretical_isotope_pattern" }
            };
          }
          if (scenario.saved && current === 2) {
            const value = JSON.parse(body.messages.findLast((message) => message.role === "tool").content);
            assert.equal(value.ok, extended);
            assert.equal(value.catalogVersion, scenario.saved.catalogVersion);
            if (!extended) assert.equal(value.error.code, "unknown_tool");
            return {
              name: "science_run",
              arguments:
                v6 && scenario.requiresChemistry
                  ? { name: "rdkit_exact_mass_and_formula", arguments: { smiles: "CCO" } }
                  : { name: "calculate_theoretical_isotope_pattern", arguments: { num_chlorine: 2 } }
            };
          }
          if (scenario.saved && !extended && current === 3) {
            const value = JSON.parse(body.messages.findLast((message) => message.role === "tool").content);
            assert.equal(value.ok, false);
            assert.equal(value.error.code, "unknown_tool");
            assert.equal(value.catalogVersion, scenario.saved.catalogVersion);
            const { expected: _expected, ...arguments_ } = retainedKernel(scenario.saved.catalogVersion);
            return {
              name: "science_run",
              arguments: scenario.requiresChemistry
                ? { name: "rdkit_molecular_descriptors", arguments: { smiles: "CCO" } }
                : arguments_
            };
          }
          const ordinaryStep = current - (scenario.saved ? (extended ? 3 : 4) : 0);
          if (ordinaryStep === 0) {
            if (scenario.saved) {
              const value = JSON.parse(body.messages.findLast((message) => message.role === "tool").content);
              assert.equal(value.ok, scenario.succeeds, JSON.stringify(value));
              assert.equal(value.catalogVersion, scenario.saved.catalogVersion);
              if (scenario.succeeds) {
                if (v4 || scenario.requiresChemistry) {
                  assert.equal(value.result.canonical_smiles, "CCO");
                  assert.ok(
                    Math.abs(
                      v6 ? value.result.exact_mass_da - 46.041864812 : value.result.molecular_weight - 46.069
                    ) < 1e-9
                  );
                  assert.equal(value.result.rdkit_version, "2026.09.1");
                  assert.equal(value.metadata.source.kind, "atria-native");
                } else if (v6) {
                  assert.ok(Math.abs(value.result.M_plus_2_ratio - 0.6399155227032735) < 1e-12);
                } else {
                  assert.ok(
                    Math.abs(value.result - retainedKernel(scenario.saved.catalogVersion).expected) < 1e-9,
                    JSON.stringify(value)
                  );
                }
                assert.equal(value.metadata.catalogVersion, scenario.saved.catalogVersion);
              } else {
                assert.equal(value.isError, true);
                assert.equal(value.error.code, "unavailable");
              }
            }
            return {
              name: "write_file",
              arguments: { path: "recovered.txt", content: "ordinary tools survive recovery" }
            };
          }
          if (ordinaryStep === 1) return { name: "read_file", arguments: { path: "recovered.txt" } };
          assert.match(
            body.messages.findLast((message) => message.role === "tool").content,
            /ordinary tools survive recovery/
          );
          return { text: "Recovered work completed with the original capability scope." };
        } catch (error) {
          failures.push(error.message);
          return { text: `Fixture failed: ${error.message}` };
        }
      });
      t.after(async () => {
        await provider.close();
        await rm(workspaceRoot, { recursive: true, force: true });
      });
      const runtime = new CoordinatorRuntime();
      const options = {
        workspaceRoot,
        taskId,
        runId,
        baseUrl: provider.baseUrl,
        apiKey: "local-fixture",
        model: "protocol-fixture",
        api: "openai-completions",
        thinkingLevel: "off",
        supportsReasoningEffort: false,
        supportsImages: false,
        maxTurns: 8,
        timeoutMs: 10_000,
        maxErrorRetries: 0,
        questionTimeoutMs: 0,
        skillRoots: [],
        science: scenario.current
      };
      const recovered = await runtime.recoverRun(options);
      assert.deepEqual(failures, []);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].status, "succeeded", recovered[0].error);
      const expectedSteps = scenario.saved
        ? scenario.saved.catalogVersion === SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION
          ? 6
          : 7
        : 3;
      assert.equal(step, expectedSteps + (scenario.verifyRevokedSkill ? 1 : 0));
      assert.equal(
        await readFile(join(store.agentWorkDir(taskId, runId, agentId), "recovered.txt"), "utf8"),
        "ordinary tools survive recovery"
      );
      const [settled] = await scheduler.list();
      assert.equal(settled.status, "completed");
      assert.equal(settled.attempts, 1);
      assert.deepEqual(
        settled.payload,
        payload,
        "scheduler enqueue must not replace the original snapshot during recovery"
      );
      assert.deepEqual(await runtime.recoverRun(options), []);
      assert.equal(
        step,
        expectedSteps + (scenario.verifyRevokedSkill ? 1 : 0),
        "completed queued work is not executed again"
      );
    }
  );
}
