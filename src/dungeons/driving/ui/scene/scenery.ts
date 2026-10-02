// Detailed Poly Haven models placed by instancing: streetlights along grid
// streets, shrubs by the trees, and detailed trees swapped in for the
// nearest leaf-card trees as the car moves.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { seeded } from "../../../../lib/random.ts";
import type { Junction, Tree, World } from "../../world/types.ts";
import { assetManager, materials, renderProfile } from "./materials.ts";
import type { Vegetation } from "./vegetation.ts";

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

interface Placement {
  x: number;
  y?: number;
  z: number;
  height: number;
  rotation?: number;
}

const assets = new Map<string, Promise<Part[]>>();

/** A model normalized to unit height, standing on the origin; cached per page. */
function loadAsset(name: string, file: string): Promise<Part[]> {
  let asset = assets.get(name);
  if (!asset) {
    asset = new GLTFLoader(assetManager)
      .loadAsync(`/models/${name}/${file}.glb`)
      .then(({ scene }) => {
        scene.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const normalize = new THREE.Matrix4()
          .makeScale(1 / size.y, 1 / size.y, 1 / size.y)
          .multiply(
            new THREE.Matrix4().makeTranslation(
              -center.x,
              -bounds.min.y,
              -center.z,
            ),
          );
        const parts: Part[] = [];
        scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const mat = object.material as THREE.MeshStandardMaterial;
          for (const value of Object.values(mat))
            if (value instanceof THREE.Texture)
              value.anisotropy = Math.min(4, renderProfile.anisotropy);
          mat.envMapIntensity = 0.5;
          materials.set(`scenery:${mat.uuid}`, mat);
          parts.push({
            geometry: object.geometry
              .clone()
              .applyMatrix4(normalize.clone().multiply(object.matrixWorld)),
            material: mat,
          });
        });
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh) object.geometry.dispose();
        });
        return parts;
      });
    assets.set(name, asset);
  }
  return asset;
}

/** Groups placements into square cells, so each cell's instances cull together. */
function chunks(locations: Placement[], cell: number): Placement[][] {
  const groups = new Map<string, Placement[]>();
  for (const location of locations) {
    const key = `${Math.floor(location.x / cell)}:${Math.floor(location.z / cell)}`;
    const group = groups.get(key) ?? [];
    group.push(location);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export class SceneryAssets {
  /** Cleared when the world is rebuilt, so late loads do not add to a dead scene. */
  active = true;
  readonly ready: Promise<void>;
  private nextUpdate = 0;
  private treeMeshes: THREE.InstancedMesh[] = [];
  private treeObjects: Tree[];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly vegetation: Vegetation,
  ) {
    this.treeObjects = world.objects.filter(
      (o): o is Tree => o.type === "tree",
    );
    this.ready = Promise.allSettled([
      renderProfile.detailedFoliage ? this.trees() : null,
      this.streetlights(),
      renderProfile.detailedFoliage ? this.shrubs() : null,
    ]).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          console.warn("Scenery model unavailable", result.reason);
    });
  }

  private instances(
    parts: Part[],
    locations: Placement[],
    name: string,
  ): THREE.InstancedMesh[] {
    const dummy = new THREE.Object3D();
    const meshes: THREE.InstancedMesh[] = [];
    for (const part of parts) {
      // Each world owns its GPU geometry; the cached templates survive a rebuild.
      const mesh = new THREE.InstancedMesh(
        part.geometry.clone(),
        part.material,
        locations.length,
      );
      mesh.name = name;
      locations.forEach((p, i) => {
        dummy.position.set(p.x, p.y ?? 0, p.z);
        dummy.rotation.set(0, p.rotation ?? 0, 0);
        dummy.scale.setScalar(p.height);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }

  private async trees(): Promise<void> {
    const parts = await loadAsset("tree_small_02", "tree");
    if (!this.active) return;
    this.treeMeshes = this.instances(
      parts,
      Array.from({ length: 36 }, () => ({ x: 0, z: 0, height: 0 })),
      "detailed-tree",
    );
    for (const mesh of this.treeMeshes) mesh.count = 0;
  }

  private async streetlights(): Promise<void> {
    if (this.world.type === "highway") return;
    const parts = await loadAsset("street_lamp_01", "lamp");
    if (!this.active) return;
    const locations: Placement[] = [];
    for (const edge of this.world.edges) {
      const a = this.world.byId[edge.a] as Junction;
      const b = this.world.byId[edge.b] as Junction;
      const h = Math.atan2(b.x - a.x, a.z - b.z);
      for (let distance = 26; distance < edge.length - 20; distance += 42) {
        const side = Math.round(distance / 42) % 2 ? -1 : 1;
        locations.push({
          x: a.x + Math.sin(h) * distance + Math.cos(h) * 7.25 * side,
          z: a.z - Math.cos(h) * distance + Math.sin(h) * 7.25 * side,
          height: 6.8,
          rotation: -h + (side * Math.PI) / 2,
        });
      }
    }
    for (const chunk of chunks(locations, 70))
      this.instances(parts, chunk, "streetlight");
  }

  private async shrubs(): Promise<void> {
    const parts = await loadAsset("shrub_01", "shrub");
    if (!this.active) return;
    const random = seeded(this.world.seed + 510);
    const locations = this.treeObjects
      .filter((_, i) => i % 3 === 0)
      .map((o) => {
        const height = 0.75 + random() * 0.65;
        return {
          x: o.x + 1.5,
          z: o.z - 1.2,
          height,
          rotation: random() * Math.PI * 2,
        };
      });
    for (const chunk of chunks(locations, 80))
      this.instances(parts, chunk, "landscape-shrub");
  }

  /** Swaps the 36 nearest trees (within 130 m) for detailed models, every 0.4 s. */
  update(player: { x: number; z: number }, time: number): void {
    if (!this.treeMeshes.length || time < this.nextUpdate) return;
    this.nextUpdate = time + 0.4;
    const nearby = this.treeObjects
      .map((o) => ({
        object: o,
        distance: Math.hypot(o.x - player.x, o.z - player.z),
      }))
      .filter((o) => o.distance < 130)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 36);
    const dummy = new THREE.Object3D();
    for (const mesh of this.treeMeshes) {
      mesh.count = nearby.length;
      nearby.forEach(({ object: tree }, i) => {
        dummy.position.set(tree.x, 0, tree.z);
        dummy.rotation.set(0, tree.x * 0.81 + tree.z * 0.37, 0);
        dummy.scale.setScalar(tree.height * 1.25);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.vegetation.hideTrees(new Set(nearby.map((o) => o.object.id)));
  }
}
