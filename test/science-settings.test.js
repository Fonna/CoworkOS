import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScienceSettings } from "../dist/src/dashboard/science-settings.js";
import { handleScienceSettingsRequest } from "../dist/src/dashboard/science-settings-routes.js";
import { localRequestUrl, sendJson } from "../dist/src/dashboard/http.js";

const diagnostic = {
  python: { available: true, version: "3.11.9" },
  packages: {
    numpy: { available: true, version: "2.2.6" },
    scipy: { available: true, version: "1.15.3" },
    rdkit: { available: true, version: "2026.09.1", selfTestPassed: true }
  }
};

async function fixture(t, extraEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-science-settings-test-"));
  const path = join(root, "config.json");
  const config = { model: "preserved-model", apiKey: "fixture-only-secret", webTools: false };
  await writeFile(path, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { COWORK_CONFIG: path, ...extraEnv };
  return { root, path, config, env, settings: createScienceSettings(root, config, { env }) };
}

async function pythonFixture(
  f,
  script = `process.stdout.write(${JSON.stringify(JSON.stringify(diagnostic))});`
) {
  const path = join(f.root, "python-fixture");
  await writeFile(path, `#!${process.execPath}\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

async function api(t, settings) {
  let base;
  const server = createServer(async (request, response) => {
    try {
      const url = localRequestUrl(request, base);
      if (await handleScienceSettingsRequest(request, response, url, settings)) return;
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const call = async (path, body, headers) => {
    const response = await fetch(
      base + path,
      body === undefined
        ? { headers }
        : {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body)
          }
    );
    return { status: response.status, value: await response.json() };
  };
  return { base, call };
}

test("science settings persist atomically without touching old Run pins, queue or unrelated config", async (t) => {
  const f = await fixture(t);
  const run = join(f.root, "workspace", "task", "runs", "old");
  await mkdir(run, { recursive: true });
  const pin = JSON.stringify({
    version: 1,
    catalogVersion: "sciagentgym-e9dbbea-pilot-v1",
    pythonExecutable: "/pinned/python"
  });
  const queue = JSON.stringify({
    science: {
      enabled: true,
      catalogVersion: "sciagentgym-e9dbbea-analysis-v2",
      pythonExecutable: "/queued/python"
    }
  });
  await writeFile(join(run, "science-tools.json"), pin);
  await writeFile(join(run, "queue.json"), queue);
  await Promise.all([
    f.settings.save({ enabled: true, pythonExecutable: "/new/python" }),
    f.settings.save({ chemistryPythonExecutable: "/new/chemistry" })
  ]);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(saved.model, "preserved-model");
  assert.equal(saved.apiKey, "fixture-only-secret");
  assert.equal(saved.webTools, false);
  assert.deepEqual(saved.science, {
    enabled: true,
    pythonExecutable: "/new/python",
    chemistryPythonExecutable: "/new/chemistry"
  });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(run, "science-tools.json"), "utf8"), pin);
  assert.equal(await readFile(join(run, "queue.json"), "utf8"), queue);
  assert.doesNotMatch(JSON.stringify(f.settings.status()), /fixture-only-secret/);
  const before = await readFile(f.path, "utf8");
  await assert.rejects(f.settings.save({ enabled: true, install: true }));
  await assert.rejects(f.settings.save({ pythonExecutable: "../python" }));
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("environment-managed fields are protected while independent paths remain editable", async (t) => {
  const f = await fixture(t, { COWORK_SCIENCE_TOOLS: "1" });
  assert.equal(f.settings.status().enabled, true);
  assert.deepEqual(f.settings.status().managedFields, {
    enabled: true,
    pythonExecutable: false,
    chemistryPythonExecutable: false
  });
  await f.settings.save({ pythonExecutable: "/saved/python", chemistryPythonExecutable: "/saved/chemistry" });
  const original = await readFile(f.path, "utf8");
  await assert.rejects(
    f.settings.save({ enabled: false }),
    (error) => error.status === 409 && error.code === "managed_by_environment"
  );
  assert.equal(await readFile(f.path, "utf8"), original);
  assert.equal(f.settings.status().enabled, true);
  assert.equal(f.settings.status().chemistryPythonExecutable, "/saved/chemistry");
});

test(
  "GET and save stay metadata-only; explicit HTTP check can test an unsaved interpreter",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const marker = join(f.root, "probe-started");
    const python = await pythonFixture(
      f,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdout.write(${JSON.stringify(JSON.stringify(diagnostic))});`
    );
    const { call } = await api(t, f.settings);
    assert.equal((await call("/api/science-settings")).value.enabled, false);
    const saved = await call("/api/science-settings", {
      enabled: true,
      pythonExecutable: "/not-installed/python"
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.appliesTo, "new-runs");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const original = await readFile(f.path, "utf8");
    const checked = await call("/api/science-settings/check", {
      target: "chemistry",
      pythonExecutable: python
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.value.ok, true, JSON.stringify(checked.value));
    assert.equal(checked.value.pythonExecutable, python);
    assert.equal(checked.value.packages.rdkit.version, "2026.09.1");
    assert.equal(await readFile(marker, "utf8"), "started");
    assert.equal(await readFile(f.path, "utf8"), original, "checking a draft never saves it");
    assert.equal((await call("/api/science-settings/check")).status, 405);
    assert.equal(
      (await call("/api/science-settings/check", { target: "general", modules: ["os"] })).status,
      400
    );
    assert.equal(
      (await call("/api/science-settings", { enabled: true }, { origin: "https://foreign.invalid" })).status,
      403
    );
    assert.equal((await call("/api/science-settings", { pythonExecutable: "x".repeat(20000) })).status, 413);
  }
);

test(
  "explicit checks honor host-managed interpreter selection and limit concurrency",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const python = await pythonFixture(
      f,
      `setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(diagnostic))}),300);`
    );
    const settings = createScienceSettings(f.root, f.config, {
      env: { ...f.env, COWORK_SCIENCE_PYTHON: python }
    });
    const first = settings.check({ target: "general", pythonExecutable: "/not-selected/python" });
    const second = settings.check({ target: "chemistry" });
    await assert.rejects(
      settings.check({ target: "general" }),
      (error) => error.status === 429 && error.code === "check_busy"
    );
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.pythonExecutable, python);
    }
    const controller = new AbortController();
    const cancelled = settings.check({ target: "general" }, controller.signal);
    controller.abort();
    assert.equal((await cancelled).error.code, "cancelled");
    assert.equal(
      (await settings.check({ target: "general" })).ok,
      true,
      "cancellation releases the check slot"
    );
  }
);

test(
  "a new independent chemistry draft can be checked while the inherited general Python is managed",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, { COWORK_SCIENCE_PYTHON: "/missing/managed-general-python" });
    const draft = await pythonFixture(f);
    const checked = await f.settings.check({ target: "chemistry", pythonExecutable: draft });
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(checked.pythonExecutable, draft);
    assert.equal(f.settings.status().chemistryPythonExecutable, "/missing/managed-general-python");
    assert.equal(f.settings.status().chemistryInheritsGeneral, true, "checking does not save the draft");
    const managed = createScienceSettings(f.root, f.config, {
      env: { ...f.env, COWORK_SCIENCE_CHEMISTRY_PYTHON: draft }
    });
    const locked = await managed.check({ target: "chemistry", pythonExecutable: "/missing/ignored-draft" });
    assert.equal(locked.ok, true, JSON.stringify(locked));
    assert.equal(locked.pythonExecutable, draft, "an explicitly managed chemistry interpreter stays fixed");
  }
);
