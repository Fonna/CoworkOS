import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinaryFileProvider } from "../dist/src/software/binary-file-provider.js";
import { SoftwareProviderRegistry } from "../dist/src/software/provider-registry.js";
import { GrantedPermissions } from "../dist/src/security/execution-permissions.js";
import { GuiService } from "../dist/src/gui/gui-service.js";

test("binary provider preserves non UTF-8 bytes, refuses stale revisions and authorized-root escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-binary-"));
  const outside = await mkdtemp(join(tmpdir(), "atria-outside-"));
  try {
    const file = join(root, "data.bin");
    const original = Buffer.from([0, 255, 128, 13, 10]);
    await writeFile(file, original);
    const target = { kind: "binary-file", path: file, mediaType: "application/octet-stream" };
    const provider = new BinaryFileProvider([root]);
    const snapshot = await provider.read(target);
    assert.deepEqual(snapshot.content.bytes, original);
    const changed = await provider.apply(target, {
      id: "edit-1",
      type: "binary.replace",
      baseRevision: snapshot.revision,
      payload: Uint8Array.from([255, 0, 42])
    });
    assert.deepEqual(await readFile(file), Buffer.from([255, 0, 42]));
    await assert.rejects(
      provider.apply(target, {
        id: "edit-2",
        type: "binary.replace",
        baseRevision: snapshot.revision,
        payload: original
      }),
      { code: "revision_conflict", currentRevision: changed.revision }
    );
    const foreign = join(outside, "foreign.bin");
    await writeFile(foreign, original);
    await symlink(foreign, join(root, "link.bin"));
    await assert.rejects(provider.read({ ...target, path: join(root, "link.bin") }), /outside authorized/);
    await assert.rejects(
      provider.apply(target, {
        id: "bad",
        type: "binary.replace",
        baseRevision: changed.revision,
        payload: "text"
      }),
      { code: "invalid_operation" }
    );
    await assert.rejects(provider.read(target, AbortSignal.abort()), { name: "AbortError" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("provider discovery refuses unsupported resource shapes and closes remote connections", async () => {
  const registry = new SoftwareProviderRegistry();
  let closed = false;
  const snapshot = {
    revision: "opaque-etag",
    content: { kind: "remote", schema: "cad/v1", value: { parameter: 42 } }
  };
  registry.register({
    id: "remote-cad",
    protocolVersion: 2,
    resourceKinds: ["remote"],
    async read() {
      return snapshot;
    },
    async apply() {
      return snapshot;
    },
    async close() {
      closed = true;
    }
  });
  const target = { kind: "remote", connectionId: "connection-1", objectId: "drawing-1" };
  assert.deepEqual(await registry.resolve("remote-cad", target).read(target), snapshot);
  assert.throws(
    () => registry.resolve("remote-cad", { kind: "project", root: "/project", entryPoints: [] }),
    { code: "unsupported_resource" }
  );
  await registry.close();
  assert.equal(closed, true);
});

test("GUI operations require scoped human decisions; queued actions recheck expiry and keep a shared desktop serial", async () => {
  let now = 1;
  const grants = ["gui.observe", "gui.control"].map((capability) => ({
    taskId: "task",
    target: "editor",
    capability,
    authorizedBy: "human",
    decisionId: "decision",
    expiresAt: 10
  }));
  const permissions = new GrantedPermissions(grants, () => now);
  const effects = [],
    audits = [];
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const service = new GuiService(
    {
      id: "desktop",
      async observe() {
        effects.push("observe");
        return { capturedAt: "now", width: 1, height: 1, image: new Uint8Array() };
      },
      async act(target, action) {
        effects.push(action.type);
        await gate;
      }
    },
    permissions,
    async (event) => {
      audits.push(event);
    }
  );
  await assert.rejects(service.act("other-task", "editor", { type: "activate" }), /Permission required/);
  await assert.rejects(service.act("task", "other-app", { type: "activate" }), /Permission required/);
  await assert.rejects(
    service.act("task", "editor", { type: "click", x: NaN, y: 1, button: "left" }),
    /Invalid coordinates/
  );
  const first = service.act("task", "editor", { type: "activate" });
  const queued = service.observe("task", "editor");
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(effects, ["activate"]);
  now = 20;
  release();
  await first;
  await assert.rejects(queued, /Permission required/);
  assert.deepEqual(effects, ["activate"]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, "completed");
});

test("software read permission does not authorize editing or another target", async () => {
  const { SoftwareService } = await import("../dist/src/software/software-service.js");
  const registry = new SoftwareProviderRegistry();
  let writes = 0;
  const snapshot = { revision: "revision-1", content: { kind: "remote", schema: "test/v1", value: {} } };
  registry.register({
    id: "remote",
    protocolVersion: 2,
    resourceKinds: ["remote"],
    async read() {
      return snapshot;
    },
    async apply() {
      writes++;
      return snapshot;
    }
  });
  const grants = [
    {
      taskId: "task",
      target: "remote:remote:connection/object",
      capability: "software.read",
      authorizedBy: "human",
      decisionId: "user-decision",
      expiresAt: 20
    }
  ];
  const service = new SoftwareService(registry, new GrantedPermissions(grants, () => 1));
  const target = { kind: "remote", connectionId: "connection", objectId: "object" };
  assert.deepEqual(await service.read("task", "remote", target), snapshot);
  await assert.rejects(
    service.apply("task", "remote", target, {
      id: "edit",
      baseRevision: "revision-1",
      type: "edit",
      payload: {}
    }),
    /Permission required/
  );
  await assert.rejects(
    service.read("task", "remote", { ...target, objectId: "other" }),
    /Permission required/
  );
  assert.equal(writes, 0);
});
