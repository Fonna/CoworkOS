import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
if (process.platform !== "darwin") process.exit(0);
const source = "src/gui/macos-helper.swift";
const output = "dist/src/gui/atria-computer-use";
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`;
const hash = createHash("sha256")
  .update(target)
  .update(await readFile(source))
  .digest("hex");
if (
  (await access(output).then(
    () => true,
    () => false
  )) &&
  (await readFile(`${output}.sha256`, "utf8").catch(() => "")) === hash
)
  process.exit(0);
await mkdir("dist/src/gui", { recursive: true });
execFileSync(
  "/usr/bin/xcrun",
  ["swiftc", "-target", target, "-parse-as-library", "-O", source, "-o", output],
  {
    stdio: "inherit"
  }
);
await writeFile(`${output}.sha256`, hash);
