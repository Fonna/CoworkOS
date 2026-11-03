// Evaluated in QuickJS only; no functions or objects are bridged to the host.
export function runDesign(source, parameters, exportStl, limits) {
  const { modeling, stl } = globalThis.cadLibraries;
  const module = { exports: {} };
  const require = (name) => {
    if (name !== "@jscad/modeling") throw new Error(`仅支持 @jscad/modeling；不可访问 ${name}`);
    return modeling;
  };
  new Function("require", "module", "exports", source)(require, module, module.exports);
  if (typeof module.exports.main !== "function")
    throw new Error("请导出 module.exports = { main, getParameterDefinitions }");
  const definitions = module.exports.getParameterDefinitions?.() ?? [];
  if (!Array.isArray(definitions) || definitions.length > 2048)
    throw new Error("参数定义必须为数组，最多 2048 项");
  const effective = Object.fromEntries(
    definitions
      .filter((d) => d.name && d.type !== "group")
      .map((d) => [
        d.name,
        d.initial ??
          (d.type === "checkbox" ? false : d.type === "text" ? "" : d.type === "choice" ? d.values?.[0] : 0)
      ])
  );
  Object.assign(effective, parameters);
  for (const d of definitions) {
    if (!d.name || d.type === "group") continue;
    const value = effective[d.name];
    if (["float", "number", "int", "slider"].includes(d.type) && typeof value !== "number")
      throw new Error(`参数 ${d.name} 必须为数字`);
    if (d.type === "checkbox" && typeof value !== "boolean") throw new Error(`参数 ${d.name} 必须为布尔值`);
    if (d.type === "text" && typeof value !== "string") throw new Error(`参数 ${d.name} 必须为文本`);
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (typeof d.min === "number" && value < d.min) ||
        (typeof d.max === "number" && value > d.max))
    )
      throw new Error(`参数 ${d.name} 超出范围`);
    if (d.type === "int" && !Number.isInteger(value)) throw new Error(`参数 ${d.name} 必须为整数`);
    if (d.type === "choice" && !d.values?.includes(value)) throw new Error(`参数 ${d.name} 不在可选值中`);
  }
  const output = module.exports.main(effective);
  const solids = Array.isArray(output) ? output.flat(Infinity) : [output];
  if (solids.length > 1024) throw new Error("返回对象超过渲染预算，请分组或简化预览");
  let totalCoordinates = 0;
  const features = solids.map((solid, i) => {
    if (!modeling.geometries.geom3.isA(solid))
      throw new Error(`main 返回的第 ${i + 1} 项不是 JSCAD geom3 实体`);
    const positions = [];
    for (const polygon of modeling.geometries.geom3.toPolygons(solid)) {
      for (let j = 1; j < polygon.vertices.length - 1; j++) {
        totalCoordinates += 9;
        if (positions.length + 9 > limits.maxPartTriangles * 9) throw new Error("单个实体超过网格预览预算");
        if (totalCoordinates > limits.maxTotalTriangles * 9) throw new Error("模型超过网格预算");
        positions.push(...polygon.vertices[0], ...polygon.vertices[j], ...polygon.vertices[j + 1]);
      }
    }
    return { id: `solid_${i}`, name: String(solid.name || `实体 ${i + 1}`).slice(0, 80), positions };
  });
  const positions = features.flatMap((f) => f.positions);
  if (positions.length > limits.maxTotalTriangles * 9 || !positions.every(Number.isFinite))
    throw new Error("模型超过网格预算或包含无效坐标");
  const dimensions = [0, 0, 0];
  if (positions.length)
    for (let axis = 0; axis < 3; axis++) {
      let min = Infinity,
        max = -Infinity;
      for (let i = axis; i < positions.length; i += 3) {
        min = Math.min(min, positions[i]);
        max = Math.max(max, positions[i]);
      }
      dimensions[axis] = max - min;
    }
  const volume = solids.reduce((sum, solid) => sum + modeling.measurements.measureVolume(solid), 0);
  const result = { positions, features, dimensions, volume, definitions, parameters: effective };
  if (exportStl) {
    if (!positions.length) throw new Error("空模型不能导出 STL");
    const bytes = stl.serialize({ binary: true }, ...solids);
    result.stl = bytes.flatMap((part) =>
      Array.from(part instanceof ArrayBuffer ? new Uint8Array(part) : part)
    );
    if (result.stl.length > limits.maxExportBytes) throw new Error("STL 导出超过文件预算");
  }
  return JSON.stringify(result);
}
