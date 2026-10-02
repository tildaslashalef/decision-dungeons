// The candidate paths on the road: the chosen three-second plan as a
// bright blue ribbon, and on request every sampled candidate, colored by
// kind, with the decider's probability as a label. Paths are stored
// car-relative per batch, so they ride with the car between decisions.

import * as THREE from "three";
import type { Selection } from "../../decide/selection.ts";
import { candidateName } from "../../decide/selection.ts";
import type { Candidate, DrivingPlan } from "../../sim/plan.ts";
import { CANDIDATE_COUNT, VECTOR_STEPS } from "../../sim/vehicle.ts";

/** The car the paths ride with: its pose and footprint. */
interface CarPose {
  x: number;
  z: number;
  heading: number;
  width: number;
  depth: number;
}

/** An answer older than this (simulated ms) no longer marks a path as chosen. */
const ANSWER_LIFETIME_MS = 1800;

type Ribbon = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

function ribbon(): Ribbon {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array((VECTOR_STEPS + 1) * 6),
      3,
    ).setUsage(THREE.DynamicDrawUsage),
  );
  const progress: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= VECTOR_STEPS; i++)
    progress.push(i / VECTOR_STEPS, i / VECTOR_STEPS);
  geometry.setAttribute(
    "progress",
    new THREE.Float32BufferAttribute(progress, 1),
  );
  for (let i = 0; i < VECTOR_STEPS; i++) {
    const n = i * 2;
    indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
  }
  geometry.setIndex(indices);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tint: { value: new THREE.Color("#007aff") },
      alpha: { value: 0.27 },
      time: { value: 0 },
      pulse: { value: 0 },
      ego: { value: new THREE.Vector3() },
      body: { value: new THREE.Vector2() },
    },
    vertexShader: `attribute float progress; varying float vProgress; varying vec2 vWorld; void main() { vProgress = progress; vWorld = (modelMatrix * vec4(position, 1.0)).xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    // Discards inside the car's footprint, fades in and out along the path.
    fragmentShader: `uniform vec3 tint; uniform float alpha; uniform float time; uniform float pulse; uniform vec3 ego; uniform vec2 body; varying float vProgress; varying vec2 vWorld; void main() {
      vec2 delta = vWorld - ego.xy;
      float right = dot(delta, vec2(cos(ego.z), sin(ego.z)));
      float ahead = dot(delta, vec2(sin(ego.z), -cos(ego.z)));
      if (abs(right) < body.x && abs(ahead) < body.y) discard; float fade = (1.0 - smoothstep(0.72,1.0,vProgress)) * smoothstep(0.015,0.08,vProgress); float scan = 1.0 - pulse * (0.5 + 0.5 * sin(vProgress * 18.0 - time * 6.0)); gl_FragColor = vec4(tint, alpha * fade * scan);
      #include <colorspace_fragment>
    }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

interface Point {
  x: number;
  z: number;
}

interface Relative {
  right: number;
  ahead: number;
}

function updateRibbon(
  mesh: Ribbon,
  points: Point[],
  width: number,
  y: number,
): void {
  const a = mesh.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(0, i - 1)] as Point;
    const after = points[Math.min(points.length - 1, i + 1)] as Point;
    const p = points[i] as Point;
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    const len = Math.hypot(dx, dz) || 1;
    a.setXYZ(i * 2, p.x - (dz / len) * width, y, p.z + (dx / len) * width);
    a.setXYZ(i * 2 + 1, p.x + (dz / len) * width, y, p.z - (dx / len) * width);
  }
  a.needsUpdate = true;
}

/** Each candidate's path from its bumper, in the car's frame at planning time. */
const displayPaths = new WeakMap<DrivingPlan, Record<string, Relative[]>>();

function pathsOf(plan: DrivingPlan): Record<string, Relative[]> {
  let paths = displayPaths.get(plan);
  if (!paths) {
    const origin = plan.origin;
    const sin = Math.sin(origin.heading);
    const cos = Math.cos(origin.heading);
    paths = Object.fromEntries(
      Object.entries(plan.projections).map(([id, path]) => {
        const direction = (plan.vectors[id]?.velocity_mps ?? 0) < 0 ? -1 : 1;
        return [
          id,
          path.points.map((p) => {
            const x =
              p.x + Math.sin(p.heading) * (origin.depth / 2 + 0.2) * direction;
            const z =
              p.z - Math.cos(p.heading) * (origin.depth / 2 + 0.2) * direction;
            return {
              right: (x - origin.x) * cos + (z - origin.z) * sin,
              ahead: (x - origin.x) * sin - (z - origin.z) * cos,
            };
          }),
        ];
      }),
    );
    displayPaths.set(plan, paths);
  }
  return paths;
}

