import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantDisplayContent,
  buildLiveActivity,
  normalizeReasoningDisplay,
  reasoningPreview
} from "../web/assets/activity.js";

test("thought previews select the model's first content sentence in Chinese and English", () => {
  assert.equal(reasoningPreview("\n > - 先确认输入。再检查工具。\n还有一段。"), "先确认输入。");
  assert.equal(reasoningPreview("Inspect v1.2 locally. Then check the tool."), "Inspect v1.2 locally.");
  assert.equal(reasoningPreview("确认“路径正确！”然后继续。"), "确认“路径正确！”");
  assert.equal(
    reasoningPreview("No punctuation in this line\nDo not replace it with the next line"),
    "No punctuation in this line"
  );
});

test("Markdown thought headings and paired emphasis become plain preview text", () => {
  assert.equal(
    reasoningPreview(
      "**Planning project inspection and testing**\nI should read the project instructions first."
    ),
    "Planning project inspection and testing"
  );
  assert.equal(reasoningPreview("## **Review the input**\nFurther work."), "Review the input");
  assert.equal(
    reasoningPreview("*Inspect source* and __read tests__. Then edit."),
    "Inspect source and read tests."
  );
});

test("preview formatting preserves literal stars in code and mathematical expressions", () => {
  assert.equal(reasoningPreview("Compute 2 * 3 = 6. Then check."), "Compute 2 * 3 = 6.");
  assert.equal(
    reasoningPreview("Use `**kwargs` and `a**2**2` in the script."),
    "Use **kwargs and a**2**2 in the script."
  );
  assert.equal(
    reasoningPreview("Check $a*b*c$ and \\(x*y*z\\) before editing."),
    "Check $a*b*c$ and \\(x*y*z\\) before editing."
  );
  assert.equal(reasoningPreview("```python\nresult = a**2**2\n```"), "result = a**2**2");
});

test("code-only thought previews omit fence markers and keep real code instead of inventing prose", () => {
  assert.equal(
    reasoningPreview("```js\nconsole.log('What?');\n```\nThen inspect the output."),
    "console.log('What?');"
  );
  assert.equal(reasoningPreview("~~~python\n\nanswer = 42\n~~~"), "answer = 42");
  assert.equal(reasoningPreview("\n```js\n```\n\n确认结果。后续说明。"), "确认结果。");
});

test("long thought previews are bounded without breaking Unicode or changing the full source", () => {
  const source = "🔎".repeat(100) + "后续检查";
  const preview = reasoningPreview(source);
  assert.equal(Array.from(preview).length, 88);
  assert.equal(preview, "🔎".repeat(87) + "…");
  assert.equal(source, "🔎".repeat(100) + "后续检查");
  assert.equal(reasoningPreview("界".repeat(100) + "。第二句。"), "界".repeat(87) + "…");
});

test("empty and formatting-only thoughts have no fabricated preview", () => {
  for (const source of [undefined, "", " \n \t", "```js\n```", "---\n***\n# "])
    assert.equal(reasoningPreview(source), "");
});

const update = (type, contentIndex, rest = {}) => ({
  type: "message_update",
  assistantMessageEvent: { type, contentIndex, ...rest }
});
const start = () => [
  { type: "turn_start" },
  { type: "message_start", message: { role: "assistant", content: [] } }
];
const snapshot = (content) => ({ type: "message_end", message: { role: "assistant", content } });
const reasoning = (events) =>
  buildLiveActivity(events)
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "reasoning");

test("each thinking block starts before text and completes independently of tools", () => {
  const events = [...start(), update("thinking_start", 0)];
  assert.equal(reasoning(events)[0].text, "");
  assert.equal(reasoning(events)[0].done, false);
  events.push(
    update("thinking_end", 0, { content: "First thought" }),
    update("toolcall_start", 1, { id: "read", toolName: "read" })
  );
  assert.equal(buildLiveActivity(events)[0].done, false);
  assert.equal(reasoning(events)[0].done, true);
  events.push(update("thinking_start", 2));
  assert.deepEqual(
    reasoning(events).map((item) => item.done),
    [true, false]
  );
});

