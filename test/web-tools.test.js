import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { createWebTools } from "../dist/src/tools/web-tools.js";

function cleanProxy(t) {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function server(t, handle) {
  cleanProxy(t);
  const requests = [];
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    await handle(req, res, requests);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
  });
  return { http, requests, port: http.address().port, url: `http://127.0.0.1:${http.address().port}` };
}

test("Serper rotates throttled/rejected credentials, redacts echoes, and keeps its result contract", async (t) => {
  const service = await server(t, (req, res) => {
    const key = req.headers["x-api-key"];
    if (key === "throttled-fixture") {
      res.writeHead(429, { "retry-after": "60" });
      return res.end(key);
    }
    if (key === "bad-fixture") {
      res.writeHead(401);
      return res.end(key);
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        organic: [{ title: "Receipt", link: "https://example.org", snippet: key }],
        extra: "kept in raw mode"
      })
    );
  });
  const tools = createWebTools({
    serperApiKeys: ["throttled-fixture", "bad-fixture", "good-fixture"],
    serperEndpoint: service.url
  });
  const result = await tools.get("search").execute({ query: "receipt", numResults: 4 });
  assert.deepEqual(
    service.requests.map((item) => item.headers["x-api-key"]),
    ["throttled-fixture", "bad-fixture", "good-fixture"]
  );
  assert.deepEqual(JSON.parse(service.requests.at(-1).body), { q: "receipt", num: 4 });
  assert.equal(result.query, "receipt");
  assert.equal(result.organic[0].snippet, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /good-fixture|bad-fixture|throttled-fixture/);
  assert.equal(result.extra, undefined);
  await tools.get("search").execute({ query: "next" });
  assert.equal(service.requests.at(-1).headers["x-api-key"], "good-fixture");
  const raw = await createWebTools({
    serperApiKeys: ["good-fixture"],
    serperEndpoint: service.url,
    rawSearchResults: true
  })
    .get("search")
    .execute({ query: "raw" });
  assert.equal(raw.extra, "kept in raw mode");
  assert.equal(raw.organic[0].snippet, "[REDACTED]");
});

test("non-retryable failures are requested once and never expose response secrets", async (t) => {
  const service = await server(t, (_req, res) => {
    res.writeHead(400);
    res.end("secret-fixture");
  });
  const search = createWebTools({ serperApiKeys: ["secret-fixture"], serperEndpoint: service.url }).get(
    "search"
  );
  await assert.rejects(
    search.execute({ query: "bad" }),
    (error) => /HTTP 400/.test(error.message) && !error.message.includes("secret-fixture")
  );
  assert.equal(service.requests.length, 1);
  await assert.rejects(search.execute({ query: "bad", numResults: 1.5 }), /numResults/);
  assert.equal(service.requests.length, 1);
});

test("cancellation ends a key cooldown without another HTTP request", { timeout: 3000 }, async (t) => {
  let received;
  const first = new Promise((resolve) => {
    received = resolve;
  });
  const service = await server(t, (_req, res) => {
    res.writeHead(429, { "retry-after": "60" });
    res.end();
    received();
  });
  const controller = new AbortController();
  const pending = createWebTools({ serperApiKeys: ["fixture-key"], serperEndpoint: service.url })
    .get("search")
    .execute({ query: "wait" }, controller.signal);
  await first;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(service.requests.length, 1);
});

test("direct visit bounds streaming bodies, preserves status, and validates every redirect", async (t) => {
  const service = await server(t, (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/html" });
      return res.end();
    }
    if (req.url === "/long") return res.end("x".repeat(8192));
    if (req.url === "/missing") {
      res.writeHead(404);
      return res.end("missing");
    }
    if (req.url === "/pdf") {
      res.setHeader("content-type", "application/pdf");
      return res.end("%PDF fixture");
    }
    res.setHeader("content-type", "text/html");
    res.end(
      "<title>Receipt &amp; total</title><script>secret script</script><p>Total &#999999999; &euro; 12</p>"
    );
  });
  const visit = createWebTools({ allowPrivateNetwork: true, maxContentBytes: 512 }).get("visit");
  const page = await visit.execute({ url: `${service.url}/redirect` });
  assert.equal(page.url, `${service.url}/html`);
  assert.equal(page.title, "Receipt & total");
  assert.match(page.content, /€ 12/);
  assert.doesNotMatch(page.content, /secret script/);
  const large = await visit.execute({ url: `${service.url}/long` });
  assert.equal(large.content.length, 512);
  assert.equal(large.truncated, true);
  const missing = await visit.execute({ url: `${service.url}/missing` });
  assert.equal(missing.status, 404);
  assert.equal(missing.isError, true);
  await assert.rejects(visit.execute({ url: `${service.url}/pdf` }), /PDF/);

  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    return new Response("", { status: 302, headers: { location: "http://[::ffff:127.0.0.1]/private" } });
  });
  const publicVisit = createWebTools().get("visit");
  await assert.rejects(publicVisit.execute({ url: "https://public.fixture.test" }), /private-network/);
  assert.equal(requests.length, 1);
  for (const url of [
    "http://127.0.0.1",
    "http://2130706433",
    "http://localhost.",
    "http://[::ffff:7f00:1]",
    "http://[::]",
    "file:///tmp/item",
    "https://user:pass@example.org"
  ]) {
    await assert.rejects(publicVisit.execute({ url }));
  }
  assert.equal(requests.length, 1);
});

