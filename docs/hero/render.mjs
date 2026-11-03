import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import "./build.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const built = resolve(source, "../../.tmp/readme-hero");
const frames = resolve(process.argv[2] || resolve(source, "../../.tmp/readme-tech-frames"));
await mkdir(frames, { recursive: true });
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      built,
      `.${new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html")}`
    );
    if (!path.startsWith(built + sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 480 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?capture=1`);
  await page.waitForFunction(
    () => document.documentElement.dataset.captureReady === "true",
    {},
    { timeout: 60000 }
  );
  await page.evaluate(() => document.fonts.ready);
  // Direct sampling of a periodic scene: 120 frames, six seconds at 20 fps.
  for (let index = 0; index < 120; index++) {
    const time = index / 20;
    await page.evaluate((value) => window.renderHeroFrame(value), time);
    await page.screenshot({
      path: resolve(frames, `frame-${String(index).padStart(3, "0")}.png`),
      omitBackground: false
    });
    if (index % 30 === 0) console.log(`Rendered ${index}/120`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  await page.goto(`http://127.0.0.1:${server.address().port}/?capture=1&static=1`);
  await page.waitForFunction(() => document.documentElement.dataset.captureReady === "true");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(frames, "static.png") });
  console.log(`Frames: ${frames}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
