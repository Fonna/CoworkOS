import ts from "typescript";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preflightCliShell } from "./cli-shell-compatibility.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const policyURL = new URL("./cli-ui-policy.json", import.meta.url);

/** Build-only AST validation; the installed CLI does not need TypeScript. */
export async function buildCliUiManifest(
  outputPath = fileURLToPath(new URL("../dist/cli-ui-manifest.json", import.meta.url))
) {
  const policyBytes = await readFile(policyURL);
  for (const target of preflightCliShell().targets) {
    let shellSource = await readFile(new URL(target.targetURL), "utf8");
    for (const span of [...target.spans].sort((a, b) => b.start - a.start))
      shellSource = shellSource.slice(0, span.start) + span.replacement + shellSource.slice(span.end);
    if (
      ts.createSourceFile(target.targetURL, shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
        .parseDiagnostics.length
    )
      throw new Error("SDK shell projections produced invalid JavaScript");
  }
  const policy = JSON.parse(policyBytes);
  const sdkRoot = fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const metadata = JSON.parse(await readFile(resolve(sdkRoot, "package.json"), "utf8"));
  if (metadata.version !== policy.sdkVersion)
    throw new Error("SDK UI policy needs review after an SDK upgrade");
  for (const [file, expected] of Object.entries(policy.files))
    if (hash(await readFile(resolve(sdkRoot, file))) !== expected)
      throw new Error(`SDK UI policy source mismatch: ${file}`);
  const source = await readFile(resolve(sdkRoot, policy.target), "utf8");
  const ast = ts.createSourceFile(policy.target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error("SDK UI source could not be parsed");
  const classes = [];
  const visit = (node, callback) => {
    callback(node);
    ts.forEachChild(node, (child) => visit(child, callback));
  };
  visit(ast, (node) => {
    if ((ts.isClassExpression(node) || ts.isClassDeclaration(node)) && node.name?.text === policy.className)
      classes.push(node);
  });
  if (classes.length !== 1) throw new Error("SDK UI class must match exactly once");
  const spans = [];
  const select = (method, predicate) => {
    const matches = [];
    visit(method, (node) => {
      if (predicate(node)) matches.push(node);
    });
    if (matches.length !== 1)
      throw new Error(`SDK UI target must match exactly once: ${method.name.getText(ast)}`);
    return matches[0];
  };
  for (const name of policy.methods) {
    const methods = classes[0].members.filter(
      (m) => ts.isMethodDeclaration(m) && m.name.getText(ast) === name
    );
    if (methods.length !== 1) throw new Error(`Missing/duplicate SDK UI method: ${name}`);
    const method = methods[0];
    let node, replacement;
    if (name === "setupEditorSubmitHandler") {
      const branch = select(
        method,
        (n) =>
          ts.isIfStatement(n) &&
          ts.isBinaryExpression(n.expression) &&
          n.expression.left.getText(ast) === "text" &&
          n.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isStringLiteral(n.expression.right) &&
          n.expression.right.text === "/dementedelves"
      );
      if (
        branch.elseStatement ||
        !ts.isBlock(branch.thenStatement) ||
        branch.thenStatement.statements.length !== 2 ||
        !ts.isExpressionStatement(branch.thenStatement.statements[0]) ||
        !ts.isReturnStatement(branch.thenStatement.statements[1])
      )
        throw new Error("SDK hidden command dispatch shape changed");
      node = select(
        branch,
        (n) =>
          ts.isCallExpression(n) &&
          n.expression.getText(ast) === "this.handleDementedDelves" &&
          n.arguments.length === 0
      );
      select(
        branch,
        (n) =>
          ts.isCallExpression(n) &&
          n.expression.getText(ast) === "this.editor.setText" &&
          n.arguments.length === 1 &&
          ts.isStringLiteral(n.arguments[0]) &&
          n.arguments[0].text === ""
      );
      if (
        branch.thenStatement.statements[0].expression.getText(ast) !==
        'this.handleDementedDelves(),this.editor.setText("")'
      )
        throw new Error("SDK hidden command dispatch adjacency changed");
      replacement = 'this.showStatus("CoworkOS 不支持此命令，请使用 /help。")';
    } else {
      const marker = {
        renderProjectTrustWarningIfNeeded: "then restart pi.",
        checkTmuxKeyboardSetup: "Pi works best with csi-u",
        suggestBugReport: "/bug sends a report to the developers.",
        crashReportInstructions: "To report this crash:",
        run: "the crash details are attached automatically."
      }[name];
      node = select(
        method,
        (n) => (ts.isStringLiteral(n) || ts.isTemplateExpression(n)) && n.getText(ast).includes(marker)
      );
      const original = node.getText(ast);
      replacement = {
        renderProjectTrustWarningIfNeeded: () =>
          original.replace("then restart pi.", "then restart coworkos."),
        checkTmuxKeyboardSetup: () => original.replace("Pi works best", "CoworkOS works best"),
        suggestBugReport: () =>
          original.replace(
            "/bug sends a report to the developers.",
            "submit feedback manually. When CoworkOS commands are enabled, /coworkos-bug saves a local feedback file for review."
          ),
        crashReportInstructions: () =>
          original
            .replace("To report this crash:", "To prepare local feedback:")
            .replace("start pi and", "start coworkos and")
            .replace("run /bug.", "run /coworkos-bug when CoworkOS commands are enabled.")
            .replace(
              "The crash details are attached automatically.",
              "Review the saved file before submitting it manually."
            ),
        run: () =>
          original.replace(
            "Run /bug to report it; the crash details are attached automatically.",
            "Run /coworkos-bug when CoworkOS commands are enabled to save local feedback; review the file before submitting it manually."
          )
      }[name]();
      if (replacement === original) throw new Error(`Empty SDK UI difference: ${name}`);
    }
    spans.push({
      id: name,
      start: node.getStart(ast),
      end: node.end,
      original: node.getText(ast),
      replacement
    });
  }
  spans.sort((a, b) => a.start - b.start);
  if (spans.some((span, i) => i > 0 && span.start < spans[i - 1].end))
    throw new Error("Overlapping SDK UI differences");
  if (hash(JSON.stringify(spans)) !== policy.spansSha256)
    throw new Error("SDK UI replacements need independent review before the policy digest is updated");
  let transformed = source;
  for (const span of [...spans].reverse())
    transformed = transformed.slice(0, span.start) + span.replacement + transformed.slice(span.end);
  if (
    ts.createSourceFile(policy.target, transformed, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      .parseDiagnostics.length
  )
    throw new Error("SDK UI replacements produced invalid JavaScript");
  const manifest = {
    schemaVersion: 1,
    policySha256: hash(policyBytes),
    offsetUnit: "UTF-16",
    sdkVersion: policy.sdkVersion,
    entry: policy.entry,
    target: policy.target,
    files: policy.files,
    spans
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await buildCliUiManifest();
