import { readdir, rm, access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./test.mjs";

// tsc does not remove outputs of deleted/moved source files. Only remove orphaned
// compiler products: keep native executables, icons, Python runners and bundles.
export async function cleanCompiled(root = repositoryRoot) {
  const removed = [];
  const exists = async (path) =>
    access(resolve(root, path)).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    );
  async function visit(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /(?:\.js|\.d\.ts)(?:\.map)?$/.test(file)) {
        const source = file.replace(/^dist\//, "").replace(/(?:\.js|\.d\.ts)(?:\.map)?$/, "");
        if ((await exists(`${source}.ts`)) || (await exists(`${source}.js`))) continue;
        await rm(resolve(root, file));
        removed.push(file);
      }
    }
  }
  for (const directory of ["dist/src", "dist/test", "dist/web"]) await visit(directory);
  return removed.sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cleanCompiled()
    .then((removed) => {
      for (const file of removed) console.log(`Removed orphaned compiler output: ${file}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
