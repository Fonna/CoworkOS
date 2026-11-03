import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-smoke-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "configured-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    const reply = ({ text, call }) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      send({ role: "assistant" });
      if (call)
        send({
          tool_calls: [
            {
              index: 0,
              id: `tool-${requests.length}`,
              type: "function",
              function: { name: call[0], arguments: JSON.stringify(call[1]) }
            }
          ]
        });
      else send({ content: text });
      send({}, call ? "tool_calls" : "stop");
      response.end("data: [DONE]\n\n");
    };
    respond(body, reply, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const configPath = join(root, "explicit-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "isolated-fixture-key",
      model: "configured-fixture",
      reasoningEffort: "off",
      supportsReasoningEffort: false
    })
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("COWORK_") && !name.startsWith("SERPER_"))
  );
  const run = async (name, expectedCode = 0) => {
    const child = spawn(process.execPath, [`dist/src/cli/${name}.js`], {
      cwd: resolve("."),
      env: { ...env, COWORK_CONFIG: configPath, COWORK_WORKSPACE: root },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    t.after(() => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const [code] = await once(child, "exit");
    clearTimeout(timer);
    const text = Buffer.concat(output).toString();
    assert.equal(code, expectedCode, text);
    assert.doesNotMatch(text, /isolated-fixture-key/);
    return JSON.parse(text.trim());
  };
  return { requests, run };
}

test(
  "coding acceptance uses explicit model configuration and verifies actual read/edit/test work",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, (body, reply) => {
      const count = body.messages.filter((message) => message.role === "tool").length;
      if (count === 0) return reply({ call: ["read_file", { path: "calc.mjs" }] });
      if (count === 1)
        return reply({
          call: ["apply_patch", { path: "calc.mjs", oldText: "return 1", newText: "return 2" }]
        });

      if (count === 2)
        return reply({ call: ["run_tests", { command: process.execPath, args: ["calc.test.mjs"] }] });
      return reply({ text: "已修改并运行测试。" });
    });
    const receipt = await f.run("coding-smoke");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.model, "configured-fixture");
    assert.equal(receipt.independentlyVerified, true);
    assert.deepEqual(receipt.tools, ["read_file", "apply_patch", "run_tests"]);
    assert.ok(
      f.requests.every(
        (body) =>
          body.model === "configured-fixture" && (body.max_completion_tokens ?? body.max_tokens) === 2048
      )
    );
    assert.equal(f.requests.length, 4);
  }
);

test(
  "two delegated acceptance calls share one run and leave both durable callbacks ready",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, (_body, reply) => reply({ text: "1. 检查行为。\n2. 核对测试。" }));
    const receipt = await f.run("multi-subagent-smoke");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.model, "configured-fixture");
    assert.deepEqual(
      receipt.agents.map((agent) => agent.status),
      ["succeeded", "succeeded"]
    );
    assert.deepEqual(receipt.pending, []);
    assert.equal(receipt.callbackPending.length, 2);
    assert.equal(f.requests.length, 2);
    assert.ok(
      f.requests.every(
        (body) =>
          body.model === "configured-fixture" && (body.max_completion_tokens ?? body.max_tokens) === 1024
      )
    );
  }
);

test(
  "a failed coding acceptance preserves diagnostics and redacts the provider error",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, (_body, _reply, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Rejected isolated-fixture-key", type: "authentication_error" }
        })
      );
    });
    const receipt = await f.run("coding-smoke", 1);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.stopReason, "error");
    assert.match(receipt.error, /401/);
    assert.doesNotMatch(receipt.error, /isolated-fixture-key/);
    assert.equal(f.requests.length, 1, "an acceptance failure must not silently issue more model attempts");
    assert.deepEqual(receipt.tools, []);
    const result = JSON.parse(
      await readFile(
        join(receipt.workspace, "coding-smoke", "runs", "run-1", "agents", "main", "result.json"),
        "utf8"
      )
    );
    assert.equal(result.termination, "aborted", "the incomplete task remains available for diagnosis");
  }
);
