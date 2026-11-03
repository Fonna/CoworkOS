import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { createVisionAnalyzer, parseVisionReview } from "../dist/src/tools/vision-model.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

export const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const pass = { status: "pass", summary: "Readable", issues: [] };
const input = { data: pixel, mimeType: "image/png", path: "slide.png", review: true };

test("structured review rejects malformed, contradictory and unbounded claims", () => {
  assert.deepEqual(parseVisionReview(`\`\`\`json\n${JSON.stringify(pass)}\n\`\`\``), pass);
  for (const value of [
    "everything is fine",
    { ...pass, summary: "" },
    { ...pass, issues: [{ severity: "major", location: "title", problem: "clipped", fix: "shorten" }] },
    { ...pass, status: "needs_revision" },
    {
      status: "needs_revision",
      summary: "bad",
      issues: [{ severity: "major", location: "title", problem: "x".repeat(181), fix: "shorten" }]
    }
  ]) {
    assert.throws(
      () => parseVisionReview(typeof value === "string" ? value : JSON.stringify(value)),
      /unreviewed/
    );
  }
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`vision ${api}: real streaming protocol, concurrent deduplication and changed-pixel evidence`, async (t) => {
    const fixture = await modelProtocolFixture(api, async () => {
      await new Promise((done) => setTimeout(done, 20));
      return { text: JSON.stringify(pass) };
    });
    t.after(() => fixture.close());
    const config = {
      baseUrl: fixture.baseUrl,
      apiKey: "local-vision-fixture-key",
      model: "vision-fixture",
      api
    };
    const analyze = createVisionAnalyzer();
    const [first, duplicate] = await Promise.all([analyze(config, input), analyze(config, input)]);
    assert.equal(fixture.requests.length, 1);
    assert.equal(first.review.status, "pass");
    assert.equal(duplicate.cached, true);
    assert.equal((await analyze(config, input)).cached, true);
    const changed = await analyze(config, { ...input, data: Buffer.concat([pixel, Buffer.from("changed")]) });
    assert.notEqual(changed.imageHash, first.imageHash);
    assert.equal(fixture.requests.length, 2);
    assert.ok(JSON.stringify(fixture.requests[0].body).includes("data:image/png;base64,"));
    assert.equal(JSON.stringify(first).includes(config.apiKey), false);
  });
}

test("unreviewed responses never become cached success and repeated failures stop", async (t) => {
  const fixture = await modelProtocolFixture("openai-completions", () => ({
    text: JSON.stringify({ status: "unreviewed", summary: "Cannot read image", issues: [] })
  }));
  t.after(() => fixture.close());
  const analyze = createVisionAnalyzer();
  const config = { baseUrl: fixture.baseUrl, apiKey: "local-key", model: "fixture" };
  assert.equal((await analyze(config, input)).review.status, "unreviewed");
  assert.equal((await analyze(config, input)).cached, false);
  await assert.rejects(analyze(config, input), /two identical/);
  assert.equal(fixture.requests.length, 2);
});

test("HTTP failures are bounded and do not reveal provider response bodies", async (t) => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(503);
    res.end("private-provider-body-and-key");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const config = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "local-key",
    model: "fixture"
  };
  const analyze = createVisionAnalyzer();
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      analyze(config, input),
      (error) => /HTTP 503/.test(error.message) && !/private-provider/.test(error.message)
    );
  await assert.rejects(analyze(config, input), /two identical/);
  assert.equal(calls, 2);
});

test("image paths reject outside symlinks in both work and task scopes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work"),
    task = join(root, "task"),
    outside = join(root, "outside");
  await Promise.all([work, task, outside].map((path) => mkdir(path)));
  await writeFile(join(outside, "dummy.png"), pixel);
  await symlink(join(outside, "dummy.png"), join(work, "linked.png"));
  await symlink(outside, join(task, "linked-directory"));
  await writeFile(join(work, "pixel.png"), pixel);
  await writeFile(join(task, "pixel.png"), pixel);
  const tool = createBuiltinTools({
    rootDirectory: work,
    workspaceDirectory: task,
    supportsImages: true
  }).get("read_image");
  await assert.rejects(tool.execute({ path: "linked.png" }), /escapes/);
  await assert.rejects(tool.execute({ path: "linked-directory/dummy.png", scope: "task" }), /escapes/);
  assert.equal((await tool.execute({ path: "pixel.png" })).content[1].type, "image");
  assert.equal((await tool.execute({ path: "pixel.png", scope: "task" })).details.scope, "task");
  await writeFile(join(work, "invalid.png"), "not an image");
  await assert.rejects(tool.execute({ path: "invalid.png" }), /header/);
  await assert.rejects(tool.execute({ path: "pixel.png", scope: "unknown" }), /scope/);
  await assert.rejects(tool.execute({ path: "pixel.png", review: "true" }), /boolean/);
});

