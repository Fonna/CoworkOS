import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const privateFiles =
  /^(?:config\.json$|\.openai\/hosting\.json$|(?:\.tmp|\.cowork|\.cowork-cli|node_modules|dist|build|release|applications|workspace|test-results|playwright-report|docs\/history)\/|task-[^/]+\/)/;
const credential =
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/g;
const personalPath = /\/(?:Users|home)\/([^\s/"'<>`]+)/g;
const numericUrl = /https?:\/\/((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?/g;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g;
const testFile = /^(?:test|e2e)\//;
const exampleUser = /^(?:example|user|alice|bob|developer|fixture|test|runner|USERNAME)$/;

function localOrExampleAddress(address) {
  const parts = address.split(".").map(Number);
  if (parts.some((part) => part > 255)) return true;
  return (
    parts[0] === 127 ||
    address === "0.0.0.0" ||
    address.startsWith("192.0.2.") ||
    address.startsWith("198.51.100.") ||
    address.startsWith("203.0.113.")
  );
}

/** Findings contain locations and rule names, never matching credential values. */
export function inspectSource(path, content) {
  if (privateFiles.test(path)) return [{ path, line: 1, rule: "private-or-generated-file" }];
  const findings = [];
  const add = (match, rule) =>
    findings.push({ path, line: content.slice(0, match.index).split("\n").length, rule });
  for (const match of content.matchAll(privateKey)) add(match, "private-key");
  for (const match of content.matchAll(credential)) {
    if (testFile.test(path) && /^sk-(?:test|fixture|example)-/.test(match[0])) continue;
    add(match, "credential-token");
  }
  if (!path.startsWith("vendor/")) {
    for (const match of content.matchAll(personalPath))
      if (!exampleUser.test(match[1])) add(match, "personal-home-path");
    if (!testFile.test(path))
      for (const match of content.matchAll(numericUrl))
        if (!localOrExampleAddress(match[1])) add(match, "numeric-service-address");
  }
  return findings;
}

export async function checkSource(root, files) {
  const selected = files ?? [
    ...new Set(
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        encoding: "utf8"
      })
        .split("\0")
        .filter(Boolean)
    )
  ];
  const findings = [];
  let checked = 0;
  for (const path of selected) {
    let metadata;
    try {
      metadata = await lstat(resolve(root, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (privateFiles.test(path)) {
      findings.push(...inspectSource(path, ""));
      continue;
    }
    if (metadata.isSymbolicLink()) {
      findings.push({ path, line: 1, rule: "source-symlink-needs-review" });
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(resolve(root, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (bytes.includes(0)) continue;
    checked++;
    findings.push(...inspectSource(path, bytes.toString("utf8")));
  }
  return { checked, findings };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await checkSource(process.cwd());
  for (const finding of result.findings) console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
  console.log(`Source hygiene: ${result.checked} text files, ${result.findings.length} findings.`);
  if (result.findings.length) process.exitCode = 1;
}
