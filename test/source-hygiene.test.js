import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkSource, inspectSource } from "../scripts/check-source.mjs";

test("source findings identify credentials and paths without echoing values", () => {
  const token = ["sk", "proj", "A".repeat(48)].join("-");
  const home = ["", "Users", "private-person", "project"].join("/");
  const content = `const key = "${token}";\nconst root = "${home}";\n`;
  const findings = inspectSource("src/config.ts", content);
  assert.deepEqual(
    findings.map(({ line, rule }) => ({ line, rule })),
    [
      { line: 1, rule: "credential-token" },
      { line: 2, rule: "personal-home-path" }
    ]
  );
  assert.ok(!JSON.stringify(findings).includes(token));
  assert.ok(!JSON.stringify(findings).includes(home));
  for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "DSA ", "ENCRYPTED "]) {
    const pem = ["-----BEGIN", `${kind}PRIVATE KEY-----`].join(" ");
    assert.equal(inspectSource("vendor/component/file.txt", pem)[0].rule, "private-key");
  }
});

test("source gate allows documented examples and network/redaction fixtures", () => {
  const synthetic = ["sk", "fixture", "test-secret-that-must-be-redacted"].join("-");
  assert.deepEqual(
    inspectSource("test/security.test.js", `${synthetic}\n/Users/example/file\nhttp://192.168.1.2`),
    []
  );
  for (const host of ["127.0.0.1", "0.0.0.0", "192.0.2.1", "198.51.100.5", "203.0.113.7"])
    assert.deepEqual(inspectSource("docs/configuration.md", `http://${host}:3880`), []);
  const address = ["http://", "35", ".", "77", ".", "88", ".", "99", ":3888"].join("");
  assert.equal(inspectSource("src/model.ts", address)[0].rule, "numeric-service-address");
  assert.equal(inspectSource("docs/history/old.md", "")[0].rule, "private-or-generated-file");
});

test("source gate scans Git candidates while keeping ignored local profiles and backups unread", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-source-hygiene-"));
  try {
    await mkdir(join(root, "empty-template"));
    execFileSync("git", ["init", `--template=${join(root, "empty-template")}`], {
      cwd: root,
      stdio: "ignore"
    });
    await writeFile(join(root, ".gitignore"), "config.json\n.tmp/\nempty-template/\n");
    await writeFile(join(root, "public.md"), "Public documentation\n");
    execFileSync("git", ["add", ".gitignore", "public.md"], { cwd: root });
    await mkdir(join(root, "docs/history"), { recursive: true });
    await writeFile(join(root, "docs/history/deleted.md"), "Retired internal note\n");
    execFileSync("git", ["add", "docs/history/deleted.md"], { cwd: root });
    await rm(join(root, "docs/history/deleted.md"));
    await mkdir(join(root, ".tmp"));
    const token = ["ghp", "A".repeat(40)].join("_");
    await writeFile(join(root, "config.json"), token);
    await writeFile(join(root, ".tmp/private-backup.md"), token);
    await writeFile(join(root, "new.md"), "New public guide\n");
    let result = await checkSource(root);
    assert.equal(result.checked, 3);
    assert.deepEqual(result.findings, []);
    await writeFile(join(root, "unsafe.md"), token);
    result = await checkSource(root);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, "unsafe.md");
    await writeFile(join(root, "retained.txt"), token);
    execFileSync("git", ["add", "retained.txt"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "config.json\n.tmp/\nempty-template/\nretained.txt\n");
    execFileSync("git", ["rm", "--cached", "retained.txt"], { cwd: root, stdio: "ignore" });
    result = await checkSource(root);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, "unsafe.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source gate reports private files and symlinks without following them", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-source-metadata-"));
  try {
    const token = ["ghp", "A".repeat(40)].join("_");
    await writeFile(join(root, "config.json"), token);
    await symlink(join(root, "config.json"), join(root, "public-link.json"));
    const result = await checkSource(root, ["config.json", "public-link.json"]);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.findings, [
      { path: "config.json", line: 1, rule: "private-or-generated-file" },
      { path: "public-link.json", line: 1, rule: "source-symlink-needs-review" }
    ]);
    assert.ok(!JSON.stringify(result).includes(token));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
