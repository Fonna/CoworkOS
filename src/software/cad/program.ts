import { record } from "./model.js";
import { CAD_COMPUTE_LIMITS } from "./compute-limits.js";
export { CAD_COMPUTE_LIMITS, CAD_TIMEOUT_STEPS, computeBudget } from "./compute-limits.js";
export const CAD_PROGRAM_KIND = "model/atria-jscad+json";
export const CADQUERY_PROGRAM_KIND = "model/atria-cadquery+json";
export type ParameterValue = number | string | boolean;
export interface CadProgram {
  version: 2;
  engine: "jscad" | "cadquery";
  units: "mm";
  source: string;
  parameters: Record<string, ParameterValue>;
}
/** Native BRep assembly construction includes Python startup and validation. */
export const defaultComputeBudget = (program: Pick<CadProgram, "engine">): number =>
  program.engine === "cadquery"
    ? CAD_COMPUTE_LIMITS.nativeDefaultTimeoutMs
    : CAD_COMPUTE_LIMITS.jscadDefaultTimeoutMs;
/** New documents contain no sample geometry or preset design parameters. */
export function blankProgram(engine: CadProgram["engine"]): CadProgram {
  return normalizeProgram({
    version: 2,
    engine,
    units: "mm",
    source:
      engine === "cadquery"
        ? "import cadquery as cq\n\ndef get_parameter_definitions():\n    return []\n\ndef main(p):\n    return []\n"
        : "const getParameterDefinitions = () => [];\nfunction main(p) { return []; }\nmodule.exports = { main, getParameterDefinitions };\n",
    parameters: {}
  });
}
export const DEFAULT_SOURCE = `const { cylinder } = require('@jscad/modeling').primitives;
const getParameterDefinitions = () => [
  { name: 'radius', type: 'float', initial: 20, min: 1, caption: '半径 (mm)' },
  { name: 'height', type: 'float', initial: 60, min: 1, caption: '高度 (mm)' }
];
function main(p) { return cylinder({ radius: p.radius, height: p.height, segments: 64 }); }
module.exports = { main, getParameterDefinitions };
`;
export const isCadProgram = (value: unknown): value is CadProgram =>
  Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === 2);
export function normalizeParameters(value: unknown): Record<string, ParameterValue> {
  const input = record(value);
  if (Object.keys(input).length > 2048) throw new Error("参数过多");
  const result: Record<string, ParameterValue> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key) || ["constructor", "prototype", "__proto__"].includes(key))
      throw new Error("无效参数名");
    if (
      typeof item === "number"
        ? !Number.isFinite(item)
        : typeof item !== "boolean" && (typeof item !== "string" || item.length > 1000)
    )
      throw new Error(`无效参数 ${key}`);
    result[key] = item as ParameterValue;
  }
  return result;
}
export function normalizeProgram(value: unknown): CadProgram {
  const input = record(value);
  if (
    Object.keys(input).some((key) => !["version", "engine", "units", "source", "parameters"].includes(key)) ||
    input.version !== 2 ||
    !["jscad", "cadquery"].includes(String(input.engine)) ||
    input.units !== "mm"
  )
    throw new Error("需要 version:2、engine:jscad/cadquery、units:mm 的源码工程");
  if (
    typeof input.source !== "string" ||
    !input.source.trim() ||
    new TextEncoder().encode(input.source).byteLength > CAD_COMPUTE_LIMITS.maxSourceBytes
  )
    throw new Error("CAD 源码不能为空或超过 1 MiB（UTF-8）");
  return {
    version: 2,
    engine: input.engine as CadProgram["engine"],
    units: "mm",
    source: input.source,
    parameters: normalizeParameters(input.parameters ?? {})
  };
}
export const emptyProgram = (): CadProgram =>
  normalizeProgram({ version: 2, engine: "jscad", units: "mm", source: DEFAULT_SOURCE, parameters: {} });

export const DEFAULT_CADQUERY_SOURCE = `import cadquery as cq

def get_parameter_definitions():
    return [
        {"name": "width", "type": "float", "initial": 60, "min": 10, "caption": "宽度 (mm)"},
        {"name": "height", "type": "float", "initial": 30, "min": 8, "caption": "高度 (mm)"},
        {"name": "hole", "type": "float", "initial": 10, "min": 1, "max": 18, "caption": "通孔直径 (mm)"},
    ]

def main(p):
    body = cq.Workplane("XY").box(p["width"], 40, p["height"])
    body = body.edges("|Z").fillet(3)
    body = body.faces(">Z").workplane().hole(p["hole"])
    return [{"name": "圆角支架", "shape": body}]
`;
export const emptyCadQueryProgram = (): CadProgram =>
  normalizeProgram({
    version: 2,
    engine: "cadquery",
    units: "mm",
    source: DEFAULT_CADQUERY_SOURCE,
    parameters: {}
  });
