import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationRegistry } from "../dist/src/applications/registry.js";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { defaultRegistry } from "../dist/src/applications/builtins.js";
import { registerHarnessPlugins } from "../dist/src/applications/plugins/index.js";
import { createFreecadHarnessAdapter } from "../dist/src/applications/plugins/freecad-harness/adapter.js";
import { createBlenderHarnessAdapter } from "../dist/src/applications/plugins/blender-harness/adapter.js";
import { createOfficeHarnessAdapter } from "../dist/src/applications/plugins/office-harness/adapter.js";

const user = { type: "user", id: "local" };

const plugins = [
  { appType: "freecad-harness", kind: "application/freecad-session+json", make: createFreecadHarnessAdapter },
  { appType: "blender-harness", kind: "application/blender-session+json", make: createBlenderHarnessAdapter }
];

test("defaultRegistry offers four built-in applications and retains every harness session kind", () => {
  const registry = defaultRegistry(tmpdir());
  assert.deepEqual(
    registry.catalogDefinitions().map((definition) => definition.appType),
    ["text-editor", "pptist", "cad", "blender"]
  );
  assert.equal(registry.definitions().length, 8);
  const all = [
    ...plugins,
    { appType: "cad-harness", kind: "application/cad-session+json" },
    { appType: "office-harness", kind: "application/office-session+json" }
  ];
  for (const { appType, kind } of all) {
    assert.equal(registry.require(appType).definition.appType, appType);
    assert.equal(registry.require(appType).definition.catalogVisibility, "compatibility");
    assert.equal(registry.forKind(kind).definition.appType, appType);
  }
});

test("the MCP server specs resolve env overrides to absolute values", (t) => {
  const saved = {
    FREECAD_UV: process.env.FREECAD_UV,
    FREECAD_MCP_DIR: process.env.FREECAD_MCP_DIR,
    FREECAD_RPC_HOST: process.env.FREECAD_RPC_HOST,
    BLENDER_UV: process.env.BLENDER_UV,
    BLENDER_MCP_DIR: process.env.BLENDER_MCP_DIR,
    BLENDER_MCP_HOST: process.env.BLENDER_MCP_HOST,
    BLENDER_MCP_PORT: process.env.BLENDER_MCP_PORT,
    OFFICEHARNESS_PLUGIN_ROOT: process.env.OFFICEHARNESS_PLUGIN_ROOT,
    OFFICEHARNESS_PROFILE_DIR: process.env.OFFICEHARNESS_PROFILE_DIR
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.FREECAD_UV = "/opt/uv";
  process.env.FREECAD_MCP_DIR = "/opt/freecad-mcp";
  process.env.FREECAD_RPC_HOST = "10.0.0.5";
  process.env.BLENDER_UV = "/opt/uv";
  process.env.BLENDER_MCP_DIR = "/opt/blender-mcp/mcp";
  process.env.BLENDER_MCP_HOST = "10.0.0.6";
  process.env.BLENDER_MCP_PORT = "9877";
  process.env.OFFICEHARNESS_PLUGIN_ROOT = "/opt/office-harness";
  process.env.OFFICEHARNESS_PROFILE_DIR = "/opt/office-profile";

  const freecad = createFreecadHarnessAdapter().definition.mcpServer;
  assert.equal(freecad.command, "/opt/uv");
  assert.deepEqual(freecad.args, [
    "--directory",
    "/opt/freecad-mcp",
    "run",
    "freecad-mcp",
    "--only-text-feedback",
    "--host",
    "10.0.0.5"
  ]);

  const blender = createBlenderHarnessAdapter().definition.mcpServer;
  assert.equal(blender.command, "/opt/uv");
  assert.deepEqual(blender.args, ["--directory", "/opt/blender-mcp/mcp", "run", "blender-mcp"]);
  assert.deepEqual(blender.env, { BLENDER_MCP_HOST: "10.0.0.6", BLENDER_MCP_PORT: "9877" });

  const office = createOfficeHarnessAdapter().definition.mcpServer;
  assert.equal(office.command, "/opt/office-harness/runtime/bin/node");
  assert.deepEqual(office.args, ["/opt/office-harness/host/mcp.cjs"]);
  assert.deepEqual(office.env, {
    OFFICEHARNESS_MANAGED_HOST: "1",
    OFFICEHARNESS_CONNECTION_FILE: "/opt/office-profile/connection.json"
  });
});

for (const { appType, kind, make } of plugins) {
  test(`${appType} satisfies the adapter contract over a session descriptor`, async (t) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-harness-"));
    t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

    const registry = new ApplicationRegistry();
    registerHarnessPlugins(registry);
    const service = new ApplicationService(workspaceRoot, registry);
    const taskId = "task-1";
    assert.deepEqual(service.catalogDefinitions(), []);
    assert.equal(service.definitions().length, 4);

    const created = await service.createResource({
      taskId,
      kind,
      title: `${appType}.session`,
      actor: user
    });
    assert.equal(created.resource.appType, appType);
    assert.equal(created.resource.status, "ready");

    const applied = await service.applyOperation({
      taskId,
      resourceId: created.resource.resourceId,
      operationId: "op-1",
      appType,
      operationType: "session.update",
      baseRevision: 0,
      payload: { host: "10.0.0.7", port: 9999 },
      actor: user
    });
    assert.equal(applied.resource.revision, 1);
    assert.match(applied.event.summary, /10\.0\.0\.7:9999/);
    assert.ok(applied.event.inverse, "session.update must be invertible for undo");

    await service.bindResource(taskId, created.resource.resourceId);
    const context = await service.activeContext({ taskId, agentId: "main" });
    assert.equal(context.appType, appType);
    assert.match(context.shape, /10\.0\.0\.7:9999/);
    assert.equal(context.shape.includes("\n"), false, "the shape is one line");

    // No in-process tools: the harness's tools come from the MCP server, not the adapter.
    assert.deepEqual(context.availableToolNames, []);
    // The resource is a real file, and the session descriptor round-trips.
    assert.match(context.resource.path, /-session\.json$/);
    const read = await service.readResource(taskId, created.resource.resourceId);
    assert.equal(read.snapshot.content.host, "10.0.0.7");
    assert.equal(read.snapshot.content.port, 9999);
    const restarted = new ApplicationService(workspaceRoot, registry);
    const reopened = await restarted.readResource(taskId, created.resource.resourceId);
    assert.equal(reopened.resource.appType, appType);
    assert.equal(reopened.resource.revision, 1);
    assert.deepEqual(reopened.snapshot.content, read.snapshot.content);
    await restarted.bindResource(taskId, created.resource.resourceId);
    assert.equal((await restarted.activeContext({ taskId, agentId: "main" })).appType, appType);
    // The plugin declares an MCP server, which is what makes its tools appear.
    assert.ok(make().definition.mcpServer);
  });
}