test("reasoning endings and final snapshots update the streamed block after tools start", () => {
  const content = [
    { type: "thinking", thinking: "Inspect the code." },
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "app.js" } },
    { type: "text", text: "Reading the file." }
  ];
  const events = [
    ...start(),
    update("thinking_start", 0),
    update("thinking_delta", 0, { delta: "Inspect " }),
    update("thinking_delta", 0, { delta: "the code." }),
    update("toolcall_start", 1, { id: "read-1", toolName: "read" }),
    update("thinking_end", 0, { content: "Inspect the code." }),
    update("text_delta", 2, { delta: "Reading the file." }),
    update("toolcall_end", 1, { toolCall: content[1] }),
    snapshot(content),
    { type: "tool_execution_start", toolCallId: "read-1", toolName: "read" },
    { type: "tool_execution_end", toolCallId: "read-1", result: { ok: true } },
    { type: "turn_end", message: { role: "assistant", content } },
    snapshot(content)
  ];
  // The block must remain unique during streaming too, not only on completion.
  for (let length = 4; length <= events.length; length++) {
    assert.equal(reasoning(events.slice(0, length)).length, 1);
    assert.equal(reasoning(events.slice(0, length))[0].key, reasoning(events)[0].key);
  }
  const [turn] = buildLiveActivity(events);
  assert.deepEqual(
    turn.items.map((item) => item.type),
    ["reasoning", "tool", "answer"]
  );
  assert.equal(turn.reasoning, "Inspect the code.");
  assert.equal(turn.answer, "Reading the file.");
  assert.equal(turn.calls.length, 1);
  assert.equal(turn.calls[0].statusLabel, "调用完成");
  assert.equal(turn.done, true);
});

test("distinct blocks and messages may repeat text without being merged", () => {
  const first = [
    { type: "thinking", thinking: "Check this." },
    { type: "text", text: "An update." },
    { type: "thinking", thinking: "Check this." }
  ];
  const events = [
    ...start(),
    update("thinking_delta", 0, { delta: "Check this." }),
    update("text_delta", 1, { delta: "An update." }),
    update("thinking_delta", 2, { delta: "Check this." }),
    snapshot(first),
    { type: "message_start", message: { role: "assistant", content: [] } },
    update("thinking_delta", 0, { delta: "Check this." }),
    snapshot([first[0]]),
    ...start(),
    update("thinking_delta", 0, { delta: "Check this." }),
    snapshot([first[0]])
  ];
  assert.equal(reasoning(events).length, 4);
  assert.equal(new Set(reasoning(events).map((item) => item.key)).size, 4);
  assert.deepEqual(
    buildLiveActivity(events)[0].items.map((item) => item.type),
    ["reasoning", "answer", "reasoning", "reasoning"]
  );
});

test("parallel tool deltas and completion events stay attached to their own calls", () => {
  const events = [
    ...start(),
    update("toolcall_start", 0, { id: "a", toolName: "read" }),
    update("toolcall_start", 1, { id: "b", toolName: "call_subagent" }),
    update("toolcall_delta", 0, { delta: '{"path":"first.js"}' }),
    update("toolcall_delta", 1, { delta: '{"task":"review"}' }),
    { type: "tool_execution_start", toolCallId: "a" },
    { type: "tool_execution_start", toolCallId: "b" },
    { type: "tool_execution_end", toolCallId: "b", result: "review done" },
    { type: "tool_execution_end", toolCallId: "a", result: "file read" }
  ];
  const [turn] = buildLiveActivity(events);
  assert.equal(turn.calls.length, 2);
  assert.equal(turn.calls[0].arguments, '{"path":"first.js"}');
  assert.equal(turn.calls[1].arguments, '{"task":"review"}');
  assert.equal(turn.calls[0].result, "file read");
  assert.equal(turn.calls[1].result, "review done");
  assert.equal(turn.calls[1].subagent, true);
});

test("snapshots restore missing blocks in message order when the event window starts mid-stream", () => {
  const events = [
    update("text_delta", 1, { delta: "suffix" }),
    snapshot([
      { type: "thinking", thinking: "Complete reasoning." },
      { type: "text", text: "Complete answer, including suffix" },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.js" } }
    ])
  ];
  const [turn] = buildLiveActivity(events);
  assert.deepEqual(
    turn.items.map((item) => item.type),
    ["reasoning", "answer", "tool"]
  );
  assert.equal(turn.answer, "Complete answer, including suffix");
  assert.deepEqual(buildLiveActivity(events.map((payload) => ({ type: "runtime_event", payload }))), [turn]);
  assert.deepEqual(buildLiveActivity([null, { type: "agent_start" }]), []);
});

