import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunService } from "../dist/src/runtime/run-service.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { CheckpointStore } from "../dist/src/runtime/scheduler.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: bounded tool feedback retains images, failure status and full diagnostic details`, async (t) => {
    const model = await modelProtocolFixture(api, (_body, requests) =>
      requests.length === 1
        ? { name: "inspect_receipt", arguments: {} }
        : { text: "Checked failure feedback." }
    );
    t.after(() => model.close());
    const long = "HEAD " + "中文😀".repeat(5000) + " TAIL";
    const image = {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM3sAAAAASUVORK5CYII="
    };
    const result = await new PiSession({
      api,
      baseUrl: model.baseUrl,
      apiKey: "fixture-key",
      supportsImages: true,
      maxToolResponseChars: 128,
      tools: new Map([
        [
          "inspect_receipt",
          {
            parameters: { type: "object", properties: {} },
            execute: async () => ({
              content: [{ type: "text", text: long }, image, { type: "text", text: "error status retained" }],
              details: { original: long },
              isError: true
            })
          }
        ]
      ])
    }).run("Inspect the receipt.");
    const feedback = result.messages.find((message) => message.role === "toolResult");
    const text = feedback.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    assert.ok(text.length <= 128);
    assert.match(text, /HEAD/);
    assert.match(text, /TAIL/);
    assert.match(text, /truncated/);
    assert.equal(text.isWellFormed(), true);
    assert.equal(feedback.isError, true);
    assert.equal(feedback.details.original, long);
    assert.deepEqual(
      feedback.content.find((block) => block.type === "image"),
      image
    );
    assert.ok(JSON.stringify(model.requests[1].body).includes(image.data));
    assert.equal(result.termination, "completed");
  });
}

test("formal Run forwards the tool limit without losing structured result details", async (t) => {
  const model = await modelProtocolFixture("openai-completions", (_body, requests) =>
    requests.length === 1 ? { name: "search", arguments: { query: "fixture" } } : { text: "Search checked." }
  );
  t.after(() => model.close());
  const root = await mkdtemp(join(tmpdir(), "atria-tool-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = { content: "unbrokenlatin".repeat(5000), total: 1 };
  const result = await new RunService(root).runPi({
    taskId: "cap-task",
    runId: "cap-run",
    prompt: "Inspect.",
    baseUrl: model.baseUrl,
    apiKey: "fixture-key",
    maxToolResponseChars: 100,
    tools: () => new Map([["search", { execute: async () => original }]])
  });
  const feedback = result.messages.find((message) => message.role === "toolResult");
  assert.ok(feedback.content[0].text.length <= 100);
  assert.deepEqual(feedback.details, original);
  const stored = JSON.parse(await readFile(join(root, "cap-task", result.diagnostics.resultPath), "utf8"));
  assert.deepEqual(stored.messages.find((message) => message.role === "toolResult").details, original);
});

test("formal Run cancellation reaches web/tool signals and persists resumable interruption", async (t) => {
  const model = await modelProtocolFixture("openai-completions", () => ({
    name: "wait_fixture",
    arguments: {}
  }));
  t.after(() => model.close());
  const root = await mkdtemp(join(tmpdir(), "atria-run-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let entered;
  const executing = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new RunService(root).runPi({
    taskId: "cancel-task",
    runId: "cancel-run",
    prompt: "Wait.",
    baseUrl: model.baseUrl,
    apiKey: "fixture-key",
    signal: controller.signal,
    tools: () =>
      new Map([
        [
          "wait_fixture",
          {
            parameters: { type: "object", properties: {} },
            execute: async (_input, signal) => {
              entered();
              await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
              return { isError: true, error: "cancelled" };
            }
          }
        ]
      ])
  });
  await executing;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  const checkpoint = await new CheckpointStore(
    join(root, "cancel-task", "runs", "cancel-run", "checkpoint.json")
  ).load("cancel-run");
  assert.equal(checkpoint.state.status, "running");
  assert.equal(model.requests.length, 1);
});