test("a harness has no in-process tools and refuses export, but never blocks binding", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-harness-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const registry = new ApplicationRegistry();
  registerHarnessPlugins(registry);
  const service = new ApplicationService(workspaceRoot, registry);
  const created = await service.createResource({
    taskId: "task-1",
    kind: "application/freecad-session+json",
    title: "x",
    actor: user
  });

  const adapter = registry.require("freecad-harness");
  assert.equal(adapter.agentTools, undefined);
  await assert.rejects(
    () =>
      service.renderForDownload({
        taskId: "task-1",
        resourceId: created.resource.resourceId,
        format: "json"
      }),
    (error) => error.code === "invalid_operation"
  );
});

test("office-harness satisfies the adapter contract over a profile descriptor", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-harness-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const registry = new ApplicationRegistry();
  registerHarnessPlugins(registry);
  const service = new ApplicationService(workspaceRoot, registry);
  const taskId = "task-1";

  const created = await service.createResource({
    taskId,
    kind: "application/office-session+json",
    title: "office.session",
    actor: user
  });
  assert.equal(created.resource.appType, "office-harness");
  assert.equal(created.resource.status, "ready");

  const applied = await service.applyOperation({
    taskId,
    resourceId: created.resource.resourceId,
    operationId: "op-1",
    appType: "office-harness",
    operationType: "session.update",
    baseRevision: 0,
    payload: { profile: "/tmp/custom-office-profile" },
    actor: user
  });
  assert.equal(applied.resource.revision, 1);
  assert.match(applied.event.summary, /custom-office-profile/);
  assert.ok(applied.event.inverse, "session.update must be invertible for undo");

  await service.bindResource(taskId, created.resource.resourceId);
  const context = await service.activeContext({ taskId, agentId: "main" });
  assert.equal(context.appType, "office-harness");
  assert.match(context.shape, /custom-office-profile/);
  // No in-process tools: the office tools come from the MCP server.
  assert.deepEqual(context.availableToolNames, []);

  const read = await service.readResource(taskId, created.resource.resourceId);
  assert.equal(read.snapshot.content.profile, "/tmp/custom-office-profile");
  assert.ok(createOfficeHarnessAdapter().definition.mcpServer);
});
