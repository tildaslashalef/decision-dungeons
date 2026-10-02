// Trees as branch meshes with instanced leaf cards, and instanced grass,
// both swaying in a shader wind. Seeded, so a world always grows the same.

import * as THREE from "three";
import { seeded } from "../../../../lib/random.ts";
import type { Tree, World } from "../../world/types.ts";
import { materials, metricUV, pbr, renderProfile } from "./materials.ts";

function leafTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const random = seeded(812);
  ctx.lineCap = "round";
  ctx.strokeStyle = "#544a2d";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(250, 490);
  ctx.quadraticCurveTo(230, 280, 260, 30);
  ctx.stroke();
  for (let row = 0; row < 10; row++)
    for (const side of [-1, 1]) {
      const y = 58 + row * 39;
      ctx.save();
      ctx.translate(250 + side * (22 + random() * 48), y);
      ctx.rotate(side * (-0.8 + random() * 0.35));
      const width = 23 + random() * 12;
      const length = 59 + random() * 30;
      const gradient = ctx.createLinearGradient(-width, 0, width, length);
      gradient.addColorStop(0, "#6b852b");
      gradient.addColorStop(0.5, "#466b23");
      gradient.addColorStop(1, "#203f18");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(0, -length / 2);
      ctx.bezierCurveTo(width, -length / 3, width, length / 4, 0, length / 2);
      ctx.bezierCurveTo(
        -width,
        length / 4,
        -width,
        -length / 3,
        0,
        -length / 2,
      );
      ctx.fill();
      ctx.strokeStyle = "#93a249a0";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, -length / 2);
      ctx.lineTo(0, length / 2);
      ctx.stroke();
      for (let vein = -2; vein <= 2; vein++) {
        ctx.beginPath();
        ctx.moveTo(0, vein * 10);
        ctx.lineTo(width * 0.7, vein * 10 - 12);
        ctx.moveTo(0, vein * 10);
        ctx.lineTo(-width * 0.7, vein * 10 - 12);
        ctx.stroke();
      }
      ctx.restore();
    }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

interface Leaf {
  treeId: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  rx: number;
  ry: number;
  rz: number;
  shade: number;
}

interface Card {
  mesh: THREE.InstancedMesh;
  index: number;
  matrix: THREE.Matrix4;
}

