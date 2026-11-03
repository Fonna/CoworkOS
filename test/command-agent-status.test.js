import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { toolExecutionFailed } from "../web/assets/tool-result.js";

async function fixture(t, name, args) {
  const root = await mkdtemp(join(tmpdir(), "atria-command-agent-status-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "command-fixture", object: "chat.completion.chunk", created: 1, model: "command-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant" });
    if (!body.messages.some((message) => message.role === "tool")) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "command-1",
            type: "function",
            function: { name, arguments: JSON.stringify(typeof args === "function" ? args(root) : args) }
          }
        ]
      });
      send({}, "tool_calls");
    } else {
      send({ content: "Fixture result inspected." });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const tools = new Map(createBuiltinTools({ rootDirectory: root }));
  tools.set("business_payload", {
    execute: async () => ({ failed: true, count: 1 }),
    parameters: { type: "object", properties: {} }
  });
  const events = [];
  const session = new PiSession({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "local-fixture",
    model: "command-fixture",
    thinkingLevel: "off",
    maxTokens: 512,
    maxTurns: 2,
    maxErrorRetries: 0,
    timeoutMs: 5000,
    tools,
    onEvent(event) {
      events.push(event);
    }
  });
  const result = await session.run("Use the requested tool once and inspect its actual result.");
  assert.equal(result.termination, "completed");
  return {
    requests,
    message: result.messages.find((message) => message.role === "toolResult"),
    end: events.find((event) => event.type === "tool_execution_end")
  };
}

test("failed tests with empty stderr are failures in the model transcript and activity", async (t) => {
  const f = await fixture(t, "run_tests", { command: process.execPath, args: ["-e", "process.exit(1)"] });
  assert.equal(f.message.details.exitCode, 1);
  assert.equal(f.message.details.failed, true);
  assert.equal(f.message.isError, true);
  assert.equal(f.end.isError, true);
  assert.equal(toolExecutionFailed(f.end), true);
  assert.match(f.message.details.stderr, /Command failed/);
});

test("ordinary nonzero commands retain stderr and are marked failed", async (t) => {
  const f = await fixture(t, "run_command", {
    command: process.execPath,
    args: ["-e", "process.stderr.write('expected fixture failure');process.exit(3)"]
  });
  assert.equal(f.message.details.exitCode, 3);
  assert.equal(f.message.details.stderr, "expected fixture failure");
  assert.equal(f.message.isError, true);
  assert.equal(toolExecutionFailed(f.end), true);
});

test("a successful test command remains successful with exit zero", async (t) => {
  const f = await fixture(t, "run_tests", {
    command: process.execPath,
    args: ["-e", "console.log('fixture passed')"]
  });
  assert.equal(f.message.details.exitCode, 0);
  assert.equal(f.message.isError, false);
  assert.equal(toolExecutionFailed(f.end), false);
  assert.match(f.message.details.stdout, /fixture passed/);
});

test("run_tests explains directory ownership and still rejects absolute cwd", async (t) => {
  const f = await fixture(t, "run_tests", (root) => ({
    command: process.execPath,
    args: ["-e", "console.log('unreachable')"],
    cwd: root
  }));
  assert.equal(f.message.isError, true);
  assert.equal(toolExecutionFailed(f.end), true);
  assert.match(f.message.content[0].text, /path must be relative/);
  const schema = f.requests[0].tools.find((tool) => tool.function.name === "run_tests").function.parameters;
  assert.match(schema.properties.cwd.description, /Relative/);
  assert.match(schema.properties.cwd.description, /Agent's working directory/);
});

test("a user business payload named failed does not become a runtime tool exception", async (t) => {
  const f = await fixture(t, "business_payload", {});
  assert.equal(f.message.details.failed, true);
  assert.equal(f.message.isError, false);
  assert.equal(toolExecutionFailed(f.end), false);
});
