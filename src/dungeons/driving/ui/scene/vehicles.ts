// The cars and people on the road: the player's Model Y (a Draco glTF,
// re-materialed and rigged so its wheels roll and steer), procedural cars
// and motorcycles for traffic, and simple walking pedestrians.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Pedestrian } from "../../sim/types.ts";
import { steeringCurvature } from "../../sim/vehicle.ts";
import {
  assetManager,
  material,
  materials,
  type Paint,
  physical,
} from "./materials.ts";

const WHEEL_NAMES = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];

/** Merges a group's meshes per material, keeping its transform baked in. */
function mergeByMaterial(group: THREE.Group, indexed = false): THREE.Group {
  group.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const mat = object.material as THREE.Material;
    const list = batches.get(mat) ?? [];
    const source = object.geometry as THREE.BufferGeometry;
    const geometry =
      !indexed && source.index ? source.toNonIndexed() : source.clone();
    list.push(geometry.applyMatrix4(object.matrixWorld));
    batches.set(mat, list);
    source.dispose();
  });
  group.clear();
  for (const [mat, geometries] of batches) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries), mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    for (const g of geometries) g.dispose();
  }
  return group;
}

/** Rolls the wheels by the distance driven and steers the fronts (Ackermann). */
export function updateHeroWheels(
  model: THREE.Object3D,
  signedDistance: number,
  steering: number,
  speed: number,
): void {
  const wheelbase = model.userData.wheelbase as number;
  const curvature = steeringCurvature(steering, speed);
  for (const name of WHEEL_NAMES) {
    const wheel = model.getObjectByName(name);
    const rotor = wheel?.children[0];
    if (!wheel || !rotor) continue;
    // Local −z is forward. Calipers steer with the axle but do not roll.
    rotor.rotation.x =
      (rotor.rotation.x - signedDistance / (wheel.userData.radius as number)) %
      (Math.PI * 2);
    wheel.rotation.y = wheel.userData.front
      ? -Math.atan((wheelbase * curvature) / (1 - wheel.position.x * curvature))
      : 0;
  }
}

let carAsset: Promise<THREE.Group> | undefined;

