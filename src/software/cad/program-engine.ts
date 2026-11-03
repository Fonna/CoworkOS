import { runDesign } from "./program-guest.js";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { runtimeSource } from "./runtime-source.generated.js";
import { normalizeProgram, type CadProgram } from "./program.js";
import { CAD_COMPUTE_LIMITS, computeBudget } from "./compute-limits.js";
const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
import { validateGeometry, type ProgramGeometry } from "./program-geometry.js";
export type { ProgramParameter, ProgramGeometry } from "./program-geometry.js";
const utf8Bytes = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};
/** Complete JSCAD API in an isolated interpreter; no fs, process, DOM, fetch or host eval. */
export function evaluateProgram(
  input: CadProgram,
  {
    timeoutMs = CAD_COMPUTE_LIMITS.jscadDefaultTimeoutMs,
    exportStl = false
  }: { timeoutMs?: number; exportStl?: boolean } = {}
): ProgramGeometry {
  computeBudget(timeoutMs);
  const program = normalizeProgram(input);
  if (program.engine !== "jscad") throw new Error("此解释器仅支持 JSCAD；CadQuery 需要本地精确实体内核");
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(CAD_COMPUTE_LIMITS.jscadMemoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const result = context.evalCode(
      `${runtimeSource}\n(${runDesign.toString()})(${JSON.stringify(program.source)},${JSON.stringify(program.parameters)},${exportStl},${JSON.stringify(CAD_COMPUTE_LIMITS)})`,
      "design.jscad"
    );
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(
        error?.message === "interrupted"
          ? "建模计算超时；可提高计算时限重试，已保存设计保持不变"
          : `CAD 编译失败：${error?.message || "未知错误"}`
      );
    }
    const raw = context.dump(result.value);
    result.value.dispose();
    if (
      typeof raw !== "string" ||
      raw.length > CAD_COMPUTE_LIMITS.maxResultBytes ||
      utf8Bytes(raw) > CAD_COMPUTE_LIMITS.maxResultBytes
    )
      throw new Error("模型计算结果超过传输预算");
    const geometry = validateGeometry(JSON.parse(raw));
    if (!Number.isFinite(geometry.volume) || !geometry.dimensions.every(Number.isFinite))
      throw new Error("无效几何结果");
    return geometry;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