export class Vegetation {
  private random: () => number;
  /** The wind clock, shared by every foliage shader of this world. */
  private wind = { value: 0 };
  private leaves = new Map<string, Leaf[]>();
  private treeCards = new Map<string, Card[]>();
  private hiddenTrees = new Set<string>();
  private leafMaterial: THREE.MeshStandardMaterial;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
  ) {
    this.random = seeded(world.seed + 983);
    let leaves = materials.get("leaves") as
      | THREE.MeshStandardMaterial
      | undefined;
    if (!leaves) {
      leaves = new THREE.MeshStandardMaterial({
        map: leafTexture(),
        alphaTest: 0.38,
        side: THREE.DoubleSide,
        roughness: 0.87,
        emissive: "#253613",
        emissiveIntensity: 0.13,
      });
      materials.set("leaves", leaves);
    }
    // The shared material takes this world's wind uniform on each rebuild.
    this.leafMaterial = leaves;
    this.addWind(this.leafMaterial, 0.045);
    this.leafMaterial.needsUpdate = true;
  }

  private addWind(mat: THREE.Material, strength: number): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.windTime = this.wind;
      shader.vertexShader =
        `uniform float windTime;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
        #ifdef USE_INSTANCING
        float phase = instanceMatrix[3].x * 0.29 + instanceMatrix[3].z * 0.21;
        transformed.x += sin(windTime * 1.3 + phase + position.y * 2.0) * ${strength.toFixed(3)} * (position.y + 1.0);
        transformed.z += cos(windTime * 0.8 + phase) * ${(strength * 0.6).toFixed(3)};
        #endif`,
        );
    };
    mat.customProgramCacheKey = () => `foliage-wind-${strength}`;
  }

  /** Adds a tree's trunk and branches to `parent`; its leaves are instanced in `finish`. */
  tree(parent: THREE.Object3D, tree: Tree): void {
    const r = this.random;
    const height = tree.height * 1.25;
    const bark = pbr("bark", "#b8b0a0", 1.6);
    const branch = (a: THREE.Vector3, b: THREE.Vector3, radius: number) => {
      const direction = b.clone().sub(a);
      const geometry = new THREE.CylinderGeometry(
        radius * 0.4,
        radius,
        direction.length(),
        9,
      );
      metricUV(geometry, bark);
      const mesh = new THREE.Mesh(geometry, bark);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize(),
      );
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
    };
    const origin = new THREE.Vector3(tree.x, 0, tree.z);
    branch(
      origin,
      origin.clone().add(new THREE.Vector3(0.15, height * 0.86, 0.12)),
      height * 0.031,
    );
    for (let i = 0; i < 9; i++) {
      const a = i * 2.4 + r();
      const y = height * (0.28 + i * 0.048);
      branch(
        origin.clone().add(new THREE.Vector3(0, y, 0)),
        origin
          .clone()
          .add(
            new THREE.Vector3(
              Math.cos(a) * height * 0.23,
              y + height * 0.2,
              Math.sin(a) * height * 0.23,
            ),
          ),
        height * 0.012,
      );
    }
    const key = `${Math.floor(tree.x / 70)}:${Math.floor(tree.z / 70)}`;
    const leaves = this.leaves.get(key) ?? [];
    const pine = tree.kind === "pine";
    for (let i = 0; i < renderProfile.leafCards; i++) {
      const a = r() * Math.PI * 2;
      const u = r();
      const radial =
        Math.sqrt(r()) *
        height *
        (pine ? (1 - u) * 0.29 : Math.sqrt(1 - (u * 2 - 1) ** 2) * 0.31);
      leaves.push({
        treeId: tree.id,
        x: tree.x + Math.cos(a) * radial,
        y: height * (0.42 + u * 0.58),
        z: tree.z + Math.sin(a) * radial,
        scale: height * (pine ? 0.2 : 0.24),
        rx: (r() - 0.5) * Math.PI,
        ry: r() * Math.PI,
        rz: r() * Math.PI,
        shade: pine ? 0.7 + r() * 0.22 : 0.82 + r() * 0.3,
      });
    }
    this.leaves.set(key, leaves);
  }

  /** Builds the instanced canopies (one per 70 m cell, so distant ones cull) and the grass. */
  finish(): void {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (const leaves of this.leaves.values()) {
      const mesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        this.leafMaterial,
        leaves.length,
      );
      mesh.name = "leaf-canopy";
      leaves.forEach((leaf, i) => {
        dummy.position.set(leaf.x, leaf.y, leaf.z);
        dummy.rotation.set(leaf.rx, leaf.ry, leaf.rz);
        dummy.scale.setScalar(leaf.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const cards = this.treeCards.get(leaf.treeId) ?? [];
        cards.push({ mesh, index: i, matrix: dummy.matrix.clone() });
        this.treeCards.set(leaf.treeId, cards);
        color.setRGB(leaf.shade, leaf.shade, leaf.shade * 0.9);
        mesh.setColorAt(i, color);
      });
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: this.leafMaterial.map,
        alphaTest: 0.38,
        side: THREE.DoubleSide,
      });
      this.addWind(mesh.customDepthMaterial, 0.045);
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
    }
    this.grass();
  }

  private grass(): void {
    const r = this.random;
    const locations: { x: number; z: number }[] = [];
    const buildings = this.world.objects.filter((o) => o.type === "building");
    for (const parcel of this.world.objects) {
      if (parcel.type !== "parcel") continue;
      for (let i = 0; i < (parcel.park ? 600 : 200); i++) {
        const x = parcel.x + (r() - 0.5) * (parcel.width - 2);
        const z = parcel.z + (r() - 0.5) * (parcel.depth - 2);
        if (
          parcel.park &&
          (Math.abs(x - parcel.x) < 1.3 || Math.abs(z - parcel.z) < 1.3)
        )
          continue;
        if (
          buildings.some(
            (o) =>
              Math.abs(x - o.x) < o.width / 2 + 1 &&
              Math.abs(z - o.z) < o.depth / 2 + 1,
          )
        )
          continue;
        locations.push({ x, z });
      }
    }
    if (this.world.type === "highway") {
      for (const tree of this.world.objects)
        if (tree.type === "tree")
          for (let i = 0; i < 24; i++) {
            const x = tree.x + (r() - 0.5) * 8;
            locations.push({ x, z: tree.z + (r() - 0.5) * 8 });
          }
    }
    const verts: number[] = [];
    const normals: number[] = [];
    for (let blade = 0; blade < 5; blade++) {
      const x = (r() - 0.5) * 0.45;
      const z = (r() - 0.5) * 0.45;
      const height = 0.18 + r() * 0.28;
      verts.push(x - 0.035, 0, z, x + 0.035, 0, z, x + 0.12, height, z + 0.08);
      normals.push(0, 0.7, 0.7, 0, 0.7, 0.7, 0, 0.7, 0.7);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(verts, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(normals, 3),
    );
    const mat = new THREE.MeshStandardMaterial({
      color: "#586537",
      roughness: 1,
      side: THREE.DoubleSide,
    });
    this.addWind(mat, 0.025);
    const mesh = new THREE.InstancedMesh(geometry, mat, locations.length);
    const dummy = new THREE.Object3D();
    locations.forEach((p, i) => {
      dummy.position.set(p.x, 0.1, p.z);
      dummy.rotation.y = r() * Math.PI;
      dummy.scale.setScalar(0.6 + r() * 0.6);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.name = "grass-blades";
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
  }

  /** Thins the cards of trees replaced by detailed models nearby. */
  hideTrees(ids: Set<string>): void {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const id of new Set([...this.hiddenTrees, ...ids])) {
      if (this.hiddenTrees.has(id) === ids.has(id)) continue;
      for (const card of this.treeCards.get(id) ?? []) {
        card.mesh.setMatrixAt(
          card.index,
          ids.has(id) && card.index % 3 !== 0 ? zero : card.matrix,
        );
        card.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.hiddenTrees = ids;
  }

  update(time: number): void {
    this.wind.value = time;
  }
}