test("late message_start and late deltas do not create partial reasoning duplicates", () => {
  const events = [
    { type: "turn_start" },
    update("thinking_start", 0),
    update("thinking_delta", 0, { delta: "First " }),
    { type: "message_start", message: { role: "assistant", timestamp: 123, content: [] } },
    update("thinking_delta", 0, { delta: "thought." }),
    update("thinking_end", 0, { content: "First thought." }),
    update("thinking_delta", 0, { delta: "thought." }),
    { type: "message_start", message: { role: "assistant", timestamp: 123, content: [] } },
    snapshot([{ type: "thinking", thinking: "First thought." }])
  ];
  assert.equal(reasoning(events).length, 1);
  assert.equal(reasoning(events)[0].text, "First thought.");
});

test("interrupted message snapshots preserve partial thinking without completing it or undoing an ended block", () => {
  for (const stopReason of ["error", "aborted", "length"]) {
    const content = [
      { type: "thinking", thinking: "Already checked." },
      { type: "thinking", thinking: "Still checking." }
    ];
    const events = [
      ...start(),
      update("thinking_end", 0, { content: "Already checked." }),
      update("thinking_delta", 1, { delta: "Still checking." }),
      { type: "message_end", message: { role: "assistant", content, stopReason } },
      { type: "turn_end", message: { role: "assistant", content, stopReason } },
      update("thinking_delta", 1, { delta: "Still checking." })
    ];
    const blocks = reasoning(events);
    assert.deepEqual(
      blocks.map((item) => item.text),
      ["Already checked.", "Still checking."]
    );
    assert.deepEqual(
      blocks.map((item) => item.complete),
      [true, false]
    );
    assert.ok(
      blocks.every((item) => item.done),
      "neither ended nor interrupted thoughts should keep spinning"
    );
  }
});

test("persisted assistant text envelopes become thinking without leaking into the answer", () => {
  const source =
    "<thinking>**Planning PPTX creation with python-pptx****Creating script to build deck****Writing PPT generation script now**</thinking>\n\n已生成演示文稿。";
  const [turn] = buildLiveActivity([snapshot([{ type: "text", text: source }])]);
  assert.deepEqual(
    turn.items.map((item) => item.type),
    ["reasoning", "answer"]
  );
  assert.equal(
    turn.reasoning,
    "**Planning PPTX creation with python-pptx**\n\n**Creating script to build deck**\n\n**Writing PPT generation script now**"
  );
  assert.equal(turn.answer.trim(), "已生成演示文稿。");
  assert.equal(reasoningPreview(turn.reasoning), "Planning PPTX creation with python-pptx");
  assert.equal(turn.items[0].rawText, source.slice(0, source.indexOf("\n\n")));
  assert.equal(source.includes("<thinking>"), true, "display projection must not mutate history");
});

test("partial text tags are held during streaming and the same thought survives block snapshots", () => {
  const events = [...start()];
  let key;
  for (const delta of ["<thi", "nking>**Planning", " PPTX creation**", "</thin", "king>", "\n\nCreated."]) {
    events.push(update("text_delta", 0, { delta }));
    const [turn] = buildLiveActivity(events);
    const thought = turn.items.find((item) => item.type === "reasoning");
    assert.ok(thought, "a streaming envelope belongs to thinking from its partial opening onward");
    key ??= thought.key;
    assert.equal(thought.key, key);
    assert.doesNotMatch(turn.answer, /<\/?thi/i);
    assert.doesNotMatch(thought.text, /<\/?thi/i);
  }
  const source = "<thinking>**Planning PPTX creation**</thinking>\n\nCreated.";
  events.push(snapshot([{ type: "text", text: source }]));
  const [turn] = buildLiveActivity(events);
  assert.equal(turn.items.find((item) => item.type === "reasoning").key, key);
  assert.equal(turn.reasoning, "**Planning PPTX creation**");
  assert.equal(turn.answer.trim(), "Created.");
});