async function buildHeroCar(): Promise<THREE.Group> {
  const decoder = new DRACOLoader(assetManager).setDecoderPath("/draco/");
  const loader = new GLTFLoader(assetManager).setDRACOLoader(decoder);
  const { scene } = await loader.loadAsync("/models/model-y/model-y.glb");
  decoder.dispose();
  const paint = physical("model-y-paint", {
    color: "#e1e4e8",
    metalness: 0.35,
    roughness: 0.24,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const alloy = physical("model-y-alloy", {
    color: "#5c626a",
    metalness: 0.9,
    roughness: 0.28,
  });
  const glass = physical("model-y-glass", {
    color: "#192530",
    metalness: 0.25,
    roughness: 0.08,
    clearcoat: 1,
  });
  // The driver's view hides materials named Glass.
  glass.name = "Glass";
  const lenses = physical("model-y-light-lenses", {
    color: "#eef4ff",
    metalness: 0.05,
    roughness: 0.1,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
  });
  const leather = physical("model-y-leather", {
    color: "#24282c",
    roughness: 0.85,
  });
  // The source faces −x; the simulation's forward is −z.
  scene.rotation.y = -Math.PI / 2;
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 4.75 / size.z;
  const transform = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(
      new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z),
    );
  const model = new THREE.Group();
  const batches = new Map<
    THREE.Object3D,
    Map<THREE.Material, THREE.BufferGeometry[]>
  >([[model, new Map()]]);
  const wheels = new Map<string, { pivot: THREE.Group; rotor: THREE.Group }>();
  const meshBounds = (mesh: THREE.Object3D) =>
    new THREE.Box3().setFromObject(mesh).applyMatrix4(transform);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  const nameOf = (mesh: THREE.Mesh) => (mesh.material as THREE.Material).name;
  const panes = meshes
    .filter((mesh) => nameOf(mesh) === "glass_body")
    .map(meshBounds);
  for (const mesh of meshes) {
    if (nameOf(mesh) !== "tires") continue;
    const box = meshBounds(mesh);
    const wheelSize = box.getSize(new THREE.Vector3());
    // The four whole tire shells give exact axle centers and radii; the
    // sidewall lettering meshes are attached to them below.
    if (wheelSize.y < 0.72) continue;
    const position = box.getCenter(new THREE.Vector3());
    const front = position.z < 0;
    const name = `wheel_${front ? "f" : "r"}${position.x < 0 ? "l" : "r"}`;
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.copy(position);
    pivot.userData.front = front;
    pivot.userData.radius = wheelSize.y / 2;
    const rotor = new THREE.Group();
    rotor.name = `${name}_spin`;
    pivot.add(rotor);
    model.add(pivot);
    wheels.set(name, { pivot, rotor });
    batches.set(rotor, new Map());
    batches.set(pivot, new Map());
  }
  if (wheels.size !== 4) throw new Error("Model Y asset is missing an axle");
  const rolling = new Set([
    "tires",
    "wheels",
    "brakedsk",
    "metal",
    "alum",
    "chrome",
  ]);
  const calipers = new Set(["calipers", "calipers2"]);
  for (const mesh of meshes) {
    const sourceMaterial = nameOf(mesh);
    const box = meshBounds(mesh);
    const c = box.getCenter(new THREE.Vector3());
    const extent = box.getSize(new THREE.Vector3());
    const candidate = wheels.get(
      `wheel_${c.z < 0 ? "f" : "r"}${c.x < 0 ? "l" : "r"}`,
    );
    const atAxle =
      !!candidate &&
      Math.abs(c.z - candidate.pivot.position.z) < 0.3 &&
      Math.abs(c.x - candidate.pivot.position.x) < 0.25 &&
      box.max.y < 0.8 &&
      extent.z < 0.8;
    const wheel =
      atAxle && (rolling.has(sourceMaterial) || calipers.has(sourceMaterial))
        ? candidate
        : null;
    // Interior backfaces of the glass must also clear the driver's view.
    const paneLiner =
      sourceMaterial === "interior" &&
      panes.some(
        (pane) =>
          pane.min.distanceTo(box.min) < 0.025 &&
          pane.max.distanceTo(box.max) < 0.025,
      );
    if (paneLiner) continue;
    let mat = mesh.material as THREE.Material;
    if (sourceMaterial === "body") mat = paint;
    else if (sourceMaterial === "wheels") mat = alloy;
    else if (sourceMaterial === "glass_body") mat = glass;
    else if (
      sourceMaterial === "glass_lights" ||
      sourceMaterial === "glass_front_lights"
    )
      mat = lenses;
    else if (sourceMaterial === "interior") mat = leather;
    const source = mesh.geometry as THREE.BufferGeometry;
    const geometry = (
      source.index ? source.toNonIndexed() : source.clone()
    ).applyMatrix4(transform.clone().multiply(mesh.matrixWorld));
    if (wheel)
      geometry.translate(
        -wheel.pivot.position.x,
        -wheel.pivot.position.y,
        -wheel.pivot.position.z,
      );
    for (const name of Object.keys(geometry.attributes))
      if (!["position", "normal", "uv"].includes(name))
        geometry.deleteAttribute(name);
    if (!geometry.attributes.uv)
      geometry.setAttribute(
        "uv",
        new THREE.BufferAttribute(
          new Float32Array(
            (geometry.attributes.position as THREE.BufferAttribute).count * 2,
          ),
          2,
        ),
      );
    const parent = wheel
      ? calipers.has(sourceMaterial)
        ? wheel.pivot
        : wheel.rotor
      : model;
    const byMaterial = batches.get(parent) as Map<
      THREE.Material,
      THREE.BufferGeometry[]
    >;
    const list = byMaterial.get(mat) ?? [];
    list.push(geometry);
    byMaterial.set(mat, list);
  }
  for (const [parent, byMaterial] of batches)
    for (const [mat, geometries] of byMaterial) {
      materials.set(`asset-car:${mat.uuid}`, mat);
      const mesh = new THREE.Mesh(mergeGeometries(geometries), mat);
      mesh.castShadow = mat !== lenses;
      mesh.receiveShadow = true;
      parent.add(mesh);
      for (const g of geometries) g.dispose();
    }
  for (const mesh of meshes) mesh.geometry.dispose();
  model.name = "tesla-model-y";
  model.userData.eyeHeight = 1.28;
  model.userData.eyeForward = 0.45;
  const fl = wheels.get("wheel_fl") as { pivot: THREE.Group };
  const rl = wheels.get("wheel_rl") as { pivot: THREE.Group };
  model.userData.wheelbase = Math.abs(
    fl.pivot.position.z - rl.pivot.position.z,
  );
  return model;
}

/** A fresh copy of the player's Model Y; the parsed template is loaded once. */
export async function loadHeroCar(): Promise<THREE.Group> {
  carAsset ??= buildHeroCar();
  const model = (await carAsset).clone(true);
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry = object.geometry.clone();
  });
  return model;
}

