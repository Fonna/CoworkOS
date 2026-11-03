import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGalaxyParticles,
  galaxyCamera,
  orbitalPoint,
  projectGalaxyPoint
} from "../web/assets/galaxy-space.js";
import { createOrbitLayout } from "../web/assets/agent-room.js";

test("the galaxy is a stable finite 3D volume with silver central emission", () => {
  const particles = createGalaxyParticles();
  assert.deepEqual(particles, createGalaxyParticles());
  assert.ok(particles.length > 6000 && particles.length < 8000);
  assert.ok(particles.every((p) => [p.x, p.y, p.z, p.alpha, p.size, ...p.color].every(Number.isFinite)));
  assert.ok(particles.some((p) => p.z > 0.15) && particles.some((p) => p.z < -0.15));
  const core = particles[0];
  assert.deepEqual([core.x, core.y, core.z], [0, 0, 0]);
  assert.ok(core.color.every((channel) => channel > 0.6));
  assert.ok(Math.max(...core.color) - Math.min(...core.color) < 0.15);
});

test("perspective keeps CoworkOS centred while near and far stars have different apparent size", () => {
  for (const [w, h] of [
    [300, 350],
    [395, 350],
    [480, 350]
  ]) {
    const camera = galaxyCamera(w, h);
    const origin = projectGalaxyPoint({ x: 0, y: 0, z: 0 }, camera);
    assert.deepEqual([origin.x, origin.y], [w / 2, h * 0.48]);
    const near = projectGalaxyPoint({ x: 0.7, y: 0.6, z: 0.1 }, camera);
    const far = projectGalaxyPoint({ x: 0.7, y: -0.6, z: -0.1 }, camera);
    assert.ok(near.zoom > far.zoom);
    const rotated = projectGalaxyPoint({ x: 0.7, y: 0.6, z: 0.1 }, galaxyCamera(w, h, 1.1, 0.8));
    assert.notEqual(rotated.x, near.x);
    assert.notEqual(rotated.y, near.y);
  }
});

test("all member orbits remain finite and selectable across responsive views and camera tilts", () => {
  const orbits = createOrbitLayout()(
    Array.from({ length: 30 }, (_, i) => ({ agentId: `subagent_${i + 1}` }))
  );
  for (const width of [300, 395, 480])
    for (const tilt of [-1.18, 0.57, 1.18])
      for (const orbit of orbits) {
        const camera = galaxyCamera(width, 350, tilt);
        for (let angle = 0; angle < Math.PI * 2; angle += 0.15) {
          const p = projectGalaxyPoint(orbitalPoint(orbit, angle), camera);
          assert.ok([p.x, p.y, p.zoom].every(Number.isFinite));
          assert.ok(p.x > 10 && p.x < width - 10 && p.y > 15 && p.y < 330);
        }
      }
});
