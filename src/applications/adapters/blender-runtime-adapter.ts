import { ApplicationError, type AdapterToolDefinition, type WorkbenchRuntimeAdapter } from "../types.js";
import {
  BLENDER_APP,
  BLENDER_KIND,
  BLENDER_LIMITS,
  document,
  emptyDocument,
  invalid,
  parameters,
  record,
  scenePage,
  type BlenderDocument
} from "../../software/blender/model.js";
import { BlenderProjectProvider } from "../../software/blender/project-provider.js";
import { blenderStatus, runBlender } from "../../software/blender/engine.js";
import { BLENDER_COMPUTE_LIMITS } from "../../software/blender/compute-limits.js";

const parameterSchema = {
  type: "object",
  description: "JSON 参数，支持嵌套对象/数组/null；顶层字段显式覆盖，不做深层合并。最多 8 层、64000 字符。",
  additionalProperties: true
};
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});
const budget = { type: "integer", minimum: 1, maximum: BLENDER_COMPUTE_LIMITS.maxTimeoutSeconds };

export function createBlenderRuntimeAdapter(workspaceRoot: string): WorkbenchRuntimeAdapter {
  const provider = new BlenderProjectProvider(workspaceRoot);
  const image = async (doc: BlenderDocument) => [
    { mimeType: "image/png" as const, data: (await provider.bytes(doc, "render.png")).toString("base64") }
  ];
  const tools = (): AdapterToolDefinition[] => [
    {
      name: "blender_read_scene",
      access: "read",
      description:
        "读取绑定 Blender 工程、版本、稳定对象 ID 与运行预算。默认返回前 100 对象，可按 ID、名称子串、类型过滤及分页；nextOffset=null 表示读完。triangles/bounds 是全场景统计。复杂节点、骨骼等详情使用 blender_query。位置是场景单位、旋转是度，变换相对父级。",
      parameters: schema({
        ids: { type: "array", items: { type: "string" }, maxItems: 1000 },
        name: { type: "string", maxLength: 256 },
        type: { type: "string", maxLength: 256 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        includeSource: { type: "boolean", description: "默认 true；不需要源码时设 false。" }
      }),
      async execute({ content, resource, selection, params }) {
        const doc = document(content),
          report = scenePage(await provider.inspect(doc), params);
        const { source, ...metadata } = doc;
        return {
          result: {
            interfaceVersion: 2,
            revision: resource.revision,
            document: params.includeSource === false ? metadata : { ...metadata, source },
            scene: report,
            selection,
            runtime: await blenderStatus(),
            limits: {
              ...BLENDER_LIMITS,
              timeoutSeconds: BLENDER_COMPUTE_LIMITS.maxTimeoutSeconds,
              compute: BLENDER_COMPUTE_LIMITS,
              renderDimension: 2048,
              renderSamples: 128
            },
            workflow:
              "先读取。Python 默认在现有场景上执行，按名称或稳定 ID 定位对象以保留人工修改；仅确需重建整个场景时使用 resetScene。"
          }
        };
      }
    },
    {
      name: "blender_run_python",
      requiresFreshRead: true,
      description:
        "在独立候选工程中运行完整 bpy Python，成功后原子提交一次版本。可定义 main(p)。默认保留场景，resetScene=true 才清空。默认保存运行源码；临时修补用 saveSource=false，保留原建模草稿。省略 source 使用已保存草稿；parameters 仅覆盖显式顶层字段。失败、取消、空网格或版本冲突不覆盖工程。不要修改 atria_id。",
      parameters: schema({
        source: { type: "string", minLength: 1, maxLength: 256000 },
        parameters: parameterSchema,
        resetScene: { type: "boolean" },
        saveSource: {
          type: "boolean",
          description: "默认 true；false 仅执行本次 source，不替换保存的建模源码。"
        },
        timeoutSeconds: budget
      }),
      async execute({ content, params, signal }) {
        if (params.saveSource !== undefined && typeof params.saveSource !== "boolean")
          throw invalid("saveSource 需要布尔值");
        const old = document(content),
          next = document({
            ...old,
            source: params.saveSource === false ? old.source : (params.source ?? old.source),
            parameters: { ...old.parameters, ...parameters(params.parameters) }
          });
        const candidate = await provider.prepare(
          next,
          "blender.python",
          { source: params.source, resetScene: params.resetScene, timeoutSeconds: params.timeoutSeconds },
          signal
        );
        return {
          result: {
            interfaceVersion: 2,
            status: "ready",
            scene: scenePage(candidate.scene, {}),
            snapshot: candidate.document.snapshot
          },
          operations: [
            { operationType: "blender.snapshot.commit", payload: { document: candidate.document } }
          ],
          images: await image(candidate.document)
        };
      }
    },
    {
      name: "blender_apply_operations",
      requiresFreshRead: true,
      description:
        "按稳定对象 ID 原子修改一个或多个对象的局部位置、旋转（度）、缩放、名称及基础 Principled 材质。保留其他对象和人工修改。先 blender_read_scene 获取 ID；复杂节点材质使用 Python。",
      parameters: schema(
        {
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: schema(
              {
                id: { type: "string" },
                name: { type: "string" },
                position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                color: {
                  type: "array",
                  items: { type: "number", minimum: 0, maximum: 1 },
                  minItems: 4,
                  maxItems: 4
                },
                metallic: { type: "number", minimum: 0, maximum: 1 },
                roughness: { type: "number", minimum: 0, maximum: 1 }
              },
              ["id"]
            )
          },
          timeoutSeconds: budget
        },
        ["edits"]
      ),
      async execute({ content, params, signal }) {
        const candidate = await provider.prepare(document(content), "blender.edit", params, signal);
        return {
          result: {
            interfaceVersion: 2,
            status: "ready",
            scene: scenePage(candidate.scene, {}),
            snapshot: candidate.document.snapshot
          },
          operations: [
            { operationType: "blender.snapshot.commit", payload: { document: candidate.document } }
          ],
          images: await image(candidate.document)
        };
      }
    },
    {
      name: "blender_preview",
      access: "read",
      description: "读取当前已保存场景的快速渲染图和几何诊断，不运行草稿、不创建新版本。",
      parameters: schema(),
      async execute({ content, resource }) {
        const doc = document(content);
        return {
          result: {
            interfaceVersion: 2,
            revision: resource.revision,
            snapshot: doc.snapshot,
            scene: scenePage(await provider.inspect(doc), {})
          },
          ...(doc.snapshot ? { images: await image(doc) } : {})
        };
      }
    },
    {
      name: "blender_render",
      access: "read",
      description:
        "渲染已保存工程的指定相机（稳定 ID 或名称）和帧，返回 CPU Cycles PNG。支持矩形画幅和降噪；省略相机/帧使用保存状态，无相机时自动构图。所有覆盖仅本次生效，不修改工程。下载使用 export_resource png，接受同样选项。",
      parameters: schema({
        resolution: { type: "integer", minimum: 64, maximum: 2048 },
        width: { type: "integer", minimum: 64, maximum: 2048 },
        height: { type: "integer", minimum: 64, maximum: 2048 },
        camera: { type: "string", minLength: 1, maxLength: 256 },
        frame: { type: "integer", minimum: -1048574, maximum: 1048574 },
        denoise: { type: "boolean" },
        samples: { type: "integer", minimum: 1, maximum: 128 },
        timeoutSeconds: budget
      }),
      async execute({ content, resource, params, signal }) {
        const body = await provider.render(document(content), params, signal);
        return {
          result: {
            status: "ready",
            revision: resource.revision,
            snapshot: document(content).snapshot,
            format: "png",
            sizeBytes: body.length
          },
          images: [{ mimeType: "image/png", data: body.toString("base64") }]
        };
      }
    },
    {
      name: "blender_get_api_reference",
      access: "read",
      description: "查询实际 Blender 运行时的 bpy、bmesh 或 mathutils 成员与文档，减少 API 猜测。",
      parameters: schema({
        module: { type: "string", enum: ["bpy", "bpy.data", "bpy.ops", "bpy.types", "bmesh", "mathutils"] },
        member: { type: "string", maxLength: 128 }
      }),
      async execute({ params, signal }) {
        return {
          result: await runBlender(
            { ...params, operation: "api" },
            20000,
            async (_directory, result) => result,
            signal
          )
        };
      }
    },
    {
      name: "blender_query",
      access: "read",
      description:
        "在已保存原生场景的隔离副本中执行 bpy 查询；main(p) 返回 JSON（或设置全局 result）。用来检查材质/节点/集合/修改器/动画/骨骼等任意原生数据。返回 value 和 print 诊断，最多 64000 字符。副本中即使发生修改也全部丢弃，不更新版本、参数或源码；不能代替修改前 blender_read_scene。",
      parameters: schema(
        {
          source: { type: "string", minLength: 1, maxLength: 256000 },
          parameters: parameterSchema,
          timeoutSeconds: budget
        },
        ["source"]
      ),
      async execute({ content, resource, params, signal }) {
        const doc = document(content);
        return {
          result: {
            revision: resource.revision,
            snapshot: doc.snapshot,
            ...(await provider.query(doc, params, signal))
          }
        };
      }
    }
  ];
  return {
    definition: {
      appType: BLENDER_APP,
      displayName: "Blender",
      version: "2",
      resourceKinds: [BLENDER_KIND],
      fileExtensions: { [BLENDER_KIND]: ".blender.json" },
      capabilities: ["view", "edit", "select", "history", "export", "agent-commands"],
      selectionSchemas: ["blender.object/v1"],
      exportFormats: ["blend", "glb", "png", "python"],
      creationHint:
        "Blender 新建格式 project/atria-blender+json；默认空工程。initialContent 可包含 source 和 parameters，创建只保存草稿，随后 blender_read_scene → blender_run_python 生成真实场景。",
      entryReadTool: "blender_read_scene",
      skillRoots: [".pi/skills/blender"],
      operationSchemas: {
        "blender.document.edit": { description: "保存源码和参数草稿，保留当前场景", required: [] },
        "blender.snapshot.commit": { description: "提交已验证的 Blender 工程快照", required: ["document"] },
        "blender.document.restore": { description: "恢复同一工程的历史版本", required: ["document"] }
      }
    },
    createContent: ({ initialContent }) => emptyDocument(initialContent),
    serialize: (content) => JSON.stringify(document(content), null, 2) + "\n",
    parse(raw) {
      try {
        return document(JSON.parse(raw));
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw invalid("Blender 工程清单不是合法 JSON");
      }
    },
    applyOperation({ operationType, payload, content }) {
      const old = document(content),
        input = record(payload);
      const next =
        operationType === "blender.document.edit"
          ? document({
              ...old,
              source: input.source ?? old.source,
              parameters: { ...old.parameters, ...parameters(input.parameters) }
            })
          : document(input.document);
      if (next.projectId !== old.projectId) throw invalid("不能更换已有工程身份");
      return {
        content: next,
        summary:
          operationType === "blender.document.edit"
            ? "保存 Blender 建模草稿"
            : operationType === "blender.document.restore"
              ? "恢复 Blender 工程版本"
              : "更新 Blender 场景",
        inverse: { operationType: "blender.document.restore", payload: { document: old } }
      };
    },
    async reviewContent(content) {
      const doc = document(content);
      const report = await provider.inspect(doc);
      const objects = [...report.objects].sort((a, b) => a.id.localeCompare(b.id));
      return [
        `相机：${report.camera || "无"}`,
        `对象：${objects.length} · 三角面：${report.triangles}`,
        `参数：${JSON.stringify(doc.parameters)}`,
        "",
        ...objects.map(
          (object) =>
            `${object.name} (${object.type})\n${JSON.stringify({ position: object.position, rotation: object.rotation, scale: object.scale, color: object.color, metallic: object.metallic, roughness: object.roughness, triangles: object.triangles })}`
        ),
        "",
        "Python 代码：",
        doc.source
      ].join("\n");
    },
    async validateOperation({ operationType, payload, content, signal }) {
      if (operationType === "blender.document.edit") return;
      const next = document(record(payload).document),
        old = document(content);
      if (next.projectId !== old.projectId) throw invalid("不能更换已有工程身份");
      if (operationType === "blender.snapshot.commit" && !next.snapshot)
        throw invalid("提交需要真实场景快照");
      await provider.verify(next);
      signal?.throwIfAborted();
    },
    summarizeSelection({ selection }) {
      const input = record(selection.data);
      return input.id === null
        ? "未选择对象"
        : `选中 Blender 对象 ${tokenForSelection(input.id)}${typeof input.name === "string" ? `（${input.name.slice(0, 128)}）` : ""}`;
    },
    summarizeContext({ content, selection }) {
      const doc = document(content);
      return {
        shape: doc.snapshot
          ? "Blender 三维工程，完整场景和依赖保存在原生快照"
          : "Blender 空工程，尚未生成场景",
        selectionSummary: selection?.summary
      };
    },
    async previewResource({ content, savedContent }) {
      const doc = document(content);
      if (savedContent && doc.projectId !== document(savedContent).projectId)
        throw invalid("预览工程身份不一致");
      return {
        scene: await provider.inspect(doc),
        snapshot: doc.snapshot,
        runtime: await blenderStatus(),
        computeLimits: BLENDER_COMPUTE_LIMITS
      };
    },
    async readAttachment({ content, name }) {
      const formats = { "preview.glb": "model/gltf-binary", "render.png": "image/png" } as const;
      if (!(name in formats)) throw invalid("不支持此 Blender 附件");
      const key = name as keyof typeof formats;
      return { fileName: key, mimeType: formats[key], body: await provider.bytes(document(content), key) };
    },
    async importResource({ content, body, signal }) {
      const candidate = await provider.prepare(document(content), "blender.import", { body }, signal);
      return {
        result: { status: "ready", scene: candidate.scene },
        operations: [{ operationType: "blender.snapshot.commit", payload: { document: candidate.document } }]
      };
    },
    async exportResource({ resource, content, format, options, signal }) {
      const doc = document(content),
        title =
          resource.title
            .replace(/\.blender\.json$/i, "")
            .replace(/[\\/]/g, "-")
            .slice(0, 100) || "场景";
      if (format === "python")
        return { fileName: `${title}.py`, mimeType: "text/x-python", body: doc.source };
      if (format === "png")
        return {
          fileName: `${title}.png`,
          mimeType: "image/png",
          body: await provider.render(doc, options, signal)
        };
      if (format === "blend" || format === "glb")
        return {
          fileName: `${title}.${format}`,
          mimeType: format === "blend" ? "application/x-blender" : "model/gltf-binary",
          body: await provider.bytes(doc, format === "blend" ? "scene.blend" : "preview.glb")
        };
      throw invalid("Blender 不支持此导出格式");
    },
    agentTools: tools
  };
}
function tokenForSelection(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw invalid("无效对象选区");
  return value;
}
