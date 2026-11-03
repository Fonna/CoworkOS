import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWorkspaceText, searchWorkspaceText } from "../dist/src/tools/workspace-text.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-workspace-text-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "trace.jsonl");
}

test("workspace read pages a sparse file larger than 2 GB without loading its contents", async (t) => {
  const path = await fixture(t);
  const file = await open(path, "w");
  const size = 2 ** 31 + 4096;
  const ending = Buffer.from("最后一条记录\n", "utf8");
  try {
    await file.write(Buffer.from("trace header\n"), 0, 13, 0);
    await file.write(ending, 0, ending.length, size - ending.length);
  } finally { await file.close(); }
  const first = await readWorkspaceText(path, 32);
  assert.equal(first.size, size);
  assert.equal(first.offset, 0);
  assert.equal(first.content.slice(0, 13), "trace header\n");
  assert.equal(Buffer.byteLength(first.content), 32);
  assert.equal(first.nextOffset, 32);
  assert.equal(first.truncated, true);
  const last = await readWorkspaceText(path, 128, size - ending.length);
  assert.equal(last.content, ending.toString("utf8"));
  assert.equal(last.truncated, false);
  assert.equal(last.nextOffset, undefined);
  assert.deepEqual(await searchWorkspaceText(path, "trace", 1), [{ line: 1, text: "trace header" }]);
});

test("UTF-8 byte pagination reconstructs Chinese and emoji without dropped characters", async (t) => {
  const path = await fixture(t);
  const source = "A中文🙂e\u0301第二行\n报告𠮷已完成\n".repeat(17);
  await writeFile(path, source);
  for (const budget of [1, 2, 3, 4, 7, 16, 128]) {
    let text = "";
    let offset = 0;
    for (let pageNumber = 0; ; pageNumber += 1) {
      assert.ok(pageNumber < Buffer.byteLength(source));
      const page = await readWorkspaceText(path, budget, offset);
      assert.equal(page.offset, offset);
      assert.doesNotMatch(page.content, /\ufffd/);
      assert.ok(Buffer.byteLength(page.content) <= Math.max(budget, 4));
      text += page.content;
      if (!page.truncated) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(text, source);
  }
  const aligned = await readWorkspaceText(path, 3, 2);
  assert.equal(aligned.offset, 1);
  assert.equal(aligned.content, "中");
});

test("read handles empty files, past-EOF offsets and invalid byte budgets", async (t) => {
  const path = await fixture(t);
  await writeFile(path, "");
  assert.deepEqual(await readWorkspaceText(path, 4, 100), { content: "", truncated: false, offset: 0, size: 0 });
  await writeFile(path, "done");
  assert.deepEqual(await readWorkspaceText(path, 4, 100), { content: "", truncated: false, offset: 4, size: 4 });
  await assert.rejects(() => readWorkspaceText(path, 0), /maxBytes/);
  await assert.rejects(() => readWorkspaceText(path, 4, -1), /offset/);
});

test("search finds queries and UTF-8 characters across stream chunks", async (t) => {
  const path = await fixture(t);
  const query = "研究🙂完成";
  await writeFile(path, "x".repeat(64 * 1024 - 8) + query + " tail\nsecond NEEDLE line\n");
  const matches = await searchWorkspaceText(path, query, 10);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 1);
  assert.ok(matches[0].text.includes(query));
  assert.match(matches[0].text, /\[truncated\]/);
  assert.doesNotMatch(matches[0].text, /\ufffd/);
  assert.ok(Buffer.byteLength(matches[0].text) <= 1000);
  assert.deepEqual(await searchWorkspaceText(path, "needle", 10), [{ line: 2, text: "second NEEDLE line" }]);
});

test("search can match a literal longer than one stream chunk", async (t) => {
  const path = await fixture(t);
  const query = "START_" + "q".repeat(70 * 1024) + "_END";
  await writeFile(path, "first line\n" + query + "\nlast line");
  const matches = await searchWorkspaceText(path, query, 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 2);
  assert.ok(matches[0].text.startsWith("START_"));
  assert.match(matches[0].text, /\[truncated\]/);
  assert.ok(Buffer.byteLength(matches[0].text) <= 1000);
});

test("search reaches the end of long JSONL records and returns context near each match", async (t) => {
  const path = await fixture(t);
  const file = await open(path, "w");
  try {
    await file.write('{"payload":"');
    const chunk = Buffer.from("中".repeat(32 * 1024));
    for (let i = 0; i < 64; i += 1) await file.write(chunk);
    await file.write('","verdict":"MATCH_AT_THE_END"}\nshort match_at_the_end\n');
  } finally { await file.close(); }
  const matches = await searchWorkspaceText(path, "match_at_the_end", 10);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].line, 1);
  assert.match(matches[0].text, /MATCH_AT_THE_END/);
  assert.match(matches[0].text, /\[truncated\]/);
  assert.ok(Buffer.byteLength(matches[0].text) <= 1000);
  assert.doesNotMatch(matches[0].text, /\ufffd/);
  assert.deepEqual(matches[1], { line: 2, text: "short match_at_the_end" });
});

test("search preserves one result per line, maxMatches, CRLF, and a final line without newline", async (t) => {
  const path = await fixture(t);
  await writeFile(path, "first HIT hit\r\nno match\nthird hit\nfinal hit\r");
  assert.deepEqual(await searchWorkspaceText(path, "hit", 2), [
    { line: 1, text: "first HIT hit" },
    { line: 3, text: "third hit" }
  ]);
  assert.deepEqual((await searchWorkspaceText(path, "hit", 10)).at(-1), { line: 4, text: "final hit\r" });
  assert.deepEqual(await searchWorkspaceText(path, "absent", 10), []);
  assert.deepEqual(await searchWorkspaceText(path, "hit", 0), []);
});

test("search maps lowercase expansions to their original context and caps trailing context", async (t) => {
  const path = await fixture(t);
  await writeFile(path, "İ ".repeat(100) + "TARGET " + "文".repeat(1000) + "\n");
  const [match] = await searchWorkspaceText(path, "target", 1);
  assert.ok(match.text.includes("TARGET"));
  assert.match(match.text, /\[truncated\]/);
  assert.ok(Buffer.byteLength(match.text) <= 1000);
  assert.doesNotMatch(match.text, /\ufffd/);
});
