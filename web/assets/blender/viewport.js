import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

function dispose(root) {
  const geometries = new Set(),
    materials = new Set(),
    textures = new Set();
  root?.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : object.material
        ? [object.material]
        : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const value of [...geometries, ...materials, ...textures]) value.dispose();
}

/** The scene is an immutable derivative. All edits go back through the resource protocol. */
export function createBlenderViewport(host, { onSelect } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Blender 三维场景，拖动旋转，滚轮缩放，点击选择对象");
  host.append(canvas);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
  camera.position.set(5, 4, 6);
  const controls = new OrbitControls(camera, canvas);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x68758c, 2));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(5, 8, 6);
  scene.add(light);
  const grid = new THREE.GridHelper(20, 20, 0x425066, 0x293341);
  scene.add(grid);
  const raycaster = new THREE.Raycaster(),
    lookup = new Map();
  let model,
    box,
    selected,
    disposed = false,
    generation = 0,
    start;
  const draw = () => {
    if (!disposed) renderer.render(scene, camera);
  };
  const updateAppearance = () => {
    const stage = host.closest(".blender-stage") || host;
    const style = getComputedStyle(stage);
    renderer.setClearColor(style.backgroundColor);
    grid.material.transparent = true;
    grid.material.opacity = style.colorScheme === "light" ? 0.2 : 1;
    draw();
  };
  const appearance = new MutationObserver(updateAppearance);
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  updateAppearance();
  controls.addEventListener("change", draw);
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth,
      height = host.clientHeight;
    if (!width || !height) return;
    const previousAspect = camera.aspect;
    camera.aspect = width / height;
    if (model) {
      const scale = Math.min(previousAspect, 1) / Math.min(camera.aspect, 1);
      camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
      controls.update();
    }
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    draw();
  });
  resize.observe(host);
  function highlight() {
    if (box) {
      scene.remove(box);
      box.geometry.dispose();
      box.material.dispose();
      box = null;
    }
    const object = lookup.get(selected);
    if (object) {
      box = new THREE.BoxHelper(object, 0xf3b35d);
      scene.add(box);
    }
    draw();
  }
  function fit() {
    if (!model) return;
    const bounds = new THREE.Box3().setFromObject(model);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3()),
      size = bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.01),
      distance = (extent * 2.2) / Math.min(camera.aspect, 1);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1.2).normalize().multiplyScalar(distance));
    camera.near = Math.max(extent / 1000, 0.00001);
    camera.far = Math.max(extent * 100, 100);
    controls.minDistance = extent / 100;
    controls.maxDistance = extent * 100;
    camera.updateProjectionMatrix();
    controls.update();
    grid.scale.setScalar(extent / 5);
    grid.position.y = bounds.min.y - extent / 1000;
    draw();
  }
  const down = (event) => {
    if (event.button === 0) start = { x: event.clientX, y: event.clientY };
  };
  const up = (event) => {
    if (!start || event.button !== 0) return;
    const previous = start;
    start = null;
    if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 5 || !model) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1
      ),
      camera
    );
    let object = raycaster.intersectObject(model, true)[0]?.object;
    while (object && !object.userData?.atria_id) object = object.parent;
    onSelect?.(object?.userData?.atria_id ?? null);
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointerup", up);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    throw new Error("Blender 预览必须包含贴图，不能加载外部地址");
  });
  const loader = new GLTFLoader(manager);
  return {
    async load(bytes, signal) {
      const request = ++generation;
      const parsed = await loader.parseAsync(bytes, "");
      if (disposed || request !== generation || signal?.aborted) {
        dispose(parsed.scene);
        return false;
      }
      if (model) {
        scene.remove(model);
        dispose(model);
      }
      model = parsed.scene;
      scene.add(model);
      lookup.clear();
      model.traverse((object) => {
        if (object.userData?.atria_id) lookup.set(object.userData.atria_id, object);
      });
      fit();
      highlight();
      host.dataset.ready = "true";
      return true;
    },
    select(id) {
      selected = id;
      highlight();
    },
    clear() {
      generation++;
      if (model) {
        scene.remove(model);
        dispose(model);
        model = null;
      }
      lookup.clear();
      selected = null;
      highlight();
      host.dataset.ready = "false";
    },
    fit,
    focus: () => canvas.focus(),
    dispose() {
      disposed = true;
      generation++;
      resize.disconnect();
      appearance.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", up);
      dispose(model);
      dispose(grid);
      if (box) dispose(box);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    }
  };
}