/** A procedural car (4.16 m) or motorcycle with a rider, batched per material. */
export function detailedCar(
  color = "#d6d9df",
  motorcycle = false,
): THREE.Group {
  const group = new THREE.Group();
  const paint = physical(`paint:${color}`, {
    color,
    metalness: 0.55,
    roughness: 0.25,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  });
  const glass = physical("vehicle-glass", {
    color: "#202d3b",
    metalness: 0.38,
    roughness: 0.08,
    clearcoat: 1,
  });
  const rubber = physical("rubber", { color: "#141518", roughness: 0.96 });
  const chrome = physical("wheel-alloy", {
    color: "#a4a9b2",
    metalness: 0.9,
    roughness: 0.25,
  });
  const trim = physical("dark-trim", {
    color: "#24262a",
    roughness: 0.4,
    metalness: 0.5,
  });
  const led = physical("headlight", {
    color: "#f8fcff",
    emissive: "#d9eeff",
    emissiveIntensity: 2,
    roughness: 0.2,
  });
  const tail = physical("taillight", {
    color: "#d71121",
    emissive: "#a9000b",
    emissiveIntensity: 1.3,
    roughness: 0.2,
  });
  const mesh = (
    geometry: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    radius = 0.025,
  ) => mesh(new RoundedBoxGeometry(w, h, d, 2, radius), mat, x, y, z);
  const quad = (points: [number, number, number][], mat: THREE.Material) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(points.flat(), 3),
    );
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    return mesh(geometry, mat, 0, 0, 0);
  };
  if (motorcycle) {
    box(0.48, 0.4, 1.15, 0, 0.65, 0, trim, 0.1);
    box(0.58, 0.4, 0.7, 0, 0.94, -0.22, paint, 0.15);
    box(0.5, 0.13, 0.68, 0, 1.06, 0.28, rubber);
    box(0.78, 0.05, 0.08, 0, 1.16, -0.6, chrome);
    box(0.3, 0.15, 0.1, 0, 1.04, -0.82, led);
    box(0.2, 0.12, 0.1, 0, 0.86, 0.85, tail);
    box(0.47, 0.56, 0.35, 0, 1.37, 0.15, material("#303942"), 0.12);
    mesh(new THREE.SphereGeometry(0.245, 16, 12), paint, 0, 1.83, 0);
    box(0.34, 0.12, 0.12, 0, 1.83, -0.2, glass);
    for (const side of [-1, 1]) {
      const leg = box(0.16, 0.7, 0.18, side * 0.25, 0.91, 0.2, rubber, 0.06);
      leg.rotation.x = 0.3;
      const arm = box(0.14, 0.55, 0.14, side * 0.28, 1.36, -0.12, trim, 0.05);
      arm.rotation.x = 0.85;
    }
  } else {
    box(1.9, 0.64, 4.16, 0, 0.73, 0, paint, 0.2);
    box(1.77, 0.17, 3.95, 0, 0.43, 0, trim, 0.06);
    box(1.65, 0.15, 1.25, 0, 1.03, -1.28, paint, 0.08);
    box(1.62, 0.14, 0.85, 0, 1.04, 1.51, paint, 0.07);
    const lowerY = 1.04;
    const roofY = 1.61;
    quad(
      [
        [-0.78, lowerY, -0.92],
        [0.78, lowerY, -0.92],
        [0.66, roofY, -0.36],
        [-0.66, roofY, -0.36],
      ],
      glass,
    );
    quad(
      [
        [0.77, lowerY, 1.16],
        [-0.77, lowerY, 1.16],
        [-0.66, roofY, 0.68],
        [0.66, roofY, 0.68],
      ],
      glass,
    );
    for (const side of [-1, 1]) {
      const points: [number, number, number][] = [
        [side * 0.78, lowerY, -0.87],
        [side * 0.78, lowerY, 1.11],
        [side * 0.66, roofY, 0.68],
        [side * 0.66, roofY, -0.36],
      ];
      if (side < 0) points.reverse();
      quad(points, glass);
      box(0.075, 0.55, 0.075, side * 0.72, 1.32, 0.28, trim);
      box(0.045, 0.05, 2.08, side * 0.81, 1.04, 0.12, chrome);
      for (const z of [-0.2, 0.88])
        box(0.05, 0.035, 0.22, side * 0.95, 0.92, z, chrome);
      box(0.24, 0.13, 0.34, side * 1.0, 1.08, -0.66, paint, 0.055);
      box(0.15, 0.08, 0.02, side * 1.0, 1.08, -0.47, chrome);
      box(0.017, 0.46, 0.017, side * 0.95, 0.77, 0.29, trim, 0.002);
      box(0.59, 0.065, 0.055, side * 0.58, 0.91, -2.06, led);
      box(0.6, 0.075, 0.055, side * 0.58, 0.91, 2.06, tail);
    }
    box(1.38, 0.095, 1.16, 0, 1.64, 0.15, paint, 0.045);
    box(1.28, 0.02, 0.83, 0, 1.696, 0.1, glass);
    box(1.14, 0.18, 0.05, 0, 0.56, -2.074, trim);
    for (let i = -4; i <= 4; i++)
      box(0.016, 0.12, 0.06, i * 0.115, 0.56, -2.08, chrome, 0.003);
    box(0.47, 0.13, 0.035, 0, 0.62, 2.09, material("#e0e2e4"));
    box(0.5, 0.04, 0.025, 0, 0.98, 2.094, tail);
  }
  for (const z of motorcycle ? [-0.77, 0.77] : [-1.29, 1.28])
    for (const side of motorcycle ? [0] : [-1, 1]) {
      const x = side * 0.87;
      const tire = mesh(
        new THREE.TorusGeometry(
          motorcycle ? 0.28 : 0.285,
          motorcycle ? 0.085 : 0.1,
          10,
          24,
        ),
        rubber,
        x,
        0.39,
        z,
      );
      tire.rotation.y = Math.PI / 2;
      const hub = mesh(
        new THREE.CylinderGeometry(0.23, 0.23, motorcycle ? 0.13 : 0.22, 24),
        trim,
        x,
        0.39,
        z,
      );
      hub.rotation.z = Math.PI / 2;
      for (let spoke = 0; spoke < 6; spoke++) {
        const spokeMesh = box(
          motorcycle ? 0.15 : 0.24,
          0.035,
          0.43,
          x,
          0.39,
          z,
          chrome,
          0.012,
        );
        spokeMesh.rotation.x = (spoke * Math.PI) / 6;
      }
    }
  return mergeByMaterial(group);
}

