import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const pilotVersion = "sciagentgym-e9dbbea-pilot-v1";
const analysisVersion = "sciagentgym-e9dbbea-analysis-v2";
const astronomyVersion = "sciagentgym-e9dbbea-astronomy-v3";
const chemistryVersion = "atria-rdkit-chemistry-v4";
const materialsVersion = "sciagentgym-e9dbbea-materials-v5";
const massVersion = "sciagentgym-e9dbbea-mass-spec-v6";
const statisticsVersion = "atria-statistics-v7";
const chemistryPython = process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON;
const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
const scienceNames = ["science_search", "science_describe", "science_run"];

function definitions(body, api) {
  return (body.tools ?? []).map((tool) => (api === "openai-responses" ? tool : tool.function));
}

function lastToolText(body, api) {
  const value =
    api === "openai-responses"
      ? body.input.findLast((item) => item.type === "function_call_output")?.output
      : body.messages.findLast((item) => item.role === "tool")?.content;
  return typeof value === "string" ? value : (value ?? []).map((part) => part.text ?? "").join("\n");
}

function assertNoScience(body, api) {
  const tools = definitions(body, api);
  assert.ok(scienceNames.every((name) => !tools.some((tool) => tool.name === name)));
  const enable = tools.find((tool) => tool.name === "enable_tools");
  assert.ok(enable, "ordinary capability discovery remains available");
  assert.ok(!JSON.stringify(enable).includes('"science"'), "science is absent from the capability enum");
}

