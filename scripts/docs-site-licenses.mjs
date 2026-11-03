import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const licenseFile = /^(?:licen[cs]e|copying|notice|copyright|unlicen[cs]e)(?:[._-].*)?$/i;
const termsFile = /^(?:licen[cs]e|copying|unlicen[cs]e)(?:[._-].*)?$/i;
const readmeFile = /^readme(?:\.(?:md|markdown|txt))?$/i;
const licenseSection =
  /^#{1,6}\s+(?:licen[cs]e|licensing|copyright|copying)\b|permission is hereby granted|licensed under|SPDX-License-Identifier/im;
// This package ships complete MIT terms in its README. Accept only the reviewed bytes.
const reviewedReadmeTerms = new Map([
  ["fastdom@1.0.12", "cc5669ab6f7741bb061c8a7244addc8e3af1f84ec7d2445744b59d0169a87d11"]
]);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]
  );
const posix = (value) => value.split(sep).join("/");
const href = (value) => value.split("/").map(encodeURIComponent).join("/");

function packageRoot(source, input) {
  if (input.startsWith("<") || input.includes("\0")) return undefined;
  const parts = resolve(source, input).split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || !parts[at + 1]) return undefined;
  const scoped = parts[at + 1].startsWith("@");
  const names = parts.slice(at + 1, at + (scoped ? 3 : 2));
  if (names.length !== (scoped ? 2 : 1) || names.some((name) => !/^@?[a-z\d._-]+$/i.test(name)))
    return undefined;
  return { root: parts.slice(0, at + 1 + names.length).join(sep), name: names.join("/") };
}

function destination(output, file) {
  const target = resolve(output, file);
  const within = relative(output, target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error("License destination escapes the site output");
  }
  return target;
}

function spdx(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (typeof manifest.license?.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    return (
      manifest.licenses
        .map((entry) => (typeof entry === "string" ? entry : entry?.type))
        .filter(Boolean)
        .join(" / ") || "Not declared"
    );
  }
  return "Not declared";
}

/** Preserve complete license files for packages actually used by browser bundles. */
export async function writeBundleLicenses({ source, output, metafile }) {
  if (!isAbsolute(source) || !isAbsolute(output))
    throw new Error("License source/output must be absolute paths");
  const roots = new Map();
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const item = packageRoot(source, input);
    if (item) roots.set(item.root, item);
  }
  const files = [];
  const packages = [];
  const missing = [];
  const directories = new Map();
  for (const item of [...roots.values()].sort((a, b) => a.root.localeCompare(b.root))) {
    let manifest = {};
    try {
      const manifestFile = resolve(item.root, "package.json");
      if ((await lstat(manifestFile)).isFile()) {
        const parsed = JSON.parse(await readFile(manifestFile, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const name = typeof manifest.name === "string" ? manifest.name : item.name;
    const version = typeof manifest.version === "string" ? manifest.version : "Unknown";
    const label = `${name}@${version}`;
    // Folder names come from the resolved dependency path, never manifest fields.
    const base = `${item.name}@${encodeURIComponent(version)}`;
    const occurrence = (directories.get(base) ?? 0) + 1;
    directories.set(base, occurrence);
    const directory = `_site/licenses/${base}${occurrence > 1 ? `-${occurrence}` : ""}`;
    const entries = (await readdir(item.root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !/[\\/\0]/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const selected = entries.filter((entry) => licenseFile.test(entry.name));
    let hasTerms = selected.some((entry) => termsFile.test(entry.name));
    let fallback = false;
    if (!hasTerms) {
      for (const entry of entries.filter((entry) => readmeFile.test(entry.name))) {
        const contents = await readFile(resolve(item.root, entry.name));
        if (!licenseSection.test(contents.toString("utf8"))) continue;
        selected.push(entry);
        fallback = true;
        hasTerms = createHash("sha256").update(contents).digest("hex") === reviewedReadmeTerms.get(label);
        break;
      }
      // Unreviewed README sections or NOTICE files do not prove complete terms.
      if (!hasTerms) missing.push(label);
    }
    const links = [];
    for (const entry of selected) {
      const filename = `${entry.name}.txt`;
      const file = `${directory}/${filename}`;
      const target = destination(output, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(item.root, entry.name), target);
      files.push(file);
      links.push(`<a href="${escape(href(file.slice("_site/licenses/".length)))}">${escape(entry.name)}</a>`);
    }
    packages.push({ name, version, license: spdx(manifest), links, missing: !hasTerms, fallback });
  }
  const rows = packages
    .map(
      (item) =>
        `<tr><td><strong>${escape(item.name)}</strong></td><td>${escape(item.version)}</td><td><code>${escape(item.license)}</code></td><td>${item.links.join("<br>") || "No root-level license file"}${item.missing ? `<small>${item.fallback ? "README fallback; standalone terms missing" : "Complete license terms not found"}</small>` : ""}</td></tr>`
    )
    .join("\n");
  const index = "_site/licenses/index.html";
  const target = destination(output, index);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Browser bundle licenses · CoworkOS Docs</title>
<style>:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#30364b;background:#f7f8fc}body{max-width:1100px;margin:64px auto;padding:0 24px}h1{font-size:30px;letter-spacing:-.8px}p{color:#838a9e;line-height:1.7}a{color:#7561bc;text-decoration:none}a:hover{text-decoration:underline}.table{overflow:auto;border:1px solid #e3e5ee;border-radius:10px;background:white;margin:30px 0}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px;line-height:1.8}th,td{padding:14px 18px;border-bottom:1px solid #edeef5;vertical-align:top}th{background:#f1f2f8;color:#798198;font-size:11px}tr:last-child td{border-bottom:0}code{font-size:11px;color:#8675a3}small{display:block;color:#b39374;font-size:10px;margin-top:7px}footer{font-size:11px;color:#9ca2b2;margin:30px 0}@media(max-width:600px){body{margin:30px auto;padding:0 16px}th,td{padding:11px 12px}h1{font-size:25px}}</style>
</head><body><a href="../../docs/README.html">← CoworkOS Docs</a><h1>Browser bundle licenses</h1><p>${packages.length} bundled packages. Original license and notice files are preserved in full.${missing.length ? ` ${missing.length} package(s) need review because standalone terms were not found.` : ""}</p><div class="table"><table><thead><tr><th>Package</th><th>Version</th><th>License declaration</th><th>Original files</th></tr></thead><tbody>${rows}</tbody></table></div><footer>Package declarations are reported as installed. README fallbacks are identified explicitly; no terms are inferred or fetched from the network.</footer></body></html>`,
    "utf8"
  );
  files.push(index);
  console.log(`Browser bundle licenses: ${packages.length} packages, ${files.length} files`);
  for (const label of missing) console.warn(`Missing standalone license terms: ${label}`);
  return { files: files.map(posix), packages: packages.length, missing };
}
