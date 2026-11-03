import assert from "node:assert/strict";
import { test } from "node:test";
import { textRuntimeAdapter } from "../dist/src/applications/adapters/text-runtime-adapter.js";
import { textHash } from "../dist/src/applications/types.js";

const user = { type: "user", id: "local" };

function apply(content, operationType, payload) {
  return textRuntimeAdapter.applyOperation({ operationType, payload, content, actor: user });
}

test("offsets are UTF-16 code units, consistently for Chinese, Emoji and newlines", () => {
  // "你好" is 2 units, the emoji is a surrogate pair (2 units), so the newline
  // sits at 4. A naive byte or codepoint index would land somewhere else.
  const content = "你好🙂\n世界";
  assert.equal(content.length, 7);
  assert.equal(apply(content, "text.insert", { at: 2, text: "，" }).content, "你好，🙂\n世界");
  assert.equal(apply(content, "text.delete", { from: 2, to: 4 }).content, "你好\n世界");
  assert.equal(apply(content, "text.replace", { from: 5, to: 7, text: "地球" }).content, "你好🙂\n地球");
});

test("splitting a surrogate pair is allowed by offset but never corrupts the stored round trip", () => {
  const content = "🙂";
  // Half a surrogate pair is a lone surrogate, which is still a valid JS string
  // and must survive being written and read back rather than silently mutating.
  const result = apply(content, "text.delete", { from: 0, to: 1 });
  assert.equal(result.content.length, 1);
  assert.equal(JSON.parse(JSON.stringify(result.content)), result.content);
});

test("every operation is invertible and the inverse restores the exact prior content", () => {
  const cases = [
    ["起始内容\n", "text.insert", { at: 4, text: "新增" }],
    ["起始内容\n", "text.delete", { from: 0, to: 2 }],
    ["起始内容\n", "text.replace", { from: 2, to: 4, text: "替换后的更长文本" }],
    ["🙂标题\n正文", "text.replace", { from: 0, to: 2, text: "✅" }]
  ];
  for (const [content, operationType, payload] of cases) {
    const forward = apply(content, operationType, payload);
    assert.ok(forward.inverse, `${operationType} must produce an inverse`);
    const back = apply(forward.content, forward.inverse.operationType, forward.inverse.payload);
    assert.equal(back.content, content, `${operationType} inverse must restore the original`);
  }
});

test("a precondition hash that does not match the current text is refused", () => {
  const content = "目标用户是产品经理\n";
  assert.throws(
    () => apply(content, "text.replace", { from: 0, to: 4, text: "新用户", replacedTextHash: textHash("别的内容") }),
    (error) => error.code === "operation_precondition_failed"
  );
  assert.equal(apply(content, "text.replace", { from: 0, to: 4, text: "新用户", replacedTextHash: textHash("目标用户") }).content, "新用户是产品经理\n");
  // Omitting the hash is allowed: an Agent computing a patch from a summary may
  // not know the exact bytes, and revision CAS still protects it.
  assert.equal(apply(content, "text.replace", { from: 0, to: 4, text: "新用户" }).content, "新用户是产品经理\n");
});

test("ranges beyond the document, inverted ranges and non-integer offsets are refused", () => {
  const content = "短\n";
  assert.throws(() => apply(content, "text.replace", { from: 0, to: 99, text: "x" }), (error) => error.code === "operation_precondition_failed");
  assert.throws(() => apply(content, "text.insert", { at: 99, text: "x" }), (error) => error.code === "operation_precondition_failed");
  assert.throws(() => apply(content, "text.delete", { from: 2, to: 1 }), (error) => error.code === "invalid_operation");
  assert.throws(() => apply(content, "text.insert", { at: 1.5, text: "x" }), (error) => error.code === "invalid_operation");
  assert.throws(() => apply(content, "text.insert", { at: -1, text: "x" }), (error) => error.code === "invalid_operation");
  assert.throws(() => apply(content, "text.insert", { at: 0, text: 42 }), (error) => error.code === "invalid_operation");
});