async function fixture(t, api, handle, science) {
  const received = [],
    failures = [];
  let dashboard;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ data: [{ id: "science-retry-fixture" }] }));
    }
    try {
      const raw = await readFixtureRequestBody(request);
      const body = JSON.parse(raw);
      assert.equal(request.url, api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
      const snapshot = await new MainRequestStore(
        mainRequestPath(dashboard.workspaceRoot, "science-retry-task"),
        "science-retry-task"
      ).read();
      received.push({ raw, body, snapshot, path: request.url });
      const reply = await handle({ received, body, dashboard, api });
      if (reply.reject) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "isolated scientific Main request failure" } }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          protocolStream(api, reply).replaceAll("call_protocol", `science_call_${received.length}`)
        );
      }
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream(api, { text: "Scientific fixture assertion failed." }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await dashboard?.stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${server.address().port}`,
    model: "science-retry-fixture",
    science
  });
  await writeFile(join(dashboard.root, "config.json"), JSON.stringify({ api, mainMaxTokens: 256 }));
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(
    join(dashboard.root, "pi", "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
  );
  const call = async (path, body, expected = 200) => {
    const response = await fetch(
      `${dashboard.base}${path}`,
      body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  await call(
    "/api/tasks",
    { taskId: "science-retry-task", goal: "Verify scientific recovery", projectId: dashboard.projectId },
    201
  );
  const run = (body) => call("/api/tasks/science-retry-task/run", body, 202);
  const settle = async (status) => {
    for (let attempt = 0; attempt < 1200; attempt++) {
      const detail = await call("/api/tasks/science-retry-task");
      if (!detail.runtime.active) {
        assert.deepEqual(failures, [], failures.map((error) => error.stack).join("\n"));
        assert.equal(detail.task.status, status, JSON.stringify(detail.task));
        return detail;
      }
      await delay(50);
    }
    assert.fail("The real scientific Main process did not settle");
  };
  const pin = (runId) =>
    join(dashboard.workspaceRoot, "science-retry-task", "runs", runId, "science-tools.json");
  return { dashboard, received, run, settle, pin, call };
}

for (const api of ["openai-completions", "openai-responses"]) {
  for (const [originalVersion, sameRun] of [
    [pilotVersion, false],
    [analysisVersion, false],
    [analysisVersion, true],
    [astronomyVersion, false],
    [chemistryVersion, false],
    [materialsVersion, false],
    [materialsVersion, true],
    [massVersion, false],
    [statisticsVersion, false]
  ]) {
    const targetRunId = sameRun ? "legacy-original" : "legacy-retry";
    const originalTotal =
      originalVersion === pilotVersion
        ? 12
        : originalVersion === analysisVersion
          ? 18
          : originalVersion === astronomyVersion
            ? 26
            : originalVersion === chemistryVersion
              ? 29
              : originalVersion === materialsVersion
                ? 33
                : originalVersion === massVersion
                  ? 37
                  : 40;
    test(
      `${api}: manual Main ${sameRun ? "same Run" : "new Run"} retry preserves ${originalVersion} under the v7 default`,
      { timeout: 120000 },
      async (t) => {
        if ([chemistryVersion, materialsVersion, massVersion].includes(originalVersion) && !chemistryPython)
          return t.skip("Set COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON for RDKit retry acceptance");
        if (originalVersion === statisticsVersion && !process.env.COWORK_SCIENCE_TEST_PYTHON)
          return t.skip("Set COWORK_SCIENCE_TEST_PYTHON for statistical retry acceptance");
        const f = await fixture(
          t,
          api,
          ({ received, body }) => {
            const step = received.length;
            if (step === 1) {
              const enable = definitions(body, api).find((tool) => tool.name === "enable_tools");
              assert.ok(JSON.stringify(enable).includes('"science"'));
              return { name: "enable_tools", arguments: { groups: ["science"] } };
            }
            if (step === 2) return { name: "science_search", arguments: { limit: 12 } };
            if (step === 3 || step === 6) {
              const result = JSON.parse(lastToolText(body, api));
              assert.equal(result.ok, true);
              assert.equal(result.catalogVersion, originalVersion);
              assert.equal(result.total, originalTotal);
              assert.equal(result.tools.length, 12);
              if ([pilotVersion, analysisVersion].includes(originalVersion))
                assert.ok(!result.tools.some((tool) => tool.domain === "astronomy"));
              if (originalVersion === pilotVersion)
                assert.ok(!result.tools.some((tool) => tool.name === "fit_calibration_curve"));
              return step === 3
                ? { reject: true }
                : { text: "Original catalog and retained scientific computation recovered." };
            }
            if (step === 4) {
              assert.equal(
                received[3].raw,
                received[2].raw,
                "the archived model request is replayed byte for byte"
              );
              assert.equal(received[3].snapshot.runId, targetRunId);
              return {
                name: "science_run",
                arguments:
                  originalVersion === pilotVersion
                    ? { name: "nm_to_eV", arguments: { wavelength_nm: 500 } }
                    : originalVersion === analysisVersion
                      ? { name: "bragg_law_d_spacing", arguments: { two_theta: 60 } }
                      : originalVersion === astronomyVersion
                        ? { name: "distance_from_modulus", arguments: { mu: 10 } }
                        : originalVersion === statisticsVersion
                          ? { name: "summarize_numeric_data", arguments: { values: [1, 2, 3, 4] } }
                          : { name: "rdkit_molecular_descriptors", arguments: { smiles: "CCO" } }
              };
            }
            assert.equal(step, 5);
            const computed = JSON.parse(lastToolText(body, api));
            assert.equal(computed.ok, true, JSON.stringify(computed));
            if (originalVersion === statisticsVersion) {
              assert.equal(computed.result.mean, 2.5);
              assert.equal(computed.result.count, 4);
            } else {
              assert.ok(
                Math.abs(
                  ([chemistryVersion, materialsVersion, massVersion].includes(originalVersion)
                    ? computed.result.molecular_weight
                    : computed.result) -
                    (originalVersion === pilotVersion
                      ? 2.479683968664005
                      : originalVersion === analysisVersion
                        ? 1.5406
                        : originalVersion === astronomyVersion
                          ? 1000
                          : 46.069)
                ) < 1e-10
              );
            }
            assert.equal(computed.metadata.catalogVersion, originalVersion);
            return { name: "science_search", arguments: { limit: 12 } };
          },
          { enabled: true, pythonExecutable: python }
        );
        const originalPin =
          JSON.stringify(
            {
              version: 1,
              catalogVersion: originalVersion,
              pythonExecutable: python,
              ...([chemistryVersion, materialsVersion, massVersion].includes(originalVersion)
                ? { chemistryPythonExecutable: chemistryPython }
                : {})
            },
            null,
            2
          ) + "\n";
        await mkdir(dirname(f.pin("legacy-original")), { recursive: true });
        await writeFile(f.pin("legacy-original"), originalPin);
        await f.run({
          runId: "legacy-original",
          prompt:
            originalVersion === pilotVersion
              ? "List the scientific catalog and calculate the photon energy for 500 nm."
              : originalVersion === analysisVersion
                ? "List the scientific catalog and calculate the Bragg spacing for 2theta=60 degrees."
                : originalVersion === astronomyVersion
                  ? "List the scientific catalog and calculate the distance for true distance modulus 10."
                  : originalVersion === statisticsVersion
                    ? "List the scientific catalog and summarize the numeric observations 1, 2, 3, 4."
                    : "List the scientific catalog and compute the molecular descriptors of ethanol SMILES CCO."
        });
        const failed = await f.settle("failed");
        assert.equal(failed.task.activeRunId, "legacy-original");
        assert.equal(f.received.length, 3);
        const retryArchive = mainRequestPath(f.dashboard.workspaceRoot, "science-retry-task");
        const originalSnapshot = await readFile(retryArchive);
        const conflictPinPath = f.pin("legacy-conflicting");
        const conflictInputPath = join(dirname(conflictPinPath), "main-input.json");
        const conflictPin = Buffer.from(
          JSON.stringify(
            { version: 1, catalogVersion: "conflicting-catalog-unavailable", pythonExecutable: python },
            null,
            2
          ) + "\n"
        );
        const conflictInput = Buffer.from(
          JSON.stringify(
            {
              version: 1,
              prompt: "TARGET_INPUT_SENTINEL_MUST_SURVIVE_SCIENCE_SCOPE_CONFLICT",
              submittedAt: 123,
              taskId: "science-retry-task",
              runId: "legacy-conflicting"
            },
            null,
            2
          ) + "\n"
        );
        await mkdir(dirname(conflictPinPath), { recursive: true });
        await writeFile(conflictPinPath, conflictPin);
        await writeFile(conflictInputPath, conflictInput);
        await f.dashboard.restart({
          science: { enabled: true, pythonExecutable: join(f.dashboard.root, "missing-replacement-python") }
        });
        const rejected = await fetch(`${f.dashboard.base}/api/tasks/science-retry-task/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resume: true,
            runId: "legacy-conflicting",
            retryRequestId: failed.retryRequest.requestId
          })
        });
        const rejection = await rejected.json();
        assert.deepEqual(
          await readFile(retryArchive),
          originalSnapshot,
          "the source retry archive stays byte-identical after a scientific scope conflict"
        );
        assert.deepEqual(
          await readFile(f.pin("legacy-original")),
          Buffer.from(originalPin),
          "the original scientific pin is not rewritten"
        );
        assert.deepEqual(
          await readFile(conflictPinPath),
          conflictPin,
          "the conflicting destination pin is not replaced"
        );
        assert.deepEqual(
          await readFile(conflictInputPath),
          conflictInput,
          "a refused scientific retry must not overwrite the destination's accepted input"
        );
        assert.equal(rejected.status, 409, JSON.stringify(rejection));
        assert.equal(rejection.code, "main_retry_context_changed", JSON.stringify(rejection));
        assert.equal((await f.settle("failed")).task.activeRunId, "legacy-original");
        assert.equal(f.received.length, 3, "a scientific scope conflict is rejected before model HTTP");
        await f.run({
          resume: true,
          ...(sameRun ? {} : { runId: targetRunId }),
          retryRequestId: failed.retryRequest.requestId
        });
        const completed = await f.settle("completed");
        assert.equal(completed.task.activeRunId, targetRunId);
        assert.equal(f.received.length, 6);
        assert.equal(await readFile(f.pin(targetRunId), "utf8"), originalPin);
        assert.equal(await readFile(f.pin("legacy-original"), "utf8"), originalPin);
        assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
      }
    );
  }

  for (const sameRun of [false, true]) {
    test(
      `${api}: an ordinary unpinned request stays ordinary on ${sameRun ? "same Run UI retry" : "new Run retry"} after science is enabled`,
      { timeout: 120000 },
      async (t) => {
        const targetRunId = sameRun ? "ordinary-original" : "ordinary-retry";
        let archivedBody;
        const f = await fixture(
          t,
          api,
          ({ received, body, dashboard }) => {
            assertNoScience(body, api);
            if (received.length === 1 || received.length === 3) {
              if (received.length === 3) {
                assert.equal(
                  received[2].raw,
                  archivedBody,
                  "science opt-in cannot regenerate or widen the exact archived request bytes"
                );
                assert.equal(received[2].snapshot.body, archivedBody);
                assert.equal(received[2].snapshot.runId, targetRunId);
              }
              return { name: "read", arguments: { path: join(dashboard.workspaceRoot, "ordinary.txt") } };
            }
            assert.match(lastToolText(body, api), /ORDINARY_DATA_REMAINS_AVAILABLE/);
            return received.length === 2
              ? { reject: true }
              : { text: "Ordinary file tools recovered without adding science." };
          },
          { enabled: false }
        );
        await writeFile(join(f.dashboard.workspaceRoot, "ordinary.txt"), "ORDINARY_DATA_REMAINS_AVAILABLE\n");
        await f.run({ runId: "ordinary-original", prompt: "Read ordinary.txt and report its content." });
        const failed = await f.settle("failed");
        assert.equal(f.received.length, 2);
        const archive = JSON.parse(
          await readFile(mainRequestPath(f.dashboard.workspaceRoot, "science-retry-task"), "utf8")
        );
        archivedBody = archive.body;
        assert.equal(archivedBody, f.received[1].raw);
        await assert.rejects(readFile(f.pin("ordinary-original")), { code: "ENOENT" });
        await f.dashboard.restart({ science: { enabled: true, pythonExecutable: python } });
        await f.run({
          resume: true,
          retryRequestId: failed.retryRequest.requestId,
          ...(sameRun ? {} : { runId: targetRunId })
        });
        const completed = await f.settle("completed");
        assert.equal(completed.task.activeRunId, targetRunId);
        assert.equal(f.received.length, 4);
        assert.equal(JSON.parse(await readFile(f.pin(targetRunId), "utf8")).scope, "none");
        if (!sameRun) await assert.rejects(readFile(f.pin("ordinary-original")), { code: "ENOENT" });
        assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
      }
    );
  }
}

