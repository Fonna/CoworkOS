import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

/** Smooth tessellated curves without merging parts or rounding their sharp boundaries. */
export function smoothSurface(geometry) {
  return toCreasedNormals(geometry, Math.PI / 6);
}
const materials = {
  aluminum: [0xb9c2ca, 0.65, 0.34],
  steel: [0x8b969f, 0.72, 0.3],
  "cast-iron": [0x686e76, 0.35, 0.7],
  brass: [0xb99957, 0.65, 0.32],
  rubber: [0x292e35, 0.02, 0.84]
};
export function surfaceAppearance(feature, mode = "engineering") {
  if (mode === "materials" && feature.material) {
    const [color, metalness, roughness] = materials[feature.material] ?? materials.steel;
    return { color: new THREE.Color(color), metalness, roughness };
  }
  const color =
    mode === "colors" && feature.color
      ? new THREE.Color().setRGB(...feature.color.slice(0, 3), THREE.SRGBColorSpace)
      : new THREE.Color(0x8996a4);
  return { color, metalness: 0.28, roughness: 0.46 };
}
