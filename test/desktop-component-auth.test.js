import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessHost } from "../dist/src/runtime/process-host.js";
const { createComponentAuth, createComponentAuthController, syncComponentAuth } = createRequire(
  import.meta.url
)("../desktop/component-auth.cjs");
test("public desktop distribution never reads stored component credentials", async () => {
  let reads = 0;
  const sent = [];
  const store = {
    read: async () => {
      reads++;
      return "synthetic-legacy-token";
    }
  };
  const backend = { componentAuth: async (token) => sent.push(token) };
  for (const root of [
    undefined,
    "https://github.com/ignorejjj/Atria-Components/releases/download/components-v1",
    "https://example.invalid/release"
  ])
    await syncComponentAuth(backend, store, root);
  assert.equal(reads, 0);
  assert.deepEqual(sent, []);
  await syncComponentAuth(
    backend,
    store,
    "https://github.com/ignorejjj/Atria-Cowork/releases/download/v1.0.0"
  );
  assert.equal(reads, 1);
  assert.deepEqual(sent, ["synthetic-legacy-token"]);
});
// Synthetic encryption contract fixture, not an assertion about OS/keychain behavior.
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from([...v].reverse().join("")),
  decryptString: (v) => [...v.toString()].reverse().join("")
};
test("desktop credential store saves separately, exposes only masked status, survives reopen and clears", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-component-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let store = createComponentAuth(root, encryption);
  assert.deepEqual(await store.status(), { configured: false, unavailable: false });
  assert.deepEqual(await store.save({ token: "synthetic-secret" }), { configured: true, unavailable: false });
  const file = join(root, "component-github-secret.bin");
  assert.equal((await readFile(file)).includes("synthetic-secret"), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  store = createComponentAuth(root, encryption);
  assert.equal(await store.read(), "synthetic-secret");
  assert.equal(JSON.stringify(await store.status()).includes("secret"), false);
  await assert.rejects(store.save({ token: "bad\ntoken" }));
  await assert.rejects(store.save({ token: "synthetic-secret", clear: true }));
  await assert.rejects(store.save({ token: "synthetic-secret", extra: true }));
  await store.save({ clear: true });
  assert.equal(await store.read(), "");
  assert.deepEqual(await createComponentAuth(root, encryption).status(), {
    configured: false,
    unavailable: false
  });
});
test("unavailable system encryption fails closed and allows clearing an unreadable saved credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-component-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createComponentAuth(root, encryption).save({ token: "synthetic-secret" });
  const store = createComponentAuth(root, { ...encryption, isEncryptionAvailable: () => false });
  assert.deepEqual(await store.status(), { configured: false, unavailable: true });
  await assert.rejects(store.save({ token: "replacement" }), /系统密钥存储/);
  await assert.rejects(store.read(), /无法解密/);
  await store.save({ clear: true });
  assert.deepEqual(await store.status(), { configured: false, unavailable: false });
});
test("Run ProcessHost excludes component credentials from real child environments", async () => {
  const host = new ProcessHost();
  const child = host.start(
    "fixture",
    process.execPath,
    ["-e", "process.stdout.write(String(process.env.ATRIA_COMPONENTS_GITHUB_TOKEN))"],
    {
      env: { ...process.env, ATRIA_COMPONENTS_GITHUB_TOKEN: "synthetic-marker" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  await new Promise((done) => child.once("close", done));
  assert.equal(output, "undefined");
});

test("complete save/read/live-backend operation is serialized so clear cannot be overtaken", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-component-auth-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createComponentAuth(root, encryption);
  let release, start;
  const started = new Promise((done) => (start = done));
  const delayed = new Promise((done) => (release = done));
  const applied = [];
  const backend = {
    async componentAuth(value) {
      if (value) {
        start();
        await delayed;
      }
      applied.push(value);
    }
  };
  const controller = createComponentAuthController(store, () => backend);
  const save = controller.save({ token: "synthetic-secret" });
  await started;
  const clear = controller.save({ clear: true });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(await store.read(), "synthetic-secret");
  release();
  await Promise.all([save, clear]);
  assert.deepEqual(applied, ["synthetic-secret", ""]);
  assert.equal(await store.read(), "");
});

test("a plaintext system-storage backend cannot persist a component credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-component-auth-plaintext-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createComponentAuth(root, { ...encryption, getSelectedStorageBackend: () => "basic_text" });
  await assert.rejects(store.save({ token: "synthetic-secret" }), /系统密钥存储/);
  assert.deepEqual(await store.status(), { configured: false, unavailable: false });
});
