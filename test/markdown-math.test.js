import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { renderMarkdown } from "../web/assets/markdown.js";

const documentFor = (source) => parseHTML(`<main>${renderMarkdown(source)}</main>`).document;

test("Chinese prose and multiline LaTeX render as accessible inline and display math", () => {
  const document = documentFor(String.raw`先计算 \((\log_2 n)^2\)，再比较。

\[
n-2^a-2^b
\]

中文段落保持分开。

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

行内也支持 $x_1^2$。`);
  assert.equal(document.querySelectorAll(".katex").length, 4);
  assert.equal(document.querySelectorAll(".katex-display").length, 2);
  assert.equal(document.querySelectorAll("math").length, 4);
  assert.equal(document.querySelector("annotation").textContent, "(\\log_2 n)^2");
  assert.ok(document.querySelector("msub"));
  assert.ok(document.querySelector("msup"));
  assert.ok(document.querySelector("mfrac"));
  assert.match(document.querySelector("main").textContent, /中文段落保持分开/);
});

test("math never changes fenced or inline code, including longer and unfinished fences", () => {
  const formula = String.raw`\[(\log_2 n)^2\] $x_1^2$`;
  for (const fence of ["```", "````", "~~~"]) {
    const document = documentFor(`${fence}latex\n${formula}\n${fence}\n\n普通 $y^2$。`);
    assert.equal(document.querySelector("pre code").textContent, formula);
    assert.equal(document.querySelector("pre .katex"), null);
    assert.equal(document.querySelectorAll(".katex").length, 1);
  }
  const inline = documentFor("`" + formula + "` 和 ``带 ` 的 $x$``。");
  assert.deepEqual(
    [...inline.querySelectorAll("code")].map((node) => node.textContent),
    [formula, "带 ` 的 $x$"]
  );
  assert.equal(inline.querySelector(".katex"), null);
  const unfinished = documentFor("```latex\n" + formula);
  assert.equal(unfinished.querySelector("pre code").textContent, formula);
  assert.equal(unfinished.querySelector(".katex"), null);
});

test("dollar math coexists with currency, escaped delimiters and unchanged link destinations", () => {
  const source = String.raw`价格 $5 和 $10，转义 \$x\$，字面 \\(a_b\\)，公式 $x_1$、$$y^2$$。
[下载](https://example.invalid/$folder$/a_b) 仍可点击。`;
  const document = documentFor(source);
  assert.equal(document.querySelectorAll(".katex").length, 2);
  assert.equal(document.querySelector("a").getAttribute("href"), "https://example.invalid/$folder$/a_b");
  assert.match(document.querySelector("main").textContent, /价格 \$5 和 \$10/);
  const unmatched = documentFor("先 $x 后续正文\n\n接着 $y$。");
  assert.equal(unmatched.querySelectorAll(".katex").length, 1);
  assert.match(unmatched.querySelector("main").textContent, /先 \$x 后续正文/);
});

test("invalid and untrusted formulas retain surrounding content without executable HTML", () => {
  const invalid = String.raw`\[\unknowncommand{<img src=x onerror=fail()>}\]`;
  const document = documentFor(`之前\n\n${invalid}\n\n之后 $x^2$。`);
  assert.equal(document.querySelector(".math-fallback").textContent, invalid);
  assert.equal(document.querySelectorAll(".katex").length, 1);
  assert.equal(document.querySelector("img"), null);
  assert.match(document.querySelector("main").textContent, /之后/);
  for (const command of [
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\includegraphics{https://example.invalid/track.png}`,
    String.raw`\htmlStyle{background:url(https://example.invalid/track)}{x}`
  ]) {
    const unsafe = documentFor(`\\(${command}\\)`);
    assert.equal(unsafe.querySelector("a, img, script, [onerror]"), null);
    assert.doesNotMatch(unsafe.querySelector("main").innerHTML, /(?:src|href|background)=?"?https?:/);
  }
});

test("formula limits and macro isolation keep subsequent messages usable", () => {
  const document = documentFor(String.raw`\(\def\loop{\loop}\loop\) 后续 \(x\)。`);
  assert.equal(document.querySelectorAll(".math-fallback").length, 1);
  assert.equal(document.querySelectorAll(".katex").length, 1);
  documentFor(String.raw`\(\gdef\privateMacro{42}\privateMacro\)`);
  assert.equal(documentFor(String.raw`\(\privateMacro\)`).querySelectorAll(".math-fallback").length, 1);
  assert.equal(documentFor(`\\(${"x".repeat(16_001)}\\)`).querySelectorAll(".math-fallback").length, 1);
});

test("partial streamed delimiters can finish without changing prose, lists or tables", () => {
  const partial = String.raw`中文前文

\[
\frac{n(n+1)}{2}`;
  const pending = documentFor(partial);
  assert.equal(pending.querySelector(".katex"), null);
  assert.match(pending.querySelector("main").textContent, /中文前文/);
  const complete = documentFor(
    partial +
      String.raw`
\]

- 结论 \(x_1\)

| 公式 | 说明 |
| --- | --- |
| $a*b*c$ | 正常 **加粗** |`
  );
  assert.equal(complete.querySelectorAll(".katex").length, 3);
  assert.equal(complete.querySelectorAll(".katex-display").length, 1);
  assert.equal(complete.querySelectorAll("li .katex").length, 1);
  assert.equal(complete.querySelectorAll("td .katex").length, 1);
  assert.equal(complete.querySelector("strong").textContent, "加粗");
  assert.equal(complete.querySelector("em"), null);
});
