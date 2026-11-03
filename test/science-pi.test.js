import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { scienceSkillRoots } from "../dist/src/runtime/science-guidance.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const chemistryPython = process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON;
const generalPython = process.env.COWORK_SCIENCE_TEST_PYTHON;
const materialsVersion = "sciagentgym-e9dbbea-materials-v5";
const massVersion = "sciagentgym-e9dbbea-mass-spec-v6";
const statisticsVersion = "atria-statistics-v7";
const cases = [
  {
    catalogVersion: "sciagentgym-e9dbbea-analysis-v2",
    total: 18,
    mainCall: { name: "bragg_law_d_spacing", arguments: { two_theta: 60, wavelength: 1.5406 } },
    mainValue: 1.5406,
    mainParameter: "two_theta",
    delegateCall: { name: "nernst_potential", arguments: { E0: 0, n: 1, a_oxidized: 10 } },
    delegateValue: 0.05915934968478112
  },
  {
    catalogVersion: "sciagentgym-e9dbbea-astronomy-v3",
    total: 26,
    mainCall: { name: "distance_from_modulus", arguments: { mu: 10 } },
    mainValue: 1000,
    mainParameter: "mu",
    delegateCall: { name: "calculate_mass_ratio_from_rv", arguments: { k1: 30, k2: 60 } },
    delegateValue: 2
  },
  {
    catalogVersion: "atria-rdkit-chemistry-v4",
    total: 29,
    mainCall: { name: "rdkit_molecular_descriptors", arguments: { smiles: "CCO" } },
    mainValue: 46.069,
    mainResultKey: "molecular_weight",
    mainParameter: "smiles",
    delegateCall: { name: "rdkit_molecular_descriptors", arguments: { smiles: "CC(=O)Oc1ccccc1C(=O)O" } },
    delegateValue: 63.6,
    delegateResultKey: "tpsa"
  },
  {
    catalogVersion: materialsVersion,
    total: 33,
    mainCall: { name: "cubic_lattice_parameter", arguments: { d_spacing: 2, hkl: [1, 1, 1] } },
    mainValue: Math.sqrt(12),
    mainParameter: "hkl",
    delegateCall: {
      name: "calculate_interplanar_spacing_general",
      arguments: {
        h: 1,
        k: 1,
        l: 0,
        metric_tensor: [
          [16, 0, 0],
          [0, 16, 0],
          [0, 0, 16]
        ]
      }
    },
    delegateValue: Math.sqrt(8)
  },
  {
    catalogVersion: massVersion,
    total: 37,
    mainCall: { name: "rdkit_exact_mass_and_formula", arguments: { smiles: "CCO" } },
    mainValue: 46.041864812,
    mainResultKey: "exact_mass_da",
    mainParameter: "smiles",
    delegateCall: { name: "calculate_theoretical_isotope_pattern", arguments: { num_chlorine: 2 } },
    delegateValue: 0.6399155227032735,
    delegateResultKey: "M_plus_2_ratio"
  },
  {
    catalogVersion: statisticsVersion,
    total: 40,
    mainCall: { name: "summarize_numeric_data", arguments: { values: [1, 2, 3, 4] } },
    mainValue: 2.5,
    mainResultKey: "mean",
    mainParameter: "values",
    delegateCall: { name: "pearson_correlation", arguments: { x: [-1, -1, 1, 1], y: [-1, 1, -1, 1] } },
    delegateValue: 0,
    delegateResultKey: "r"
  }
];
const scienceNames = ["science_search", "science_describe", "science_run"];

function normalizedRequest(api, body) {
  if (api === "openai-completions") return body;
  return {
    ...body,
    tools: body.tools.map((tool) => ({ type: "function", function: tool })),
    messages: body.input.map((item) =>
      item.type === "function_call_output"
        ? {
            role: "tool",
            content:
              typeof item.output === "string"
                ? item.output
                : item.output.map((part) => part.text ?? "").join("\n")
          }
        : item
    )
  };
}

