import { randomInt, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { PNG } from "pngjs";

const glyphs = {
  2: ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
  3: ["11111", "00001", "00001", "11111", "00001", "00001", "11111"],
  4: ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
  5: ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  6: ["11111", "10000", "10000", "11111", "10001", "10001", "11111"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["11111", "10001", "10001", "11111", "10001", "10001", "11111"],
  9: ["11111", "10001", "10001", "11111", "00001", "00001", "11111"]
};

function challengeImage(token) {
  const image = new PNG({ width: 300, height: 80 });
  image.data.fill(255);
  for (const [index, digit] of [...token].entries())
    for (const [y, row] of glyphs[digit].entries())
      for (const [x, on] of [...row].entries())
        if (on === "1")
          for (let yy = 0; yy < 2; yy++)
            for (let xx = 0; xx < 2; xx++) {
              const offset = ((24 + y * 2 + yy) * image.width + 24 + index * 17 + x * 2 + xx) * 4;
              image.data.set([23, 40, 71, 255], offset);
            }
  return PNG.sync.write(image);
}

/** Loopback fixture; the random answer exists only in pixels, never in page text or URLs. */
export async function cuaLiveFixture() {
  const token = Array.from({ length: 6 }, () => randomInt(2, 10)).join("");
  const image = challengeImage(token);
  let attempts = 0,
    accepted = 0,
    duplicateSubmissions = 0,
    decoySubmissions = 0,
    downloads = 0;
  let receipt;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && path === "/challenge.png") {
      response.setHeader("content-type", "image/png");
      return response.end(image);
    }
    if (request.method === "POST" && path === "/decoy") {
      decoySubmissions++;
      response.writeHead(400);
      return response.end("Wrong form");
    }
    if (request.method === "POST" && path === "/submit") {
      attempts++;
      if (receipt) {
        duplicateSubmissions++;
        response.writeHead(409);
        return response.end("Already saved; download the existing receipt");
      }
      if (attempts > 3) {
        response.writeHead(429);
        return response.end("Attempt limit reached");
      }
      let body = "";
      try {
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 8192) throw new Error();
        }
        const value = JSON.parse(body);
        if (value.code !== token || value.memo !== "CoworkOS browser verification") throw new Error();
        accepted++;
        receipt = Buffer.from(
          JSON.stringify({
            receiptId: randomUUID(),
            code: token,
            memo: value.memo,
            accepted,
            result: "saved"
          }) + "\n"
        );
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ status: "Saved and verified" }));
      } catch {
        response.writeHead(400);
        return response.end("Code or memo did not match; reobserve before correcting");
      }
    }
    if (request.method === "GET" && path === "/download") {
      if (!receipt) {
        response.writeHead(409);
        return response.end("Save first");
      }
      downloads++;
      response.writeHead(200, {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="cua-live-receipt.json"'
      });
      return response.end(receipt);
    }
    if (request.method !== "GET" || path !== "/") {
      response.writeHead(404);
      return response.end();
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>CoworkOS visual challenge</title>
      <style>body{font:18px system-ui;margin:32px;color:#172847}canvas{display:block;border:1px solid #aaa;margin:12px 0}section{display:inline-block;vertical-align:top;margin:12px 40px 12px 0;padding:20px;border:1px solid #bbb}label{display:block;margin:10px 0}input{font:inherit;width:240px}button,a{font:inherit;margin:8px 0}</style></head><body>
      <h1>Visual receipt challenge</h1><p>Read the six small digits in the canvas. They are available only as pixels. Enlarge the screenshot crop before filling the Receipt form.</p>
      <canvas width="300" height="80" aria-label="Six-digit visual challenge"></canvas>
      <section role="region" aria-label="Decoy form"><h2>Decoy form</h2><label>Verification code <input aria-label="Verification code"></label><label>Memo <input aria-label="Memo"></label><button onclick="fetch('/decoy',{method:'POST'})">Save</button></section>
      <section role="region" aria-label="Receipt form"><h2>Receipt form</h2><label>Verification code <input id="code" aria-label="Verification code" autocomplete="off"></label><label>Memo <input id="memo" aria-label="Memo" autocomplete="off"></label><button id="save">Save</button><p id="status" role="status">Not saved</p><a id="download" href="/download" download hidden>Download receipt</a></section>
      <script>
      const picture=new Image();picture.onload=()=>document.querySelector('canvas').getContext('2d').drawImage(picture,0,0);picture.src='/challenge.png';
      document.querySelector('#save').onclick=async()=>{const result=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.querySelector('#code').value,memo:document.querySelector('#memo').value})});const text=await result.text();document.querySelector('#status').textContent=result.ok?'Saved and verified':text;if(result.ok){document.querySelector('#download').hidden=false;document.querySelector('#save').disabled=true}};
      </script></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    summary: () => ({
      attempts,
      accepted,
      duplicateSubmissions,
      decoySubmissions,
      downloads,
      challengeSha256: createHash("sha256").update(image).digest("hex")
    }),
    receipt: () => receipt,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}