test("a rejected value is described, never echoed back into the error", () => {
  // The bug this pins, reported from a real run: a model sent `at: [].at` — a
  // native function — and the rejection carried the function itself. Error
  // details reach the tool result, which the session recorder clones with
  // `structuredClone`, so the turn died with
  // "function at() { [native code] } could not be cloned." instead of the model
  // being told `at` was not an integer and retrying.
  const content = "短\n";
  for (const [label, value] of [
    ["native function", [].at],
    ["arrow function", () => 0],
    ["object", { nested: {} }],
    ["symbol", Symbol("x")],
    ["bigint", 1n]
  ]) {
    let thrown;
    assert.throws(() => apply(content, "text.insert", { at: value, text: "x" }), (error) => { thrown = error; return error.code === "invalid_operation"; });
    assert.equal(thrown.details.field, "at");
    assert.equal(typeof thrown.details.received, "string", `${label} must be described as a string`);
    // The whole result has to survive the clone the session recorder performs.
    assert.doesNotThrow(() => structuredClone({ ok: false, code: thrown.code, error: thrown.message, details: thrown.details }),
      `${label} must not break the session record`);
  }
  // A long string is summarized rather than copied into the error.
  let long;
  assert.throws(() => apply(content, "text.insert", { at: "x".repeat(500), text: "y" }), (error) => { long = error; return true; });
  assert.match(long.details.received, /^string\(500\)$/);
});

test("summaries name the affected lines and quote a bounded fragment, not the whole edit", () => {
  const content = "第一行\n第二行\n第三行\n";
  const replaced = apply(content, "text.replace", { from: 4, to: 7, text: "改写后的第二行" });
  assert.match(replaced.summary, /第 2 行/);
  assert.match(replaced.summary, /第二行/);

  const long = apply(content, "text.insert", { at: 0, text: "很长的内容".repeat(200) });
  assert.ok(long.summary.length < 120, `summary must stay short, got ${long.summary.length}`);
  assert.match(long.summary, /…/);

  const spanning = apply(content, "text.delete", { from: 0, to: 8 });
  assert.match(spanning.summary, /第 1–3 行/);
});

test("deleting a paragraph describes it instead of copying it into the log", () => {
  const paragraph = "这是一段需要被删除的完整段落，它本身包含了不应该被复制进事件日志和 prompt 的具体内容。";
  const content = `## 背景\n${paragraph}\n\n## 目标\n`;
  // Both shapes must behave the same: the editor sends replace-with-empty for a
  // debounced removal, while an Agent may send an explicit delete.
  for (const result of [
    apply(content, "text.delete", { from: 5, to: 5 + paragraph.length }),
    apply(content, "text.replace", { from: 5, to: 5 + paragraph.length, text: "" })
  ]) {
    assert.match(result.summary, /删除/, "a removal must read as a removal");
    assert.equal(result.summary.includes(paragraph), false, "the deleted text must not be reproduced in full");
    assert.ok(result.summary.length < paragraph.length, `summary must be shorter than what it describes, got ${result.summary.length}`);
    assert.match(result.summary, /共 \d+ 字/, "the reader should still learn how much was removed");
    // The inverse still carries the exact text, so undo remains lossless.
    assert.equal(apply(result.content, result.inverse.operationType, result.inverse.payload).content, content);
  }
});

test("selection summaries are bounded and describe a cursor as a position", () => {
  const content = `标题\n${"正文内容".repeat(500)}`;
  const wide = textRuntimeAdapter.summarizeSelection({ selection: { schema: "text.range/v1", data: { anchor: 0, head: content.length } }, content });
  assert.ok(wide.length <= 1_000, `selection summary must be bounded, got ${wide.length}`);
  assert.match(wide, /第 1–2 行/);

  const caret = textRuntimeAdapter.summarizeSelection({ selection: { schema: "text.range/v1", data: { anchor: 3, head: 3 } }, content });
  assert.match(caret, /光标位于第 2 行/);

  // A backwards selection means the same range; a reader should not care.
  const backwards = textRuntimeAdapter.summarizeSelection({ selection: { schema: "text.range/v1", data: { anchor: 6, head: 2 } }, content });
  const forwards = textRuntimeAdapter.summarizeSelection({ selection: { schema: "text.range/v1", data: { anchor: 2, head: 6 } }, content });
  assert.equal(backwards, forwards);
});