test(
  "real Main reads local CSV, computes v2 linear calibration and writes a normal result file",
  { timeout: 120000 },
  async (t) => {
    const scientificPython = process.env.COWORK_SCIENCE_TEST_PYTHON;
    if (!scientificPython)
      return t.skip("Set COWORK_SCIENCE_TEST_PYTHON to an isolated Python with NumPy for the data pipeline");
    const probe = spawnSync(scientificPython, ["-I", "-c", "import numpy"], {
      env: {},
      timeout: 30000,
      encoding: "utf8"
    });
    if (probe.error || probe.status !== 0)
      return t.skip(
        "NumPy is unavailable in COWORK_SCIENCE_TEST_PYTHON; retry compatibility tests still run"
      );
    const api = "openai-completions";
    let rows, report;
    const f = await fixture(
      t,
      api,
      ({ received, body, dashboard }) => {
        const step = received.length;
        if (step === 1)
          return { name: "read", arguments: { path: join(dashboard.workspaceRoot, "calibration.csv") } };
        if (step === 2) {
          const text = lastToolText(body, api);
          assert.match(text, /concentration,response/);
          rows = [
            ...text.matchAll(/(?:^|\n)(?:\s*\d+[|:]\s*)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?=\n|$)/gu)
          ].map((match) => [Number(match[1]), Number(match[2])]);
          assert.equal(rows.length, 4, text);
          return { name: "enable_tools", arguments: { groups: ["science"] } };
        }
        if (step === 3) return { name: "science_describe", arguments: { name: "fit_calibration_curve" } };
        if (step === 4) {
          const described = JSON.parse(lastToolText(body, api));
          assert.equal(described.catalogVersion, analysisVersion);
          assert.equal(described.parameters.properties.model.const, "linear");
          return {
            name: "science_run",
            arguments: {
              name: "fit_calibration_curve",
              arguments: {
                concentrations: rows.map((row) => row[0]),
                responses: rows.map((row) => row[1]),
                predict_at: [1.5]
              }
            }
          };
        }
        if (step === 5) {
          const computed = JSON.parse(lastToolText(body, api));
          assert.equal(computed.ok, true, JSON.stringify(computed));
          assert.equal(computed.metadata.catalogVersion, analysisVersion);
          report = {
            samples: rows.length,
            slope: computed.result.parameters[0],
            intercept: computed.result.parameters[1],
            predictedAt1_5: computed.result.predictions[0]
          };
          return {
            name: "write",
            arguments: {
              path: join(dashboard.workspaceRoot, "calibration-result.json"),
              content: JSON.stringify(report) + "\n"
            }
          };
        }
        assert.equal(step, 6);
        return { text: "The CSV calibration result has been written." };
      },
      { enabled: true, pythonExecutable: scientificPython }
    );
    await writeFile(
      join(f.dashboard.workspaceRoot, "calibration.csv"),
      "concentration,response\n0,1\n1,3\n2,5\n3,7\n"
    );
    await mkdir(dirname(f.pin("analysis-pipeline")), { recursive: true });
    await writeFile(
      f.pin("analysis-pipeline"),
      JSON.stringify({
        version: 1,
        catalogVersion: analysisVersion,
        pythonExecutable: scientificPython
      })
    );
    await f.run({
      runId: "analysis-pipeline",
      prompt:
        "Read calibration.csv, fit a straight line and write calibration-result.json with its coefficients and response predicted at concentration 1.5."
    });
    await f.settle("completed");
    const saved = JSON.parse(
      await readFile(join(f.dashboard.workspaceRoot, "calibration-result.json"), "utf8")
    );
    assert.deepEqual(saved, report);
    assert.equal(saved.samples, 4);
    assert.ok(Math.abs(saved.slope - 2) < 1e-12);
    assert.ok(Math.abs(saved.intercept - 1) < 1e-12);
    assert.ok(Math.abs(saved.predictedAt1_5 - 4) < 1e-12);
  }
);

