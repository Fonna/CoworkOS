import assert from "node:assert/strict";
import { test } from "node:test";
import { MainRunOutput, mainRunFailure } from "../dist/src/dashboard/main-run-outcome.js";

const message = (stopReason = "stop", errorMessage) => ({
  role: "assistant",
  content: [{ type: "text", text: "中文😀" }],
  stopReason,
  ...(errorMessage ? { errorMessage } : {})
});
const line = (message) => JSON.stringify({ type: "message_end", message });

test("a terminal event split at every UTF-8 byte retains its exact error, including an unterminated last line", () => {
  const observed = new MainRunOutput();
  const raw = Buffer.from(line(message("error", "诊断中文😀")));
  for (const byte of raw) observed.write(Buffer.from([byte]));
  assert.equal(observed.message, undefined);
  observed.finish();
  assert.equal(observed.message.errorMessage, "诊断中文😀");
  assert.equal(observed.message.stopReason, "error");
});

test("fresh user/agent/assistant starts invalidate an earlier terminal response", () => {
  for (const update of [
    { type: "agent_start" },
    { type: "message_start", message: message() },
    { type: "message_end", message: { role: "user", content: "下一项" } }
  ]) {
    const observed = new MainRunOutput();
    observed.write(Buffer.from(`${line(message())}\n`));
    assert.equal(observed.message.stopReason, "stop");
    observed.write(Buffer.from(`${JSON.stringify(update)}\n`));
    assert.equal(observed.message, undefined);
  }
});

test("tool results and unrelated malformed stdout do not become model failure diagnostics", () => {
  const observed = new MainRunOutput();
  observed.write(Buffer.from('not JSON\n[]\n{"type":"message_end","message":null}\n'));
  observed.write(Buffer.from(`${line({ role: "toolResult", isError: true, content: "工具真实失败" })}\n`));
  assert.equal(observed.message, undefined);
  assert.equal(mainRunFailure(observed.message, 2, null).failure.kind, "main_process");
});

test("an oversized malformed event clears old completion evidence and the next valid event recovers", () => {
  const observed = new MainRunOutput();
  observed.write(Buffer.from(`${line(message())}\n`));
  const chunk = Buffer.from("x".repeat(1024 * 1024));
  for (let index = 0; index < 9; index += 1) observed.write(chunk);
  assert.equal(observed.message, undefined);
  observed.write(Buffer.from(`\n${line(message("error", "恢复后的真实错误"))}\n`));
  assert.equal(observed.message.errorMessage, "恢复后的真实错误");
});

test("HTTP status is taken only from an explicit model error prefix", () => {
  for (const [error, status] of [
    ["429 请求频率超限", 429],
    ["HTTP 500 服务错误", 500],
    ["HTTP status code: 401 身份验证失败", 401],
    ["HTTP 503: upstream unavailable", 503],
    ['cowork-glm API error (400): {"code":"cyber_policy"}', 400]
  ]) {
    const result = mainRunFailure(message("error", error), 0, null);
    assert.equal(result.error, error);
    assert.equal(result.failure.httpStatus, status);
  }
  for (const error of [
    "服务可能出现问题，或者参数不对",
    "after 500 requests the server disconnected",
    "4290 tokens exceeded",
    "provider-401 failed at https://example.invalid/503"
  ]) {
    assert.equal(
      Object.hasOwn(mainRunFailure(message("error", error), 0, null).failure, "httpStatus"),
      false
    );
  }
});

test("spawn evidence takes precedence over any model diagnostic and process signals remain explicit", () => {
  const spawn = mainRunFailure(message("error", "旧模型错误"), null, null, new Error("spawn ENOENT"));
  assert.deepEqual(spawn, { error: "spawn ENOENT", failure: { kind: "main_process" } });
  const killed = mainRunFailure(undefined, null, "SIGKILL");
  assert.match(killed.error, /signal=SIGKILL/);
  assert.equal(killed.failure.kind, "main_process");
});

test("model-not-found classification carries only a recognized structured code for an actual 404", () => {
  for (const body of [
    { type: "model_not_found", message: "private-provider-detail" },
    { error: { code: "model_not_found", message: "private-provider-detail" } }
  ]) {
    const result = mainRunFailure(message("error", `404: ${JSON.stringify(body)}`), 0, null);
    assert.deepEqual(result.failure, {
      kind: "model_request",
      stopReason: "error",
      httpStatus: 404,
      providerCode: "model_not_found"
    });
    assert.doesNotMatch(JSON.stringify(result.failure), /private-provider-detail/);
  }
  for (const error of [
    '404: {"message":"model_not_found private-provider-detail"}',
    '404: malformed "type":"model_not_found"',
    '401: {"type":"model_not_found"}',
    '{"type":"model_not_found"}',
    "404: null"
  ]) {
    assert.equal(mainRunFailure(message("error", error), 0, null).failure.providerCode, undefined);
  }
});