for (const {
  catalogVersion,
  total,
  mainCall,
  mainValue,
  mainResultKey,
  mainParameter,
  delegateCall,
  delegateValue,
  delegateResultKey
} of cases) {
  for (const api of ["openai-completions", "openai-responses"]) {
    test(
      `real Pi ${api} ${catalogVersion} keeps science opt-in, computes in Main and delegate, and preserves ordinary work after disabling`,
      { timeout: 90_000 },
      async (t) => {
        if (["atria-rdkit-chemistry-v4", massVersion].includes(catalogVersion) && !chemistryPython)
          return t.skip("Set COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON to the pinned RDKit environment");
        if (catalogVersion === statisticsVersion && !generalPython)
          return t.skip("Set COWORK_SCIENCE_TEST_PYTHON to the pinned NumPy/SciPy environment");
        const root = await mkdtemp(join(tmpdir(), "atria-science-pi-"));
        const project = join(root, "project"),
          workspace = join(root, "workspace"),
          sessions = join(root, "sessions");
        const ordinarySkill = join(root, "ordinary-workflow", "SKILL.md");
        await mkdir(project);
        await mkdir(join(root, "ordinary-workflow"));
        await writeFile(
          ordinarySkill,
          "---\nname: ordinary-workflow\ndescription: Ordinary explicitly selected workflow\n---\nKeep this ordinary workflow available."
        );
        await writeFile(join(project, "plain.txt"), "ordinary work survives");
        await writeFile(join(root, "config.json"), "{}");
        const store = new LocalWorkspaceStore(workspace);
        for (const scope of ["ordinary", "science"]) {
          await store.createTask(`${scope}-task`, { goal: "verify local tools" });
          await store.createRun(`${scope}-task`, `${scope}-run`);
        }
        const failures = [],
          mainRequests = [],
          delegateRequests = [],
          events = [];
        let phase = "ordinary",
          mainStep = 0,
          delegateStep = 0,
          child,
          childExit,
          output = "";
        const result = (body) =>
          JSON.parse(body.messages.findLast((message) => message.role === "tool").content);
        const provider = await modelProtocolFixture(api, (rawBody) => {
          const body = normalizedRequest(api, rawBody);
          const names = body.tools.map((tool) => tool.function.name);
          const main = names.includes("call_subagent");
          (main ? mainRequests : delegateRequests).push({ phase, body });
          try {
            if (phase === "ordinary") {
              assert.equal(main, true);
              assert.ok(scienceNames.every((name) => !names.includes(name)));
              const enableSchema = body.tools.find((tool) => tool.function.name === "enable_tools");
              assert.ok(!JSON.stringify(enableSchema).includes('"science"'));
              assert.doesNotMatch(
                JSON.stringify(body.messages),
                /scientific-analysis|scientific_environment/
              );
              if (mainStep++ === 0) return { name: "read", arguments: { path: join(project, "plain.txt") } };
              assert.match(
                body.messages.findLast((message) => message.role === "tool").content,
                /ordinary work survives/
              );
              return { text: "Ordinary tools remain available." };
            }
            if (!main) {
              assert.ok(
                scienceNames.every((name) => names.includes(name)),
                "delegate receives the opted-in toolkit"
              );
              const delegatedStep = delegateStep++;
              if (delegatedStep === 0) {
                assert.match(JSON.stringify(body.messages), /ordinary-workflow/);
                assert.match(JSON.stringify(body.messages), /scientific-analysis/);
                assert.match(JSON.stringify(body.messages), /Selected general Python executable/);
                return { name: "load_skill", arguments: { name: "scientific-analysis" } };
              }
              if (delegatedStep === 1) {
                assert.equal(result(body).name, "scientific-analysis");
                assert.match(result(body).content, /可复现科学数据分析/);
                return { name: "science_describe", arguments: { name: delegateCall.name } };
              }
              if (delegatedStep === 2) {
                assert.equal(result(body).catalogVersion, catalogVersion);
                return {
                  name: "science_run",
                  arguments: delegateCall
                };
              }
              const value = result(body);
              assert.equal(value.ok, true, JSON.stringify(value));
              assert.ok(
                Math.abs(
                  (delegateResultKey ? value.result[delegateResultKey] : value.result) - delegateValue
                ) < 1e-9,
                JSON.stringify(value)
              );
              assert.equal(value.metadata.catalogVersion, catalogVersion);
              return { text: "Delegate independently verified the scientific result." };
            }
            const step = mainStep++;
            if (phase === "enabled") {
              if (step === 0) {
                assert.ok(
                  scienceNames.every((name) => !names.includes(name)),
                  "science tools load on demand"
                );
                assert.ok(
                  JSON.stringify(body.tools.find((tool) => tool.function.name === "enable_tools")).includes(
                    '"science"'
                  )
                );
                assert.match(
                  body.tools.find((tool) => tool.function.name === "enable_tools").function.description,
                  /mass-spectrum calculations/
                );
                assert.match(JSON.stringify(body.messages), /scientific-analysis/);
                assert.doesNotMatch(JSON.stringify(body.messages), /# 可复现科学数据分析/);
                return { name: "enable_tools", arguments: { groups: ["science"] } };
              }
              assert.ok(
                scienceNames.every((name) => names.includes(name)),
                "next model request sees activated tools"
              );
              if (step === 1) return { name: "load_skill", arguments: { name: "scientific-analysis" } };
              if (step === 2) {
                const skill = result(body);
                assert.equal(skill.name, "scientific-analysis");
                assert.match(skill.content, /# 可复现科学数据分析/);
                assert.match(
                  skill.directory,
                  /[\\/]\.pi[\\/]runtime[\\/]science-skills[\\/]scientific-analysis$/
                );
                return { name: "science_search", arguments: { limit: 12 } };
              }
              if (step === 3) {
                assert.equal(result(body).total, total);
                assert.equal(result(body).catalogVersion, catalogVersion);
                return { name: "science_describe", arguments: { name: mainCall.name } };
              }
              if (step === 4) {
                assert.ok(Object.hasOwn(result(body).parameters.properties, mainParameter));
                assert.equal(result(body).catalogVersion, catalogVersion);
                return {
                  name: "science_run",
                  arguments: mainCall
                };
              }
              if (step === 5) {
                const value = result(body);
                assert.equal(value.ok, true, JSON.stringify(value));
                assert.ok(
                  Math.abs((mainResultKey ? value.result[mainResultKey] : value.result) - mainValue) < 1e-9,
                  JSON.stringify(value)
                );
                assert.equal(value.metadata.catalogVersion, catalogVersion);
                return {
                  name: "call_subagent",
                  arguments: {
                    task: `Independently execute science_run with this scientific call: ${JSON.stringify(delegateCall)}.`,
                    mode: "sync"
                  }
                };
              }
              assert.match(
                JSON.stringify(result(body)),
                /Delegate independently verified the scientific result/
              );
              return { text: "Main and delegate verified their scientific computations." };
            }
            assert.equal(phase, "disabled");
            assert.ok(
              scienceNames.every((name) => names.includes(name)),
              "existing Run keeps its replay schemas"
            );
            if (step === 0) return { name: "load_skill", arguments: { name: "scientific-analysis" } };
            if (step === 1) {
              assert.match(
                body.messages.findLast((message) => message.role === "tool").content,
                /unknown skill: scientific-analysis/
              );
              return {
                name: "science_run",
                arguments: mainCall
              };
            }
            if (step === 2) {
              const value = result(body);
              assert.equal(value.ok, false, JSON.stringify(value));
              assert.equal(value.isError, true, JSON.stringify(value));
              assert.equal(value.catalogVersion, catalogVersion);
              assert.match(JSON.stringify(value), /unavailable|disabled/i);
              return { name: "read", arguments: { path: join(project, "plain.txt") } };
            }
            assert.match(
              body.messages.findLast((message) => message.role === "tool").content,
              /ordinary work survives/
            );
            return { text: "Science is unavailable; ordinary work continued." };
          } catch (error) {
            failures.push(error.message);
            return { text: `Fixture failed: ${error.message}` };
          }
        });
        t.after(async () => {
          if (child && child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already stopped. */
            }
            await childExit;
          }
          await provider.close();
          await rm(root, { recursive: true, force: true });
        });
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) =>
              !/^(?:COWORK_|PI_|ATRIA_|SERPER_|EXA_|OPENAI_|ANTHROPIC_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/.test(
                name
              )
          )
        );
        Object.assign(env, {
          ATRIA_HOME: join(root, "atria"),
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: workspace,
          COWORK_PROJECT_DIR: project,
          COWORK_TASK_ID: "ordinary-task",
          COWORK_RUN_ID: "ordinary-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_GLOBAL_INDEX: join(root, "workspaces.json"),
          COWORK_API_BASE: provider.baseUrl,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "protocol-fixture",
          COWORK_MODEL_API: api,
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_WEB_TOOLS: "0",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0"
        });
        const run = async (extra = []) => {
          child = spawn(
            process.execPath,
            [
              "scripts/atria.mjs",
              "--print",
              "--mode",
              "json",
              "--session-dir",
              sessions,
              "--skill",
              ordinarySkill,
              ...extra,
              `${phase}: verify the fixture tools`
            ],
            {
              cwd: resolve("."),
              env,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"]
            }
          );
          childExit = once(child, "exit");
          let pending = "";
          child.stdout.on("data", (chunk) => {
            output = (output + chunk).slice(-40_000);
            pending += chunk;
            const lines = pending.split("\n");
            pending = lines.pop();
            for (const line of lines) {
              try {
                events.push(JSON.parse(line));
              } catch {
                /* Startup diagnostics. */
              }
            }
          });
          child.stderr.on("data", (chunk) => {
            output = (output + chunk).slice(-40_000);
          });
          const [code] = await childExit;
          assert.equal(code, 0, output);
          assert.deepEqual(failures, [], output);
        };
        await run();
        assert.equal(mainStep, 2);
        const ordinarySessions = new Set(await readdir(sessions));
        await assert.rejects(
          readFile(join(workspace, "ordinary-task", "runs", "ordinary-run", "science-tools.json")),
          { code: "ENOENT" }
        );
        phase = "enabled";
        mainStep = 0;
        env.COWORK_TASK_ID = "science-task";
        env.COWORK_RUN_ID = "science-run";
        env.COWORK_SCIENCE_TOOLS = "1";
        if (["atria-rdkit-chemistry-v4", massVersion].includes(catalogVersion))
          env.COWORK_SCIENCE_CHEMISTRY_PYTHON = chemistryPython;
        if (catalogVersion === statisticsVersion) env.COWORK_SCIENCE_PYTHON = generalPython;
        if (catalogVersion !== statisticsVersion) {
          const pinDirectory = join(workspace, "science-task", "runs", "science-run");
          await mkdir(pinDirectory, { recursive: true });
          await writeFile(
            join(pinDirectory, "science-tools.json"),
            JSON.stringify({
              version: 1,
              catalogVersion,
              pythonExecutable: "python3",
              ...(["atria-rdkit-chemistry-v4", massVersion].includes(catalogVersion)
                ? { chemistryPythonExecutable: chemistryPython }
                : {})
            })
          );
        }
        await run();
        assert.equal(mainStep, 7);
        assert.equal(delegateStep, 4);
        const queue = new DurableScheduler(
          join(workspace, "science-task", "runs", "science-run", "queue.json")
        );
        const [dispatched] = await queue.list();
        assert.ok(dispatched.payload.skillRoots.includes(ordinarySkill));
        const scientificRoots = scienceSkillRoots({ enabled: true }, resolve("."));
        assert.ok(
          dispatched.payload.skillRoots.every((skillRoot) =>
            scientificRoots.every(
              (scientificRoot) =>
                skillRoot !== scientificRoot && !skillRoot.startsWith(`${scientificRoot}${sep}`)
            )
          ),
          "science roots follow the pinned science scope instead of becoming durable ordinary skills"
        );
        const [session] = (await readdir(sessions)).filter(
          (name) => name.endsWith(".jsonl") && !ordinarySessions.has(name)
        );
        assert.ok(session, await readdir(sessions));
        const pin = await readFile(
          join(workspace, "science-task", "runs", "science-run", "science-tools.json"),
          "utf8"
        );
        assert.equal(JSON.parse(pin).catalogVersion, catalogVersion);
        if (["atria-rdkit-chemistry-v4", massVersion].includes(catalogVersion))
          assert.equal(JSON.parse(pin).chemistryPythonExecutable, chemistryPython);
        phase = "disabled";
        mainStep = 0;
        env.COWORK_SCIENCE_TOOLS = "0";
        await run(["--session", join(sessions, session)]);
        assert.equal(mainStep, 4);
        assert.equal(
          await readFile(
            join(workspace, "science-task", "runs", "science-run", "science-tools.json"),
            "utf8"
          ),
          pin
        );
        assert.ok(
          mainRequests
            .at(-1)
            .body.messages.some((message) =>
              JSON.stringify(message).includes("Main and delegate verified their scientific computations")
            ),
          "history survives restart"
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "tool_execution_end" &&
              event.toolName === "science_run" &&
              event.isError === true
          ),
          `disabled execution is visibly failed to Pi: ${JSON.stringify(events.map((event) => ({ type: event.type, toolName: event.toolName, isError: event.isError, eventType: event.event?.type })).slice(-30))}`
        );
        assert.match(output, /Science is unavailable; ordinary work continued/);
      }
    );
  }
}
