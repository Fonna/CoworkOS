import { cadQueryReference } from "../../software/cad/cadquery-engine.js";
import { ApplicationError, type AdapterToolDefinition, type OperationResult } from "../types.js";
import { record, normalizeModel } from "../../software/cad/model.js";
import {
  normalizeProgram,
  normalizeParameters,
  isCadProgram,
  defaultComputeBudget,
  CAD_COMPUTE_LIMITS,
  computeBudget
} from "../../software/cad/program.js";
import { inspectProgram, previewProgram, type PreviewReport } from "../../software/cad/program-preview.js";
import { motionReference, viewerReference } from "../../software/cad/assembly-reference.js";
import { designReference } from "../../software/cad/design-manifest.js";
import type { CadView } from "../../software/cad/assembly.js";
const adjustedPreviewWarning = "已调整预览精度，仅影响显示网格；精确实体、尺寸、体积和 STEP 导出不变。";
const maxTimeoutSeconds = CAD_COMPUTE_LIMITS.maxTimeoutMs / 1000;
const computeDescription = `CadQuery 默认 ${CAD_COMPUTE_LIMITS.nativeDefaultTimeoutMs / 1000} 秒、JSCAD 默认 ${CAD_COMPUTE_LIMITS.jscadDefaultTimeoutMs / 1000} 秒；复杂设计可用 timeoutSeconds 增加到 ${maxTimeoutSeconds} 秒。保持完整模型及默认预览精度，不为满足预算删除零件或降低精度。`;
const timeoutSecondsSchema = { type: "integer", minimum: 1, maximum: maxTimeoutSeconds };
function toolComputeBudget(value: unknown, fallback: number, details: Record<string, unknown>): number {
  try {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value)))
      throw new Error("无效计算预算");
    return computeBudget(value === undefined ? undefined : (value as number) * 1000, fallback);
  } catch {
    throw new ApplicationError("invalid_operation", `计算预算须为 1–${maxTimeoutSeconds} 秒的整数`, details);
  }
}
function compareMetrics(before: PreviewReport, after: PreviewReport) {
  const dimensionDelta = after.dimensions.map((n, i) => n - before.dimensions[i]);
  const volumeDelta = after.volume - before.volume;
  const objectCountDelta = after.objects.length - before.objects.length;
  const faceCountDelta = before.brep && after.brep ? after.brep.faces - before.brep.faces : undefined;
  const solidCountDelta = before.brep && after.brep ? after.brep.solids - before.brep.solids : undefined;
  const boundsChanged = after.objects.some((object, i) =>
    object.bounds.some((v, side) =>
      v.some((n, axis) => Math.abs(n - (before.objects[i]?.bounds[side]?.[axis] ?? Infinity)) > 1e-4)
    )
  );
  const assemblyChanged = JSON.stringify(before.assembly) !== JSON.stringify(after.assembly);
  const motionChanged = before.motion?.signature !== after.motion?.signature;
  const appearanceChanged =
    JSON.stringify(before.objects.map((o) => [o.name, o.color])) !==
    JSON.stringify(after.objects.map((o) => [o.name, o.color]));
  return {
    previous: {
      dimensions: before.dimensions,
      volume: before.volume,
      objects: before.objects.length,
      brep: before.brep
    },
    dimensionDelta,
    volumeDelta,
    objectCountDelta,
    assemblyChanged,
    motionChanged,
    appearanceChanged,
    ...(faceCountDelta !== undefined ? { faceCountDelta, solidCountDelta } : {}),
    metricsChanged:
      dimensionDelta.some((n) => Math.abs(n) > 1e-4) ||
      Math.abs(volumeDelta) > Math.max(1e-5, Math.abs(before.volume) * 1e-8) ||
      objectCountDelta !== 0 ||
      (faceCountDelta ?? 0) !== 0 ||
      (solidCountDelta ?? 0) !== 0 ||
      boundsChanged ||
      assemblyChanged ||
      motionChanged ||
      appearanceChanged
  };
}
const parametersSchema = {
  type: "object",
  additionalProperties: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }] }
};
export function programOperation(content: unknown, operationType: string, payload: unknown): OperationResult {
  const input = record(payload);
  let next;
  if (operationType === "cad.document.restore")
    next = isCadProgram(input.document) ? normalizeProgram(input.document) : normalizeModel(input.document);
  else if (operationType === "cad.program.replace") next = normalizeProgram(input.program);
  else if (operationType === "cad.program.parameters" && isCadProgram(content))
    next = normalizeProgram({
      ...content,
      parameters: { ...content.parameters, ...normalizeParameters(input.parameters) }
    });
  else throw new Error("当前文档不支持此源码操作");
  return {
    content: next,
    summary:
      operationType === "cad.program.parameters"
        ? `调整 ${Object.keys(record(input.parameters)).length} 项设计参数`
        : "更新 CAD 源码工程",
    inverse: { operationType: "cad.document.restore", payload: { document: content } }
  };
}
export function programTools(): AdapterToolDefinition[] {
  return [
    {
      name: "cad_run_program",
      requiresFreshRead: true,
      description:
        "运行并提交当前 CAD 的源码或参数修改，返回实际几何、逐零件 BRep 诊断、装配树、运动摘要、四视图和基线变化。CadQuery main(p) 可返回 cq.Assembly，get_motion(p) 可返回关键帧运动；get_design_manifest(p) 可声明部件数量、材质和验证限制，返回 assessment 不会把几何有效当成设计完成；查询 module:'Design'。运动契约查询 cad_get_api_reference({module:'Motion'})。用 assert 检查设计要求、运动学与间隙，print 输出诊断。source 省略保留源码；parameters 仅合并指定覆盖，保留其他人工参数。计算及运动格式验证通过后才提交，失败或取消不改变保存设计；修正候选后重试。先 cad_read_model。engine 默认保持；切换须完整源码。JSCAD 用 CommonJS main(params)。无需另调 cad_preview。" +
        computeDescription,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", minLength: 1, maxLength: CAD_COMPUTE_LIMITS.maxSourceBytes },
          parameters: parametersSchema,
          engine: { type: "string", enum: ["cadquery", "jscad"] },
          timeoutSeconds: timeoutSecondsSchema
        }
      },
      async execute({ content, resource, params, signal }) {
        let program;
        try {
          if (!isCadProgram(content)) throw new Error("旧形体设计请先读取 editableSource 并升级源码");
          if (params.engine !== undefined && params.engine !== content.engine && params.source === undefined)
            throw new Error("切换引擎必须提供完整源码");
          program = normalizeProgram({
            ...content,
            engine: params.engine ?? content.engine,
            source: params.source ?? content.source,
            parameters: { ...content.parameters, ...normalizeParameters(params.parameters ?? {}) }
          });
        } catch (error) {
          throw new ApplicationError(
            "invalid_operation",
            error instanceof Error ? error.message : "无效源码",
            {
              sourceSaved: false,
              revision: resource.revision
            }
          );
        }
        const timeoutMs = toolComputeBudget(params.timeoutSeconds, defaultComputeBudget(program), {
          sourceSaved: false
        });
        const baseline = inspectProgram(content);
        const preview = await previewProgram(program, timeoutMs, signal);
        if (preview.status === "failed" || !preview.report.objects.length)
          throw new ApplicationError(
            "invalid_operation",
            preview.status === "failed" ? preview.error : "空模型；请返回有效实体",
            {
              sourceSaved: false,
              revision: resource.revision,
              nextAction:
                preview.status === "failed" && /排队|队列/.test(preview.error)
                  ? "当前保存设计未改变。等待其他 CAD 任务完成后，以原计算时限重试本次 cad_run_program 候选。"
                  : "当前保存设计未改变。修正本次代码或参数后重试 cad_run_program；计算超时可提高 timeoutSeconds。"
            }
          );
        signal?.throwIfAborted();
        const changeSummary =
          baseline.status === "ready" ? compareMetrics(baseline.report, preview.report) : undefined;
        const changedInput = JSON.stringify(normalizeProgram(content)) !== JSON.stringify(program);
        return {
          result: {
            engine: program.engine,
            status: "ready",
            ...preview.report,
            ...(changeSummary ? { changeSummary } : {}),
            warnings: [
              ...(changedInput && changeSummary?.metricsChanged === false
                ? [
                    "建模代码或参数已变化，但尺寸、体积、实体/面数和包围盒指标未变化。若要求新增孔、槽或其他几何特征，请核对切割位置及作用；这些指标不能证明两个模型完全相同。"
                  ]
                : []),
              ...(preview.report.tessellation?.adjusted ? [adjustedPreviewWarning] : []),
              ...(preview.report.assessment?.warnings ?? [])
            ],
            imageViews: ["isometric", "front (-Y)", "right (+X)", "top (+Z)"],
            note: "几何验证通过；运行时将按已读版本提交，冲突不会覆盖人工修改。多个实体体积相加，重叠未扣除。"
          },
          operations: [{ operationType: "cad.program.replace", payload: { program } }],
          images: [{ mimeType: "image/png" as const, data: preview.png }]
        };
      }
    },
    {
      name: "cad_preview",
      access: "read",
      description:
        "检查当前保存源码，返回精确尺寸/体积、逐零件有效性、装配/运动摘要和实际四视图。可用 view.timeSeconds 检查运动某帧、view.paths 隔离子装配、view.hiddenPaths 隐藏组、view.explode/explodeMode 拆解、view.section/sections 单轴或多轴剖切；view.bounds/objects 是派生视图包围盒，顶层指标仍是静止精确模型。不保存、不中断人工参数、不改变验证基线。运动帧仅变换已建模零件；格式有效不证明运动/无干涉正确。图片需支持图像输入；文字诊断始终可用。" +
        computeDescription,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          timeoutSeconds: timeoutSecondsSchema,
          view: {
            type: "object",
            additionalProperties: false,
            properties: {
              timeSeconds: { type: "number", minimum: 0, maximum: 3600 },
              paths: { type: "array", minItems: 1, maxItems: 256, items: { type: "string" } },
              hiddenPaths: { type: "array", minItems: 1, maxItems: 256, items: { type: "string" } },
              explode: { type: "number", minimum: 0, maximum: 1 },
              explodeMode: { type: "string", enum: ["parts", "groups"] },
              section: {
                type: "object",
                additionalProperties: false,
                properties: {
                  axis: { type: "string", enum: ["x", "y", "z"] },
                  offset: { type: "number" },
                  inverted: { type: "boolean" }
                },
                required: ["axis", "offset"]
              },
              sections: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    axis: { type: "string", enum: ["x", "y", "z"] },
                    offset: { type: "number" },
                    inverted: { type: "boolean" }
                  },
                  required: ["axis", "offset"]
                }
              }
            }
          }
        }
      },
      async execute({ content, resource, params, signal }) {
        if (!isCadProgram(content))
          throw new ApplicationError("invalid_operation", "请先在同一文件升级为源码工程", {});
        const timeoutMs = toolComputeBudget(params.timeoutSeconds, defaultComputeBudget(content), {});
        const preview = await previewProgram(content, timeoutMs, signal, params.view as CadView | undefined);
        if (preview.status === "failed")
          throw new ApplicationError("invalid_operation", preview.error, {
            sourceSaved: true,
            revision: resource.revision,
            preview,
            nextAction: /排队|队列/.test(preview.error)
              ? "源码仍可读取、下载和修改。等待其他 CAD 任务完成后，以原计算时限重试 cad_preview。"
              : "源码仍可读取、下载和修改。计算超时可增加 timeoutSeconds 重试；接口或几何错误请修正源码。"
          });
        return {
          result: {
            ...preview.report,
            revision: resource.revision,
            contentVersion: resource.contentVersion,
            status: "ready",
            warnings: [
              ...(preview.report.tessellation?.adjusted ? [adjustedPreviewWarning] : []),
              ...(preview.report.assessment?.warnings ?? []),
              ...(preview.report.objects.length ? [] : ["空模型；没有可显示的实体，尚未完成用户设计"])
            ],
            imageViews: ["isometric", "front (-Y)", "right (+X)", "top (+Z)"],
            note: preview.report.brep
              ? "图片为 BRep 网格预览；尺寸和体积由 OpenCascade 精确实体计算。多个实体体积相加，重叠未扣除。STEP 导出独立于显示网格。"
              : "图片从本次实际几何渲染。体积为实体相加，重叠部分未扣除。"
          },
          images: [{ mimeType: "image/png" as const, data: preview.png }]
        };
      }
    },
    {
      name: "cad_get_api_reference",
      access: "read",
      description:
        "按需查询真实安装 API 和示例。CadQuery 的 module 如 Workplane、Sketch、Shape、Assembly、Plane；module:'Motion' 查询 harness 装配/运动关键帧契约、坐标语义、预算与可运行 Python 示例。module:'Viewer' 查询选区、显示检查和派生视图协议；module:'Design' 查询 get_design_manifest 的部件清单、显示材质、验收反馈及简化声明。省略返回目录和源码契约。engine 默认当前文档；JSCAD 如 primitives、extrusions、transforms。无需每次查询已知接口。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          engine: { type: "string", enum: ["cadquery", "jscad"] },
          module: { type: "string" },
          member: { type: "string" }
        }
      },
      async execute({ params, content }) {
        const engine = params.engine ?? (isCadProgram(content) ? content.engine : "jscad");
        if (params.module === "Viewer") return { result: { engine, ...viewerReference } };
        if (params.module === "Design")
          return { result: { engine, ...designReference, supported: engine === "cadquery" } };
        if (engine === "cadquery") {
          if (params.module === "Motion") return { result: { engine: "cadquery", ...motionReference } };
          try {
            return {
              result: {
                ...(await cadQueryReference(
                  params.module ? String(params.module) : undefined,
                  params.member ? String(params.member) : undefined
                )),
                documentation: "https://cadquery.readthedocs.io/en/stable/classreference.html",
                harnessModules: ["Motion", "Viewer", "Design"],
                conventions: {
                  coordinates: "毫米，Z 向上；CadQuery rotate 角度是度。用 Workplane/Shape 原生 API。",
                  output:
                    "def main(p): 返回 cq.Workplane/cq.Shape/cq.Assembly 或命名实体数组；def get_parameter_definitions(): 人工参数。cq.Assembly 保留树、放置和颜色。可选 get_motion(p) 定义运动，module:'Motion' 查询准确契约；get_design_manifest(p) 声明需求部件/显示材质/验证限制，module:'Design' 查询。无文件/网络权限。",
                  exactGeometry:
                    "OpenCascade BRep，STEP 保留精确曲面、装配层级、名称和颜色；预览只做三角化，二者独立。",
                  motion:
                    "装配节点使用完整 path；get_motion 返回 duration/tracks。前端变换零件，不逐帧重建几何。cad_preview.view 可检查时间、隔离、爆炸和剖切。关键帧验证不等于物理仿真。"
                },
                example:
                  'import cadquery as cq\ndef main(p):\n    return cq.Workplane("XY").box(60,40,20).edges("|Z").fillet(3).faces(">Z").workplane().hole(10)'
              }
            };
          } catch (error) {
            throw new ApplicationError(
              "invalid_operation",
              error instanceof Error ? error.message : "内核 API 不可用",
              {}
            );
          }
        }
        const [{ default: modeling }, { apiReference }] = await Promise.all([
          import("@jscad/modeling"),
          import("../../software/cad/api-reference.generated.js")
        ]);
        const library = modeling as unknown as Record<string, Record<string, unknown>>;
        const modules = Object.fromEntries(
          Object.entries(library).map(([name, functions]) => [name, Object.keys(functions).sort()])
        );
        if (params.module && !Object.hasOwn(modules, String(params.module)))
          throw new ApplicationError("invalid_operation", "未知 JSCAD 模块", {
            modules: Object.keys(modules)
          });
        const moduleName = params.module ? String(params.module) : undefined;
        const memberName = params.member ? String(params.member) : undefined;
        if (memberName && (!moduleName || !Object.hasOwn(library[moduleName], memberName)))
          throw new ApplicationError("invalid_operation", "member 需要有效的 module 和函数/命名空间名", {});
        const reference = moduleName ? apiReference[moduleName] : undefined;
        const selected = memberName ? reference?.[memberName] : reference && Object.values(reference).flat();
        const help = selected && [...new Map(selected.map((item) => [item.path, item])).values()];
        return {
          result: {
            engine: "@jscad/modeling 2.13.0",
            radians: true,
            conventions: {
              coordinates: "Z 为高度轴，单位 mm；polygon 的点是 XY 二维坐标。",
              extrudeRotate:
                "extrudeRotate({segments,angle,startAngle}, geom2)；轮廓点 [半径,轴向高度]，返回绕 Z 轴的 geom3，无需再旋转到 Z。",
              extrudeLinear: "extrudeLinear({height,twistAngle,twistSteps}, geom2)；从 z=0 沿 +Z 拉伸。",
              transforms:
                "translate([x,y,z], ...objects)；rotate([rx,ry,rz], ...objects)，弧度、绕原点；rotateX/Y/Z(angle,...objects)。",
              torus:
                "torus({innerRadius,outerRadius})：innerRadius 是管截面半径，outerRadius 是主圆半径，非环的内外边缘半径。",
              output: "main(params) 返回 geom3 或嵌套实体数组；不要返回未经拉伸的二维轮廓。"
            },
            modules: params.module ? { [String(params.module)]: modules[String(params.module)] } : modules,
            documentation: "https://jscad.app/docs/",
            ...(help
              ? { installedApi: help }
              : { nextAction: "传入 module 和可选 member 查询本版本的准确函数签名与说明。" }),
            example:
              "const { polygon } = require('@jscad/modeling').primitives;\nconst { extrudeRotate } = require('@jscad/modeling').extrusions;\nmodule.exports.main = () => extrudeRotate({segments:64}, polygon({points:[[0,0],[20,0],[10,30],[0,45]]}));"
          }
        };
      }
    },
    {
      name: "cad_write_program",
      requiresFreshRead: true,
      description:
        "保存完整 CAD 源码。当前引擎默认保留；切换必须显式 engine 并重写源码。CadQuery: Python import cadquery as cq，def main(p) 返回 Workplane/Shape/Assembly 或命名实体数组，def get_parameter_definitions() 提供参数，支持完整原生 OpenCascade 建模；JSCAD: CommonJS main(params)/getParameterDefinitions，返回 geom3。源码先保存，不因编译错误或超时丢失；保存后必须 cad_preview 检查真实几何和多视图，再根据结果修正。不要把源码保存成功称为建模完成。先 cad_read_model；旧模型从 editableSource 在同一文件升级。parameters 省略保留人工覆盖，参数改名时迁移。禁止文件、网络和其他包。不要降级为三个基本形体。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          engine: { type: "string", enum: ["cadquery", "jscad"] },
          source: { type: "string", minLength: 1, maxLength: CAD_COMPUTE_LIMITS.maxSourceBytes },
          parameters: parametersSchema
        },
        required: ["source"]
      },
      async execute({ content, params }) {
        try {
          const program = normalizeProgram({
            version: 2,
            engine: params.engine ?? (isCadProgram(content) ? content.engine : "jscad"),
            units: "mm",
            source: params.source,
            parameters: params.parameters ?? (isCadProgram(content) ? content.parameters : {})
          });
          return {
            result: {
              engine: program.engine,
              sourceSaved: true,
              preview: inspectProgram(program),
              nextAction: { tool: "cad_preview", arguments: {} }
            },
            operations: [{ operationType: "cad.program.replace", payload: { program } }]
          };
        } catch (error) {
          throw new ApplicationError(
            "invalid_operation",
            error instanceof Error ? error.message : "源码建模失败",
            { nextAction: "修正文档格式后重新提交；原设计尚未修改" }
          );
        }
      }
    },
    {
      name: "cad_set_parameters",
      requiresFreshRead: true,
      description:
        "保存 CAD 参数覆盖，保持完整源码及未涉及的人工参数；先读取定义，修改后 cad_preview 验证，计算失败不丢失源码与参数。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { parameters: parametersSchema },
        required: ["parameters"]
      },
      async execute({ content, params }) {
        try {
          const payload = { parameters: normalizeParameters(params.parameters) };
          const next = programOperation(content, "cad.program.parameters", payload);
          return {
            result: {
              program: next.content,
              sourceSaved: true,
              nextAction: { tool: "cad_preview", arguments: {} }
            },
            operations: [{ operationType: "cad.program.parameters", payload }]
          };
        } catch (error) {
          throw new ApplicationError(
            "invalid_operation",
            error instanceof Error ? error.message : "无效参数",
            {}
          );
        }
      }
    }
  ];
}