export interface PersonModel extends THREE.Group {
  userData: { limbs: { legs: THREE.Group[]; arms: THREE.Group[] } };
}

const TORSO_COLORS = ["#c27d55", "#8d9cab", "#dec060", "#548975"];

/** A pedestrian with swinging arms and legs (rotated in the render loop). */
export function personModel(p: Pick<Pedestrian, "id">): PersonModel {
  const g = new THREE.Group() as PersonModel;
  const body = new THREE.Group();
  const color = TORSO_COLORS[Number(p.id.split("-").at(-1)) % 4] as string;
  const capsule = (
    parent: THREE.Object3D,
    radius: number,
    length: number,
    x: number,
    y: number,
    z: number,
    c: Paint,
  ) => {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, length, 4, 8),
      material(c),
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const block = (
    parent: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    c: Paint,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(c));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const torso = capsule(body, 0.21, 0.28, 0, 1.09, 0, color);
  torso.scale.z = 0.62;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 10),
    material("#be9578"),
  );
  head.position.set(0, 1.57, -0.015);
  head.scale.set(0.9, 1.1, 0.95);
  head.castShadow = true;
  body.add(head);
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.181, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
    material("#3b2c23"),
  );
  hair.position.set(0, 1.61, 0);
  body.add(hair);
  capsule(body, 0.065, 0.08, 0, 1.38, 0, "#be9578");
  for (const x of [-0.058, 0.058])
    block(body, 0.025, 0.019, 0.018, x, 1.6, -0.17, "#28201e");
  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.032, 6, 6),
    material("#b8886d"),
  );
  nose.position.set(0, 1.55, -0.182);
  body.add(nose);
  g.add(mergeByMaterial(body, true));
  const legs: THREE.Group[] = [];
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.12, 0.77, 0);
    capsule(leg, 0.08, 0.48, 0, -0.3, 0, "#323c4c");
    block(leg, 0.17, 0.12, 0.28, 0, -0.61, -0.055, "#293936");
    g.add(leg);
    legs.push(leg);
    const arm = new THREE.Group();
    arm.position.set(side * 0.3, 1.31, 0);
    capsule(arm, 0.071, 0.37, 0, -0.24, 0, color);
    capsule(arm, 0.055, 0.07, 0, -0.51, 0, "#be9578");
    g.add(arm);
    arms.push(arm);
  }
  g.userData.limbs = { legs, arms };
  return g;
}