test("a large document is described by its headings rather than copied", () => {
  const content = `# 产品方案\n${"填充段落\n".repeat(5_000)}## 目标用户\n更多内容\n`;
  const summary = textRuntimeAdapter.summarizeContext({
    resource: { title: "proposal.md" }, content, changes: []
  });
  assert.ok(Buffer.byteLength(summary.shape, "utf8") < 1_000, "the shape must not scale with the document");
  // The titles, so the line still names what the document is made of. The `#`
  // markers are gone with the line numbers: they were markup, not information.
  assert.match(summary.shape, /产品方案/);
  assert.match(summary.shape, /目标用户/);
  assert.equal(summary.shape.includes("填充段落 填充段落"), false, "and never dumps the body");
  // No address of any kind. This line used to read "8 行 · 33 个字符 标题：第 3
  // 行 ## 目标用户", and a model turned the "第 3 行" into an offset: it passed
  // `from: 4` to text.replace, which accepted it as valid in a 33-character
  // document, wrote into line 1, and reported success.
  assert.equal(/第\s*\d+\s*行/.test(summary.shape), false, `no line numbers: ${summary.shape}`);
  assert.equal(summary.shape.includes("\n"), false, "one line");
  // Counting is still fine — a count is nothing a model can pass as an argument.
  assert.match(summary.shape, /^\d+ 个标题/);
  // The protocol itself is unchanged: the editor still has every operation.
  assert.deepEqual(Object.keys(textRuntimeAdapter.definition.operationSchemas).sort(),
    ["text.delete", "text.insert", "text.replace", "text.rewrite"]);
});

test("the adapter refuses kinds and export formats it did not declare", () => {
  assert.throws(
    () => textRuntimeAdapter.createContent({ kind: "model/cad+json", title: "x" }),
    (error) => error.code === "unsupported_resource_kind"
  );
  assert.throws(
    () => textRuntimeAdapter.createContent({ kind: "text/markdown", title: "x", initialContent: { not: "text" } }),
    (error) => error.code === "invalid_operation"
  );
  assert.throws(
    () => textRuntimeAdapter.exportResource({ resource: { title: "x", resourceId: "res_1" }, content: "x", format: "pdf" }),
    (error) => error.code === "invalid_operation"
  );
  assert.equal(textRuntimeAdapter.exportResource({ resource: { title: "报告.md", resourceId: "res_1" }, content: "内容", format: "markdown" }).fileName, "报告.md");
  assert.equal(textRuntimeAdapter.exportResource({ resource: { title: "报告", resourceId: "res_1" }, content: "内容", format: "text" }).fileName, "报告.txt");
});

test("an empty title falls back to the resource id rather than producing a dotfile", () => {
  for (const title of ["", "   ", "...", "///"]) {
    const name = textRuntimeAdapter.exportResource({ resource: { title, resourceId: "res_abc" }, content: "", format: "markdown" }).fileName;
    assert.equal(name.startsWith("."), false, `title ${JSON.stringify(title)} produced ${name}`);
    assert.match(name, /^res_abc\.md$|^[^.].*\.md$/);
  }
});

test("the precondition hash tells apart text that utf8 encoding would collapse", () => {
  // Offsets are UTF-16 units, so a range may split a surrogate pair. Hashing
  // through utf8 mapped every unpaired half to U+FFFD, so the two halves — and
  // a literal U+FFFD — all hashed the same, and a patch aimed at one would be
  // accepted against another.
  const high = "\ud83d";
  const low = "\ude00";
  assert.notEqual(textHash(high), textHash(low), "the halves of a split pair must be distinguishable");
  assert.notEqual(textHash(high), textHash("�"));
  assert.notEqual(textHash(low), textHash("�"));
  // Ordinary text still round-trips, including Chinese and whole emoji.
  assert.equal(textHash("目标用户"), textHash("目标用户"));
  assert.notEqual(textHash("目标用户"), textHash("目标客户"));
  assert.equal(textHash("😀"), textHash("😀"));

  // And the guard now actually refuses a patch aimed at a different half.
  const content = "😀";
  assert.throws(
    () => apply(content, "text.delete", { from: 1, to: 2, deletedTextHash: textHash(high) }),
    (error) => error.code === "operation_precondition_failed",
    "deleting the low half with the high half's hash must be refused"
  );
  assert.equal(apply(content, "text.delete", { from: 1, to: 2, deletedTextHash: textHash(low) }).content, high);
});

/** Call one of the adapter's own tools, the way the extension does. */
async function tool(name, content, params) {
  const definition = textRuntimeAdapter.agentTools().find((entry) => entry.name === name);
  assert.ok(definition, `the adapter must declare ${name}`);
  return definition.execute({
    params, content,
    resource: { resourceId: "r", appType: "text-editor", kind: "text/markdown", title: "doc.md" }
  });
}