for (const api of ["openai-completions", "openai-responses"]) {
  test(
    `${api}: saved science settings start a real Main with separate pinned chemistry environment`,
    { timeout: 120000 },
    async (t) => {
      if (!chemistryPython)
        return t.skip("Set COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON for settings-to-Main acceptance");
      const f = await fixture(t, api, ({ received, body }) => {
        const step = received.length;
        if (step === 1) return { name: "enable_tools", arguments: { groups: ["science"] } };
        if (step === 2)
          return { name: "science_describe", arguments: { name: "rdkit_molecular_descriptors" } };
        if (step === 3) {
          const described = JSON.parse(lastToolText(body, api));
          assert.equal(described.catalogVersion, statisticsVersion);
          assert.equal(described.source.kind, "atria-native");
          return {
            name: "science_run",
            arguments: { name: "rdkit_molecular_descriptors", arguments: { smiles: "CCO" } }
          };
        }
        assert.equal(step, 4);
        const result = JSON.parse(lastToolText(body, api));
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.metadata.catalogVersion, statisticsVersion);
        assert.ok(Math.abs(result.result.molecular_weight - 46.069) < 1e-10);
        assert.equal(result.result.rdkit_version, "2026.09.1");
        return { text: "Saved separate chemistry environment computed the ethanol descriptors." };
      });
      const initial = await f.call("/api/science-settings");
      assert.equal(initial.enabled, false);
      await f.call("/api/science-settings", {
        enabled: true,
        pythonExecutable: python,
        chemistryPythonExecutable: chemistryPython
      });
      const checked = await f.call("/api/science-settings/check", { target: "chemistry" });
      assert.equal(checked.ok, true, JSON.stringify(checked));
      await f.run({
        runId: "configured-chemistry",
        prompt: "Compute ethanol molecular descriptors using science_run for SMILES CCO."
      });
      await f.settle("completed");
      const original = await readFile(f.pin("configured-chemistry"), "utf8");
      assert.equal(JSON.parse(original).chemistryPythonExecutable, chemistryPython);
      await f.call("/api/science-settings", {
        pythonExecutable: "/missing/new-general",
        chemistryPythonExecutable: "/missing/new-chemistry"
      });
      assert.equal(await readFile(f.pin("configured-chemistry"), "utf8"), original);
    }
  );
}
