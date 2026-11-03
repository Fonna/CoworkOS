#!/usr/bin/env node
/** Paid, opt-in integration exercise. Reads existing private model config; never logs credentials.
 * The configured authoring model creates a structured deck; batch vision review checks rendered images.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildDeck } from "../.pi/skills/presentations/scripts/build_deck.mjs";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { readCoworkConfig } from "../dist/src/runtime/config.js";
import { visionModelConfig } from "../dist/src/runtime/vision-config.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import {
  runtimeSettingsEnv,
  configuredModelApi,
  configuredThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredMainMaxTokens
} from "../dist/src/runtime/runtime-settings.js";
const exec = promisify(execFile);
const root = process.cwd();
const arg = process.argv.slice(2);
if (arg.includes("--help") || !arg.includes("--live")) {
  console.log(
    "Usage: node scripts/presentation-smoke.mjs --live [--output DIR] [--resume]\nUses configured authoring and vision connections (billable). Defaults to .tmp/presentation-smoke."
  );
  process.exit(0);
}
const output = resolve(
  arg.includes("--output") ? arg[arg.indexOf("--output") + 1] : ".tmp/presentation-smoke"
);
await mkdir(output, { recursive: true });
const config = readCoworkConfig();
const env = runtimeSettingsEnv(config);
const vision = visionModelConfig(config);
if (!vision) throw Error("Vision model is not configured");
const tools = createBuiltinTools({ rootDirectory: output, supportsImages: false, visionModel: vision });
const save = async (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const note = (stage, data = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), stage, ...data }));
};
async function author(prompt) {
  const baseUrl = env.COWORK_API_BASE ?? config.baseUrl;
  const apiKey = env.COWORK_API_KEY ?? config.apiKey;
  const model = env.COWORK_MODEL ?? config.model;
  if (!baseUrl || !apiKey || !model) throw Error("Configure an authoring model first");
  const session = new PiSession({
    baseUrl,
    apiKey,
    model,
    api: configuredModelApi(env),
    thinkingFormat: configuredThinkingFormat(env),
    thinkingLevel: configuredReasoningEffort(env),
    supportsReasoningEffort: configuredSupportsReasoningEffort(env),
    supportsImages: false,
    maxTokens: configuredMainMaxTokens(env),
    maxTurns: 1,
    maxErrorRetries: 0,
    timeoutMs: 300000,
    tools: new Map()
  });
  const result = await session.run(prompt);
  if (result.termination !== "completed") throw Error(`Authoring request ${result.termination}`);
  const text = result.assistant?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text?.trim()) throw Error("Authoring model returned no final text");
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
  );
}
const schema = await readFile(join(root, ".pi/skills/presentations/references/deck-spec.md"), "utf8");
const brief = `制作6页中文PPT，主题“让PPT从可生成走向可验证”，受众是CoworkOS开发者。页型依次为cover/comparison/flow/chart/timeline/closing。\n事实：主模型负责内容与修改，配置的视觉模型检查渲染图后返回文字证据；文件结构、字体和视觉检查互补；相同图片与目标可以复用检查；最多两轮修改，检查失败必须标为未完成。\n图表只展示明确标注的“流程演示数据，非实测”：初稿3处问题，修改后1处，复查后0处，单位“处”，不要将其解释为测量结果。\n流程3步，时间线3项，每项标题6-10汉字、正文10-18汉字；对比页每栏3条，每条最多18汉字。标题最多20汉字。source控制在40汉字内。封面subtitle最多28汉字；图表takeaway最多28汉字。\n采用teal主题，font为Droid Sans Fallback；内容简洁但有明确观点。仅返回符合下面规范的JSON，不要解释或Markdown。\n${schema}`;
let spec = arg.includes("--resume")
  ? JSON.parse(await readFile(join(output, "deck.json"), "utf8"))
  : await author(brief);
const rounds = [];
for (let round = 0; round <= 2; round++) {
  await save("deck.json", spec);
  let built = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await buildDeck(spec, join(output, "deck.pptx"), { baseDirectory: output });
      built = true;
      break;
    } catch (error) {
      note("build_issue", { message: error.message });
      if (attempt === 1) throw error;
      spec = await author(
        `修复以下PPT规范JSON的构建错误。仅返回完整JSON；不要改动事实与主题。\n错误：${error.message}\n规范：${schema}\n现有JSON：${JSON.stringify(spec)}`
      );
      await save("deck.json", spec);
    }
  }
  if (!built) throw Error("Deck build failed");
  await save(`round-${round}-spec.json`, spec);
  const auditRun = await exec(
    process.execPath,
    [join(root, ".pi/skills/presentations/scripts/validate_slides.mjs"), join(output, "deck.pptx")],
    { maxBuffer: 2000000 }
  );
  const audit = JSON.parse(auditRun.stdout);
  await save(`round-${round}-audit.json`, audit);
  note("audit", { round, errors: audit.errors.length, warnings: audit.warnings.length });
  const renderRun = await exec(
    process.execPath,
    [
      join(root, ".pi/skills/presentations/scripts/render_slides.mjs"),
      join(output, "deck.pptx"),
      "--output-dir",
      join(output, `render-${round}`),
      "--dpi",
      "120"
    ],
    { timeout: 300000, maxBuffer: 2000000 }
  );
  const render = JSON.parse(renderRun.stdout);
  await save("render.json", render);
  const batch = await tools.get("review_slides").execute({
    slides: render.slides.map((path, i) => ({
      path: relative(output, path),
      goal: `第${i + 1}页：检查文字遮挡、溢出、对比度、可读性与图示标签。图表数据是明确标注的流程演示，并非实测。`
    })),
    overview: { path: relative(output, render.contactSheet) },
    reportPath: "review-ledger.json",
    concurrency: 2
  });
  const reviews = [...(batch.overview ? [batch.overview] : []), ...batch.slides].map((check) => ({
    ...check,
    ...check.review,
    status: check.status,
    issues: check.review?.issues ?? []
  }));
  note("batch_review", { round, ...batch.summary });
  const result = { round, audit, reviews };
  rounds.push(result);
  await save("review.json", { rounds, final: result });
  const issues = reviews.filter((r) => r.status === "needs_revision");
  if (!issues.length || round === 2) break;
  note("revision", { round, affectedPages: issues.map((r) => r.page) });
  spec = await author(
    `根据下面视觉检查修订PPT JSON。保留事实、页数、主题；只改有问题的页面。不要盲从报告的猜测，只处理具体可见问题。内容过多优先精简，不缩小字体。版式受规范限制。仅返回完整JSON。\n规范：${schema}\n检查：${JSON.stringify(issues)}\n当前JSON：${JSON.stringify(spec)}`
  );
}
const final = rounds.at(-1);
const status = final.reviews.every((r) => r.status === "pass")
  ? "pass"
  : final.reviews.some((r) => r.status === "unreviewed")
    ? "incomplete"
    : "needs_revision";
await save("summary.json", {
  status,
  model: config.model,
  visionModel: vision.model,
  rounds: rounds.length,
  slides: spec.slides.length,
  finalReviews: final.reviews.map(({ page, status, issues }) => ({ page, status, issues })),
  notes:
    "Controlled spec generation + real batch pixel review. Not an unrestricted autonomous CLI benchmark; chart data is explicitly illustrative."
});
note("finished", { status, output, rounds: rounds.length });