test("the adapter gives a model a patch tool, not offsets to compute", async () => {
  // The failure this fixes, from a real run: the model called
  // apply_resource_operation six times and every one was refused with
  // "at 必须是非负整数" / "from 必须是非负整数". It could not compute UTF-16
  // offsets for text it only sees as a string, so nothing was ever written.
  //
  // The protocol keeps its offset operations — the editor knows exact positions
  // from the caret, and undo needs an inverse that restores exactly. What
  // changed is that a model is no longer handed the protocol: the application
  // declares the tool that fits its domain, shaped like the harness's own
  // `apply_patch` (src/tools/builtin.ts), which solved this for files.
  const content = "# 产品方案\n\n## 目标用户\n待补充。\n\n## 背景\n也待补充。\n";

  const patched = await tool("patch_document", content, {
    oldText: "## 目标用户\n待补充。", newText: "## 目标用户\n研究员和产品经理。"
  });
  // It returns operations rather than writing, so a specialized tool still goes
  // through revision CAS, the operation log and undo like everything else.
  assert.equal(patched.operations.length, 1);
  assert.equal(patched.operations[0].operationType, "text.replace");
  assert.ok(patched.operations[0].payload.replacedTextHash, "the anchor is pinned by content hash");
  // And the offsets it computed are correct when applied.
  const applied = apply(content, patched.operations[0].operationType, patched.operations[0].payload);
  assert.match(applied.content, /## 目标用户\n研究员和产品经理。/);
  assert.match(applied.content, /## 背景\n也待补充。/, "the rest of the document is untouched");
  assert.ok(applied.inverse, "and it is still undoable");

  // Deleting is an empty replacement, the same as in any patch tool.
  const deleted = await tool("patch_document", content, { oldText: "\n## 背景\n也待补充。\n", newText: "" });
  assert.equal(apply(content, deleted.operations[0].operationType, deleted.operations[0].payload).content,
    "# 产品方案\n\n## 目标用户\n待补充。\n");
});

test("an ambiguous or stale anchor is refused with something the model can act on", async () => {
  // Ambiguity is the failure worth naming. A model can act on "your copy is
  // stale, re-read" and on "be more specific"; it cannot act on an edit that
  // silently landed in the wrong place.
  const content = "# 产品方案\n\n## 目标用户\n待补充。\n\n## 背景\n也待补充。\n";

  // "待补充" appears twice, once inside "也待补充".
  await assert.rejects(() => tool("patch_document", content, { oldText: "待补充", newText: "X" }), (error) => {
    assert.equal(error.code, "operation_precondition_failed");
    assert.equal(error.details.found, 2);
    assert.match(error.message, /出现了 2 次/);
    assert.match(error.message, /多带几行上下文/, "it says how to fix it");
    return true;
  });

  await assert.rejects(() => tool("patch_document", content, { oldText: "不存在的段落", newText: "X" }), (error) => {
    assert.equal(error.details.found, 0);
    assert.match(error.message, /已过期/);
    assert.match(error.message, /read_document/, "it says to re-read, and names the tool that does it");
    return true;
  });

  // An empty anchor cannot locate anything, and saying so beats matching at 0.
  await assert.rejects(() => tool("patch_document", content, { oldText: "", newText: "X" }),
    (error) => error.code === "invalid_operation");
});

test("writing a whole document pins the content it replaces", async () => {
  // `write_document` is for a rewrite or a first write. It carries the hash of
  // what it expects to find, so it cannot silently discard an edit that landed
  // between the model's read and its write.
  const content = "# 方案\n第一段。\n";
  const written = await tool("write_document", content, { content: "# 全新方案\n" });
  assert.equal(written.operations[0].operationType, "text.rewrite");
  assert.ok(written.operations[0].payload.baseContentHash);

  const applied = apply(content, written.operations[0].operationType, written.operations[0].payload);
  assert.equal(applied.content, "# 全新方案\n");
  // Its inverse restores the previous content exactly.
  assert.equal(apply(applied.content, applied.inverse.operationType, applied.inverse.payload).content, content);

  // Against content that moved on, the same write is refused rather than
  // overwriting: the hash is the guard a revision number cannot be.
  const moved = apply(content, "text.insert", { at: content.length, text: "别人加的一行\n" }).content;
  assert.throws(() => apply(moved, written.operations[0].operationType, written.operations[0].payload),
    (error) => error.code === "operation_precondition_failed");
});
