// Shared materials, textures, and asset loading for the driving scene.
// Materials are cached by key and live as long as the page: rebuilding a
// world reuses them, so only per-world geometry is disposed.

import * as THREE from "three";

/** Rendering quality, the same on phones and desktops. */
export const renderProfile = {
  pixelRatio: 1.5,
  antialias: true,
  shadowSize: 2048,
  detailedFoliage: true,
  leafCards: 120,
  anisotropy: 8,
};

/** Every model and texture load goes through this manager, so readiness can be awaited. */
export const assetManager = new THREE.LoadingManager();
let idle = true;
const waiting = new Set<() => void>();
assetManager.onStart = () => {
  idle = false;
};
assetManager.onLoad = () => {
  idle = true;
  for (const resolve of waiting) resolve();
  waiting.clear();
};

/** Resolves once nothing is loading, nested textures included. */
export function assetsReady(): Promise<void> {
  return idle
    ? Promise.resolve()
    : new Promise((resolve) => waiting.add(resolve));
}

export const materials = new Map<string, THREE.Material>();
const loader = new THREE.TextureLoader(assetManager);
const maps = new Map<string, THREE.Texture>();

function texture(
  name: string,
  kind: "color" | "normal" | "roughness",
): THREE.Texture {
  const key = `${name}-${kind}`;
  let value = maps.get(key);
  if (!value) {
    value = loader.load(`/textures/${key}.jpg`);
    value.wrapS = value.wrapT = THREE.RepeatWrapping;
    value.anisotropy = renderProfile.anisotropy;
    if (kind === "color") value.colorSpace = THREE.SRGBColorSpace;
    maps.set(key, value);
  }
  return value;
}

/** A tinted Poly Haven surface whose texture repeats every `scale` meters. */
export function pbr(
  name: string,
  tint = "#ffffff",
  scale = 3,
): THREE.MeshStandardMaterial {
  const key = `${name}:${tint}`;
  let value = materials.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!value) {
    const normal = name === "grass" ? 0.5 : 0.65;
    value = new THREE.MeshStandardMaterial({
      color: tint,
      map: texture(name, "color"),
      normalMap: texture(name, "normal"),
      roughnessMap: texture(name, "roughness"),
      normalScale: new THREE.Vector2(normal, normal),
      roughness: 0.95,
      metalness: 0,
    });
    value.userData.metersPerTile = scale;
    materials.set(key, value);
  }
  return value;
}

/** Flat colors that stand for a textured surface family. */
const FAMILIES: Record<string, [string, string, number]> = {
  "#73817e": ["asphalt", "#d2d5d9", 5],
  "#70817c": ["asphalt", "#c6cbd2", 5],
  "#6d7e79": ["asphalt", "#d2d5d9", 5],
  "#d8d6c9": ["pavement", "#d7d4ca", 2.5],
  "#d2c9a7": ["pavement", "#d1c7af", 2.5],
  "#b2c5a0": ["grass", "#b4bf91", 8],
  "#9eb890": ["grass", "#a5b781", 8],
  "#adbf9d": ["grass", "#bec598", 8],
  "#94ad85": ["grass", "#99ad83", 8],
  "#a8b89c": ["grass", "#afbb8a", 8],
  "#86755c": ["bark", "#b8b0a0", 1.6],
};

export type Paint = string | THREE.Material;

/** A material for a color (textured when the color names a surface family), or the material itself. */
export function material(color: Paint): THREE.Material {
  if (typeof color !== "string") return color;
  const cached = materials.get(color);
  if (cached) return cached;
  const family = FAMILIES[color];
  const value = family
    ? pbr(...family)
    : new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0 });
  materials.set(color, value);
  return value;
}

export function physical(
  name: string,
  options: THREE.MeshPhysicalMaterialParameters,
): THREE.MeshPhysicalMaterial {
  let value = materials.get(name) as THREE.MeshPhysicalMaterial | undefined;
  if (!value) {
    value = new THREE.MeshPhysicalMaterial(options);
    materials.set(name, value);
  }
  return value;
}

/** UVs in meters, so a texture keeps the same grain on every block. */
export function metricUV<G extends THREE.BufferGeometry>(
  geometry: G,
  mat: THREE.Material,
): G {
  const scale = mat.userData.metersPerTile as number | undefined;
  if (!scale) return geometry;
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const x = Math.abs(normal.getX(i));
    const y = Math.abs(normal.getY(i));
    const z = Math.abs(normal.getZ(i));
    uv[i * 2] = (x > y && x > z ? position.getZ(i) : position.getX(i)) / scale;
    uv[i * 2 + 1] =
      (y >= x && y >= z ? position.getZ(i) : position.getY(i)) / scale;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}
