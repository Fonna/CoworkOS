import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { ComputerUse } from "../dist/src/gui/computer-use.js";
import { handleComputerRequest } from "../dist/src/dashboard/computer-routes.js";
import { createImageTools } from "../dist/src/tools/read-image.js";
import { createImageArchive } from "../dist/src/tools/image-archive.js";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const { registerComputerTools } = await createJiti(import.meta.url).import(
  resolve(".pi/runtime/tools/computer-use.ts")
);

async function fixture(t) {
  const taskDirectory = await mkdtemp(join(tmpdir(), "atria-computer-visual-"));
  const image = new PNG({ width: 8, height: 6 });
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) image.data.set([x * 20, y * 30, 0, 255], (y * image.width + x) * 4);
  const data = PNG.sync.write(image);
  const target = {
    pid: 11,
    windowId: 12,
    bundleId: "org.atria.fixture",
    application: "Fixture",
    title: "Visual"
  };
  const effects = [];
  const computer = new ComputerUse({
    status: async () => ({ available: true, screenRecording: true, accessibility: true, windows: [target] }),
    observe: async () => ({
      width: 8,
      height: 6,
      image: data.toString("base64"),
      frame: { x: 20, y: 30, width: 4, height: 3 },
      accessibilityText: "Fixture"
    }),
    act: async (_target, action) => effects.push(action)
  });
  const server = createServer((request, response) => {
    handleComputerRequest(
      request,
      response,
      new URL(request.url, "http://localhost"),
      computer,
      async () => {}
    ).catch((error) => {
      response.writeHead(error.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = process.env.COWORK_DASHBOARD_URL;
  process.env.COWORK_DASHBOARD_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previous === undefined) delete process.env.COWORK_DASHBOARD_URL;
    else process.env.COWORK_DASHBOARD_URL = previous;
    computer.stop("task", "ended");
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(taskDirectory, { recursive: true, force: true });
  });
  const session = await computer.authorize("task", target.pid, target.windowId, "control");
  const tools = new Map();
  registerComputerTools({ registerTool: (tool) => tools.set(tool.name, tool) }, "task", taskDirectory);
  const execute = (name, params, signal) =>
    tools.get(name).execute("test", params, signal, undefined, { model: { input: ["text", "image"] } });
  return { taskDirectory, session, execute, data, effects, computer };
}

test("window screenshot crop maps original pixels without granting or renewing action credentials", async (t) => {
  const f = await fixture(t);
  const observed = await f.execute("computer_observe", { sessionId: f.session.sessionId });
  const current = observed.details;
  assert.match(current.imageRef, /^img_/);
  const images = createImageTools({
    rootDirectory: f.taskDirectory,
    taskDirectory: f.taskDirectory,
    supportsImages: true
  });
  const crop = await images.crop_image.execute({
    imageRef: current.imageRef,
    region: { x: 2, y: 1, width: 3, height: 2 },
    scale: 2
  });
  const zoom = PNG.sync.read(Buffer.from(crop.content[1].data, "base64"));
  assert.deepEqual([...zoom.data.subarray(0, 4)], [40, 30, 0, 255]);
  assert.equal(crop.details.mapping.sourceImageRef, current.imageRef);
  assert.equal(crop.details.observationId, undefined);
  const denied = await f.execute("computer_act", {
    sessionId: f.session.sessionId,
    observationId: crop.details.imageRef,
    action: { type: "click", x: 3, y: 2, button: "left" }
  });
  assert.equal(denied.isError, true);
  assert.equal(f.effects.length, 0);
  // Cropping does not renew or consume the original live observation.
  const acted = await f.execute("computer_act", {
    sessionId: f.session.sessionId,
    observationId: current.observationId,
    action: { type: "click", x: 3, y: 2, button: "left" }
  });
  assert.equal(acted.details.dispatchStatus, "sent");
  assert.equal(f.effects.length, 1);
  assert.notEqual(acted.details.observation.observationId, current.observationId);
  const stored = await createImageArchive({ taskDirectory: f.taskDirectory }).read(current.imageRef);
  assert.equal(stored.record.source.sourceObservationId, current.observationId);
  const stale = await f.execute("computer_act", {
    sessionId: f.session.sessionId,
    observationId: stored.record.source.sourceObservationId,
    action: { type: "activate" }
  });
  assert.equal(stale.isError, true);
  assert.equal(f.effects.length, 1);
});

test("archive failure after dispatched input preserves sent status and current pixels", async (t) => {
  const f = await fixture(t);
  const observed = await f.execute("computer_observe", { sessionId: f.session.sessionId });
  await writeFile(join(f.taskDirectory, "visual", "images", "invalid-entry"), "fixture corruption");
  const acted = await f.execute("computer_act", {
    sessionId: f.session.sessionId,
    observationId: observed.details.observationId,
    action: { type: "activate" }
  });
  assert.equal(acted.isError, undefined);
  assert.equal(acted.details.dispatchStatus, "sent");
  assert.equal(acted.details.requiresObservation, false);
  assert.equal(acted.details.observation.imageArchive.saved, false);
  assert.equal(acted.content[1].data, f.data.toString("base64"));
  assert.equal(f.effects.length, 1);
});

test("cancellation after action response cannot report already-sent input as not_sent", async (t) => {
  const f = await fixture(t);
  const observed = await f.execute("computer_observe", { sessionId: f.session.sessionId });
  const controller = new AbortController();
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args) => {
    const response = await fetch(...args);
    const json = response.json.bind(response);
    response.json = async () => {
      const result = await json();
      controller.abort();
      return result;
    };
    return response;
  });
  const acted = await f.execute(
    "computer_act",
    {
      sessionId: f.session.sessionId,
      observationId: observed.details.observationId,
      action: { type: "activate" }
    },
    controller.signal
  );
  assert.equal(acted.isError, true);
  assert.equal(acted.details.dispatchStatus, "sent");
  assert.equal(acted.details.requiresObservation, true);
  assert.equal(acted.details.errorCode, "feedback_cancelled");
  assert.equal(f.effects.length, 1);
});
