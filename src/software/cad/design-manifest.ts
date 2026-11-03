import { z } from "zod";
import type { ProgramGeometry } from "./program-geometry.js";
import { withinPath } from "./assembly.js";

const text = z.string().trim().min(1).max(240);
const path = z.string().min(2).max(512).startsWith("/");
const manifest = z
  .object({
    intent: z.enum(["concept", "kinematic-demo", "engineering"]),
    components: z
      .array(
        z
          .object({
            label: text,
            paths: z.array(path).min(1).max(256),
            minimumCount: z.number().int().min(1).max(1024).default(1),
            material: z.enum(["aluminum", "steel", "cast-iron", "brass", "rubber"]).optional()
          })
          .strict()
      )
      .max(128),
    checks: z
      .array(
        z
          .object({
            label: text,
            status: z.enum(["passed", "failed", "not_checked"]),
            evidence: z.string().max(1000).optional()
          })
          .strict()
          .refine((check) => check.status !== "passed" || !!check.evidence?.trim(), {
            message: "passed 检查须提供计算依据 evidence",
            path: ["evidence"]
          })
      )
      .max(128)
      .default([]),
    limitations: z.array(text).max(128).default([])
  })
  .strict();
export type DesignManifest = z.infer<typeof manifest>;
export type CadMaterial = NonNullable<DesignManifest["components"][number]["material"]>;
export function validateDesignManifest(value: unknown): DesignManifest {
  const parsed = manifest.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `无效设计验收清单 get_design_manifest: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`
    );
  return parsed.data;
}

/** Presence is computed from real meshes. Engineering checks remain explicitly source-reported. */
export function assessDesign(geometry: ProgramGeometry) {
  const design = geometry.design;
  const components = (design?.components ?? []).map((component) => {
    const found = geometry.features.filter(
      (f) => f.positions.length >= 9 && component.paths.some((p) => f.path && withinPath(f.path, p))
    );
    return {
      ...component,
      actualCount: found.length,
      status: found.length >= component.minimumCount ? "present" : "missing"
    };
  });
  const warnings: string[] = [];
  if (!components.length) warnings.push("未声明部件验收清单；不能确认设计完整度");
  for (const component of components)
    if (component.status === "missing")
      warnings.push(
        `${component.label}：需要 ${component.minimumCount} 个实体，实际 ${component.actualCount} 个`
      );
  for (const check of design?.checks ?? [])
    if (check.status !== "passed")
      warnings.push(`${check.label}：${check.status === "failed" ? "源码报告失败" : "尚未验证"}`);
  const loopDiscontinuities = (geometry.motion?.tracks ?? [])
    .filter((track) => {
      if (track.type === "rotation") {
        const values = track.values as number[];
        const delta = (values.at(-1)! - values[0]) % 360;
        return Math.min(Math.abs(delta), Math.abs(delta + 360), Math.abs(delta - 360)) > 1e-5;
      }
      const values = track.values as number[][];
      return values[0].some((v, i) => Math.abs(v - values.at(-1)![i]) > 1e-5);
    })
    .map((track) => track.path);
  if (loopDiscontinuities.length) warnings.push(`运动循环首尾姿态不闭合：${loopDiscontinuities.join("、")}`);
  return {
    geometry: geometry.brep?.valid ? "brep_valid" : "mesh_only",
    completeness: !components.length
      ? "not_declared"
      : components.some((c) => c.status === "missing")
        ? "missing_components"
        : "declared_components_present",
    components,
    sourceChecks: design?.checks ?? [],
    limitations: design?.limitations ?? [],
    loopDiscontinuities,
    warnings,
    note: "部件数量和循环闭合由 harness 检查；数量满足不代表结构正确。checks 是源码声明，未独立复核。几何有效不代表无干涉、动力学或可制造性已验证。"
  };
}
export type DesignAssessment = ReturnType<typeof assessDesign>;

export const designReference = {
  module: "Design",
  contract: "atria-cad-design/v1",
  entryPoint:
    "可选 def get_design_manifest(p)，在 main(p) 后调用，返回 JSON 对象。使用同一有效参数；仅 CadQuery 支持。",
  fields: {
    intent: "concept / kinematic-demo / engineering；表达用途，不是认证等级。",
    components:
      "部件要求列表 {label,paths:[完整装配路径],minimumCount:至少实体数(默认1),material?:aluminum|steel|cast-iron|brass|rubber}。包含路径的所有子孙实体，重复路径只计一次。最多128项。先定义用户需要的结构，不能按已生成零件反推一个必定通过的清单。",
    checks:
      "{label,status:passed|failed|not_checked,evidence?:计算方法和数值}，最多128项。passed 必须有真实计算依据；格式/BRep 通过不能代替运动学、干涉和装配验证。用 assert 阻止严重错误提交。",
    limitations: "字符串数组，明确省略的零件、剖开/简化的结构及未验证能力；最多128项。"
  },
  feedback:
    "cad_run_program/cad_preview 返回 assessment：真实部件数量、缺失部件、运动循环闭合、源码声明检查及限制。没有清单时 completeness=not_declared。缺件/未验证不等于计算失败，也不自动判定设计完成。",
  materials:
    "显示材质仅用于查看器，工程灰模式统一颜色，零件色模式保留原颜色，材质模式使用声明的外观；不代表采购材料、物理参数或 STEP 材料属性。",
  example: `def get_design_manifest(p):\n    return {"intent":"kinematic-demo",\n      "components":[{"label":"四组活塞","paths":["/engine/pistons"],"minimumCount":4,"material":"aluminum"},\n                    {"label":"曲轴","paths":["/engine/crank"],"material":"steel"}],\n      "checks":[{"label":"全周期干涉","status":"not_checked"}],\n      "limitations":["剖开缸体供观察；尚未验证制造公差"]}`
};
