import { parentPort, workerData } from "node:worker_threads";
import { renderViews, meshBounds } from "./program-render.js";
import { createHash } from "node:crypto";
import { validateView, geometryAtView } from "./assembly.js";
import { assessDesign } from "./design-manifest.js";

try {
  const geometry =
    workerData.geometry ??
    (await import("./program-engine.js")).evaluateProgram(workerData.program, {
      timeoutMs: workerData.timeoutMs
    });
  geometry.assessment = assessDesign(geometry);
  const view = workerData.view === undefined ? undefined : validateView(workerData.view, geometry);
  const displayed = view ? geometryAtView(geometry, view) : geometry;
  const png = renderViews(displayed);
  parentPort?.postMessage({
    status: "ready",
    geometry,
    png: png.toString("base64"),
    report: {
      ...(geometry.diagnostics ? { diagnostics: geometry.diagnostics } : {}),
      ...(geometry.tessellation ? { tessellation: geometry.tessellation } : {}),
      brep: geometry.brep,
      assessment: geometry.assessment,
      dimensions: geometry.dimensions,
      volume: geometry.volume,
      triangles: geometry.positions.length / 9,
      definitions: geometry.definitions,
      parameters: geometry.parameters,
      assembly: geometry.assembly,
      ...(geometry.motion
        ? {
            motion: {
              kind: "kinematic-keyframes",
              duration: geometry.motion.duration,
              trackCount: geometry.motion.tracks.length,
              signature: createHash("sha256").update(JSON.stringify(geometry.motion)).digest("hex"),
              tracks: geometry.motion.tracks.map((t: import("./assembly.js").MotionTrack) => ({
                path: t.path,
                type: t.type,
                keyframes: t.times.length
              }))
            }
          }
        : {}),
      ...(view
        ? {
            view: {
              options: view,
              bounds: meshBounds(displayed.positions),
              objects: displayed.features.map(
                (f: import("./program-geometry.js").ProgramGeometry["features"][number]) => ({
                  id: f.id,
                  path: f.path,
                  bounds: meshBounds(f.positions),
                  triangles: f.positions.length / 9
                })
              )
            }
          }
        : {}),
      objects: geometry.features.map(
        (feature: import("./program-geometry.js").ProgramGeometry["features"][number]) => ({
          id: feature.id,
          name: feature.name,
          ...(feature.path ? { path: feature.path } : {}),
          ...(feature.color ? { color: feature.color } : {}),
          ...(feature.material ? { material: feature.material } : {}),
          ...(feature.brep ? { brep: feature.brep } : {}),
          bounds: feature.bounds ?? meshBounds(feature.positions),
          triangles: feature.positions.length / 9
        })
      )
    }
  });
} catch (error) {
  parentPort?.postMessage({
    status: "failed",
    error: error instanceof Error ? error.message : "CAD 预览失败"
  });
}
