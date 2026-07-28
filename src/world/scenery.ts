/**
 * Sky, light, fog and weather — everything that sells "bright sunny mountain".
 *
 * Deliberately cheap: one hemispheric light, one directional light, exponential fog, no
 * shadow maps and no post-processing pipeline by default. On a phone the frame budget is
 * better spent on resolution and a steady 60fps than on effects the cartoon style does not
 * need.
 */

import type { Scene } from "@babylonjs/core/scene";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Scene as SceneCtor } from "@babylonjs/core/scene";

import { makeRng } from "../core/rng";
import { clamp01 } from "../core/math";

export const SKY_COLOUR = new Color3(0.31, 0.76, 0.97);

/** Distance at which terrain fades fully into the sky. Matched to the terrain view distance. */
const FOG_DENSITY = 0.0045;

export function setupSky(scene: Scene): { sun: DirectionalLight } {
  scene.clearColor = new Color4(SKY_COLOUR.r, SKY_COLOUR.g, SKY_COLOUR.b, 1);

  // Fog colour must match the sky exactly, or the horizon shows a visible seam
  scene.fogMode = SceneCtor.FOGMODE_EXP2;
  scene.fogColor = SKY_COLOUR.clone();
  scene.fogDensity = FOG_DENSITY;

  // Sky above, bounced snow-light below. Ambient occlusion for free, essentially.
  const ambient = new HemisphericLight("ambient", new Vector3(0.1, 1, 0.1), scene);
  ambient.diffuse = new Color3(1, 0.99, 0.94);
  ambient.groundColor = new Color3(0.52, 0.68, 0.86); // cool bounce off the snow
  ambient.intensity = 0.82;

  // Warm low sun from behind-left, so slopes facing the player catch the light
  const sun = new DirectionalLight("sun", new Vector3(-0.45, -0.82, 0.36), scene);
  sun.diffuse = new Color3(1, 0.95, 0.8);
  sun.specular = new Color3(0.7, 0.75, 0.85);
  sun.intensity = 1.15;

  return { sun };
}

/**
 * Distant mountain peaks ringing the horizon.
 *
 * One static mesh parented to the camera's XZ position, so it never needs regenerating and
 * always sits at the horizon. Seeded, so the backdrop is part of what makes a seed distinct.
 */
export function createBackdrop(scene: Scene, seed: number): Mesh {
  const rng = makeRng(seed ^ 0x517cc1b7);
  const peaks = 34;
  const radius = 900;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < peaks; i++) {
    const a0 = (i / peaks) * Math.PI * 2;
    const a1 = ((i + 1.35) / peaks) * Math.PI * 2; // overlap so there are no gaps
    const mid = (a0 + a1) / 2;
    const height = rng.range(110, 260);
    const dist = radius * rng.range(0.85, 1.15);

    const base = positions.length / 3;
    positions.push(Math.sin(a0) * dist, -40, Math.cos(a0) * dist);
    positions.push(Math.sin(a1) * dist, -40, Math.cos(a1) * dist);
    positions.push(Math.sin(mid) * dist, height, Math.cos(mid) * dist);

    // Hazy blue at the base fading to bright snow at the summit — cheap aerial perspective
    const tint = rng.range(0.86, 1.0);
    colors.push(0.55 * tint, 0.72 * tint, 0.88 * tint, 1);
    colors.push(0.55 * tint, 0.72 * tint, 0.88 * tint, 1);
    colors.push(0.98 * tint, 0.99 * tint, 1.0 * tint, 1);

    indices.push(base, base + 2, base + 1);
  }

  const mesh = new Mesh("backdrop", scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.colors = colors;
  vd.indices = indices;
  vd.normals = [];
  VertexData.ComputeNormals(positions, indices, vd.normals);
  vd.applyToMesh(mesh);

  const mat = new StandardMaterial("backdropMat", scene);
  mat.disableLighting = true; // flat poster-like peaks; lighting them fights the fog
  mat.emissiveColor = new Color3(1, 1, 1);
  mat.backFaceCulling = false;
  // Fog must NOT touch the backdrop. At 900m the exponential fog is effectively opaque, so
  // fogged peaks are just sky — the horizon vanishes entirely. Painting them crisply behind
  // the fading terrain is both cheaper and the look we want.
  mat.fogEnabled = false;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.applyFog = false;

  return mesh;
}

/** A soft round white blob, generated at runtime so there is no texture file to ship. */
function createSnowflakeTexture(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture("snowflake", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.85)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * Snow thrown up by the board.
 *
 * Emission rate is driven from steer and speed, so the spray is a readout of how hard the
 * player is carving — it makes the central mechanic visible rather than just felt.
 */
export class SnowSpray {
  private readonly system: ParticleSystem;
  private readonly emitter: Mesh;

  constructor(scene: Scene) {
    this.emitter = new Mesh("sprayEmitter", scene);
    this.emitter.isPickable = false;

    const ps = new ParticleSystem("spray", 420, scene);
    ps.particleTexture = createSnowflakeTexture(scene);
    ps.emitter = this.emitter;
    ps.minEmitBox = new Vector3(-0.35, 0, -0.5);
    ps.maxEmitBox = new Vector3(0.35, 0.1, 0.3);

    ps.color1 = new Color4(1, 1, 1, 0.95);
    ps.color2 = new Color4(0.86, 0.94, 1, 0.85);
    ps.colorDead = new Color4(1, 1, 1, 0);

    ps.minSize = 0.14;
    ps.maxSize = 0.52;
    ps.minLifeTime = 0.22;
    ps.maxLifeTime = 0.62;
    ps.emitRate = 0;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.gravity = new Vector3(0, -7, 0);
    ps.direction1 = new Vector3(-1.4, 1.6, -2.2);
    ps.direction2 = new Vector3(1.4, 3.2, -0.4);
    ps.minEmitPower = 1.2;
    ps.maxEmitPower = 3.4;
    ps.updateSpeed = 0.016;
    ps.start();

    this.system = ps;
  }

  /** `intensity` 0..1 — how hard the board is being driven into the snow right now. */
  update(x: number, y: number, z: number, heading: number, intensity: number): void {
    this.emitter.position.set(x, y, z);
    this.emitter.rotation.y = heading;
    this.system.emitRate = clamp01(intensity) * 320;
  }

  burst(x: number, y: number, z: number): void {
    this.emitter.position.set(x, y, z);
    this.system.manualEmitCount = 90;
  }

  stop(): void {
    this.system.emitRate = 0;
  }

  dispose(): void {
    this.system.dispose();
    this.emitter.dispose();
  }
}