test("a stalled body times out and a cancelled visit releases its stream", { timeout: 3000 }, async (t) => {
  let received;
  received = () => {};
  let closed;
  const ended = new Promise((resolve) => {
    closed = resolve;
  });
  const service = await server(t, (_req, res) => {
    res.writeHead(200);
    res.write("partial");
    res.on("close", closed);
    received();
  });
  await assert.rejects(
    createWebTools({ allowPrivateNetwork: true, timeoutMs: 50 }).get("visit").execute({ url: service.url }),
    { name: "TimeoutError" }
  );
  await ended;
  const nextBody = new Promise((resolve) => {
    received = resolve;
  });
  const nextEnded = new Promise((resolve) => {
    closed = resolve;
  });
  const controller = new AbortController();
  const pending = createWebTools({ allowPrivateNetwork: true })
    .get("visit")
    .execute({ url: service.url }, controller.signal);
  await nextBody;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await nextEnded;
});

test("Reader authenticates without redirecting keys, normalizes its target and preserves extraction fallback", async (t) => {
  const service = await server(t, (req, res) => {
    if (req.headers.authorization === "Bearer bad-reader") {
      res.writeHead(402);
      return res.end("bad-reader");
    }
    assert.equal(req.headers["x-respond-with"], "text");
    assert.equal(req.headers["x-timeout"], "12");
    res.end("Title: File\nMarkdown Content:\n--- PDF page 1 ---\nReceipt 12\n--- PDF page 2 ---\nTotal 42");
  });
  const seen = [];
  const options = {
    jinaEndpoint: service.url,
    jinaApiKeys: ["bad-reader", "good-reader"],
    jinaTimeoutSeconds: 12,
    extract: async (input) => {
      seen.push(input);
      return "Evidence: Total 42 on page 2";
    }
  };
  const visit = createWebTools(options).get("visit");
  const result = await visit.execute({
    url: "https://r.jina.ai/https%3A%2F%2Fexample.org%2Ffile.pdf",
    goal: "Find the total"
  });
  assert.equal(result.url, "https://example.org/file.pdf");
  assert.equal(result.extracted, true);
  assert.match(result.content, /42 on page 2/);
  assert.match(seen[0].content, /PDF page 2/);
  assert.equal(seen[0].signal.aborted, false);
  assert.equal(service.requests.at(-1).path, "/https://example.org/file.pdf");
  await assert.rejects(
    visit.execute({ url: "http://localhost/private", goal: "private" }),
    /private-network/
  );
  await assert.rejects(visit.execute({ url: "https://example.org" }), /goal/);
  assert.equal(service.requests.length, 2);
  const fallback = await createWebTools({
    ...options,
    jinaApiKeys: ["good-reader"],
    extract: async () => {
      throw new Error("good-reader");
    }
  })
    .get("visit")
    .execute({ url: "https://example.org/file.pdf", goal: "total" });
  assert.equal(fallback.extracted, false);
  assert.match(fallback.content, /Total 42/);
  assert.doesNotMatch(fallback.extractionError, /good-reader/);
});

test("Reader empty envelopes and credential redirects fail without exposing keys", async (t) => {
  const service = await server(t, (req, res) => {
    if (req.url.includes("redirect")) {
      res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
      return res.end("reader-secret");
    }
    res.end("Title: empty\nMarkdown Content: \n");
  });
  const visit = createWebTools({ jinaApiKeys: ["reader-secret"], jinaEndpoint: service.url }).get("visit");
  await assert.rejects(visit.execute({ url: "https://example.org/empty" }), /no usable page content/);
  await assert.rejects(
    visit.execute({ url: "https://example.org/redirect" }),
    (error) => !error.message.includes("reader-secret")
  );
  assert.equal(service.requests.filter((req) => req.path.includes("redirect")).length, 1);
});

test(
  "web tools use the shared proxy and release tunnels after completed bodies",
  { timeout: 5000 },
  async (t) => {
    const service = await server(t, (_req, res) => res.end('{"organic":[{"title":"proxied"}]}'));
    const connections = new Set();
    const targets = [];
    const proxy = createServer();
    proxy.on("connect", (req, client, head) => {
      targets.push(req.url);
      const upstream = createConnection({ host: "127.0.0.1", port: service.port });
      for (const socket of [client, upstream]) {
        connections.add(socket);
        socket.on("close", () => connections.delete(socket));
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    t.after(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise((done) => proxy.close(done));
    });
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
    const search = createWebTools({
      serperApiKeys: ["local-key"],
      serperEndpoint: `http://web.fixture.test:${service.port}`
    }).get("search");
    assert.equal((await search.execute({ query: "proxy" })).organic[0].title, "proxied");
    assert.equal((await search.execute({ query: "again" })).organic[0].title, "proxied");
    assert.equal(targets.length, 2);
    await Promise.all([...connections].map((socket) => once(socket, "close")));
    assert.equal(connections.size, 0);
  }
);
