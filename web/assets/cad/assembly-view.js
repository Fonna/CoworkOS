import * as THREE from "three";
import { smoothSurface, surfaceAppearance } from "./surface-rendering.js";
import {
  explosionOffsets,
  inverseRigid,
  motionMatrices,
  worldMatrices,
  withinPath
} from "../../../src/software/cad/assembly.ts";

/** Independent meshes share immutable rest geometry; playback only changes rigid transforms. */
export function createAssemblyView(scene, renderer, host, draw, onTime) {
  const root = new THREE.Group(),
    nodes = new Map(),
    parts = new Map();
  scene.add(root);
  let model,
    offsets,
    selected,
    style = "solid",
    appearance = "engineering",
    explode = 0,
    explodeMode = "parts",
    sections = [],
    time = 0,
    playing = false,
    speed = 1,
    frame,
    previous;
  const hidden = new Set();
  let isolated, focused;
  const matches = (feature, key) =>
    key?.startsWith("assembly:") ? withinPath(feature.path, key.slice(9)) : feature.id === key;
  function clear() {
    for (const { mesh, edges } of parts.values()) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      edges.geometry.dispose();
      edges.material.dispose();
    }
    root.clear();
    nodes.clear();
    parts.clear();
  }
  function update(geometry) {
    const hiddenPaths = new Set([...hidden].map((id) => parts.get(id)?.feature.path ?? id));
    const stableKey = (key) => (key?.startsWith("assembly:") ? key : (parts.get(key)?.feature.path ?? key));
    const isolatedPath = stableKey(isolated),
      focusedPath = stableKey(focused);
    pause();
    clear();
    model = geometry;
    time = 0;
    offsets = explosionOffsets(geometry, explodeMode);
    const rest = worldMatrices(geometry.assembly ?? []);
    for (const node of geometry.assembly ?? []) {
      const motion = new THREE.Group(),
        placement = new THREE.Group();
      placement.matrix.fromArray(node.transform);
      placement.matrixAutoUpdate = false;
      motion.add(placement);
      (node.parent ? nodes.get(node.parent).placement : root).add(motion);
      nodes.set(node.path, { motion, placement });
    }
    hidden.clear();
    for (const f of geometry.features) if (hiddenPaths.has(f.path ?? f.id)) hidden.add(f.id);
    const resolve = (key) =>
      key?.startsWith("assembly:")
        ? geometry.assembly?.some((n) => n.path === key.slice(9))
          ? key
          : undefined
        : geometry.features.find((f) => (f.path ?? f.id) === key)?.id;
    isolated = resolve(isolatedPath);
    focused = resolve(focusedPath);
    for (const feature of geometry.features) {
      const group = new THREE.Group(),
        data = new THREE.BufferGeometry();
      // Local assembly transforms need their own buffer; unplaced parts can reuse
      // the kernel's immutable Float32 coordinates without copying the full mesh.
      const positions =
        feature.positions instanceof Float32Array && !feature.path
          ? feature.positions
          : new Float32Array(feature.positions);
      data.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      if (feature.path)
        data.applyMatrix4(new THREE.Matrix4().fromArray(inverseRigid(rest.get(feature.path))));
      smoothSurface(data);
      data.computeBoundingBox();
      const mesh = new THREE.Mesh(
        data,
        new THREE.MeshStandardMaterial({ ...surfaceAppearance(feature, appearance), side: THREE.DoubleSide })
      );
      mesh.userData.id = feature.id;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(data, 25),
        new THREE.LineBasicMaterial({ color: 0x293541, transparent: true, opacity: 0.5 })
      );
      group.add(mesh, edges);
      (feature.path ? nodes.get(feature.path).placement : root).add(group);
      parts.set(feature.id, { feature, group, mesh, edges });
    }
    apply();
    onTime?.({ time, playing, duration: model.motion?.duration ?? 0 });
  }
  function apply() {
    if (!model) return;
    const deltas = motionMatrices(model.motion, time);
    for (const [path, { motion }] of nodes) {
      motion.matrix.fromArray(deltas.get(path) ?? new THREE.Matrix4().elements);
      motion.matrixAutoUpdate = false;
    }
    root.updateMatrixWorld(true);
    const planes = sections.map(
      (section) =>
        new THREE.Plane(
          new THREE.Vector3(
            ...[0, 1, 2].map((a) => (a === "xyz".indexOf(section.axis) ? (section.inverted ? 1 : -1) : 0))
          ),
          section.inverted ? -section.offset : section.offset
        )
    );
    renderer.localClippingEnabled = !!planes.length;
    for (const [id, part] of parts) {
      const { feature, group, mesh, edges } = part;
      group.position.set(0, 0, 0);
      const direction = new THREE.Vector3(...offsets.get(id)).multiplyScalar(explode);
      // Explode along world axes even under a rotated or animated parent.
      direction.applyMatrix3(new THREE.Matrix3().setFromMatrix4(group.parent.matrixWorld).transpose());
      group.position.copy(direction);
      group.visible = !hidden.has(id) && (!isolated || matches(feature, isolated));
      const dimmed = focused && !matches(feature, focused),
        active = matches(feature, selected);
      const alpha = dimmed ? 0.06 : style === "transparent" ? 0.22 : (feature.color?.[3] ?? 1);
      mesh.material.opacity = alpha;
      if (mesh.material.transparent !== alpha < 1) mesh.material.needsUpdate = true;
      mesh.material.transparent = alpha < 1;
      mesh.material.depthWrite = alpha >= 1;
      mesh.visible = style !== "wireframe";
      mesh.material.emissive.setHex(active ? 0x5c3600 : 0);
      edges.material.color.setHex(active ? 0xf0a43a : 0x293541);
      edges.material.opacity = dimmed ? 0.08 : active ? 1 : style === "wireframe" ? 0.8 : 0.5;
      group.userData.dimmed = !!dimmed;
      for (const material of [mesh.material, edges.material]) {
        if ((material.clippingPlanes?.length ?? 0) !== planes.length) material.needsUpdate = true;
        material.clippingPlanes = planes;
      }
    }
    root.updateMatrixWorld(true);
    host.dataset.motionTime = time.toFixed(4);
    host.dataset.playing = String(playing);
    host.dataset.visibleParts = String([...parts.values()].filter((p) => p.group.visible).length);
    host.dataset.focusedParts = String(
      [...parts.values()].filter((p) => p.group.visible && !p.group.userData.dimmed).length
    );
    host.dataset.sections = String(sections.length);
    host.dataset.explodeMode = explodeMode;
    host.dataset.appearance = appearance;
    draw();
  }
  function setTime(value) {
    time = Math.max(0, Math.min(model?.motion?.duration ?? 0, Number(value) || 0));
    apply();
    onTime?.({ time, playing, duration: model?.motion?.duration ?? 0 });
  }
  function tick(now) {
    if (!playing) return;
    if (previous !== undefined && !document.hidden && !host.closest("[hidden]")) {
      const duration = model.motion.duration;
      setTime((time + ((now - previous) / 1000) * speed) % duration);
    }
    previous = now;
    frame = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    previous = undefined;
    cancelAnimationFrame(frame);
    host.dataset.playing = "false";
    onTime?.({ time, playing, duration: model?.motion?.duration ?? 0 });
  }
  function play() {
    if (!model?.motion || playing) return;
    playing = true;
    host.dataset.playing = "true";
    onTime?.({ time, playing, duration: model.motion.duration });
    frame = requestAnimationFrame(tick);
  }
  return {
    root,
    update,
    setTime,
    pause,
    play,
    select(id) {
      selected = id;
      apply();
    },
    setStyle(value) {
      style = value;
      apply();
    },
    setAppearance(value) {
      appearance = ["engineering", "colors", "materials"].includes(value) ? value : "engineering";
      for (const { feature, mesh } of parts.values())
        Object.assign(mesh.material, surfaceAppearance(feature, appearance));
      apply();
    },
    setExplode(value) {
      explode = Math.max(0, Math.min(1, value));
      apply();
    },
    setExplodeMode(value) {
      explodeMode = value === "groups" ? "groups" : "parts";
      if (model) offsets = explosionOffsets(model, explodeMode);
      apply();
    },
    setSection(value) {
      sections = value ? [value] : [];
      apply();
    },
    setSections(value) {
      sections = value;
      apply();
    },
    setSpeed(value) {
      speed = value;
      host.dataset.speed = String(speed);
    },
    setHidden(key, value) {
      for (const [id, part] of parts)
        if (matches(part.feature, key)) {
          if (value) hidden.add(id);
          else hidden.delete(id);
        }
      apply();
    },
    hideOthers(key) {
      hidden.clear();
      isolated = focused = undefined;
      for (const [id, part] of parts) if (!matches(part.feature, key)) hidden.add(id);
      apply();
    },
    isolate(id) {
      isolated = id;
      focused = undefined;
      apply();
    },
    focus(id) {
      isolated = undefined;
      focused = id;
      apply();
    },
    showAll() {
      hidden.clear();
      isolated = focused = undefined;
      apply();
    },
    reset() {
      pause();
      hidden.clear();
      isolated = focused = undefined;
      explode = 0;
      explodeMode = "parts";
      if (model) offsets = explosionOffsets(model);
      sections = [];
      style = "solid";
      setTime(0);
    },
    bounds(id) {
      const box = new THREE.Box3();
      for (const part of parts.values())
        if ((!id || matches(part.feature, id)) && part.group.visible)
          box.union(new THREE.Box3().setFromObject(part.group));
      return box;
    },
    hit(raycaster) {
      const meshes = [...parts.values()].filter((p) => p.group.visible).map((p) => p.mesh);
      const hits = raycaster
        .intersectObjects(meshes)
        .filter((h) =>
          sections.every((s) =>
            s.inverted ? h.point[s.axis] >= s.offset - 1e-6 : h.point[s.axis] <= s.offset + 1e-6
          )
        );
      return focused
        ? (hits.find((h) => matches(parts.get(h.object.userData.id).feature, focused)) ?? hits[0])
        : hits[0];
    },
    pick(raycaster) {
      return this.hit(raycaster)?.object.userData.id;
    },
    dispose() {
      pause();
      clear();
      scene.remove(root);
    }
  };
}
