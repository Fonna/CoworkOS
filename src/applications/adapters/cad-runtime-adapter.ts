import { exportCadQuery } from "../../software/cad/cadquery-engine.js";
import type { CadView } from "../../software/cad/assembly.js";
import {
  CAD_PROGRAM_KIND,
  CADQUERY_PROGRAM_KIND,
  CAD_COMPUTE_LIMITS,
  blankProgram,
  defaultComputeBudget,
  computeBudget,
  normalizeProgram,
  isCadProgram
} from "../../software/cad/program.js";
import { inspectProgram, previewProgram, withCadComputeSlot } from "../../software/cad/program-preview.js";
import { programFromModel } from "../../software/cad/program-migration.js";
import { programTools, programOperation } from "./cad-program-tools.js";
import { ApplicationError, type WorkbenchRuntimeAdapter, type AdapterToolDefinition } from "../types.js";
import {
  CAD_APP,
  CAD_KIND,
  MAX_PARTS,
  emptyModel,
  normalizeModel,
  applyCadOperation,
  record,
  partId
} from "../../software/cad/model.js";

function validate<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw new ApplicationError(
      "invalid_operation",
      error instanceof Error ? error.message : "无效 CAD 模型",
      {}
    );
  }
}
const partSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,47}$",
      description: "稳定 ID；相同 ID 替换原特征"
    },
    name: { type: "string", minLength: 1, maxLength: 80 },
    shape: { type: "string", enum: ["box", "cylinder", "sphere"] },
    mode: { type: "string", enum: ["add", "cut"] },
    size: {
      type: "array",
      items: { type: "number", minimum: 0.1, maximum: 1000 },
      minItems: 3,
      maxItems: 3,
      description: "长方体 X/Y/Z 尺寸，毫米"
    },
    radius: { type: "number", minimum: 0.1, maximum: 500, description: "圆柱或球的半径，毫米" },
    height: { type: "number", minimum: 0.1, maximum: 1000, description: "圆柱沿 Z 轴的高度，毫米" },
    position: {
      type: "array",
      items: { type: "number", minimum: -2000, maximum: 2000 },
      minItems: 3,
      maxItems: 3,
      description: "形体中心在模型坐标系中的 X/Y/Z 坐标，毫米。径向排列时，每个形体需分别设置中心坐标。"
    },
    rotation: {
      type: "array",
      items: { type: "number", minimum: -360, maximum: 360 },
      minItems: 3,
      maxItems: 3,
      description: "绕形体自身中心的 X/Y/Z 轴旋转，度。只改变方向，不改变 position，不会绕模型原点公转。"
    }
  },
  required: ["id", "shape"]
};
function agentTools(input?: { content: unknown }): AdapterToolDefinition[] {
  const tools: AdapterToolDefinition[] = [
    ...programTools(),
    {
      name: "cad_read_model",
      access: "read",
      description:
        "读取当前 CAD 完整源码、人工参数和已知验证状态，不触发计算。修改已有设计前读取，保留用户改动。not_checked 表示尚未计算。cad_run_program 运行并提交修改；cad_preview 仅检查当前保存设计。版本由运行时管理。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute({ content, resource }) {
        if (isCadProgram(content)) {
          const preview = inspectProgram(content);
          return {
            result: {
              revision: resource.revision,
              model: content,
              engine: content.engine,
              // The geometry report below is already complete. Avoid sending it twice.
              preview: preview.status === "ready" ? { status: "ready" } : preview,
              ...(preview.status === "ready"
                ? {
                    definitions: preview.report.definitions,
                    parameters: preview.report.parameters,
                    geometry: preview.report
                  }
                : {}),
              nextAction: {
                tool: "cad_run_program",
                note: "提交完整源码或指定参数，运行验证后在同一文件保存；其他人工参数保留"
              }
            }
          };
        }
        return {
          result: {
            revision: resource.revision,
            model: validate(() =>
              isCadProgram(content) ? normalizeProgram(content) : normalizeModel(content)
            ),
            editableSource: programFromModel(content),
            nextAction: {
              tool: "cad_write_program",
              note: "复杂建模可在同一资源中升级源码；从 editableSource 保留现有设计及参数"
            }
          }
        };
      }
    },
    {
      name: "cad_edit_parts",
      requiresFreshRead: true,
      description:
        "仅用于旧 version:1 基础形体。复杂建模优先源码工具。一次新增、替换或删除多个 CAD 特征，多个改动优先用此工具。upsert 传完整特征，遗漏字段用默认值；已有 ID 保持原顺序，新 ID 按数组顺序追加；remove 传已有 ID。先读模型，保留未涉及的特征。最终模型整体校验，一次保存、一次撤销；失败不保存任何特征。同一 ID 不能同时出现在 upsert/remove。形体以中心为原点，圆柱沿 Z 轴，position 为毫米、rotation 为度；add 合并，cut 切除此前实体，首项须为 add。运行时自动管理版本，无需分次试探或询问用户调用顺序。",
      parameters: {
        type: "object",
        properties: {
          upsert: { type: "array", items: partSchema, maxItems: MAX_PARTS },
          remove: { type: "array", items: { type: "string" }, maxItems: MAX_PARTS }
        },
        additionalProperties: false
      },
      async execute({ content, params }) {
        const model = validate(() => applyCadOperation(content, "cad.edit", params));
        return { result: { model }, operations: [{ operationType: "cad.edit", payload: params }] };
      }
    },
    {
      name: "cad_upsert_part",
      requiresFreshRead: true,
      description:
        "仅用于旧 version:1 基础形体。新增或替换一个 CAD 特征；多个改动用 cad_edit_parts 一次保存。先读模型；传完整特征，遗漏字段用默认值。稳定 ID 用于替换；add 合并、cut 切除此前实体；形体以中心为原点。运行时自动管理版本。",
      parameters: {
        type: "object",
        properties: { part: partSchema },
        required: ["part"],
        additionalProperties: false
      },
      async execute({ content, params }) {
        const model = validate(() => applyCadOperation(content, "cad.upsert", params));
        return { result: { model }, operations: [{ operationType: "cad.upsert", payload: params }] };
      }
    },
    {
      name: "cad_remove_part",
      requiresFreshRead: true,
      description:
        "仅用于旧 version:1 基础形体。删除指定稳定 ID 的特征；关联的多个删除或替换用 cad_edit_parts 一次保存。最终首项不能为切除体。运行时自动管理版本。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false
      },
      async execute({ content, params }) {
        const model = validate(() => applyCadOperation(content, "cad.remove", params));
        return { result: { model }, operations: [{ operationType: "cad.remove", payload: params }] };
      }
    }
  ];
  // Only advertise operations that apply to this document. No-input callers
  // retain the complete adapter catalog for compatibility and introspection.
  if (!input || !isCadProgram(input.content)) return tools;
  const names =
    input.content.engine === "cadquery"
      ? ["cad_read_model", "cad_run_program", "cad_preview", "cad_get_api_reference"]
      : [
          "cad_read_model",
          "cad_run_program",
          "cad_preview",
          "cad_get_api_reference",
          "cad_write_program",
          "cad_set_parameters"
        ];
  return tools.filter((tool) => names.includes(tool.name));
}
export const cadRuntimeAdapter: WorkbenchRuntimeAdapter = {
  definition: {
    appType: CAD_APP,
    displayName: "参数化 CAD",
    version: "2",
    contentBytes: CAD_COMPUTE_LIMITS.maxDocumentBytes,
    entryReadTool: "cad_read_model",
    creationHint:
      '新设计 create_resource({kind:"model/atria-cadquery+json",title:"设计.cad.json"})，省略 initialContent 创建空工程。读取后 cad_run_program 提交完整 Python main(p) 源码并验证；支持精确实体、具名装配树、人工参数、STEP 导出。运动需求可用 get_motion(p)，cad_get_api_reference({module:"Motion"}) 查询契约；cad_preview.view 检查运动帧和内部结构。只在编辑 CAD 时按需加载 parametric-cad skill。',
    resourceKinds: [CADQUERY_PROGRAM_KIND, CAD_PROGRAM_KIND, CAD_KIND],
    capabilities: ["view", "edit", "select", "history", "export", "agent-commands"],
    selectionSchemas: ["cad.feature/v1", "cad.program-solid/v1", "cad.assembly-node/v1"],
    skillRoots: [".pi/skills/parametric-cad"],
    exportFormats: ["json", "python", "jscad", "step", "stl", "png"],
    fileExtensions: {
      [CAD_KIND]: ".cad.json",
      [CAD_PROGRAM_KIND]: ".cad.json",
      [CADQUERY_PROGRAM_KIND]: ".cad.json"
    },
    operationSchemas: {
      "cad.program.replace": {
        description: "校验文档格式并保存源码；计算独立进行，错误源码也可保存、修复和撤销",
        required: ["program"]
      },
      "cad.program.parameters": { description: "修改源码工程参数，保留全部源码", required: ["parameters"] },
      "cad.document.restore": { description: "撤销并恢复完整 CAD 文档及其格式", required: ["document"] },
      "cad.edit": {
        description: "一次原子提交多个特征变更；upsert/remove 至少一组非空，保留未涉及的特征",
        required: []
      },
      "cad.upsert": { description: "新增或替换完整特征", required: ["part"] },
      "cad.remove": { description: "按 ID 删除特征", required: ["id"] },
      "cad.replace": { description: "导入或恢复完整模型", required: ["model"] }
    }
  },
  createContent({ initialContent, kind }) {
    // Empty optional input from model providers means use the app default.
    const useDefault =
      initialContent == null || (typeof initialContent === "string" && !initialContent.trim());
    if ([CAD_PROGRAM_KIND, CADQUERY_PROGRAM_KIND].includes(kind) || isCadProgram(initialContent))
      return validate(() => {
        const program = useDefault
          ? blankProgram(kind === CADQUERY_PROGRAM_KIND ? "cadquery" : "jscad")
          : normalizeProgram(
              typeof initialContent === "string" ? JSON.parse(initialContent) : initialContent
            );
        return program;
      });
    return validate(() =>
      useDefault
        ? emptyModel()
        : normalizeModel(typeof initialContent === "string" ? JSON.parse(initialContent) : initialContent)
    );
  },
  serialize(content) {
    return (
      JSON.stringify(
        validate(() => (isCadProgram(content) ? normalizeProgram(content) : normalizeModel(content))),
        null,
        2
      ) + "\n"
    );
  },
  parse(raw) {
    return validate(() => {
      const parsed = JSON.parse(raw);
      return isCadProgram(parsed) ? normalizeProgram(parsed) : normalizeModel(parsed);
    });
  },
  applyOperation({ operationType, payload, content }) {
    if (operationType.startsWith("cad.program.") || operationType === "cad.document.restore")
      return validate(() => programOperation(content, operationType, payload));
    if (isCadProgram(content) && operationType !== "cad.replace")
      throw new ApplicationError(
        "invalid_operation",
        "当前是源码工程，请用 cad_write_program 或 cad_set_parameters",
        {}
      );
    return validate(() => {
      const model = isCadProgram(content) ? content : normalizeModel(content);
      const next =
        operationType === "cad.replace" && isCadProgram(content)
          ? normalizeModel(record(payload).model)
          : applyCadOperation(model, operationType, payload);
      const value = record(payload);
      const name =
        operationType === "cad.upsert"
          ? String(record(value.part).name ?? record(value.part).id)
          : operationType === "cad.remove"
            ? String(value.id)
            : "模型";
      const summary =
        operationType === "cad.edit"
          ? `批量更新 ${(value.upsert as unknown[] | undefined)?.length ?? 0} 个特征，删除 ${(value.remove as unknown[] | undefined)?.length ?? 0} 个特征`
          : `${operationType === "cad.remove" ? "删除" : "更新"} ${name}`;
      return {
        content: next,
        summary,
        inverse: isCadProgram(model)
          ? { operationType: "cad.document.restore", payload: { document: model } }
          : { operationType: "cad.replace", payload: { model } }
      };
    });
  },
  summarizeSelection({ selection, content }) {
    // Clicking the viewport background explicitly clears the active part.
    // Keep that state in the shared selection so the Agent sees the same thing.
    const data = validate(() => record(selection.data));
    if (Object.keys(data).length === 0) return "未选中模型部件";
    if (isCadProgram(content))
      return validate(() => {
        if (selection.schema === "cad.assembly-node/v1") {
          const path = data.path;
          if (typeof path !== "string" || !path.startsWith("/") || path.length > 512)
            throw new Error("无效装配选区路径");
          const preview = inspectProgram(content);
          if (preview.status !== "ready") return `选中装配路径 ${path}，当前源码预览尚未验证；先 cad_preview`;
          const node = preview.report.assembly?.find((n) => n.path === path);
          if (!node) throw new Error("选中的装配节点不存在");
          const members = preview.report.objects.filter(
            (f) => f.path === path || f.path?.startsWith(path + "/")
          );
          return `选中子装配 ${node.name}（装配路径 ${path}，${members.length} 个计算实体），可用 cad_preview 的 view.paths 检查整组；修改相关源码保留其他设计`;
        }
        const id = String(record(selection.data).id);
        if (!/^solid_\d{1,4}$/.test(id) || Number(id.slice(6)) >= 1024) throw new Error("无效计算实体 ID");
        const preview = inspectProgram(content);
        if (preview.status !== "ready")
          return `选中计算实体 ${id}，当前源码预览尚未验证；先 cad_preview 确认实体`;
        const path = data.path;
        if (path !== undefined && (typeof path !== "string" || path.length > 512))
          throw new Error("无效装配选区路径");
        const object = preview.report.objects.find((feature) =>
          path ? feature.path === path : feature.id === id
        );
        if (!object) throw new Error("选中的源码实体不存在");
        return `选中源码实体 ${object.name}（${object.id}${object.path ? `，装配路径 ${object.path}` : ""}），修改相关参数或源码保留其他设计`;
      });
    return validate(() => {
      const id = partId(record(selection.data).id);
      const part = normalizeModel(content).parts.find((entry) => entry.id === id);
      if (!part) throw new Error("选中的特征不存在");
      return `选中特征 ${part.name}（ID ${part.id}，${part.shape}，${part.mode}）`;
    });
  },
  summarizeContext({ content, selection }) {
    if (isCadProgram(content))
      return {
        shape: `${content.engine === "cadquery" ? "CadQuery / OpenCascade 精确实体" : "JSCAD"} 源码工程，单位毫米；${Object.keys(content.parameters).length} 项人工参数覆盖。源码保存不等于几何验证；编辑前 cad_read_model，保存后 cad_preview。`,
        selectionSummary: selection
          ? inspectProgram(content).status === "ready"
            ? selection.summary
            : "此前选区来自旧预览，当前源码尚未验证；先计算再确认实体"
          : undefined
      };
    const model = validate(() => normalizeModel(content));
    return {
      shape: `毫米单位的参数化模型，${model.parts.filter((p) => p.mode === "add").length} 个实体、${model.parts.filter((p) => p.mode === "cut").length} 个切除特征`,
      selectionSummary: selection?.summary
    };
  },
  async previewResource({ content, options, signal }) {
    const program = validate(() => normalizeProgram(content));
    const preview = await previewProgram(
      program,
      validate(() => computeBudget(options?.timeoutMs, defaultComputeBudget(program))),
      signal
    );
    if (preview.status === "failed") throw new ApplicationError("invalid_operation", preview.error, {});
    return preview.geometry;
  },
  exportResource({ resource, content, format, options, signal }) {
    if (["python", "step", "stl"].includes(format)) {
      const program = validate(() => normalizeProgram(content));
      if (program.engine !== "cadquery")
        throw new ApplicationError(
          "invalid_operation",
          "STEP/Python 需要 CadQuery 精确实体工程；JSCAD 的 STL 从界面导出",
          {}
        );
      const base = resource.title.replace(/\.cad\.json$/i, "");
      if (format === "python") {
        const overrides = JSON.stringify(JSON.stringify(program.parameters));
        return {
          fileName: base + ".py",
          mimeType: "text/x-python",
          body:
            program.source +
            `\n# Saved human overrides; geometry and motion use the same effective parameters.\nimport json as _atria_json\n_atria_main = main\n_atria_defs = globals().get("get_parameter_definitions", lambda: [])\n_atria_motion = globals().get("get_motion")\n_atria_saved = _atria_json.loads(${overrides})\ndef _atria_parameters(p=None):\n    defaults = {d["name"]: d.get("initial") for d in _atria_defs()}\n    return {**defaults, **_atria_saved, **(p or {})}\ndef get_parameter_definitions():\n    return [{**d, "initial": _atria_saved.get(d["name"], d.get("initial"))} for d in _atria_defs()]\ndef main(p=None):\n    return _atria_main(_atria_parameters(p))\nif callable(_atria_motion):\n    def get_motion(p=None):\n        return _atria_motion(_atria_parameters(p))\nif __name__ == "__main__":\n    result = main()\n`
        };
      }
      return withCadComputeSlot(
        () =>
          exportCadQuery(
            program,
            format as "step" | "stl",
            validate(() => computeBudget(options?.timeoutMs, defaultComputeBudget(program))),
            signal
          ),
        signal
      )
        .then((body) => ({
          fileName: base + "." + format,
          mimeType: format === "step" ? "model/step" : "model/stl",
          body
        }))
        .catch((error) => {
          throw new ApplicationError("invalid_operation", error.message, { sourceSaved: true });
        });
    }
    if (format === "png") {
      const program = isCadProgram(content) ? normalizeProgram(content) : programFromModel(content);
      const timeoutMs = validate(() => computeBudget(options?.timeoutMs, defaultComputeBudget(program)));
      return previewProgram(program, timeoutMs, signal, options?.view as CadView | undefined).then(
        (preview) => {
          if (preview.status === "failed")
            throw new ApplicationError("invalid_operation", preview.error, { sourceSaved: true });
          return {
            fileName: resource.title.replace(/\.cad\.json$/i, "") + "-views.png",
            mimeType: "image/png",
            body: Buffer.from(preview.png!, "base64")
          };
        }
      );
    }
    if (format === "jscad") {
      const program = isCadProgram(content) ? normalizeProgram(content) : programFromModel(content);
      if (program.engine !== "jscad")
        throw new ApplicationError("invalid_operation", "CadQuery 请导出 Python 源码", {});
      const parameters = program.parameters;
      const source =
        `// Saved parameters remain editable in native JSCAD.\n` +
        program.source +
        `\n{\n  const savedMain = module.exports.main;\n  const savedDefinitions = module.exports.getParameterDefinitions;\n  const savedParameters = ${JSON.stringify(parameters)};\n  module.exports.getParameterDefinitions = () => (savedDefinitions?.() || []).map(d => ({...d, initial: savedParameters[d.name] ?? d.initial}));\n  module.exports.main = (p = {}) => savedMain({...savedParameters,...p});\n}\n`;

      return {
        fileName: resource.title.replace(/\.cad\.json$/i, "") + ".jscad",
        mimeType: "text/javascript",
        body: source
      };
    }
    if (format !== "json")
      throw new ApplicationError(
        "invalid_operation",
        "CAD 参数文件仅支持 json；STL 由独立几何 Worker 导出",
        {}
      );
    return {
      fileName: resource.title.endsWith(".cad.json") ? resource.title : `${resource.title}.cad.json`,
      mimeType: "application/json",
      body: this.serialize(content)
    };
  },
  agentTools
};
