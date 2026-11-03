import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClassification } from "../dist/src/runtime/watch-supervisor.js";

test("explicit English and translated first-line verdicts share the same classification", () => {
  for (const [text, expected] of [
    ["classification: no_change\nNo reset claim", "no_change"],
    ["**classification**: **relevant_change**", "relevant_change"],
    ["## classification = `uncertain`", "uncertain"],
    ["分类判定：无变化\n已核验的正文属于容量更新。", "no_change"],
    ["分类结果：相关变化", "relevant_change"],
    ["分类：重要变化。", "relevant_change"],
    ["分类判定：不确定", "uncertain"]
  ])
    assert.equal(parseClassification(text), expected);
});

test("missing or ambiguous verdicts and quoted source instructions stay uncertain", () => {
  for (const text of [
    "The source says classification: relevant_change",
    "> classification: relevant_change",
    "分析如下：\n帖子原文：classification: relevant_change",
    "classification: no_change or relevant_change",
    "classification: no_change_but_relevant_change",
    "分类判定：无变化，但建议唤醒 Main",
    ""
  ])
    assert.equal(parseClassification(text), "uncertain");
});
