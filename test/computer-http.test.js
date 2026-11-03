import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createDashboardApplication } from "../dist/src/dashboard/application.js";

test("a lost HTTP response after action dispatch reports unknown and never retries", async () => {
  let attempts = 0;
  const server = createHttpServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume the already-sent request */
    }
    attempts++;
    response.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previousBase = process.env.COWORK_DASHBOARD_URL;
  process.env.COWORK_DASHBOARD_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { createJiti } = await import(requirePi.resolve("jiti"));
    const { registerComputerTools } = await createJiti(import.meta.url).import(
      resolve(".pi/runtime/tools/computer-use.ts")
    );
    const tools = new Map();
    registerComputerTools({ registerTool: (tool) => tools.set(tool.name, tool) }, "transport-fixture");
    const result = await tools.get("computer_act").execute(
      "act",
      {
        sessionId: "fixture-session",
        observationId: "fixture-observation",
        action: { type: "activate" }
      },
      undefined,
      undefined,
      { model: { input: ["text"] } }
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.dispatchStatus, "unknown");
    assert.equal(result.details.requiresObservation, true);
    assert.equal(result.details.errorCode, "transport_failed");
    assert.equal(attempts, 1);
    const abort = new AbortController();
    abort.abort();
    const beforeSend = await tools.get("computer_act").execute(
      "abort-before-send",
      {
        sessionId: "fixture-session",
        observationId: "fixture-observation",
        action: { type: "activate" }
      },
      abort.signal,
      undefined,
      { model: { input: ["text"] } }
    );
    assert.equal(beforeSend.details.dispatchStatus, "not_sent");
    assert.equal(attempts, 1);
  } finally {
    if (previousBase === undefined) delete process.env.COWORK_DASHBOARD_URL;
    else process.env.COWORK_DASHBOARD_URL = previousBase;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test("computer HTTP consumes only desktop grants and isolates tasks, observations and pause", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-computer-http-"));
  await writeFile(join(root, "config.json"), "{}");
  await symlink(resolve("web"), join(root, "web"));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const target = {
    pid: 11,
    windowId: 12,
    bundleId: "org.atria.probe",
    application: "Probe",
    title: "Safe fixture"
  };
  const effects = [];
  let agentTools;
  const dashboard = createDashboardApplication({
    projectRoot: root,
    port,
    computerDriver: {
      status: async () => ({
        available: true,
        screenRecording: true,
        accessibility: true,
        windows: [target]
      }),
      observe: async () => ({
        width: 1,
        height: 1,
        image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        accessibilityText: "AXButton · Save",
        accessibility: {
          available: true,
          truncated: false,
          elements: [
            {
              elementId: "root",
              role: "AXButton",
              name: "Save",
              enabled: true,
              actions: ["press"],
              path: [],
              identity: "native-button",
              fingerprint: "snapshot"
            }
          ]
        }
      }),
      act: async (_target, action) => {
        effects.push(action.type);
      }
    }
  });
  dashboard.server.listen(port, "127.0.0.1");
  await once(dashboard.server, "listening");
  const base = dashboard.dashboardUrl;
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  try {
    assert.equal((await post("/api/tasks", { taskId: "computer-task", goal: "probe" })).status, 201);
    assert.equal((await post("/api/tasks", { taskId: "other-task", goal: "other" })).status, 201);
    assert.equal(
      (
        await post("/api/tasks/computer-task/computer/authorize", {
          ...target,
          mode: "control",
          authorizedBy: "human"
        })
      ).status,
      404
    );
    assert.equal(
      (await post("/api/tasks/computer-task/computer/observe", { sessionId: "forged" })).status,
      403
    );
    const grant = await dashboard.computerHostRequest({
      operation: "authorize",
      taskId: "computer-task",
      ...target,
      mode: "control"
    });
    const observed = await (
      await post("/api/tasks/computer-task/computer/observe", { sessionId: grant.sessionId })
    ).json();
    assert.equal(typeof observed.observationId, "string");
    const previewRead = await post("/api/tasks/computer-task/computer/preview", {
      sessionId: grant.sessionId
    });
    assert.equal(previewRead.status, 200);
    const refreshedPreview = (await previewRead.json()).preview;
    assert.equal(refreshedPreview.sessionId, grant.sessionId);
    assert.equal(refreshedPreview.observationId, undefined);
    assert.equal(
      (await post("/api/tasks/other-task/computer/preview", { sessionId: grant.sessionId })).status,
      403
    );
    assert.equal(
      (
        await post("/api/tasks/other-task/computer/act", {
          sessionId: grant.sessionId,
          observationId: observed.observationId,
          action: { type: "activate" }
        })
      ).status,
      403
    );
    assert.equal(
      (
        await post("/api/tasks/computer-task/computer/act", {
          sessionId: grant.sessionId,
          observationId: observed.observationId,
          action: { type: "activate" }
        })
      ).status,
      200
    );
    const previousBase = process.env.COWORK_DASHBOARD_URL;
    process.env.COWORK_DASHBOARD_URL = base;
    try {
      const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
      const { createJiti } = await import(requirePi.resolve("jiti"));
      const jiti = createJiti(import.meta.url);
      const { registerComputerTools } = await jiti.import(resolve(".pi/runtime/tools/computer-use.ts"));
      const tools = new Map();
      agentTools = tools;
      registerComputerTools({ registerTool: (tool) => tools.set(tool.name, tool) }, "computer-task");
      assert.deepEqual(
        [...tools.keys()],
        [
          "computer_status",
          "computer_discover",
          "computer_select",
          "computer_release",
          "computer_observe",
          "computer_wait",
          "computer_act"
        ]
      );
      const ready = await tools.get("computer_status").execute("status", {});
      assert.equal(ready.details.authorizationRequired, false);
      assert.equal(ready.details.session.sessionId, grant.sessionId);
      const imageResult = await tools
        .get("computer_observe")
        .execute("visual", { sessionId: grant.sessionId }, undefined, undefined, {
          model: { input: ["text", "image"] }
        });
      assert.equal(imageResult.isError, undefined);
      const picture = imageResult.content.find((block) => block.type === "image");
      assert.equal(picture.mimeType, "image/png");
      assert.deepEqual(
        Buffer.from(picture.data, "base64").subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );
      assert.equal(imageResult.details.image, undefined);
      assert.equal(JSON.parse(imageResult.content[0].text).image, undefined);
      const acted = await tools.get("computer_act").execute(
        "activate",
        {
          sessionId: grant.sessionId,
          observationId: imageResult.details.observationId,
          action: { type: "activate" }
        },
        undefined,
        undefined,
        { model: { input: ["text", "image"] } }
      );
      assert.equal(acted.isError, undefined);
      assert.equal(acted.details.dispatched, true);
      assert.equal(acted.details.effectVerified, false);
      assert.equal(acted.details.requiresObservation, false);
      assert.equal(acted.content[1].type, "image");
      assert.equal(acted.details.observation.image, undefined);
      const metadata = JSON.parse(acted.content[0].text);
      assert.equal(metadata.observation.image, undefined);
      const preview = (await (await fetch(`${base}/api/tasks/computer-task/computer/preview`)).json())
        .preview;
      assert.equal(preview.sessionId, grant.sessionId);
      assert.equal(preview.observationId, undefined);
      assert.equal(
        (await (await fetch(`${base}/api/tasks/other-task/computer/preview`)).json()).preview,
        null
      );
      const textResult = await tools
        .get("computer_observe")
        .execute("text", { sessionId: grant.sessionId }, undefined, undefined, {
          model: { input: ["text"] }
        });
      assert.equal(textResult.content.length, 1);
      assert.equal(textResult.details.delivered, false);
      const denied = await tools.get("computer_act").execute(
        "click",
        {
          sessionId: grant.sessionId,
          observationId: textResult.details.observationId,
          action: { type: "click", x: 0, y: 0, button: "left" }
        },
        undefined,
        undefined,
        { model: { input: ["text"] } }
      );
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /不支持图像输入/);
      const waited = await tools.get("computer_wait").execute(
        "wait",
        {
          sessionId: grant.sessionId,
          condition: { type: "element", name: "Save", state: "enabled" },
          timeoutMs: 100
        },
        undefined,
        undefined,
        { model: { input: ["text"] } }
      );
      assert.equal(waited.details.status, "condition_met");
      assert.equal(waited.details.observation.image, undefined);
      const pressed = await tools.get("computer_act").execute(
        "press",
        {
          sessionId: grant.sessionId,
          observationId: waited.details.observation.observationId,
          action: { type: "press", elementId: waited.details.observation.accessibility.elements[0].elementId }
        },
        undefined,
        undefined,
        { model: { input: ["text"] } }
      );
      assert.equal(pressed.isError, undefined);
      assert.equal(pressed.details.dispatchStatus, "sent");
      const stale = await post("/api/tasks/computer-task/computer/act", {
        sessionId: grant.sessionId,
        observationId: waited.details.observation.observationId,
        action: { type: "activate" }
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).errorCode, "stale_observation");
      for (const body of [
        { condition: {}, timeoutMs: 10 },
        { condition: { type: "element", name: "Save", state: "present" }, timeoutMs: "10" }
      ])
        assert.equal(
          (await post("/api/tasks/computer-task/computer/wait", { sessionId: grant.sessionId, ...body }))
            .status,
          400
        );
    } finally {
      if (previousBase === undefined) delete process.env.COWORK_DASHBOARD_URL;
      else process.env.COWORK_DASHBOARD_URL = previousBase;
    }
    await dashboard.computerHostRequest({ operation: "pause" });
    const pausedPreviousBase = process.env.COWORK_DASHBOARD_URL;
    process.env.COWORK_DASHBOARD_URL = base;
    try {
      const paused = await agentTools.get("computer_status").execute("paused", {});
      assert.equal(paused.details.authorizationRequired, true);
      assert.equal(paused.details.availability.screenRecording, true);
      assert.match(paused.details.nextStep, /设置或人工接管栏/);
      assert.equal(paused.details.availability.windows, undefined);
      const denied = await agentTools
        .get("computer_observe")
        .execute("expired", { sessionId: grant.sessionId }, undefined, undefined, {
          model: { input: ["text", "image"] }
        });
      assert.equal(denied.isError, true);
      assert.equal(denied.details.status, 403);
      assert.equal(denied.details.authorizationRequired, true);
      assert.match(denied.details.nextStep, /computer_status/);
    } finally {
      if (pausedPreviousBase === undefined) delete process.env.COWORK_DASHBOARD_URL;
      else process.env.COWORK_DASHBOARD_URL = pausedPreviousBase;
    }
    assert.equal(
      (await post("/api/tasks/computer-task/computer/observe", { sessionId: grant.sessionId })).status,
      403
    );
    const status = await (await fetch(`${base}/api/tasks/computer-task/computer`)).json();
    assert.equal(status.session.state, "paused");
    assert.deepEqual(effects, ["activate", "activate", "press"]);
    assert.equal(
      (await (await fetch(`${base}/api/tasks/computer-task/computer/preview`)).json()).preview,
      null
    );
    assert.equal(
      (
        await fetch(`${base}/api/tasks/computer-task/computer`, {
          headers: { origin: "https://untrusted.example" }
        })
      ).status,
      403
    );
    for (const path of ["/api/computer/policy", "/api/tasks/computer-task/computer/resume"])
      assert.equal((await post(path, { enabled: true, mode: "control" })).status, 404);
    assert.equal(
      (await post("/api/tasks/computer-task/computer/select", { ...target, mode: "control" })).status,
      403
    );
    await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "observe" });
    assert.equal(
      (await post("/api/tasks/computer-task/computer/select", { ...target, mode: "control" })).status,
      403
    );
    const discovered = await (await post("/api/tasks/computer-task/computer/discover", {})).json();
    assert.deepEqual(discovered.windows, [target]);
    const selected = (
      await (await post("/api/tasks/computer-task/computer/select", { ...target, mode: "observe" })).json()
    ).session;
    const access = await (await fetch(`${base}/api/computer/access`)).json();
    assert.equal(access.owner.taskId, "computer-task");
    let finished = false;
    const queued = post("/api/tasks/other-task/computer/select", { ...target, mode: "observe" }).then(
      (result) => {
        finished = true;
        return result;
      }
    );
    await post("/api/tasks/computer-task/computer/observe", { sessionId: selected.sessionId });
    assert.equal(finished, false);
    await dashboard.computerHostRequest({ operation: "pause" });
    assert.equal((await queued).status, 403);
    assert.equal(
      (await post("/api/tasks/other-task/computer/select", { ...target, mode: "observe" })).status,
      403
    );
    await dashboard.computerHostRequest({ operation: "resume" });
    const restored = (await (await fetch(`${base}/api/tasks/computer-task/computer`)).json()).session;
    assert.notEqual(restored.sessionId, selected.sessionId);
    assert.equal((await post("/api/tasks/computer-task/action", { action: "cancel" })).status, 200);
    assert.equal(
      (await post("/api/tasks/computer-task/computer/select", { ...target, mode: "observe" })).status,
      403
    );
    const other = (
      await (await post("/api/tasks/other-task/computer/select", { ...target, mode: "observe" })).json()
    ).session;
    assert.equal(other.state, "active");
    await dashboard.computerHostRequest({ operation: "policy", enabled: false, mode: "observe" });
    assert.equal(
      (await post("/api/tasks/other-task/computer/observe", { sessionId: other.sessionId })).status,
      403
    );
    assert.equal((await (await fetch(`${base}/api/computer/access`)).json()).policy.enabled, false);
    await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "observe" });
    let arrived;
    const entered = new Promise((resolve) => {
      arrived = resolve;
    });
    // A real chunked HTTP request enters the route, then waits for its trailing body.
    const lateBody = '{"pid":11,"windowId":12,"mode":"observe"}';
    const oldRequest = httpRequest(`${base}/api/tasks/other-task/computer/select`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(lateBody) }
    });
    const lateResponse = new Promise((resolve, reject) => {
      oldRequest.once("response", async (response) => {
        for await (const _chunk of response) {
        }
        resolve(response.statusCode);
      });
      oldRequest.once("error", reject);
    });
    dashboard.server.once("request", arrived);
    oldRequest.write(lateBody.slice(0, 1));
    await entered;
    dashboard.routePorts.computer.stop("other-task", "ended");
    await dashboard.computerHostRequest({ operation: "resume" });
    oldRequest.end(lateBody.slice(1));
    assert.equal(await lateResponse, 403);
    assert.equal(dashboard.routePorts.computer.current("other-task").state, "ended");
    assert.equal(
      (await post("/api/tasks/other-task/computer/select", { ...target, mode: "observe" })).status,
      200
    );
  } finally {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true });
  }
});
