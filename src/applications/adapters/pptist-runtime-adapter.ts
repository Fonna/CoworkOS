import { createHash } from "node:crypto";
import CryptoJS from "crypto-js";
import { ApplicationError, type WorkbenchRuntimeAdapter, type AdapterToolDefinition } from "../types.js";
import {
  PPTIST_KIND,
  PPTIST_LIMIT,
  emptyPresentation,
  normalizePresentation,
  object,
  invalid,
  outline,
  freshId
} from "../../software/pptist/model.js";
import { exportPptx } from "../../software/pptist/export.js";
import { layoutWarnings } from "../../software/pptist/layout.js";

// Agent geometry describes the usable text box. Only newly added text gets
// this default; edits and UI/imported documents retain their existing inset.
function newElement(value: unknown) {
  const el = object(value);
  return el.type === "text" && el.inset === undefined ? { ...el, inset: [0, 0, 0, 0] } : el;
}

function tools(): AdapterToolDefinition[] {
  return [
    {
      name: "pptist_read_presentation",
      access: "read",
      description:
        "首次调用必须使用 {}（省略 slideId），读取当前文稿目录 outline、页面尺寸、主题和选区。outline 每项的 page 是页码，id 是该页真实标识；再传 slideId=outline 中的 id 读取完整元素，修改前必须读取。不要用页码或猜测的 1、intro、slide-1 代替真实 ID。图片仅返回类型和大小，不返回大段 base64。",
      parameters: {
        type: "object",
        properties: {
          slideId: {
            type: "string",
            description:
              "可选。首次读取目录时省略；读取具体页时使用当前文稿 outline[].id，不能用页码或格式示例 ID。"
          }
        }
      },
      async execute({ content, resource, params, selection }) {
        const doc = normalizePresentation(content);
        const slide = params.slideId ? doc.slides.find((s) => s.id === params.slideId) : undefined;
        if (params.slideId && !slide)
          throw new ApplicationError(
            "invalid_operation",
            "找不到此幻灯片。先调用 pptist_read_presentation({}) 读取当前目录，再使用返回的 outline[].id 读取页面；不要继续猜测 ID。",
            {
              requestedSlideId: params.slideId,
              availableSlides: doc.slides.map((entry, index) => ({ id: entry.id, page: index + 1 })),
              nextAction: { tool: "pptist_read_presentation", arguments: {} }
            }
          );
        const bounded = JSON.parse(
          JSON.stringify(slide, (key, value) =>
            typeof value === "string" && value.startsWith("data:")
              ? `[内嵌媒体：${value.length} 字符；修改其他属性时保留原媒体]`
              : value
          ) || "null"
        );
        return {
          result: {
            revision: resource.revision,
            title: resource.title,
            viewportSize: doc.viewportSize,
            viewportRatio: doc.viewportRatio,
            theme: doc.theme,
            outline: outline(doc),
            layoutWarnings: layoutWarnings(doc, slide?.id),
            layoutCheck: "仅结构与保守尺寸检查，不代表已完成渲染视觉验收。",
            selection: selection?.data,
            ...(slide ? { slide: bounded } : {})
          }
        };
      }
    },
    {
      name: "pptist_edit_presentation",
      requiresFreshRead: true,
      description:
        "原子修改 PPT 演示文稿。changes 按序执行：insert_slide(index,slide)、update_slide(slideId,props)、delete_slide(slideId)、reorder_slides(ids)、upsert_element(slideId,element)、delete_element(slideId,elementId)。upsert_element 按 id 合并属性，保留未提供的媒体和人工修改。完整元素使用演示文稿 JSON，坐标以 viewportSize 为基准；文本 content 是 p/span 等富文本 HTML。可同时更新 theme、viewportRatio。先 pptist_read_presentation，冲突后重读。",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "insert_slide",
                    "update_slide",
                    "delete_slide",
                    "reorder_slides",
                    "upsert_element",
                    "delete_element"
                  ]
                },
                index: { type: "integer" },
                slideId: {
                  type: "string",
                  description: "已有页面的真实 ID，复制当前文稿读取结果中的 outline[].id。"
                },
                slide: { type: "object", additionalProperties: true },
                props: { type: "object", additionalProperties: true },
                element: { type: "object", additionalProperties: true },
                elementId: { type: "string" },
                ids: { type: "array", items: { type: "string" } }
              },
              required: ["type"]
            }
          },
          theme: { type: "object", additionalProperties: true },
          viewportRatio: { type: "number" }
        },
        required: ["changes"]
      },
      async execute({ params }) {
        return {
          result: { message: "演示文稿修改已提交" },
          operations: [{ operationType: "pptist.edit", payload: params }]
        };
      }
    },
    {
      name: "pptist_get_schema",
      access: "read",
      description:
        "获取页面和常用元素的格式、约束及新建示例。示例 ID（如 intro）只用于说明格式；查询已有页面的真实 ID 请调用 pptist_read_presentation({})。",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          result: {
            identifiers:
              "已有幻灯片使用 pptist_read_presentation({}) 返回的 outline[].id；page 是页码。以下示例中的 intro、title 等 ID 用于新建页和元素，不能当作当前文稿的已有 ID。",
            coordinates:
              "页面默认 1000 × 562.5；left/top/width/height 使用同一坐标系。字体大小使用 CSS px。id 在页内唯一。",
            supportedElements: [
              "text",
              "shape",
              "image",
              "line",
              "table",
              "chart",
              "latex",
              "video",
              "audio"
            ],
            slide: {
              id: "intro",
              elements: [],
              remark: "演讲备注",
              background: { type: "solid", color: "#ffffff" }
            },
            text: {
              id: "title",
              type: "text",
              left: 80,
              top: 80,
              width: 840,
              height: 80,
              inset: [0, 0, 0, 0],
              rotate: 0,
              content: '<p style="font-size:44px;color:#15243b"><strong>演示标题</strong></p>',
              defaultFontName: "Arial",
              defaultColor: "#15243b"
            },
            textLayout:
              "pptist_edit_presentation 新增文本默认 inset=[0,0,0,0]；既有或导入文本未指定 inset 时四边默认10px。fixedHeight 不会自动缩小字体或禁止换行。修改后重读，处理 layoutWarnings。",
            pageNumber: {
              id: "page-number",
              type: "text",
              left: 850,
              top: 510,
              width: 100,
              height: 32,
              inset: [0, 0, 0, 0],
              fixedHeight: true,
              content: '<p style="font-size:18px;text-align:right">01 / 03</p>'
            },
            shape: {
              id: "block",
              type: "shape",
              left: 80,
              top: 200,
              width: 300,
              height: 200,
              rotate: 0,
              viewBox: [200, 200],
              path: "M 0 0 L 200 0 L 200 200 L 0 200 Z",
              fill: "#5b9bd5",
              fixedRatio: false
            },
            image: {
              id: "photo",
              type: "image",
              left: 500,
              top: 180,
              width: 300,
              height: 200,
              rotate: 0,
              src: "data:image/png;base64,...",
              fixedRatio: true
            },
            line: {
              id: "arrow",
              type: "line",
              left: 80,
              top: 180,
              width: 2,
              start: [0, 0],
              end: [300, 0],
              points: ["", "arrow"],
              color: "#333333",
              style: "solid"
            },
            chart: {
              id: "chart",
              type: "chart",
              chartType: "bar",
              left: 80,
              top: 180,
              width: 500,
              height: 300,
              rotate: 0,
              data: { labels: ["甲", "乙"], legends: ["数量"], series: [[12, 20]] },
              themeColors: ["#5b9bd5"],
              textColor: "#333333",
              options: { showLegend: false, showLabel: true }
            },
            table: {
              id: "table",
              type: "table",
              left: 80,
              top: 180,
              width: 500,
              height: 160,
              rotate: 0,
              colWidths: [0.5, 0.5],
              cellMinHeight: 40,
              outline: { width: 1, color: "#999999", style: "solid" },
              data: [
                [
                  { id: "a", text: "名称", colspan: 1, rowspan: 1 },
                  { id: "b", text: "数值", colspan: 1, rowspan: 1 }
                ],
                [
                  { id: "c", text: "甲", colspan: 1, rowspan: 1 },
                  { id: "d", text: "12", colspan: 1, rowspan: 1 }
                ]
              ]
            },
            export:
              "export_resource 支持 json、pptist、pptx；编辑器还可导出图片和打印 PDF。源文件保存完整演示文稿数据，PPTX 的动画及部分视觉效果受转换能力限制。",
            limits: { slides: 200, elementsPerSlide: 500, bytes: PPTIST_LIMIT }
          }
        };
      }
    }
  ];
}

