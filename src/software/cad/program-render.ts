import { deflateSync } from "node:zlib";
import type { ProgramGeometry } from "./program-engine.js";
type Vec = number[];
const dot = (a: Vec, b: Vec) => a.reduce((n, v, i) => n + v * b[i], 0);
const cross = (a: Vec, b: Vec) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const unit = (a: Vec) => {
  const length = Math.hypot(...a);
  return a.map((v) => v / (length || 1));
};
export function meshBounds(positions: ArrayLike<number>): number[][] {
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    low[axis] = Math.min(low[axis], positions[i]);
    high[axis] = Math.max(high[axis], positions[i]);
  }
  return positions.length
    ? [low, high]
    : [
        [0, 0, 0],
        [0, 0, 0]
      ];
}
const font: Record<string, string> = {
  I: "111,010,010,010,111",
  S: "111,100,111,001,111",
  O: "111,101,101,101,111",
  F: "111,100,110,100,100",
  R: "110,101,110,101,101",
  N: "101,111,111,111,101",
  T: "111,010,010,010,010",
  G: "111,100,101,101,111",
  H: "101,101,111,101,101",
  P: "110,101,110,100,100",
  X: "101,101,010,101,101",
  Y: "101,101,010,010,010",
  Z: "111,001,010,100,111"
};
/** CPU rasterization of actual triangles: deterministic four views, no browser/DOM or user code. */
export function renderViews(geometry: ProgramGeometry): Buffer {
  const size = 768,
    tile = size / 2,
    pixels = Buffer.alloc(size * size * 3),
    depth = new Float64Array(size * size).fill(-Infinity);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = 27;
    pixels[i + 1] = 30;
    pixels[i + 2] = 36;
  }
  const put = (x: number, y: number, color: Vec) => {
    const at = (y * size + x) * 3;
    for (let i = 0; i < 3; i++) pixels[at + i] = color[i];
  };
  const label = (text: string, x: number, y: number) => {
    for (const c of text) {
      const rows = (font[c] || "000,000,000,000,000").split(",");
      rows.forEach((row, j) =>
        [...row].forEach((v, i) => {
          if (v === "1")
            for (let a = 0; a < 2; a++)
              for (let b = 0; b < 2; b++) put(x + i * 2 + a, y + j * 2 + b, [190, 198, 212]);
        })
      );
      x += 8;
    }
  };
  const views = [
    { name: "ISO", eye: [1, -1, 0.8], up: [0, 0, 1] },
    { name: "FRONT", eye: [0, -1, 0], up: [0, 0, 1] },
    { name: "RIGHT", eye: [1, 0, 0], up: [0, 0, 1] },
    { name: "TOP", eye: [0, 0, 1], up: [0, 1, 0] }
  ];
  const bounds = meshBounds(geometry.positions),
    center = bounds[0].map((v, i) => (v + bounds[1][i]) / 2);
  const colors = [
    [157, 171, 194],
    [126, 157, 175],
    [180, 166, 147],
    [151, 161, 151]
  ];
  for (let view = 0; view < views.length; view++) {
    const { name, eye, up } = views[view],
      forward = unit(eye),
      right = unit(cross(up, forward)),
      vertical = cross(forward, right);
    const offsetX = (view % 2) * tile,
      offsetY = Math.floor(view / 2) * tile;
    const project = (v: Vec) => {
      const p = v.map((n, i) => n - center[i]);
      return [dot(p, right), dot(p, vertical), dot(p, forward)];
    };
    let lowX = Infinity,
      highX = -Infinity,
      lowY = Infinity,
      highY = -Infinity;
    for (let i = 0; i < geometry.positions.length; i += 3) {
      const p = project(geometry.positions.slice(i, i + 3));
      lowX = Math.min(lowX, p[0]);
      highX = Math.max(highX, p[0]);
      lowY = Math.min(lowY, p[1]);
      highY = Math.max(highY, p[1]);
    }
    const scale = (tile - 64) / Math.max(highX - lowX, highY - lowY, 1e-6);
    const midX = (lowX + highX) / 2,
      midY = (lowY + highY) / 2;
    const light = unit([0.5, -0.7, 1]);
    for (let f = 0; f < geometry.features.length; f++) {
      const positions = geometry.features[f].positions,
        color = geometry.features[f].color?.slice(0, 3).map((n) => n * 255) ?? colors[f % colors.length];
      for (let i = 0; i < positions.length; i += 9) {
        const raw = [positions.slice(i, i + 3), positions.slice(i + 3, i + 6), positions.slice(i + 6, i + 9)];
        const projected = raw
          .map(project)
          .map((v) => [
            offsetX + tile / 2 + (v[0] - midX) * scale,
            offsetY + tile / 2 - (v[1] - midY) * scale,
            v[2]
          ]);
        const [a, b, c] = projected,
          area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(area) < 1e-8) continue;
        const normal = unit(
          cross(
            raw[1].map((n, j) => n - raw[0][j]),
            raw[2].map((n, j) => n - raw[0][j])
          )
        );
        const shade = 0.45 + 0.55 * Math.abs(dot(normal, light)),
          shaded = color.map((n) => Math.round(n * shade));
        const minX = Math.max(offsetX + 1, Math.floor(Math.min(a[0], b[0], c[0]))),
          maxX = Math.min(offsetX + tile - 2, Math.ceil(Math.max(a[0], b[0], c[0])));
        const minY = Math.max(offsetY + 20, Math.floor(Math.min(a[1], b[1], c[1]))),
          maxY = Math.min(offsetY + tile - 2, Math.ceil(Math.max(a[1], b[1], c[1])));
        for (let y = minY; y <= maxY; y++)
          for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5,
              py = y + 0.5;
            const u = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
            const v = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area,
              w = 1 - u - v;
            if (u < 0 || v < 0 || w < 0) continue;
            const z = u * a[2] + v * b[2] + w * c[2],
              index = y * size + x;
            if (z > depth[index]) {
              depth[index] = z;
              put(x, y, shaded);
            }
          }
      }
    }
    label(name, offsetX + 16, offsetY + 12);
  }
  for (let p = 0; p < size; p++) {
    put(tile, p, [64, 70, 82]);
    put(p, tile, [64, 70, 82]);
  }
  return encodePng(pixels, size);
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function encodePng(pixels: Buffer, size: number): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
