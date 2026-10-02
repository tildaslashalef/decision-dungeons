// Port Alder International at blue hour, in three.js: the runway with its
// markings and lights, the approach lights and their sequenced flasher,
// PAPI, taxiway and exits, the apron, terminal, hangars, and the tower,
// the town's lights on the horizon, and the aircraft, low-poly and lit
// (navigation lights, strobes, beacon, landing lights, cabin windows).
// Built from code; no asset files. Purely a view of the flights it is given.

import * as THREE from "three";
import { seeded } from "../../../lib/random.ts";
import {
  EXITS,
  HOLD,
  NM,
  RUNWAY_LENGTH,
  RUNWAY_WIDTH,
  TAXIWAY_Z,
  TYPES,
  type Wake,
} from "../sim.ts";

export type CameraMode = "tower" | "final" | "overview";
export const CAMERA_NAMES: Record<CameraMode, string> = {
  tower: "Tower cab",
  final: "Final approach",
  overview: "Overview",
};

/** What the scene draws of one flight this frame. */
export interface FlightView {
  id: string;
  type: string;
  livery: string;
  x: number;
  z: number;
  alt: number;
  heading: number;
  /** Nose-up angle, radians. */
  pitch: number;
  landingLights: boolean;
  visible: boolean;
}

const TOWER = { x: 1620, z: 330, cab: 58 };

