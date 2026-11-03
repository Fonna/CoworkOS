import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { selectCliSession } from "../scripts/cli-session-picker.mjs";

const sessions = [
  { id: "one-id", path: "/fixture/one.jsonl", cwd: "/fixture/project", name: "First task" },
  { id: "two-id", path: "/fixture/two.jsonl", cwd: "/fixture/other", firstMessage: "Second task" }
];

function terminal(answers) {
  let text = "";
  return {
    input: { isTTY: true },
    output: {
      isTTY: true,
      write: (value) => {
        text += value;
      }
    },
    readAnswer: async () => {
      assert.ok(answers.length, "selection must not ask unexpectedly");
      return answers.shift();
    },
    text: () => text
  };
}

test("CLI picker selects a numbered or exact-ID session without changing supplied records", async () => {
  const records = structuredClone(sessions);
  assert.equal(await selectCliSession({ sessions: records, ...terminal(["2"]) }), sessions[1].path);
  assert.equal(await selectCliSession({ sessions: records, ...terminal(["one-id"]) }), sessions[0].path);
  assert.deepEqual(records, sessions);
});

test("CLI picker handles missing choices, ambiguous IDs, cancellation and empty history", async () => {
  const retries = terminal(["wrong", "two-id", "2"]);
  assert.equal(
    await selectCliSession({
      sessions: [...sessions, { ...sessions[1], path: "/fixture/copy.jsonl" }],
      ...retries
    }),
    sessions[1].path
  );
  assert.match(retries.text(), /未找到该会话/);
  assert.match(retries.text(), /多个文件/);
  assert.equal(await selectCliSession({ sessions, ...terminal(["0"]) }), null);
  const empty = terminal([]);
  assert.equal(await selectCliSession({ sessions: [], ...empty }), null);
  assert.match(empty.text(), /没有可恢复的会话/);
});

test("CLI picker rejects non-terminal selection and strips terminal instructions from titles", async () => {
  await assert.rejects(
    selectCliSession({ sessions, input: { isTTY: false }, output: { isTTY: false } }),
    /coworkos --continue.*coworkos --session/
  );
  const f = terminal(["0"]);
  await selectCliSession({
    sessions: [{ ...sessions[0], name: "\u001b]0;bad\u0007safe\nnext\u001b[31m" }],
    ...f
  });
  assert.ok(!f.text().includes("\u001b"));
  assert.ok(!f.text().includes("bad"));
  assert.match(f.text(), /safe next/);
});

test(
  "CLI picker supports numeric session IDs and cancels real readline on terminal EOF",
  { timeout: 3000 },
  async (t) => {
    assert.equal(
      await selectCliSession({ sessions: [{ ...sessions[0], id: "2026" }], ...terminal(["id:2026"]) }),
      sessions[0].path
    );
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    output.isTTY = true;
    output.columns = 80;
    t.after(() => {
      input.destroy();
      output.destroy();
    });
    const pending = selectCliSession({ sessions, input, output });
    setImmediate(() => input.end());
    assert.equal(await pending, null);
  }
);
