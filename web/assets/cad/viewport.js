import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { createAssemblyView } from "./assembly-view.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { smoothSurface } from "./surface-rendering.js";

/** Viewport owns visual selection and gestures; the editor owns drafts and persistence. */
export function createCadViewport(host, callbacks = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const software =
    info && /swiftshader|llvmpipe|softpipe|software/i.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  // CPU renderers also run the PBR environment filters; bound interactive work on GPU-less machines.
  renderer.setPixelRatio(software ? 0.5 : Math.min(devicePixelRatio || 1, 2));
  host.dataset.rendering = software ? "software" : "hardware";
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "CAD 三维视图，点击选择，拖动手柄编辑，空白处拖动旋转");
  host.append(canvas);
  const scene = new THREE.Scene();
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, 0.04, 0.1, 100, { size: software ? 64 : 256 });
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.35;
  room.dispose();
  pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20000);
  camera.up.set(0, 0, 1);
  camera.position.set(110, -150, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.minDistance = 1;
  controls.maxDistance = 10000;
  scene.add(new THREE.HemisphereLight(0xe6eef8, 0x505663, 0.75));
  const light = new THREE.DirectionalLight(0xffffff, 2.2);
  light.position.set(100, -80, 200);
  scene.add(light);
  const rim = new THREE.DirectionalLight(0xb8d6ff, 0.85);
  rim.position.set(-150, 100, 90);
  scene.add(rim);
  const grid = new THREE.GridHelper(400, 40, 0x454d5a, 0x303640);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.05;
  scene.add(grid, new THREE.AxesHelper(30));
  const solid = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      color: 0x929bb0,
      metalness: 0.12,
      roughness: 0.5,
      side: THREE.DoubleSide
    })
  );
  const edges = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x505e74, transparent: true, opacity: 0.55 })
  );
  const pivot = new THREE.Group();
  pivot.rotation.order = "ZYX"; // Same Euler convention as JSCAD's Tait–Bryan rotation.
  const ghost = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0xf0a43a,
      transparent: true,
      opacity: 0.16,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  const highlight = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xd58a27, depthTest: false, transparent: true, opacity: 0.95 })
  );
  ghost.renderOrder = 9;
  highlight.renderOrder = 10;
  pivot.add(ghost, highlight);
  pivot.visible = false;
  scene.add(solid, edges, pivot);
  const transform = new TransformControls(camera, canvas);
  transform.setSize(0.85);
  transform.minX = transform.minY = transform.minZ = -2000;
  transform.maxX = transform.maxY = transform.maxZ = 2000;
  const helper = transform.getHelper();
  scene.add(helper);
  const pickMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const picks = new Map();
  const raycaster = new THREE.Raycaster();
  let selected,
    mode = "select",
    editable = true,
    first = true,
    gesture = false,
    cancelled = false,
    navigation = "orbit",
    fitDistance = camera.position.length(),
    model,
    recorder,
    recordingTimer,
    backgroundOverride;
  const measure = new THREE.Group(),
    points = [];
  scene.add(measure);
  const compass = document.createElement("div");
  compass.className = "cad-orientation";
  compass.setAttribute("aria-label", "观察方向坐标轴");
  compass.hidden = true;
  const directions = [
    ["X", "right", [1, 0, 0]],
    ["−X", "left", [-1, 0, 0]],
    ["Y", "back", [0, 1, 0]],
    ["−Y", "front", [0, -1, 0]],
    ["Z", "top", [0, 0, 1]],
    ["−Z", "bottom", [0, 0, -1]]
  ];
  for (const [label, view] of directions) {
    const button = document.createElement("button");
    button.textContent = label;
    button.type = "button";
    button.setAttribute("aria-label", `沿 ${label} 轴观察`);
    button.dataset.axis = label.slice(-1).toLowerCase();
    button.addEventListener("click", () => fit(view));
    compass.append(button);
  }
  host.append(compass);
  const draw = () => {
    renderer.render(scene, camera);
    const inverse = camera.quaternion.clone().invert();
    directions.forEach(([, , vector], i) => {
      const p = new THREE.Vector3(...vector).applyQuaternion(inverse),
        button = compass.children[i];
      button.style.left = `${44 + p.x * 32}px`;
      button.style.top = `${44 - p.y * 32}px`;
      button.style.zIndex = String(Math.round((p.z + 1) * 10));
      button.style.opacity = String(p.z < 0 ? 0.55 : 1);
    });
    const zoom = (fitDistance / Math.max(camera.position.distanceTo(controls.target), 1e-6)) * 100;
    host.dataset.zoom = zoom.toFixed(1);
    callbacks.onCamera?.({ zoom });
  };
  const assemblyView = createAssemblyView(scene, renderer, host, draw, callbacks.onTime);
  const updateAppearance = () => {
    const style = getComputedStyle(host.closest(".cad-stage") || host);
    const lightBackground = backgroundOverride ?? style.colorScheme === "light";
    renderer.setClearColor(
      backgroundOverride === undefined ? style.backgroundColor : lightBackground ? 0xf0f3f8 : 0x1b1e24
    );
    grid.material.opacity = lightBackground ? 0.18 : 1;
    grid.material.transparent = true;
    draw();
  };
  const appearance = new MutationObserver(updateAppearance);
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  updateAppearance();
  controls.addEventListener("change", draw);
  transform.addEventListener("change", draw);
  transform.addEventListener("dragging-changed", ({ value }) => {
    controls.enabled = !value;
    host.dataset.dragging = String(value);
    if (value) {
      gesture = true;
      cancelled = false;
      callbacks.onTransformStart?.();
    } else if (gesture) {
      gesture = false;
      if (!cancelled) callbacks.onTransformEnd?.();
    }
  });
  transform.addEventListener("objectChange", () => {
    if (!gesture || cancelled) return;
    const rounded = (values) => values.map((v) => Math.round(v * 10) / 10);
    callbacks.onTransform?.({
      position: rounded(pivot.position.toArray()),
      rotation: rounded(
        [pivot.rotation.x, pivot.rotation.y, pivot.rotation.z].map((v) => (v * 180) / Math.PI)
      )
    });
  });
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth,
      height = host.clientHeight;
    if (!width || !height) return;
    const previousAspect = camera.aspect;
    camera.aspect = width / height;
    if (model) {
      const scale = Math.min(previousAspect, 1) / Math.min(camera.aspect, 1);
      camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
      fitDistance *= scale;
      controls.update();
    }
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    draw();
  });
  resize.observe(host);
  function geometry(positions) {
    const value = new THREE.BufferGeometry();
    value.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    smoothSurface(value);
    value.computeBoundingBox();
    return value;
  }
  function replace(object, value) {
    object.geometry.dispose();
    object.geometry = value;
  }
  function attach() {
    transform.detach();
    if (selected && editable && mode !== "select") {
      transform.setMode(mode);
      transform.attach(pivot);
    }
    transform.enabled = editable;
  }
  function select(part) {
    if (transform.dragging) return;
    if (!editable) {
      selected = part?.id;
      host.dataset.selected = selected ?? "";
      pivot.visible = false;
      transform.detach();
      assemblyView.select(selected);
      return;
    }
    const mesh = part && picks.get(part.id);
    selected = mesh ? part.id : undefined;
    host.dataset.selected = selected ?? "";
    pivot.visible = !!mesh;
    if (mesh) {
      pivot.position.fromArray(part.position);
      pivot.rotation.set(...part.rotation.map((v) => (v * Math.PI) / 180), "ZYX");
      pivot.updateMatrix();
      const local = mesh.geometry.clone().applyMatrix4(pivot.matrix.clone().invert());
      replace(ghost, local);
      replace(highlight, new THREE.EdgesGeometry(local, 25));
      pivot.updateMatrixWorld(true);
    }
    attach();
    draw();
  }
  function fit(view = "fit") {
    const object = view === "selected" && selected ? pivot : solid;
    const box = editable
      ? new THREE.Box3().setFromObject(object)
      : assemblyView.bounds(view === "selected" ? selected : undefined);
    if (editable && view === "fit" && selected) box.union(new THREE.Box3().setFromObject(pivot));
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const radius = box.isEmpty() ? 25 : Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
    const direction =
      view === "top"
        ? new THREE.Vector3(0, -0.001, 1)
        : view === "bottom"
          ? new THREE.Vector3(0, -0.001, -1)
          : view === "back"
            ? new THREE.Vector3(0, 1, 0)
            : view === "left"
              ? new THREE.Vector3(-1, 0, 0)
              : view === "front"
                ? new THREE.Vector3(0, -1, 0)
                : view === "right"
                  ? new THREE.Vector3(1, 0, 0)
                  : view === "iso"
                    ? new THREE.Vector3(1, -1.4, 1)
                    : camera.position.clone().sub(controls.target);
    const angle = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.min(camera.aspect, 1));
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction.normalize(), (radius / Math.sin(angle)) * 1.2);
    fitDistance = camera.position.distanceTo(center);
    controls.update();
    draw();
  }
  let pointerDown;
  function pointerStart(event) {
    canvas.focus({ preventScroll: true });
    pointerDown = { x: event.clientX, y: event.clientY, editing: !!transform.axis };
  }
  function pointerEnd(event) {
    if (
      !pointerDown ||
      pointerDown.editing ||
      gesture ||
      event.button !== 0 ||
      Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4
    )
      return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1
      ),
      camera
    );
    scene.updateMatrixWorld(true);
    if (!editable) {
      if (navigation === "pan") return;
      if (navigation === "measure") {
        const hit = assemblyView.hit(raycaster);
        if (hit) addMeasure(hit.point);
      } else callbacks.onSelect?.(assemblyView.pick(raycaster));
      return;
    }
    const surface =
      raycaster.intersectObject(solid)[0] ??
      (pivot.visible ? raycaster.intersectObject(ghost)[0] : undefined);
    const hits = raycaster.intersectObjects([...picks.values()]);
    // A buried primitive must not steal a click on the visible Boolean result.
    const hit = surface
      ? hits.reduce(
          (best, candidate) =>
            !best ||
            Math.abs(candidate.distance - surface.distance) < Math.abs(best.distance - surface.distance)
              ? candidate
              : best,
          null
        )
      : undefined;
    callbacks.onSelect?.(hit?.object.userData.id);
  }
  function cancelTransform() {
    if (!transform.dragging) return false;
    cancelled = true;
    transform.reset();
    transform.pointerUp(null);
    callbacks.onTransformCancel?.();
    draw();
    return true;
  }
  function clearMeasure() {
    points.length = 0;
    measure.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    measure.clear();
    callbacks.onMeasure?.({ points: [] });
    draw();
  }
  function addMeasure(point) {
    if (points.length === 2) clearMeasure();
    points.push(point.clone());
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(fitDistance * 0.003, 0.2), 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xf0a43a, depthTest: false })
    );
    marker.position.copy(point);
    marker.renderOrder = 20;
    measure.add(marker);
    if (points.length === 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xf0a43a, depthTest: false })
      );
      line.renderOrder = 20;
      measure.add(line);
    }
    callbacks.onMeasure?.({
      points: points.map((p) => p.toArray()),
      ...(points.length === 2
        ? { distance: points[0].distanceTo(points[1]), delta: points[1].clone().sub(points[0]).toArray() }
        : {}),
      time: Number(host.dataset.motionTime ?? 0)
    });
    draw();
  }
  function contextMenu(event) {
    if (editable) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1
      ),
      camera
    );
    scene.updateMatrixWorld(true);
    callbacks.onContextMenu?.({ id: assemblyView.pick(raycaster), x: event.clientX, y: event.clientY });
  }
  // TransformControls receives the pointer first; observe its axis before deciding to select.
  canvas.addEventListener("pointerdown", pointerStart);
  canvas.addEventListener("pointerup", pointerEnd);
  canvas.addEventListener("pointercancel", cancelTransform);
  canvas.addEventListener("contextmenu", contextMenu);
  return {
    update(value, part) {
      if (transform.dragging) return;
      model = value;
      clearMeasure();
      const { positions, features } = model;
      if (!editable) {
        solid.visible = edges.visible = false;
        assemblyView.update(model);
        select(part);
        const box = assemblyView.bounds();
        if (!box.isEmpty()) grid.position.z = box.min.z - 0.05;
        if (first && positions.length) {
          first = false;
          fit("iso");
        }
        return;
      }
      replace(solid, geometry(positions));
      if (positions.length) grid.position.z = solid.geometry.boundingBox.min.z - 0.05;
      replace(edges, new THREE.EdgesGeometry(solid.geometry, 25));
      for (const mesh of picks.values()) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      picks.clear();
      for (const feature of features) {
        const mesh = new THREE.Mesh(geometry(feature.positions), pickMaterial);
        mesh.userData.id = feature.id;
        mesh.visible = false;
        scene.add(mesh);
        picks.set(feature.id, mesh);
      }
      select(part);
      if (first && positions.length) {
        first = false;
        fit("iso");
      } else draw();
    },
    select,
    fit,
    setTime(value) {
      clearMeasure();
      assemblyView.setTime(value);
    },
    play() {
      clearMeasure();
      assemblyView.play();
    },
    pause: assemblyView.pause,
    setSpeed: assemblyView.setSpeed,
    setExplode(value) {
      clearMeasure();
      assemblyView.setExplode(value);
    },
    setExplodeMode(value) {
      clearMeasure();
      assemblyView.setExplodeMode(value);
    },
    setSection(value) {
      clearMeasure();
      assemblyView.setSection(value);
    },
    setSections(value) {
      clearMeasure();
      assemblyView.setSections(value);
    },
    setStyle: assemblyView.setStyle,
    setAppearance: assemblyView.setAppearance,
    setHidden(key, value) {
      clearMeasure();
      assemblyView.setHidden(key, value);
    },
    hideOthers(key) {
      clearMeasure();
      assemblyView.hideOthers(key);
    },
    isolate(key) {
      clearMeasure();
      assemblyView.isolate(key);
    },
    focus(key) {
      clearMeasure();
      assemblyView.focus(key);
    },
    showAll() {
      clearMeasure();
      assemblyView.showAll();
    },
    resetView() {
      clearMeasure();
      assemblyView.reset();
    },
    clearMeasure,
    setNavigation(value) {
      navigation = value;
      host.dataset.navigation = value;
      controls.mouseButtons.LEFT = value === "pan" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      if (value === "measure") assemblyView.pause();
      clearMeasure();
    },
    zoom(factor) {
      camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
      controls.update();
      draw();
    },
    resetZoom() {
      const direction = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(direction, fitDistance);
      controls.update();
      draw();
    },
    setBackground(light) {
      backgroundOverride = light;
      updateAppearance();
    },
    recordCycle() {
      if (!model?.motion || !canvas.captureStream || typeof MediaRecorder === "undefined")
        throw new Error("当前浏览器不能录制，请使用当前视图 PNG 或导出 Python 工程");
      if (recorder) throw new Error("录制正在进行");
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );
      if (!mimeType) throw new Error("当前浏览器不支持 WebM 录制");
      const stream = canvas.captureStream(30),
        chunks = [];
      recorder = new MediaRecorder(stream, { mimeType });
      clearMeasure();
      assemblyView.setTime(0);
      const result = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => {
          reject(new Error("运动录制失败"));
          recorder?.stop();
        };
        recorder.onstop = () => {
          clearTimeout(recordingTimer);
          stream.getTracks().forEach((track) => track.stop());
          recorder = undefined;
          assemblyView.pause();
          resolve(new Blob(chunks, { type: mimeType }));
        };
      });
      recorder.start();
      assemblyView.play();
      // Bounded recording follows the chosen speed; manual stop remains available.
      const speed = Number(host.dataset.speed ?? 1);
      recordingTimer = setTimeout(
        () => recorder?.state === "recording" && recorder.stop(),
        Math.min(model.motion.duration / speed, 60) * 1000
      );
      return result;
    },
    stopRecording() {
      if (recorder?.state === "recording") recorder.stop();
    },
    capture: async () => {
      const interactiveRatio = renderer.getPixelRatio();
      try {
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        draw();
        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      } finally {
        renderer.setPixelRatio(interactiveRatio);
        draw();
      }
    },
    setMode(value) {
      cancelTransform();
      mode = value;
      host.dataset.mode = mode;
      attach();
      draw();
    },
    setEditable(value) {
      if (editable === value) return;
      editable = value;
      compass.hidden = value;
      canvas.setAttribute(
        "aria-label",
        value
          ? "CAD 三维视图，点击选择，拖动手柄编辑，空白处拖动旋转"
          : "CAD 三维视图，点击选择实体，拖动旋转，滚轮缩放"
      );
      attach();
      draw();
    },
    setSnap(enabled) {
      transform.setTranslationSnap(enabled ? 1 : null);
      transform.setRotationSnap(enabled ? Math.PI / 12 : null);
    },
    cancelTransform,
    get isDragging() {
      return transform.dragging;
    },
    dispose() {
      clearTimeout(recordingTimer);
      if (recorder?.state === "recording") recorder.stop();
      clearMeasure();
      assemblyView.dispose();
      resize.disconnect();
      appearance.disconnect();
      canvas.removeEventListener("pointerdown", pointerStart);
      canvas.removeEventListener("pointerup", pointerEnd);
      canvas.removeEventListener("pointercancel", cancelTransform);
      canvas.removeEventListener("contextmenu", contextMenu);
      controls.dispose();
      transform.dispose();
      scene.remove(helper);
      for (const mesh of picks.values()) mesh.geometry.dispose();
      pickMaterial.dispose();
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material?.dispose();
      });
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      compass.remove();
    }
  };
}