test("cancelled image reads never contact a provider; in-flight cancellation aborts and does not exhaust retries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  let received;
  const requestStarted = new Promise((done) => (received = done));
  let calls = 0;
  const server = createServer((req) => {
    calls++;
    req.on("error", () => {});
    received();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const visionModel = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "local-key",
    model: "fixture"
  };
  const tool = createBuiltinTools({ rootDirectory: root, visionModel }).get("read_image");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tool.execute({ path: "pixel.png" }, cancelled.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const running = tool.execute({ path: "pixel.png" }, controller.signal);
  await requestStarted;
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(calls, 1);
  const analyze = createVisionAnalyzer();
  for (let i = 0; i < 3; i++)
    await assert.rejects(analyze({ ...visionModel, timeoutMs: 10 }, input, cancelled.signal), {
      name: "AbortError"
    });
  await assert.rejects(analyze({ ...visionModel, timeoutMs: 30 }, input), /timed out/);
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`image comparison ${api}: ordered pixels, cache invalidation and no credential or pixel text leakage`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-image-comparison-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "before.png"), pixel);
    await writeFile(join(root, "after.png"), Buffer.concat([pixel, Buffer.from("after")]));
    const fixture = await modelProtocolFixture(api, () => ({ text: "Image 2 differs from Image 1." }));
    t.after(() => fixture.close());
    const tool = createBuiltinTools({
      rootDirectory: root,
      visionModel: { baseUrl: fixture.baseUrl, apiKey: "local-comparison-secret", model: "fixture", api }
    }).get("read_image");
    const args = { paths: ["before.png", "after.png"], goal: "Compare layouts" };
    const first = await tool.execute(args);
    assert.equal(first.details.images.length, 2);
    assert.equal(first.details.cached, false);
    assert.equal((await tool.execute(args)).details.cached, true);
    const body = fixture.requests[0].body;
    const user = (api === "openai-responses" ? body.input : body.messages).find(
      (message) => message.role === "user"
    );
    const urls = user.content
      .filter((part) => part.type === (api === "openai-responses" ? "input_image" : "image_url"))
      .map((part) => (api === "openai-responses" ? part.image_url : part.image_url.url));
    assert.equal(urls.length, 2);
    assert.equal(urls[0], `data:image/png;base64,${pixel.toString("base64")}`);
    assert.notEqual(urls[0], urls[1]);
    assert.doesNotMatch(JSON.stringify(first), /local-comparison-secret|data:image|base64/);
    const reversed = await tool.execute({ ...args, paths: [...args.paths].reverse() });
    assert.equal(reversed.details.cached, false);
    await writeFile(join(root, "after.png"), Buffer.concat([pixel, Buffer.from("changed")]));
    const changed = await tool.execute(args);
    assert.notEqual(changed.details.images[1].imageHash, first.details.images[1].imageHash);
    assert.equal(fixture.requests.length, 3);
  });
}

test("native comparison keeps per-image evidence and validates every image before sending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-comparison-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tool = createBuiltinTools({ rootDirectory: root, supportsImages: true }).get("read_image");
  const result = await tool.execute({ paths: ["pixel.png", "pixel.png"] });
  assert.equal(result.content.filter((part) => part.type === "image").length, 2);
  assert.equal(result.content[0].text, "Image 1: pixel.png");
  for (const input of [
    {},
    { path: "pixel.png", paths: ["different.png"] },
    { paths: [] },
    { paths: Array(5).fill("pixel.png") },
    { paths: ["pixel.png", "../outside.png"] },
    { paths: ["pixel.png", "pixel.png"], review: true }
  ])
    await assert.rejects(tool.execute(input));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tool.execute({ paths: ["pixel.png", "pixel.png"] }, cancelled.signal), {
    name: "AbortError"
  });
  const large = Buffer.alloc(11 * 1024 * 1024);
  pixel.copy(large);
  await writeFile(join(root, "large.png"), large);
  await assert.rejects(tool.execute({ paths: ["large.png", "large.png"] }), /total byte limit/);
});

test("image selection accepts matching aliases and empty alternatives without duplicating pixels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tool = createBuiltinTools({ rootDirectory: root, supportsImages: true }).get("read_image");
  for (const args of [
    { path: "pixel.png", paths: ["pixel.png"] },
    { path: "pixel.png", paths: [""] },
    { path: "pixel.png", paths: [" "] },
    { path: "pixel.png", paths: [] }
  ]) {
    const result = await tool.execute(args);
    assert.equal(result.content.filter((part) => part.type === "image").length, 1);
    assert.equal(result.details.path, "pixel.png");
    assert.equal(result.details.images, undefined);
  }
  for (const path of ["", " "]) {
    const result = await tool.execute({ path, paths: ["pixel.png"] });
    assert.equal(result.content.filter((part) => part.type === "image").length, 1);
    assert.equal(result.details.images.length, 1);
    assert.equal(result.details.images[0].path, "pixel.png");
  }
});

test("image selection rejects conflicting aliases, incomplete comparisons and malformed alternatives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-selection-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tool = createBuiltinTools({ rootDirectory: root, supportsImages: true }).get("read_image");
  for (const args of [
    {},
    { path: "", paths: [""] },
    { paths: [] },
    { path: "pixel.png", paths: ["other.png"] },
    { path: "pixel.png", paths: ["pixel.png", "other.png"] },
    { path: "pixel.png", paths: ["pixel.png", ""] },
    { path: "pixel.png", paths: [null] },
    { path: 42, paths: ["pixel.png"] },
    { path: "pixel.png", paths: "pixel.png" }
  ])
    await assert.rejects(tool.execute(args));
});