interface Animation {
  direction?: number;
  points?: Relative[];
}

/** Eases a path toward its new shape and places it at the car's current pose. */
function animatePath(
  car: CarPose,
  candidate: Candidate,
  target: Relative[],
  animation: Animation,
  dt: number,
  paused: boolean,
): Point[] {
  const direction = candidate.velocity_mps < 0 ? -1 : 1;
  const blend = paused ? 0 : 1 - Math.exp(-Math.min(dt, 0.1) / 0.22);
  const previous =
    animation.direction === direction ? animation.points : undefined;
  animation.direction = direction;
  animation.points = target.map((p, i) => {
    const alpha = i === 0 || !previous ? 1 : blend;
    const before = previous?.[i];
    return {
      right: before ? before.right + (p.right - before.right) * alpha : p.right,
      ahead: before ? before.ahead + (p.ahead - before.ahead) * alpha : p.ahead,
    };
  });
  const sin = Math.sin(car.heading);
  const cos = Math.cos(car.heading);
  return animation.points.map((p) => ({
    x: car.x + p.right * cos + p.ahead * sin,
    z: car.z + p.right * sin - p.ahead * cos,
  }));
}

function weights(
  answer: Selection | null,
  eligible: Record<string, Candidate> | undefined,
  ageMs: number,
): Record<
  string,
  { probability: number | undefined; selected: boolean }
> | null {
  if (
    !answer ||
    !eligible ||
    ageMs > ANSWER_LIFETIME_MS ||
    !Object.hasOwn(eligible, answer.choice)
  )
    return null;
  return Object.fromEntries(
    Object.keys(eligible).map((id) => [
      id,
      // A decider that reports no distribution still chooses; its labels stay hidden.
      { probability: answer.probabilities[id], selected: id === answer.choice },
    ]),
  );
}

interface Item {
  line: Ribbon;
  glow: Ribbon;
  label: HTMLSpanElement;
  animation: Animation;
}

export class RoadVectors {
  /** Draw the chosen path. */
  enabled = true;
  /** Draw every candidate of the batch. */
  showCandidates = false;
  plan: DrivingPlan | null = null;
  answeredPlan: DrivingPlan | null = null;
  answer: Selection | null = null;
  private receivedAt = 0;
  private group = new THREE.Group();
  private pool: Item[];
  private selected = ribbon();
  private selectedGlow = ribbon();
  private selectedAnimation: Animation = {};

  constructor(
    scene: THREE.Scene,
    private readonly layer: HTMLElement,
  ) {
    this.group.visible = false;
    scene.add(this.group);
    layer.hidden = true;
    layer.replaceChildren();
    this.pool = Array.from({ length: CANDIDATE_COUNT }, () => {
      const line = ribbon();
      const glow = ribbon();
      const label = document.createElement("span");
      label.className = "vector-label";
      label.hidden = true;
      layer.append(label);
      this.group.add(glow, line);
      return { line, glow, label, animation: {} };
    });
    this.group.add(this.selectedGlow, this.selected);
    this.clear();
  }

  setCandidates(plan: DrivingPlan): void {
    pathsOf(plan);
    this.plan = plan;
  }

  /** `time` is the simulated second the answer arrived. */
  setAnswer(answer: Selection, plan: DrivingPlan, time: number): void {
    this.setCandidates(plan);
    this.answer = answer;
    this.answeredPlan = plan;
    this.receivedAt = time;
  }

  clear(): void {
    this.answer = null;
    this.plan = null;
    this.answeredPlan = null;
    this.receivedAt = 0;
    this.selectedAnimation = {};
    for (const item of this.pool) item.animation = {};
    this.group.visible = false;
    this.layer.hidden = true;
  }