/** A soft round glow, the texture of every light. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.18)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface LightSet {
  points: THREE.Points;
  colors: Float32Array;
  base: Float32Array;
}

/** Many small lights as one additive point cloud; colours can change per frame. */
function lightSet(
  glow: THREE.Texture,
  positions: number[],
  colors: number[],
  size: number,
): LightSet {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  const base = new Float32Array(colors);
  const live = new Float32Array(colors);
  geometry.setAttribute("color", new THREE.BufferAttribute(live, 3));
  // World-sized glows that never shrink below a few pixels: an airport's
  // lights stay crisp dots kilometres away, as they do to the eye.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: glow },
      size: { value: size },
      minPx: { value: 2.6 * Math.min(devicePixelRatio, 2) },
      scale: { value: 900 },
    },
    vertexShader: `
      attribute vec3 color;
      varying vec3 vColor;
      uniform float size;
      uniform float minPx;
      uniform float scale;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(minPx, size * scale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vColor * t.rgb * 1.6, t.a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return { points: new THREE.Points(geometry, material), colors: live, base };
}

const rgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** A flat quad lying on the ground. */
function patch(
  w: number,
  d: number,
  color: string,
  x: number,
  z: number,
  y = 0.02,
  rotation = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rotation;
  mesh.position.set(x, y, z);
  return mesh;
}

/** A word painted on the ground, as runway designators are. */
function painted(text: string, w: number, d: number): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#e9ecef";
  g.font = "bold 110px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 70);
  const texture = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.85,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** Lit windows: a canvas of warm rectangles, some dark. */
function windowTexture(
  cols: number,
  rows: number,
  seed: number,
): THREE.Texture {
  const rng = seeded(seed);
  const c = document.createElement("canvas");
  c.width = cols * 8;
  c.height = rows * 12;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#1a1d24";
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const lit = rng() < 0.7;
      g.fillStyle = lit ? (rng() < 0.2 ? "#cfe6ff" : "#ffd89a") : "#2a2f38";
      g.fillRect(i * 8 + 1, j * 12 + 2, 6, 8);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Craft {
  group: THREE.Group;
  strobes: THREE.Sprite[];
  beacon: THREE.Sprite;
  landing: THREE.Object3D;
}

/** A low-poly airliner facing +x, its size from its type. */
function buildCraft(type: string, livery: string, glow: THREE.Texture): Craft {
  const t = TYPES[type] ?? TYPES.A320;
  const length = t?.length ?? 38;
  const span = t?.span ?? 36;
  const heavy: Wake = t?.wake ?? "medium";
  const prop = type === "DH8D" || type === "PC12";
  const r =
    length * (heavy === "heavy" ? 0.05 : type === "PC12" ? 0.06 : 0.055);
  const group = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({
    color: "#e8eaee",
    roughness: 0.45,
    metalness: 0.25,
  });
  const paint = new THREE.MeshStandardMaterial({
    color: livery,
    roughness: 0.5,
    metalness: 0.2,
  });
  const grey = new THREE.MeshStandardMaterial({
    color: "#8a9099",
    roughness: 0.6,
    metalness: 0.4,
  });
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, length * 0.72, 14),
    white,
  );
  body.rotation.z = Math.PI / 2;
  group.add(body);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), white);
  nose.scale.set(2.1, 1, 1);
  nose.position.x = length * 0.36;
  group.add(nose);
  const tail = new THREE.Mesh(
    new THREE.ConeGeometry(r, length * 0.24, 14),
    white,
  );
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-length * 0.48, r * 0.25, 0);
  group.add(tail);
  // Cabin windows: a warm band along each side.
  const band = new THREE.MeshBasicMaterial({ color: "#ffd18a" });
  for (const side of [-1, 1]) {
    const w = new THREE.Mesh(
      new THREE.PlaneGeometry(length * 0.6, r * 0.16),
      band,
    );
    w.position.set(0, r * 0.35, side * (r + 0.02));
    if (side < 0) w.rotation.y = Math.PI;
    group.add(w);
  }
  const wingShape = (
    half: number,
    root: number,
    tip: number,
    sweep: number,
  ) => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(-sweep, half);
    s.lineTo(-sweep - tip, half);
    s.lineTo(-root, 0);
    s.closePath();
    return s;
  };
  const wing = (
    half: number,
    root: number,
    tip: number,
    sweep: number,
    material: THREE.Material,
  ) => {
    const g = new THREE.ExtrudeGeometry(wingShape(half, root, tip, sweep), {
      depth: Math.max(0.3, r * 0.12),
      bevelEnabled: false,
    });
    g.rotateX(Math.PI / 2);
    const right = new THREE.Mesh(g, material);
    const left = new THREE.Mesh(g, material);
    left.scale.z = -1;
    return [right, left];
  };
  const half = span / 2;
  for (const w of wing(
    half,
    length * 0.2,
    length * 0.06,
    prop ? length * 0.02 : half * 0.55,
    white,
  )) {
    w.position.set(length * 0.08, -r * 0.45, 0);
    group.add(w);
  }
  for (const w of wing(
    span * 0.17,
    length * 0.1,
    length * 0.04,
    span * 0.1,
    white,
  )) {
    w.position.set(-length * 0.4, r * 0.4, 0);
    group.add(w);
  }
  // The fin, in the operator's colour.
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(-length * 0.1, length * 0.18);
  finShape.lineTo(-length * 0.17, length * 0.18);
  finShape.lineTo(-length * 0.16, 0);
  finShape.closePath();
  const fin = new THREE.Mesh(
    new THREE.ExtrudeGeometry(finShape, { depth: 0.5, bevelEnabled: false }),
    paint,
  );
  fin.position.set(-length * 0.34, r * 0.6, -0.25);
  group.add(fin);
  if (!prop) {
    for (const side of [-1, 1]) {
      const engine = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.48, r * 0.42, length * 0.12, 12),
        grey,
      );
      engine.rotation.z = Math.PI / 2;
      engine.position.set(length * 0.12, -r * 1.05, side * span * 0.17);
      group.add(engine);
    }
  }
  const sprite = (color: string, scale: number) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    s.scale.setScalar(scale);
    return s;
  };
  const red = sprite("#ff2a2a", 5);
  red.position.set(length * 0.02 - half * 0.55, -r * 0.4, -half);
  const green = sprite("#2aff7a", 5);
  green.position.set(length * 0.02 - half * 0.55, -r * 0.4, half);
  group.add(red, green);
  const strobes = [
    sprite("#ffffff", 9),
    sprite("#ffffff", 9),
    sprite("#ffffff", 7),
  ];
  strobes[0]?.position.copy(red.position);
  strobes[1]?.position.copy(green.position);
  strobes[2]?.position.set(-length * 0.5, r * 0.3, 0);
  group.add(...strobes);
  const beacon = sprite("#ff3b30", 6);
  beacon.position.set(0, r * 1.05, 0);
  group.add(beacon);
  // Landing lights: a glow at the nose and a long faint beam ahead.
  const landing = new THREE.Group();
  landing.add(sprite("#fff6dd", 16));
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(14, 160, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#fff3cf",
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  beam.rotation.z = Math.PI / 2;
  beam.position.x = 80;
  landing.add(beam);
  landing.position.set(length * 0.4, -r * 0.6, 0);
  group.add(landing);
  return { group, strobes, beacon, landing };
}

export class TowerScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 1, 60000);
  private glow = glowTexture();
  private crafts = new Map<string, Craft>();
  private flasher: LightSet;
  private blinkers: { sprite: THREE.Sprite; period: number; phase: number }[] =
    [];
  private look = new THREE.Vector3(1200, 0, 0);
  private eye = new THREE.Vector3(TOWER.x, TOWER.cab, TOWER.z);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.scene.fog = new THREE.FogExp2("#463c5e", 0.00008);
    this.sky();
    this.scene.add(new THREE.HemisphereLight("#8f9dd6", "#3a3a2e", 2.4));
    const moon = new THREE.DirectionalLight("#aab8ff", 1.1);
    moon.position.set(-2000, 3000, -1500);
    this.scene.add(moon);
    this.ground();
    this.runway();
    this.airfield();
    this.flasher = this.approachLights();
    this.horizon();
  }

  private sky(): void {
    const geometry = new THREE.SphereGeometry(50000, 32, 16);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader:
        "varying vec3 v; void main(){ v = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader:
        "varying vec3 v; void main(){ float h = clamp(v.y, -0.1, 1.0); vec3 horizon = vec3(0.96,0.55,0.38); vec3 mid = vec3(0.25,0.29,0.55); vec3 top = vec3(0.04,0.06,0.15); vec3 c = h < 0.08 ? mix(horizon*0.9, mix(horizon, mid, 0.35), h/0.08) : mix(mix(horizon, mid, 0.35), mid, smoothstep(0.08,0.3,h)); c = mix(c, top, smoothstep(0.3,0.9,h)); float west = smoothstep(0.2, -1.0, v.x) * (1.0 - smoothstep(0.0,0.35,h)); c += vec3(0.25,0.08,0.02)*west; gl_FragColor = vec4(c,1.0); }",
    });
    this.scene.add(new THREE.Mesh(geometry, material));
    // Stars: the same sky every night.
    const rng = seeded(27);
    const positions: number[] = [];
    for (let i = 0; i < 1400; i++) {
      const theta = rng() * Math.PI * 2;
      const y = 0.15 + rng() * 0.85;
      const r = Math.sqrt(1 - y * y);
      positions.push(
        Math.cos(theta) * r * 45000,
        y * 45000,
        Math.sin(theta) * r * 45000,
      );
    }
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      ),
      new THREE.PointsMaterial({
        color: "#dfe6ff",
        size: 1.4,
        sizeAttenuation: false,
        fog: false,
        transparent: true,
        opacity: 0.8,
      }),
    );
    this.scene.add(stars);
  }

  private ground(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(90000, 90000),
      new THREE.MeshStandardMaterial({ color: "#36463a", roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    // Mown strips around the runway, a shade lighter.
    this.scene.add(
      patch(RUNWAY_LENGTH + 600, 300, "#34453a", RUNWAY_LENGTH / 2, 60, 0.01),
    );
  }

  private runway(): void {
    const mid = RUNWAY_LENGTH / 2;
    this.scene.add(
      patch(RUNWAY_LENGTH + 120, RUNWAY_WIDTH, "#4b4f58", mid, 0, 0.03),
    );
    const white = new THREE.MeshBasicMaterial({ color: "#d9dde3" });
    const mark = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), white);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.05, z);
      this.scene.add(m);
    };
    // Threshold bars at both ends, the centreline, the edge lines, the aiming points.
    for (const end of [6, RUNWAY_LENGTH - 6])
      for (let i = 0; i < 8; i++) {
        const z = (i - 3.5) * 4.8 + (i >= 4 ? 2 : -2);
        mark(30, 1.8, end === 6 ? 18 : RUNWAY_LENGTH - 18, z);
      }
    for (let x = 120; x < RUNWAY_LENGTH - 120; x += 50) mark(30, 0.9, x, 0);
    for (const side of [-1, 1]) {
      mark(RUNWAY_LENGTH, 0.9, mid, side * (RUNWAY_WIDTH / 2 - 1));
      mark(45, 6, 400, side * 7);
      mark(45, 6, RUNWAY_LENGTH - 400, side * 7);
    }
    const n27 = painted("27", 18, 9);
    n27.position.set(70, 0.06, 0);
    n27.rotation.z = -Math.PI / 2;
    this.scene.add(n27);
    const n09 = painted("09", 18, 9);
    n09.position.set(RUNWAY_LENGTH - 70, 0.06, 0);
    n09.rotation.z = Math.PI / 2;
    this.scene.add(n09);
    // Edge lights (amber toward the far end), centreline, threshold green, end red.
    const pos: number[] = [];
    const col: number[] = [];
    const add = (
      x: number,
      z: number,
      c: [number, number, number],
      y = 0.6,
    ) => {
      pos.push(x, y, z);
      col.push(...c);
    };
    for (let x = 0; x <= RUNWAY_LENGTH; x += 60)
      for (const side of [-1, 1])
        add(
          x,
          side * (RUNWAY_WIDTH / 2 + 1.5),
          rgb(x > RUNWAY_LENGTH - 600 ? "#ffb347" : "#fff4e0"),
        );
    for (let x = 15; x < RUNWAY_LENGTH; x += 15) {
      const left = RUNWAY_LENGTH - x;
      const c =
        left < 300 || (left < 900 && Math.round(x / 15) % 2)
          ? "#ff5a4a"
          : "#f2f4ff";
      add(x, 0, rgb(c), 0.15);
    }
    for (let z = -24; z <= 24; z += 3) {
      add(-2, z, rgb("#33ff88"));
      add(RUNWAY_LENGTH + 2, z, rgb("#ff3b30"));
    }
    this.scene.add(lightSet(this.glow, pos, col, 5).points);
    // PAPI: two white over two red, on the glide path.
    const papi: number[] = [];
    const papiCol: number[] = [];
    for (let i = 0; i < 4; i++) {
      papi.push(330, 1, -(RUNWAY_WIDTH / 2 + 18 + i * 9));
      papiCol.push(...rgb(i < 2 ? "#ffffff" : "#ff3030"));
    }
    this.scene.add(lightSet(this.glow, papi, papiCol, 9).points);
  }

  private approachLights(): LightSet {
    const steady: number[] = [];
    const steadyCol: number[] = [];
    const flash: number[] = [];
    const flashCol: number[] = [];
    for (let d = 30; d <= 900; d += 30) {
      for (let k = -2; k <= 2; k++) {
        steady.push(-d, 1.2, k * 1.1);
        steadyCol.push(...rgb("#fff1d6"));
      }
      if (d === 300)
        for (let k = -7; k <= 7; k++)
          if (Math.abs(k) > 2) {
            steady.push(-d, 1.2, k * 1.6);
            steadyCol.push(...rgb("#fff1d6"));
          }
      if (d >= 300) {
        flash.push(-d, 1.6, 0);
        flashCol.push(0, 0, 0);
      }
    }
    this.scene.add(lightSet(this.glow, steady, steadyCol, 5).points);
    const flasher = lightSet(this.glow, flash, flashCol, 14);
    this.scene.add(flasher.points);
    return flasher;
  }

  private airfield(): void {
    // Parallel taxiway, its exits, the holding point's connector.
    this.scene.add(
      patch(
        RUNWAY_LENGTH + 200,
        23,
        "#454950",
        RUNWAY_LENGTH / 2 - 60,
        TAXIWAY_Z,
        0.025,
      ),
    );
    this.scene.add(
      patch(23, TAXIWAY_Z, "#454950", HOLD.x, TAXIWAY_Z / 2, 0.026),
    );
    const blue: number[] = [];
    const blueCol: number[] = [];
    const green: number[] = [];
    const greenCol: number[] = [];
    for (let x = -120; x <= RUNWAY_LENGTH + 40; x += 30)
      for (const side of [-1, 1]) {
        if (side < 0 && EXITS.some((e) => x > e && x < e + 140)) continue;
        blue.push(x, 0.5, TAXIWAY_Z + side * 13);
        blueCol.push(...rgb("#3d6bff"));
      }
    for (const e of EXITS) {
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        const ease = k * k * (3 - 2 * k);
        green.push(e + 120 * k, 0.2, TAXIWAY_Z * ease);
        greenCol.push(...rgb("#2bff8a"));
      }
      // The exit's pavement: short quads along the curve.
      for (let i = 0; i < steps; i++) {
        const a = i / steps;
        const b = (i + 1) / steps;
        const za = TAXIWAY_Z * a * a * (3 - 2 * a);
        const zb = TAXIWAY_Z * b * b * (3 - 2 * b);
        const len = Math.hypot(120 / steps, zb - za);
        const q = patch(
          len + 4,
          22,
          "#454950",
          e + (120 * (a + b)) / 2,
          (za + zb) / 2,
          0.024,
          Math.atan2(zb - za, 120 / steps),
        );
        this.scene.add(q);
      }
    }
    for (let z = 60; z <= 60; z++)
      for (let k = -4; k <= 4; k++) {
        green.push(HOLD.x + k * 2.4, 0.4, z);
        greenCol.push(...rgb("#ff3326"));
      }
    this.scene.add(lightSet(this.glow, blue, blueCol, 4).points);
    this.scene.add(lightSet(this.glow, green, greenCol, 3.5).points);
    // Apron and terminal.
    const apron = patch(900, 220, "#5c5a52", 1500, 430, 0.02);
    // Floodlit concrete: the apron glows warm under its masts.
    (apron.material as THREE.MeshStandardMaterial).emissive.set("#2a2418");
    this.scene.add(apron);
    const terminal = new THREE.Mesh(new THREE.BoxGeometry(700, 22, 70), [
      new THREE.MeshStandardMaterial({ color: "#2b2f37" }),
      new THREE.MeshStandardMaterial({ color: "#2b2f37" }),
      new THREE.MeshStandardMaterial({ color: "#3a3f48" }),
      new THREE.MeshStandardMaterial({ color: "#2b2f37" }),
      new THREE.MeshStandardMaterial({
        map: windowTexture(90, 3, 7),
        emissive: "#ffffff",
        emissiveMap: windowTexture(90, 3, 7),
        emissiveIntensity: 0.9,
      }),
      new THREE.MeshStandardMaterial({
        map: windowTexture(90, 3, 8),
        emissive: "#ffffff",
        emissiveMap: windowTexture(90, 3, 8),
        emissiveIntensity: 0.9,
      }),
    ]);
    terminal.position.set(1500, 11, 590);
    this.scene.add(terminal);
    // Parked aircraft at the gates.
    const parked = ["A320", "B738", "E175", "A359", "B738"];
    parked.forEach((type, i) => {
      const craft = buildCraft(
        type,
        ["#c8102e", "#1d3f6e", "#2c5d8f", "#0a1d3d", "#304cb2"][i] as string,
        this.glow,
      );
      craft.landing.visible = false;
      craft.group.position.set(1230 + i * 130, 4, 505);
      craft.group.rotation.y = -Math.PI / 2;
      this.scene.add(craft.group);
    });
    // Hangars with lit doors.
    for (let i = 0; i < 3; i++) {
      const hangar = new THREE.Mesh(
        new THREE.BoxGeometry(90, 26, 70),
        new THREE.MeshStandardMaterial({ color: "#3b3f46", roughness: 0.8 }),
      );
      hangar.position.set(2350 + i * 120, 13, 470);
      this.scene.add(hangar);
      const door = new THREE.Mesh(
        new THREE.PlaneGeometry(70, 18),
        new THREE.MeshBasicMaterial({ color: "#ffe2a8" }),
      );
      door.position.set(2350 + i * 120, 9, 434.8);
      door.rotation.y = Math.PI;
      this.scene.add(door);
    }
    // The tower: shaft, glass cab, roof, beacon.
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(4.5, 6, TOWER.cab - 4, 16),
      new THREE.MeshStandardMaterial({ color: "#c9cdd3", roughness: 0.7 }),
    );
    shaft.position.set(TOWER.x, (TOWER.cab - 4) / 2, TOWER.z);
    const cab = new THREE.Mesh(
      new THREE.CylinderGeometry(10, 8, 7, 8),
      new THREE.MeshStandardMaterial({
        color: "#1f4a52",
        emissive: "#3fb6aa",
        emissiveIntensity: 0.55,
        roughness: 0.15,
        metalness: 0.6,
      }),
    );
    cab.position.set(TOWER.x, TOWER.cab, TOWER.z);
    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(11.5, 11, 1.5, 8),
      new THREE.MeshStandardMaterial({ color: "#2a2e35" }),
    );
    roof.position.set(TOWER.x, TOWER.cab + 4.2, TOWER.z);
    this.scene.add(shaft, cab, roof);
    const beacon = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glow,
        color: "#ff3b30",
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    beacon.scale.setScalar(12);
    beacon.position.set(TOWER.x, TOWER.cab + 8, TOWER.z);
    this.scene.add(beacon);
    this.blinkers.push({ sprite: beacon, period: 1.6, phase: 0 });
    // Windsock light and apron floodlights.
    const flood: number[] = [];
    const floodCol: number[] = [];
    for (let i = 0; i < 8; i++) {
      flood.push(1110 + i * 110, 24, 330);
      floodCol.push(...rgb("#ffe7c2"));
    }
    this.scene.add(lightSet(this.glow, flood, floodCol, 9).points);
  }

  private horizon(): void {
    // The town of Port Alder to the north and east, and a few masts with red lights.
    const rng = seeded(9);
    const pos: number[] = [];
    const col: number[] = [];
    for (let i = 0; i < 2600; i++) {
      const a = -0.4 + rng() * 2.6;
      const d = 4500 + rng() * rng() * 14000;
      pos.push(1500 + Math.cos(a) * d, 2 + rng() * 6, 600 + Math.sin(a) * d);
      col.push(
        ...rgb(rng() < 0.75 ? "#ffcf8a" : rng() < 0.5 ? "#ffffff" : "#9fd0ff"),
      );
    }
    this.scene.add(lightSet(this.glow, pos, col, 22).points);
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glow,
          color: "#ff2a2a",
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
        }),
      );
      s.scale.setScalar(60);
      s.position.set(
        -4000 + i * 2600,
        120 + (i % 3) * 40,
        5000 + (i % 2) * 2500,
      );
      this.scene.add(s);
      this.blinkers.push({ sprite: s, period: 2, phase: i * 0.3 });
    }
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Draws the flights at `time` (seconds, for blinking) from `mode`, watching `focus`. */
  render(
    time: number,
    flights: FlightView[],
    mode: CameraMode,
    focus: FlightView | null,
    dt: number,
  ): void {
    const seen = new Set<string>();
    for (const f of flights) {
      seen.add(f.id);
      let craft = this.crafts.get(f.id);
      if (!craft) {
        craft = buildCraft(f.type, f.livery, this.glow);
        this.crafts.set(f.id, craft);
        this.scene.add(craft.group);
      }
      craft.group.visible = f.visible;
      if (!f.visible) continue;
      const t = TYPES[f.type];
      const gear = (t?.length ?? 38) * 0.08;
      craft.group.position.set(f.x, f.alt + gear, f.z);
      craft.group.rotation.set(0, -f.heading, 0);
      craft.group.rotateZ(f.pitch);
      craft.landing.visible = f.landingLights;
      const s = time % 1;
      const on = s < 0.06 || (s > 0.14 && s < 0.2);
      for (const strobe of craft.strobes) strobe.visible = on && f.alt > 0.5;
      craft.beacon.visible = (time + f.x * 0.001) % 1.2 < 0.25;
    }
    for (const [id, craft] of this.crafts)
      if (!seen.has(id)) {
        this.scene.remove(craft.group);
        this.crafts.delete(id);
      }
    // The rabbit: one flash per bar running in toward the threshold, twice a second.
    const n = this.flasher.colors.length / 3;
    const lead = Math.floor(((time * 2) % 1) * n * 1.4);
    for (let i = 0; i < n; i++) {
      const lit = n - 1 - i === lead ? 1 : 0;
      this.flasher.colors[i * 3] = lit;
      this.flasher.colors[i * 3 + 1] = lit;
      this.flasher.colors[i * 3 + 2] = lit;
    }
    (
      this.flasher.points.geometry.getAttribute(
        "color",
      ) as THREE.BufferAttribute
    ).needsUpdate = true;
    for (const b of this.blinkers)
      b.sprite.visible = (time + b.phase) % b.period < b.period * 0.35;
    this.aim(mode, focus, dt);
    this.renderer.render(this.scene, this.camera);
  }

  private aim(mode: CameraMode, focus: FlightView | null, dt: number): void {
    const ease = 1 - Math.exp(-dt * 2.5);
    const eye = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (mode === "final") {
      const f = focus;
      const fx = f ? f.x : -2.5 * NM;
      const alt = f ? f.alt : 2.5 * NM * 0.0524;
      eye.set(fx - 140, alt + 28, (f?.z ?? 0) + 46);
      look.set(fx + 600, Math.max(0, alt - 40), f?.z ?? 0);
      this.camera.fov = 50;
    } else if (mode === "overview") {
      eye.set(-700, 420, 950);
      look.set(1000, 0, 80);
      this.camera.fov = 45;
    } else {
      eye.set(TOWER.x - 8, TOWER.cab + 1.5, TOWER.z - 6);
      // Far out on final, look between the aircraft and the threshold so the
      // runway stays in the frame; close in, follow it.
      if (focus && focus.x < -600)
        look.set(focus.x * 0.35, focus.alt * 0.35, focus.z * 0.35);
      else if (focus) look.set(focus.x, focus.alt, focus.z);
      else look.set(700, 0, 0);
      this.camera.fov = 40;
    }
    this.eye.lerp(eye, mode === "final" ? 1 : ease);
    this.look.lerp(look, mode === "final" ? 1 : ease);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.look);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      for (const material of Array.isArray(m) ? m : m ? [m] : [])
        material.dispose();
    });
  }
}
