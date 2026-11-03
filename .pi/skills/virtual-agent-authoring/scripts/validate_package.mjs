#!/usr/bin/env node

import { readFile, realpath, stat, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const errors = [];
const packageDirectory = resolve(process.argv[2] ?? ".");
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

function requiredString(value, name) {
  if (typeof value === "string" && value.trim()) return true;
  errors.push(`${name} must be a non-empty string`);
  return false;
}

async function packagePath(value, name, kind, optional = false) {
  if (!requiredString(value, name)) return;
  const target = resolve(packageDirectory, value);
  if (isAbsolute(value) || !inside(packageDirectory, target)) {
    errors.push(`${name} must be a relative path inside the package`);
    return;
  }
  try {
    // State is created on first poll. Check its existing parent without
    // requiring an initial state file or following a link out of the package.
    const root = await realpath(packageDirectory);
    let existing = target;
    for (;;) {
      try {
        if (!inside(root, await realpath(existing))) {
          errors.push(`${name} resolves outside the package`);
          return;
        }
        break;
      } catch (error) {
        if (!optional || error.code !== "ENOENT" || existing === packageDirectory) throw error;
        const link = await lstat(existing).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (link?.isSymbolicLink()) throw error;
        existing = dirname(existing);
      }
    }
    if (existing === target) {
      const info = await stat(target);
      if (kind === "file" ? !info.isFile() : !info.isDirectory()) {
        errors.push(`${name} must be a ${kind}`);
        return;
      }
    }
    return target;
  } catch (error) {
    errors.push(`${name} is not accessible: ${error.code ?? error.message}`);
  }
}

let manifest;
const manifestPath = await packagePath("manifest.json", "manifest.json", "file");
if (manifestPath) {
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      errors.push("manifest.json must contain an object");
      manifest = undefined;
    }
  } catch (error) {
    errors.push(`manifest.json is not valid JSON: ${error.message}`);
  }
}

let entrypoint;
if (manifest) {
  requiredString(manifest.name, "name");
  requiredString(manifest.version, "version");
  entrypoint = await packagePath(manifest.entrypoint, "entrypoint", "file");
  await packagePath(manifest.handler, "handler", "file");
  await packagePath(manifest.state, "state", "file", true);
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0 || manifest.sources.some((source) => typeof source !== "string" || !source.trim())) {
    errors.push("sources must be a non-empty array of strings");
  }
  if (!manifest.events || typeof manifest.events !== "object" || Array.isArray(manifest.events)) {
    errors.push("events must be an object");
  } else {
    requiredString(manifest.events.dedupeKey, "events.dedupeKey");
    if (!["never", "important", "always"].includes(manifest.events.wake)) errors.push("events.wake must be never, important, or always");
  }
}

await packagePath("AGENT.md", "AGENT.md", "file");
await packagePath("tests", "tests directory", "directory");

if (entrypoint && errors.length === 0) {
  const check = spawnSync(process.execPath, ["--check", entrypoint], { encoding: "utf8", timeout: 5_000 });
  if (check.status !== 0) errors.push(`entrypoint syntax check failed: ${check.error?.message ?? check.stderr.trim()}`);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Virtual Agent package is structurally valid: ${packageDirectory}`);
console.log("Run the package's behavioral tests separately. This check does not execute or activate the Agent.");