test("adjacent complete thinking headings keep independent paragraphs rather than becoming one bold sentence", () => {
  const [turn] = buildLiveActivity([
    snapshot([
      {
        type: "thinking",
        thinking: "<thinking>**Planning PPTX creation****Creating script to build deck**\n****\n</thinking>"
      }
    ])
  ]);
  assert.equal(turn.reasoning, "**Planning PPTX creation**\n\n**Creating script to build deck**");
  assert.equal(reasoningPreview(turn.reasoning), "Planning PPTX creation");
});

test("independent complete heading text blocks have boundaries while split Markdown stays contiguous", () => {
  const [headings] = buildLiveActivity([
    snapshot([
      { type: "text", text: "**Planning PPTX creation**" },
      { type: "text", text: "**Creating script to build deck**" }
    ])
  ]);
  assert.equal(headings.answer, "**Planning PPTX creation**\n\n**Creating script to build deck**");
  const [split] = buildLiveActivity([
    snapshot([
      { type: "text", text: "**Split" },
      { type: "text", text: " heading**" }
    ])
  ]);
  assert.equal(split.answer, "**Split heading**");
});

test("code, mathematics and prose HTML examples do not become hidden thought envelopes", () => {
  const source =
    "Use `<thinking>example</thinking>` literally.\n\n```html\n<thinking>**sample****second**</thinking>\n****\n```\n\nShow <thinking>sample</thinking> as HTML; $a*b*c$ and \\(x*y*z\\) remain literal.";
  const [turn] = buildLiveActivity([snapshot([{ type: "text", text: source }])]);
  assert.equal(turn.answer, source);
  assert.equal(turn.reasoning, "");
});

test("real provider shape retains open text thinking before a tool as process, not an answer", () => {
  const content = [
    { type: "text", text: "\n<thinking>**Planning PPTX creation****Creating script****Writing script now**" },
    { type: "toolCall", id: "write-pptx", name: "write", arguments: { path: "deck.py" } }
  ];
  const original = structuredClone(content);
  const [turn] = buildLiveActivity([
    snapshot(content),
    { type: "tool_execution_end", toolCallId: "write-pptx", toolName: "write", result: "saved" }
  ]);
  assert.equal(turn.answer, "");
  assert.deepEqual(
    turn.items.map((item) => item.type),
    ["reasoning", "tool"]
  );
  assert.equal(turn.reasoning, "**Planning PPTX creation**\n\n**Creating script**\n\n**Writing script now**");
  assert.equal(turn.calls[0].id, "write-pptx");
  assert.equal(turn.calls[0].statusLabel, "调用完成");
  assert.deepEqual(content, original);
  assert.equal(turn.items[0].rawText, original[0].text);
});

test("split persisted text tokens are classified as a whole and display projection is idempotent", () => {
  const content = [
    { type: "text", text: "<thin" },
    { type: "text", text: "king>**Plan" },
    { type: "text", text: "ning**</thi" },
    { type: "text", text: "nking>\n\n**Created" },
    { type: "text", text: " the file**." }
  ];
  const original = structuredClone(content);
  const display = assistantDisplayContent(content);
  assert.deepEqual(display, [
    { type: "thinking", thinking: "**Planning**" },
    { type: "text", text: "\n\n**Created the file**." }
  ]);
  assert.deepEqual(assistantDisplayContent(display), display);
  assert.deepEqual(content, original);
});

test("known reasoning cleans isolated marker fragments but preserves technical literal content", () => {
  assert.equal(
    normalizeReasoningDisplay("**Planning****Creating**\n****\n"),
    "**Planning**\n\n**Creating**\n\n"
  );
  for (const source of [
    "```html\n<thinking>sample</thinking>\n****\n```",
    "~~~python\nanswer = a**2**2\n****\n~~~",
    "    <thinking>literal</thinking>\n    ****\n\t**code****sample**",
    "Use `****` and `**kwargs` unchanged.",
    "$**x****y**$ and \\(a*b*c\\)",
    "2 * 3 = 6; a**2**2; and a < b.",
    "****`literal_code`",
    "Show <thinking>example</thinking> in the explanation."
  ])
    assert.equal(normalizeReasoningDisplay(source), source);
  assert.equal(normalizeReasoningDisplay("<thinking>Check 2 <</thinking>"), "Check 2 <");
  const indented = "    <thinking>literal</thinking>\n    ****";
  assert.deepEqual(assistantDisplayContent(indented), [{ type: "text", text: indented }]);
});

