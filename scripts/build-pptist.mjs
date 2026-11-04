import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, access, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./npm-command.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(root, "vendor/pptist"),
  output = join(root, "web/assets/pptist/generated");
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((e) => !["node_modules", "dist", ".git"].includes(e.name) && !e.name.endsWith(".tsbuildinfo"))
        .map((e) => (e.isDirectory() ? files(join(dir, e.name)) : join(dir, e.name)))
    )
  )
    .flat()
    .sort();
}
const hash = createHash("sha256");
hash.update(await readFile(new URL(import.meta.url)));
for (const file of await files(source)) {
  hash.update(file.slice(source.length));
  hash.update(await readFile(file));
}
const fingerprint = hash.digest("hex"),
  marker = join(output, ".source-hash");
if ((await readFile(marker, "utf8").catch(() => "")) !== fingerprint) {
  const lockHash = createHash("sha256")
    .update(await readFile(join(source, "package-lock.json")))
    .digest("hex");
  const dependencyMarker = join(source, "node_modules/.atria-lock-hash");
  if (
    !(await access(join(source, "node_modules/vite/bin/vite.js")).then(
      () => true,
      () => false
    )) ||
    (await readFile(dependencyMarker, "utf8").catch(() => "")) !== lockHash
  ) {
    const npm = npmCommand(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    execFileSync(npm.command, npm.args, { cwd: source, stdio: "inherit" });
    await writeFile(dependencyMarker, lockHash);
  }
  execFileSync(
    process.execPath,
    [join(source, "node_modules/vite/bin/vite.js"), "build", "--outDir", output, "--emptyOutDir"],
    { cwd: source, stdio: "inherit" }
  );
  await copyFile(join(source, "LICENSE"), join(output, "LICENSE.txt"));
  execFileSync(
    "tar",
    [
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=*.tsbuildinfo",
      "-czf",
      join(output, "source.tar.gz"),
      "-C",
      source,
      "."
    ],
    { stdio: "inherit" }
  );
  await writeFile(marker, fingerprint);
}