  render(
    car: CarPose,
    camera: THREE.Camera,
    width: number,
    height: number,
    dt: number,
    time: number,
    paused: boolean,
  ): void {
    const age = (time - this.receivedAt) * 1000;
    const weight = weights(this.answer, this.answeredPlan?.eligible, age);
    const chosen =
      weight && this.answer
        ? this.answeredPlan?.projections[this.answer.choice]
        : undefined;
    const visible =
      (this.enabled && !!chosen) || (this.showCandidates && !!this.plan);
    this.group.visible = visible;
    this.layer.hidden = !visible;
    if (!visible) return;
    this.selected.visible = this.selectedGlow.visible =
      this.enabled && !!chosen;
    const plan = chosen ? this.answeredPlan : this.plan;
    for (const mesh of this.group.children as Ribbon[]) {
      mesh.material.uniforms.ego?.value.set(car.x, car.z, car.heading);
      mesh.material.uniforms.body?.value.set(
        car.width / 2 + 0.12,
        car.depth / 2 + 0.15,
      );
    }
    let selectedPoints: Point[] | null = null;
    if (chosen && this.enabled && this.answer && this.answeredPlan) {
      const candidate = this.answeredPlan.vectors[this.answer.choice];
      const path = pathsOf(this.answeredPlan)[this.answer.choice];
      if (candidate && path) {
        selectedPoints = animatePath(
          car,
          candidate,
          path,
          this.selectedAnimation,
          dt,
          paused,
        );
        updateRibbon(this.selected, selectedPoints, 0.2, 0.25);
        updateRibbon(this.selectedGlow, selectedPoints, 0.5, 0.195);
        (
          this.selected.material.uniforms.alpha as THREE.IUniform<number>
        ).value = 0.9;
        (
          this.selectedGlow.material.uniforms.alpha as THREE.IUniform<number>
        ).value = 0.15;
        this.selected.renderOrder = 5;
      }
    }
    for (const item of this.pool) {
      item.line.visible = item.glow.visible = false;
      item.label.hidden = true;
    }
    if (!this.showCandidates || !plan) return;
    // A stable spatial order keeps similar paths in the same animation slot
    // although every batch has new ids and values.
    const candidates = Object.entries(plan.vectors).sort(([, a], [, b]) => {
      const directionA = Math.sign(a.velocity_mps);
      const directionB = Math.sign(b.velocity_mps);
      return (
        directionB - directionA ||
        a.steering * directionA - b.steering * directionB
      );
    });
    const paths = pathsOf(plan);
    let index = 0;
    candidates.forEach(([id, candidate], slot) => {
      const item = this.pool[slot];
      const path = paths[id];
      if (!item || !path) return;
      const selected = !!weight?.[id]?.selected;
      const animated = animatePath(
        car,
        candidate,
        path,
        item.animation,
        dt,
        paused,
      );
      const points = selected && selectedPoints ? selectedPoints : animated;
      item.line.visible = !selected || !this.enabled;
      updateRibbon(item.line, points, selected ? 0.2 : 0.055, 0.22);
      (
        item.line.material.uniforms.tint as THREE.IUniform<THREE.Color>
      ).value.set(
        candidate.collision_predicted
          ? "#e86940"
          : candidate.velocity_mps < 0
            ? "#9a6bff"
            : !candidate.stays_on_road || !candidate.stays_in_lane
              ? "#e6a34b"
              : candidate.steering < -0.02
                ? "#38bcd6"
                : "#48a5ff",
      );
      (item.line.material.uniforms.alpha as THREE.IUniform<number>).value =
        candidate.collision_predicted ? 0.3 : 0.65;
      const end = points[
        Math.floor(VECTOR_STEPS * (0.55 + (index % 4) * 0.12))
      ] as Point;
      const screen = new THREE.Vector3(end.x, 0.7, end.z).project(camera);
      const probability = weight?.[id]?.probability;
      item.label.hidden =
        probability === undefined ||
        !candidate.velocity_mps ||
        screen.z > 1 ||
        screen.z < 0 ||
        Math.abs(screen.x) > 1 ||
        Math.abs(screen.y) > 1;
      item.label.dataset.vector = id;
      item.label.classList.toggle("selected", selected);
      index++;
      item.label.textContent =
        probability === undefined ? "" : `${Math.round(probability * 100)}%`;
      item.label.setAttribute(
        "aria-label",
        `${candidateName(candidate)}, ${Math.abs(candidate.velocity_mps).toFixed(1)} meters per second${selected ? ", selected" : ""}`,
      );
      item.label.style.opacity = selected ? "1" : "0.75";
      item.label.style.transform = `translate(${(screen.x * 0.5 + 0.5) * width}px,${(-0.5 * screen.y + 0.5) * height - (index % 3) * 17}px) translate(-50%,-50%)`;
    });
  }
}
