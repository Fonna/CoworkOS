import assert from "node:assert/strict";
import { test } from "node:test";
import { createContextAssessor } from "../dist/src/runtime/personal-context-chat.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const approved = { authorized: true, sensitive: false, statement: "self_report" };
const payload = {
  action: "save",
  userText: "请保存我本月15号参加公开读书会的本对话安排",
  receivedAt: "2026-11-05T06:00:00Z",
  timeZone: "Asia/Shanghai",
  registrationEnabled: false,
  proposed: { title: "公开读书会", visibility: "task" }
};

async function fixture(t) {
  const state = { text: JSON.stringify(approved) };
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: state.text,
    finishReason: state.finishReason
  }));
  t.after(() => provider.close());
  const assess = createContextAssessor(() => ({
    baseUrl: provider.baseUrl,
    apiKey: "local-assessment-fixture",
    model: "protocol-fixture",
    api: "openai-completions",
    supportsReasoningEffort: false
  }));
  return { state, provider, assess };
}

test("semantic assessment accepts plain JSON or one complete JSON code block without retrying", async (t) => {
  const { state, provider, assess } = await fixture(t);
  const json = JSON.stringify(approved);
  for (const [name, text] of [
    ["plain", json],
    ["json fence", "```json\n" + json + "\n```"],
    ["unlabelled fence", "```\n" + json + "\n```"],
    ["whitespace and CRLF", " \n```JSON\r\n" + json + "\r\n```\n "]
  ]) {
    await t.test(name, async () => {
      state.text = text;
      const before = provider.requests.length;
      assert.deepEqual(await assess(payload), approved);
      assert.equal(provider.requests.length, before + 1, "one checker request, no automatic retry");
      assert.equal(provider.requests.at(-1).body.tools?.length ?? 0, 0, "checker cannot execute tools");
    });
  }
});

test("invalid or ambiguous checker output fails closed with a stable error and no private excerpts", async (t) => {
  const { state, provider, assess } = await fixture(t);
  const json = JSON.stringify(approved);
  for (const [name, text] of [
    ["prose prefix", "SYNTHETIC_PRIVATE_MARKER " + json],
    ["prose suffix", json + " approved"],
    ["two fenced objects", "```json\n" + json + "\n```\n```json\n" + json + "\n```"],
    ["two plain objects", json + "\n" + json],
    ["incomplete fence", "```json\n" + json],
    ["other language", "```javascript\n" + json + "\n```"],
    ["broken JSON", '```json\n{"SYNTHETIC_PRIVATE_MARKER":}\n```'],
    ["wrong field type", JSON.stringify({ ...approved, authorized: "true" })],
    ["unknown authority field", JSON.stringify({ ...approved, override: "SYNTHETIC_PRIVATE_MARKER" })],
    ["array", JSON.stringify([approved])],
    ["null", "null"],
    ["oversized", " ".repeat(16385) + json]
  ]) {
    await t.test(name, async () => {
      state.text = text;
      const before = provider.requests.length;
      await assert.rejects(assess(payload), (error) => {
        assert.equal(error.code, "assessment_invalid");
        assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_MARKER|Unexpected token/);
        return true;
      });
      assert.equal(provider.requests.length, before + 1);
    });
  }
});

test("valid refusals and sensitivity survive code-block normalization, while truncated output is rejected", async (t) => {
  const { state, assess } = await fixture(t);
  const denied = { authorized: false, sensitive: true, statement: "uncertain" };
  state.text = "```json\n" + JSON.stringify(denied) + "\n```";
  assert.deepEqual(await assess(payload), denied);
  state.text = JSON.stringify(approved);
  state.finishReason = "length";
  await assert.rejects(assess(payload), (error) => error.code === "assessment_invalid");
});
