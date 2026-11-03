import { readdir, readFile, stat, lstat } from "node:fs/promises";
import { resolve, relative, extname, join } from "node:path";
import { createRequire } from "node:module";

// Discover likely input assets only. Do not traverse hidden folders, links,
// generated previews or arbitrary project dependencies.
export async function discoverAssets(project = process.cwd(), { limit = 40 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Asset limit must be a positive integer");
  const root = resolve(project),
    images = [],
    seen = new Set();
  let imageSize,
    scanned = 0,
    truncated = false;
  try {
    const require = createRequire(import.meta.url);
    const module = createRequire(require.resolve("pptxgenjs"))("image-size");
    imageSize = typeof module === "function" ? module : module.imageSize;
  } catch {}
  const visit = async (folder, depth) => {
    if ((await lstat(folder).catch(() => null))?.isSymbolicLink()) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (
        e.name.startsWith(".") ||
        ["node_modules", "preview", "previews", "output", "outputs", "artifacts"].includes(e.name)
      )
        continue;
      const path = join(folder, e.name);
      if (e.isDirectory() && depth > 0) {
        await visit(path, depth - 1);
      } else if (e.isFile() && /\.(png|jpe?g|webp|gif|svg)$/i.test(e.name) && !seen.has(path)) {
        seen.add(path);
        scanned++;
        if (images.length >= limit) {
          truncated = true;
          return;
        }
        const info = { path: relative(root, path), format: extname(path).slice(1).toLowerCase() };
        try {
          const size = await stat(path);
          info.bytes = size.size;
          if (size.size <= 20 * 1024 * 1024 && imageSize) {
            const d = imageSize(await readFile(path));
            info.width = d.width;
            info.height = d.height;
          } else info.dimensionsUnavailable = true;
        } catch {
          info.dimensionsUnavailable = true;
        }
        images.push(info);
      }
      if (truncated) return;
    }
  };
  const roots = [".", "materials", "assets", "images", "input", "inputs", "uploads"];
  for (const name of roots) {
    await visit(resolve(root, name), name === "." ? 0 : 3);
    if (truncated) break;
  }
  return { projectRoot: root, rootsSearched: roots, images, scanned, truncated };
}