export const pptistRuntimeAdapter: WorkbenchRuntimeAdapter = {
  definition: {
    appType: "pptist",
    displayName: "PPT 演示文稿",
    version: "1",
    resourceKinds: [PPTIST_KIND],
    fileImportFormats: [
      {
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        resourceKind: PPTIST_KIND
      }
    ],
    fileExtensions: { [PPTIST_KIND]: ".pptist.json" },
    contentBytes: PPTIST_LIMIT,
    capabilities: ["view", "edit", "select", "history", "export", "agent-commands"],
    selectionSchemas: ["pptist.selection/v1"],
    operationSchemas: {
      "pptist.replace": { description: "保存完整演示文稿，保留版本历史。", required: ["document"] },
      "pptist.edit": {
        description: "原子编辑幻灯片和元素。",
        required: ["changes"],
        optional: ["theme", "viewportRatio"]
      }
    },
    exportFormats: ["json", "pptist", "pptx"],
    entryReadTool: "pptist_read_presentation",
    skillRoots: [".pi/skills/pptist"],
    creationHint: `新建演示文稿使用 ${PPTIST_KIND}，initialContent 可省略（空白第一页），或提供 {slides:[{id,elements:[]}],theme?,viewportSize?,viewportRatio?}。创建后先 pptist_read_presentation({}) 获取 outline 中的真实页 ID，再读取目标页、查看 pptist_get_schema 并编辑；格式示例 ID 不能代替已有页 ID。`
  },
  createContent({ initialContent }) {
    if (initialContent === undefined || initialContent === null || initialContent === "")
      return emptyPresentation();
    try {
      return normalizePresentation(
        typeof initialContent === "string" ? JSON.parse(initialContent) : initialContent
      );
    } catch (e) {
      if (e instanceof ApplicationError) throw e;
      invalid("演示文稿不是有效 JSON");
    }
  },
  parse(raw) {
    try {
      return normalizePresentation(JSON.parse(raw));
    } catch (e) {
      if (e instanceof ApplicationError) throw e;
      invalid("演示文稿不是有效 JSON");
    }
  },
  serialize: (content) => JSON.stringify(normalizePresentation(content)),
  async reviewContent(content) {
    return JSON.stringify(
      normalizePresentation(content),
      (key, value) =>
        typeof value === "string" && value.startsWith("data:")
          ? `[内嵌媒体：${value.length} 字符；sha256:${createHash("sha256").update(value).digest("hex")}]`
          : value,
      2
    );
  },
  applyOperation({ operationType, content, payload }) {
    const previous = normalizePresentation(content);
    const p = object(payload);
    let next = structuredClone(previous);
    if (operationType === "pptist.replace") next = normalizePresentation(p.document);
    else if (operationType === "pptist.edit") {
      if (!Array.isArray(p.changes) || p.changes.length > 200) invalid("changes 须为最多 200 项的数组");
      for (const raw of p.changes) {
        const change = object(raw);
        const index = next.slides.findIndex((s) => s.id === change.slideId);
        const slide = next.slides[index];
        if (change.type === "insert_slide") {
          const at = change.index ?? next.slides.length;
          if (typeof at !== "number" || !Number.isInteger(at) || at < 0 || at > next.slides.length)
            invalid("插入位置超出范围");
          const inserted = object(change.slide);
          next.slides.splice(at, 0, {
            ...inserted,
            id: String(inserted.id || freshId()),
            elements: Array.isArray(inserted.elements)
              ? inserted.elements.map(newElement)
              : (inserted.elements ?? [])
          } as typeof slide);
        } else if (change.type === "reorder_slides") {
          const ids = change.ids;
          if (
            !Array.isArray(ids) ||
            ids.length !== next.slides.length ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !next.slides.some((s) => s.id === id))
          )
            invalid("重排必须提供全部幻灯片 id，且不能重复");
          next.slides = ids.map((id) => next.slides.find((s) => s.id === id)!);
        } else {
          if (!slide) invalid("找不到待修改的幻灯片，请重新读取");
          if (change.type === "delete_slide") next.slides.splice(index, 1);
          else if (change.type === "update_slide") {
            const props = object(change.props);
            if (props.id && props.id !== slide.id) invalid("不能修改幻灯片 id");
            Object.assign(slide, props);
          } else if (change.type === "upsert_element") {
            const el = object(change.element);
            const at = slide.elements.findIndex((e) => e.id === el.id);
            if (at < 0) slide.elements.push(newElement(el) as (typeof slide.elements)[number]);
            else slide.elements[at] = { ...slide.elements[at], ...el };
          } else if (change.type === "delete_element") {
            const at = slide.elements.findIndex((e) => e.id === change.elementId);
            if (at < 0) invalid("找不到待删除的元素");
            slide.elements.splice(at, 1);
          } else invalid("不支持的演示文稿修改操作");
        }
      }
      if (p.theme !== undefined) next.theme = { ...next.theme, ...object(p.theme) };
      if (p.viewportRatio !== undefined) next.viewportRatio = p.viewportRatio as number;
      next = normalizePresentation(next);
    } else invalid("不支持的演示文稿操作");
    return {
      content: next,
      summary: `更新演示文稿（${next.slides.length} 页）`,
      inverse: { operationType: "pptist.replace", payload: { document: previous } }
    };
  },
  summarizeSelection({ selection, content }) {
    const doc = normalizePresentation(content),
      data = object(selection.data);
    const i = doc.slides.findIndex((s) => s.id === data.slideId);
    if (i < 0) invalid("所选幻灯片不存在");
    const ids = data.elementIds ?? [];
    if (!Array.isArray(ids) || ids.some((id) => !doc.slides[i].elements.some((e) => e.id === id)))
      invalid("所选元素不存在");
    return `第 ${i + 1} 页${ids.length ? `，选中 ${ids.length} 个元素` : ""}`;
  },
  summarizeContext({ content, selection }) {
    const doc = normalizePresentation(content);
    return {
      shape: `${doc.slides.length} 页演示文稿：${
        outline(doc)
          .map((s) => s.text)
          .filter(Boolean)
          .slice(0, 4)
          .join(" / ")
          .replace(/\s+/g, " ")
          .slice(0, 200) || "空白页面"
      }`,
      selectionSummary: selection?.summary
    };
  },
  async importResource({ body, signal }) {
    if (signal?.aborted) throw signal.reason;
    if (body.byteLength > PPTIST_LIMIT)
      throw new ApplicationError("resource_too_large", "导入文件超过 32 MiB");
    try {
      const raw = Buffer.from(body).toString("utf8").trim();
      const document = normalizePresentation(
        JSON.parse(
          raw.startsWith("{") ? raw : CryptoJS.AES.decrypt(raw, "pptist").toString(CryptoJS.enc.Utf8)
        )
      );
      return {
        result: { slides: document.slides.length },
        operations: [{ operationType: "pptist.replace", payload: { document } }]
      };
    } catch (e) {
      if (e instanceof ApplicationError) throw e;
      invalid("请导入有效的演示文稿 JSON 或源文件；PPTX 请使用编辑器的导入功能");
    }
  },
  async exportResource({ resource, content, format, signal }) {
    const doc = normalizePresentation(content);
    const stem =
      resource.title
        .replace(/[\\/\u0000-\u001f]/g, "-")
        .replace(/\.{2,}/g, ".")
        .replace(/^\.+/, "")
        .replace(/\.(pptist\.json|pptist|pptx|json)$/i, "")
        .slice(0, 90) || "演示文稿";
    const exported = {
      title: resource.title,
      width: doc.viewportSize,
      height: doc.viewportSize * doc.viewportRatio,
      theme: doc.theme,
      slides: doc.slides
    };
    if (signal?.aborted) throw signal.reason;
    if (format === "pptx")
      return {
        fileName: `${stem}.pptx`,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        body: await exportPptx(doc, resource.title, signal)
      };
    if (format === "pptist")
      return {
        fileName: `${stem}.pptist`,
        mimeType: "application/octet-stream",
        body: CryptoJS.AES.encrypt(JSON.stringify(exported), "pptist").toString()
      };
    if (format === "json")
      return {
        fileName: `${stem}.pptist.json`,
        mimeType: "application/json",
        body: JSON.stringify(exported, null, 2)
      };
    invalid("不支持此导出格式");
  },
  agentTools: tools
};