test("a stopped partial envelope never leaks tag fragments or fabricates reasoning", () => {
  for (const stopReason of ["error", "aborted", "length"]) {
    const [turn] = buildLiveActivity([
      snapshot([{ type: "text", text: "<thinking>保留已有检查。</thi" }]),
      {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<thinking>保留已有检查。</thi" }],
          stopReason
        }
      }
    ]);
    assert.equal(turn.reasoning, "保留已有检查。");
    assert.equal(turn.answer, "");
    assert.ok(turn.items.every((item) => item.done));
  }
  assert.deepEqual(assistantDisplayContent("<thi", { streaming: true }), [
    { type: "thinking", thinking: "" }
  ]);
  assert.equal(
    normalizeReasoningDisplay("ordinary thought with no Markdown"),
    "ordinary thought with no Markdown"
  );
});

test("a later streamed heading cannot change the completed first heading preview", () => {
  for (const rest of [
    "**",
    "**Cre",
    "**Creating script",
    "**Creating script**",
    "**Creating script****Wri"
  ]) {
    const source = "**Planning PPTX creation**" + rest;
    assert.equal(reasoningPreview(source), "Planning PPTX creation");
    assert.doesNotMatch(normalizeReasoningDisplay(source), /\*{4}/);
  }
});

test("every single-character later heading and closing-tag delta retains the first readable heading", () => {
  const first = "<thinking>**Planning PPTX creation**";
  const rest = "**Creating script****Writing the script**</thinking>\n\nCreated.";
  const events = [...start(), update("text_delta", 0, { delta: first })];
  for (const character of rest) {
    events.push(update("text_delta", 0, { delta: character }));
    const [turn] = buildLiveActivity(events);
    assert.equal(reasoningPreview(turn.reasoning), "Planning PPTX creation");
    assert.doesNotMatch(turn.reasoning, /\*{4}|<\/?thi/i);
  }
  assert.equal(buildLiveActivity(events)[0].answer.trim(), "Created.");
  assert.equal(buildLiveActivity(events)[0].items[0].rawText, first + rest.slice(0, rest.indexOf("\n\n")));
});

test("known thinking raw diagnostics retain every wrapper and Markdown byte", () => {
  const raw =
    "\n<thinking>**Planning****Creating**\n****\n```html\n<thinking>literal</thinking>\n```\n</thinking>\n";
  const content = [{ type: "thinking", thinking: raw }];
  const original = structuredClone(content);
  const [turn] = buildLiveActivity([snapshot(content)]);
  assert.equal(turn.items[0].rawText, raw);
  assert.notEqual(turn.items[0].text, raw);
  assert.deepEqual(content, original);
  const wrapped = "\n<thinking>**Planning**</thinking>\n";
  assert.equal(buildLiveActivity([snapshot([{ type: "text", text: wrapped }])])[0].items[0].rawText, wrapped);
});

test("structured tool results and actual event boundaries survive display projection without budget-derived time", () => {
  const result = { content: [{ type: "text", text: "saved" }], details: { path: "deck.py", exitCode: 0 } };
  const [turn] = buildLiveActivity([
    {
      type: "runtime_event",
      occurredAt: "2026-10-08T12:00:00.000Z",
      payload: {
        type: "tool_execution_start",
        toolCallId: "a",
        toolName: "write",
        args: { timeout: 120_000 }
      }
    },
    {
      type: "runtime_event",
      occurredAt: "2026-10-08T12:00:02.250Z",
      payload: { type: "tool_execution_end", toolCallId: "a", result }
    },
    {
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "run_command",
      args: { timeout: 90_000 },
      timestamp: "90000"
    },
    { type: "tool_execution_end", toolCallId: "b", result: "done" }
  ]);
  assert.deepEqual(turn.calls[0].rawResult, result);
  assert.equal(turn.calls[0].result, JSON.stringify(result, null, 2));
  assert.equal(turn.calls[0].startedAt, Date.parse("2026-10-08T12:00:00.000Z"));
  assert.equal(turn.calls[0].endedAt, Date.parse("2026-10-08T12:00:02.250Z"));
  assert.equal(turn.calls[0].durationMs, 2250);
  assert.equal(turn.calls[1].durationMs, undefined);
  assert.equal(turn.calls[1].startedAt, undefined);
});
