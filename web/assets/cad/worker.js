import { isCadProgram, computeBudget, defaultComputeBudget } from "../../../src/software/cad/program.ts";
import serializer from "@jscad/stl-serializer";
import {
  buildGeometry,
  geometryMesh,
  inspectGeometry,
  partGeometry
} from "../../../src/software/cad/geometry.ts";
import { normalizeModel } from "../../../src/software/cad/model.ts";
import { assessDesign } from "../../../src/software/cad/design-manifest.ts";
self.onmessage = async ({ data }) => {
  try {
    if (isCadProgram(data.model)) {
      const { evaluateProgram } = await import("../../../src/software/cad/program-engine.ts");
      const timeoutMs = computeBudget(data.timeoutMs, defaultComputeBudget(data.model));
      const result = evaluateProgram(data.model, { exportStl: data.type === "stl", timeoutMs });
      result.assessment = assessDesign(result);
      if (data.type === "stl")
        self.postMessage({
          id: data.id,
          blob: new Blob([new Uint8Array(result.stl)], { type: "model/stl" })
        });
      else {
        result.positions = new Float32Array(result.positions);
        for (const feature of result.features) feature.positions = new Float32Array(feature.positions);
        self.postMessage({ id: data.id, ...result }, [
          result.positions.buffer,
          ...result.features.map((f) => f.positions.buffer)
        ]);
      }
      return;
    }
    const model = normalizeModel(data.model);
    const solid = buildGeometry(model);
    if (data.type === "stl") {
      if (!solid || !geometryMesh(solid).length) throw new Error("空模型无法导出 STL");
      const bytes = new Blob(serializer.serialize({ binary: true }, solid), { type: "model/stl" });
      self.postMessage({ id: data.id, blob: bytes });
      return;
    }
    const positions = geometryMesh(solid);
    const features = model.parts.map((part) => ({
      id: part.id,
      positions: geometryMesh(partGeometry(part))
    }));
    self.postMessage({ id: data.id, positions, features, ...inspectGeometry(solid) }, [
      positions.buffer,
      ...features.map((feature) => feature.positions.buffer)
    ]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || "几何计算失败" });
  }
};
