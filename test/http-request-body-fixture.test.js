import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";

test("HTTP fixture captures exact JSON when UTF-8 characters cross incoming chunks", async (t) => {
  const raw = JSON.stringify({ text: "避免改写其他文档🙂", tools: [{ name: "write_document" }] });
  const bytes = Buffer.from(raw);
  for (const character of ["免", "🙂"]) {
    const start = bytes.indexOf(Buffer.from(character));
    for (let offset = 1; offset < Buffer.byteLength(character); offset++) {
      await t.test(`${character}: split after byte ${offset}`, async (t) => {
        let firstChunk;
        const firstReceived = new Promise((resolve) => {
          firstChunk = resolve;
        });
        let completeBody;
        const receivedBody = new Promise((resolve) => {
          completeBody = resolve;
        });
        const server = createServer(async (request, response) => {
          request.once("data", firstChunk);
          completeBody(await readFixtureRequestBody(request));
          response.end("ok");
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        });
        const client = httpRequest({ host: "127.0.0.1", port: server.address().port, method: "POST" });
        client.on("response", (response) => response.resume());
        const split = start + offset;
        client.write(bytes.subarray(0, split));
        // Wait for actual receipt so TCP cannot coalesce both writes into one chunk.
        assert.deepEqual(await firstReceived, bytes.subarray(0, split));
        client.end(bytes.subarray(split));
        const actual = await receivedBody;
        assert.equal(actual, raw);
        assert.deepEqual(Buffer.from(actual), bytes);
        assert.deepEqual(JSON.parse(actual), JSON.parse(raw));
      });
    }
  }
});
