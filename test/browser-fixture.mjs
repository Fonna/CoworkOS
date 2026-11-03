import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

export const browserTestOptions = {
  timeout: 30000,
  skip: existsSync(chromium.executablePath())
    ? false
    : "Chromium absent: npx --yes --package=playwright-core@1.63.0 playwright-core install chromium"
};

export async function browserFixture() {
  let slowStarted;
  const started = new Promise((done) => (slowStarted = done));
  const timers = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (["/advanced", "/frame", "/popup"].includes(url.pathname)) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (url.pathname === "/frame")
        return res.end(
          `<button onclick="document.querySelector('p').textContent='Frame saved'">Save</button><p>Frame ready</p>`
        );
      if (url.pathname === "/popup")
        return res.end(
          `<title>Owned popup</title><button onclick="document.querySelector('p').textContent='Popup saved'">Save popup</button><p>Popup ready</p>`
        );
      return res.end(`<!doctype html><title>Advanced fixture</title>
        <section aria-label="First"><button onclick="document.querySelector('#result').textContent='First saved'">Save</button></section>
        <section aria-label="Second"><button onclick="document.querySelector('#result').textContent='Second saved'">Save</button></section>
        <p id="result" role="status">Ready</p>
        <button onclick="setTimeout(()=>{const section=document.createElement('section');section.setAttribute('aria-label','Late scope');section.innerHTML='<button>Late save</button>';document.body.append(section)},50)">Show scope</button>
        <button onclick="document.querySelector('iframe').remove()">Remove frame</button>
        <iframe title="Editor" name="editor" src="/frame"></iframe>
        <canvas width="240" height="160" style="position:absolute;left:20px;top:300px;background:#315ac4"></canvas>
        <p id="pointer" style="position:absolute;top:470px">Pointer ready</p>
        <div style="height:2000px"></div>
        <script>
          const board=document.querySelector('canvas'), status=document.querySelector('#pointer');
          let startX=0;
          board.addEventListener('click',event=>{if(Math.abs(event.clientX-startX)<5)status.textContent='Canvas clicked'});
          board.addEventListener('pointerdown',event=>{startX=event.clientX;status.textContent='Drag started'});
          board.addEventListener('pointerup',()=>status.textContent='Drag ended');
          board.addEventListener('wheel',event=>{event.preventDefault();status.textContent='Wheel '+event.deltaY},{passive:false});
        </script>`);
    }
    if (url.pathname === "/download" || url.pathname === "/large" || url.pathname === "/slow") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="../../report.txt"'
      });
      if (url.pathname === "/slow") {
        res.write("pending-download");
        slowStarted();
        const timer = setTimeout(() => res.end("finished"), 10000);
        timers.add(timer);
        res.once("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
        return;
      }
      return res.end(url.pathname === "/large" ? "x".repeat(4096) : "Saved report: CoworkOS 中文\n");
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>Browser fixture</title></head><body>
      <label>Name <input id="name" aria-label="Name"></label>
      <button onclick="document.querySelector('#status').textContent='Saved '+document.querySelector('#name').value;document.cookie='session=task-a'">Save</button>
      <div id="status" role="status">Ready</div><div id="cookie"></div>
      <button onclick="setTimeout(()=>{document.querySelector('#later').hidden=false;document.querySelector('#enabled').disabled=false},100)">Show later</button>
      <p id="later" hidden>Finished later</p><button id="enabled" disabled>Enabled later</button>
      <button onclick="document.querySelector('#status').textContent='incorrect duplicate'">Duplicate</button><button>Duplicate</button>
      <label for="format-select">Format</label><select id="format-select" onchange="document.querySelector('#format').textContent='Format: '+this.value"><option value="txt">Text</option><option value="json">JSON</option></select><p id="format">Format: txt</p>
      <label><input type="checkbox" data-testid="agree">Agree</label>
      <a href="/download" download>Download report</a><a href="/large" download>Large report</a><a href="/slow" download>Slow report</a>
      <button onclick="window.open('/popup')">Popup</button>
      <button onclick="let n=0;let timer=setInterval(()=>{window.open('/popup');if(++n===35){clearInterval(timer);document.querySelector('#status').textContent='Popup storm finished'}},20)">Popup storm</button>
      <button onclick="document.body.remove()">Remove body</button>
      <script>document.querySelector('#cookie').textContent='Cookie: '+(document.cookie||'empty')</script>
      </body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    started,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}
