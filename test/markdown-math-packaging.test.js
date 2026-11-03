import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, stat, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";

const require = createRequire(import.meta.url);
const config = require("../electron-builder.config.cjs");
const exec = promisify(execFile);

test("desktop file selection carries the complete math renderer, CSS, fonts and license without node_modules", async (t) => {
  const source = resolve(".");
  const stage = await mkdtemp(join(tmpdir(), "atria-math-package-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const filter = new FileMatcher(source, stage, (pattern) => pattern, config.files).createFilter();
  const queue = ["web/assets/markdown.js", "web/assets/math.css", "web/assets/math/generated/LICENSE.txt"];
  const included = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (included.has(file)) continue;
    included.add(file);
    const path = join(source, file);
    assert.equal(filter(path, await stat(path)), true, `App package excludes ${file}`);
    const target = join(stage, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
    if (!/\.(?:js|css)$/.test(file)) continue;
    const content = await readFile(path, "utf8");
    const references = file.endsWith(".css")
      ? [...content.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1])
      : [...content.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
    for (const reference of references) queue.push(relative(source, resolve(dirname(path), reference)));
  }
  assert.ok([...included].some((file) => file.endsWith(".woff2")));
  assert.equal(
    await readFile(join(stage, "web/assets/math/generated/LICENSE.txt"), "utf8"),
    await readFile(join(source, "licenses/katex-0.19.0-LICENSE.txt"), "utf8")
  );
  await writeFile(join(stage, "package.json"), '{"type":"module"}');
  const probe = `
    import assert from 'node:assert/strict';
    import { renderMarkdown } from './web/assets/markdown.js';
    const html = renderMarkdown(${JSON.stringify(String.raw`\[(\log_2 n)^2\]`)});
    assert.match(html, /class="katex-display"/);
    assert.match(html, /<math/);
    console.log('packaged-math-rendered');
  `;
  const result = await exec(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: stage,
    timeout: 15_000
  });
  assert.match(result.stdout, /packaged-math-rendered/);
});
