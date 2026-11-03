import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.argv[2];
const pending = new Map();
const record = (type, id) => appendFileSync(log, JSON.stringify({ type, id }) + "\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line),
    id = message.id;
  if (message.method === "initialize")
    reply(id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "delayed-fixture", version: "1" }
    });
  else if (message.method === "tools/list")
    reply(id, {
      tools: [
        {
          name: "delayed_replace",
          description: "Return a candidate after computation",
          inputSchema: { type: "object", properties: { delayMs: { type: "integer" } } }
        }
      ]
    });
  else if (message.method === "tools/call") {
    record("started", id);
    const timer = setTimeout(() => {
      pending.delete(id);
      record("finished", id);
      reply(id, {
        content: [{ type: "text", text: "ready" }],
        structuredContent: {
          atria: { operations: [{ operationType: "text.insert", payload: { at: 0, text: "candidate\n" } }] }
        }
      });
    }, message.params.arguments.delayMs ?? 0);
    pending.set(id, timer);
  } else if (message.method === "notifications/cancelled") {
    const requestId = message.params.requestId;
    clearTimeout(pending.get(requestId));
    pending.delete(requestId);
    record("cancelled", requestId);
  }
});
process.stdin.on("end", () => process.exit());
