import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createComponentDownload,
  componentTokenProvider,
  takeComponentToken,
  componentJson
} from "../dist/src/software/components/download.js";
import {
  DEFAULT_COMPONENT_RELEASE_ROOT,
  privateComponentSource
} from "../dist/src/software/components/source.js";
const root = "https://github.com/ignorejjj/Atria-Cowork/releases/download/v1.0.0";
async function fixture(t) {
  const seen = [];
  let status = 200,
    redirect = true,
    unsafe = false;
  const server = createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization, accept: request.headers.accept });
    if (request.url.includes("/tags/")) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ assets: [{ name: "catalog.json", id: 7, url: "https://evil.invalid/asset" }] })
      );
    } else if (request.url.includes("/assets/")) {
      if (redirect)
        response.writeHead(302, {
          location: unsafe
            ? "https://evil.invalid/?secret=signed"
            : "https://release-assets.githubusercontent.com/fixture?secret=signed"
        });
      response.end(redirect ? "" : "asset");
    } else response.end("asset");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const fetcher = (url, options) => {
    const target = new URL(url);
    return fetch(`http://127.0.0.1:${server.address().port}${target.pathname}${target.search}`, options);
  };
  return {
    seen,
    fetcher,
    mode(code, direct = false, invalid = false) {
      status = code;
      redirect = !direct;
      unsafe = invalid;
    }
  };
}
test("private release metadata and asset use fixed API paths; signed CDN receives no credential", async (t) => {
  const f = await fixture(t);
  const download = createComponentDownload({
    releaseRoot: root,
    fetcher: f.fetcher,
    token: () => "synthetic-token"
  });
  assert.equal(await (await download("catalog.json", AbortSignal.timeout(2000))).text(), "asset");
  assert.deepEqual(
    f.seen.map((r) => r.auth),
    ["Bearer synthetic-token", "Bearer synthetic-token", undefined]
  );
  assert.equal(f.seen[0].url, "/repos/ignorejjj/Atria-Cowork/releases/tags/v1.0.0");
  assert.equal(f.seen[1].url, "/repos/ignorejjj/Atria-Cowork/releases/assets/7");
  assert.equal(f.seen[1].accept, "application/octet-stream");
  f.mode(200, true);
  assert.equal(await (await download("catalog.json", AbortSignal.timeout(2000))).text(), "asset");
});
test("missing and invalid access are actionable and do not reflect response secrets", async (t) => {
  const f = await fixture(t);
  for (const code of [401, 403, 404]) {
    f.mode(code);
    await assert.rejects(
      createComponentDownload({ releaseRoot: root, fetcher: f.fetcher, token: () => "synthetic-token" })(
        "catalog.json",
        AbortSignal.timeout(2000)
      ),
      (error) =>
        error.message.includes(`HTTP ${code}`) &&
        error.message.includes("Contents: read") &&
        !error.message.includes("synthetic-token")
    );
  }
  f.mode(200, false, true);
  await assert.rejects(
    createComponentDownload({ releaseRoot: root, fetcher: f.fetcher, token: () => "synthetic-token" })(
      "catalog.json",
      AbortSignal.timeout(2000)
    ),
    /Unsafe component asset redirect/
  );
  assert.equal(
    f.seen.some((r) => r.url.includes("evil")),
    false
  );
});
test("custom roots and anonymous public download never receive GitHub credential", async (t) => {
  const f = await fixture(t);
  for (const [releaseRoot, token] of [
    [DEFAULT_COMPONENT_RELEASE_ROOT, () => assert.fail("public releases must not request credentials")],
    ["https://example.invalid/releases", () => "synthetic-token"],
    [root, () => ""]
  ]) {
    const download = createComponentDownload({ releaseRoot, fetcher: f.fetcher, token });
    assert.equal(await (await download("catalog.json", AbortSignal.timeout(2000))).text(), "asset");
  }
  assert.equal(
    f.seen.every((r) => r.auth === undefined),
    true
  );
  const env = { ATRIA_COMPONENTS_GITHUB_TOKEN: "synthetic-token", OTHER: "kept" };
  assert.equal(takeComponentToken(env), "synthetic-token");
  assert.deepEqual(env, { OTHER: "kept" });
});

test("public defaults discard inherited tokens without reading them; private compatibility is explicit and scoped", () => {
  const env = {};
  Object.defineProperty(env, "ATRIA_COMPONENTS_GITHUB_TOKEN", {
    configurable: true,
    get: () => assert.fail("public component source read an inherited token")
  });
  assert.equal(componentTokenProvider(DEFAULT_COMPONENT_RELEASE_ROOT, env)(), "");
  assert.equal(Object.hasOwn(env, "ATRIA_COMPONENTS_GITHUB_TOKEN"), false);
  assert.equal(privateComponentSource(root), true);
  for (const source of [
    undefined,
    DEFAULT_COMPONENT_RELEASE_ROOT,
    `${root}/extra`,
    `${root}?token=fixture`,
    "https://example.invalid/releases"
  ])
    assert.equal(privateComponentSource(source), false);
  const privateEnv = { ATRIA_COMPONENTS_GITHUB_TOKEN: "synthetic-private-token" };
  assert.equal(componentTokenProvider(root, privateEnv)(), "synthetic-private-token");
  assert.deepEqual(privateEnv, {});
});
test("network failures and cancellation hide token and signed URL diagnostics", async () => {
  const download = createComponentDownload({
    releaseRoot: root,
    token: () => "synthetic-token",
    fetcher: async () => {
      throw new Error("synthetic-token https://cdn.invalid/?signed=secret");
    }
  });
  await assert.rejects(
    download("catalog.json", AbortSignal.timeout(2000)),
    (error) => !/synthetic-token|signed=|cdn/.test(error.message)
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(download("catalog.json", controller.signal), /cancelled/);
});

test("release JSON is bounded and malformed response content never appears in diagnostics", async () => {
  for (const body of [
    "malformed synthetic-token https://asset.invalid/?signed=secret",
    " ".repeat(1_048_577)
  ]) {
    await assert.rejects(
      componentJson(new Response(body)),
      (error) =>
        error.message.startsWith("Invalid component JSON") && !/synthetic-token|signed=/.test(error.message)
    );
  }
});
