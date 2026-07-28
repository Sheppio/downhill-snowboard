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

/** How far below eye level the backdrop's skirt reaches. */
const BACKDROP_BASE = -900;
/** Height of the shoulder ring where the visible mountain colour begins. */
const BACKDROP_SHOULDER = -70;
const BACKDROP_RADIUS = 900;
const BACKDROP_SEGMENTS = 180; // fine enough to resolve the highest ridge frequency

/**
 * Distant mountain range ringing the horizon.
 *
 * Two details matter, and the original version got both wrong so the peaks floated visibly
 * in mid-air:
 *
 *  1. It must follow the camera's **height**, not just its XZ. The mountain drops about 270m
 *     per kilometre travelled, so a backdrop pinned to world y=0 climbs into the sky as the
 *     player descends.
 *
 *  2. It needs a **skirt** reaching far below eye level. The terrain only extends a few
 *     hundred metres before fog takes over, so anything between that edge and the backdrop is
 *     open sky — and a range whose base sits above the terrain's far edge shows its cut-off
 *     bottom hanging in that gap. The skirt drops well below the sightline and fades to
 *     exactly the sky colour, so wherever terrain does not cover it, it is invisible.
 *
 * Built as a continuous ring rather than separate triangles, so it reads as a mountain range
 * with no gaps between peaks. Seeded, so the skyline is part of what makes a seed distinct.
 */
export function createBackdrop(scene: Scene, seed: number): Mesh {
  const rng = makeRng(seed ^ 0x517cc1b7);

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Triangle waves rather than sines, because sines give rounded humps and these want to read
  // as sharp alpine summits. Frequencies are integers so the ridgeline wraps seamlessly, and
  // deliberately high: the camera only ever sees about a sixth of the ring, so low
  // frequencies put a single broad mound on screen instead of a range of peaks.
  const phase = [rng.range(0, 1), rng.range(0, 1), rng.range(0, 1)];
  const tri = (x: number): number => {
    const f = x - Math.floor(x);
    return 1 - Math.abs(f * 2 - 1);
  };
  // Kept modest on purpose. At 900m these subtend about 9 degrees, roughly a sixth of the
  // vertical field of view — distant scenery framing the horizon. Twice this height filled
  // half the screen with pale grey and flattened the whole image.
  const ridgeAt = (t: number): number =>
    28 + 78 * tri(t * 9 + phase[0]!) + 34 * tri(t * 17 + phase[1]!) + 13 * tri(t * 31 + phase[2]!);

  for (let i = 0; i <= BACKDROP_SEGMENTS; i++) {
    const t = i / BACKDROP_SEGMENTS;
    const a = t * Math.PI * 2;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const peak = ridgeAt(t);

    // Three rings: invisible skirt, hazy shoulder, snowy summit
    positions.push(sin * BACKDROP_RADIUS, BACKDROP_BASE, cos * BACKDROP_RADIUS);
    positions.push(sin * BACKDROP_RADIUS, BACKDROP_SHOULDER, cos * BACKDROP_RADIUS);
    positions.push(sin * BACKDROP_RADIUS, peak, cos * BACKDROP_RADIUS);

    // Base is exactly the sky colour, so the skirt vanishes against it wherever terrain
    // does not already hide it. Above that, hazy blue lifting to snow — aerial perspective.
    const tint = 0.9 + 0.1 * tri(t * 5 + phase[2]!);
    colors.push(SKY_COLOUR.r, SKY_COLOUR.g, SKY_COLOUR.b, 1);
    colors.push(0.47 * tint, 0.66 * tint, 0.88 * tint, 1);
    colors.push(0.97 * tint, 0.985 * tint, 1.0 * tint, 1);
  }

  // Two quad bands per segment, wound to face inward toward the camera at the centre
  for (let i = 0; i < BACKDROP_SEGMENTS; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    for (let ring = 0; ring < 2; ring++) {
      const a0 = a + ring;
      const a1 = a + ring + 1;
      const b0 = b + ring;
      const b1 = b + ring + 1;
      indices.push(a0, b0, a1, a1, b0, b1);
    }
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
/** Peak particles per second at full carve. */
const MAX_EMIT_RATE = 900;

export class SnowSpray {
  private readonly system: ParticleSystem;
  private readonly emitter: Mesh;

  constructor(scene: Scene) {
    this.emitter = new Mesh("sprayEmitter", scene);
    this.emitter.isPickable = false;

    const ps = new ParticleSystem("spray", 1400, scene);
    ps.particleTexture = createSnowflakeTexture(scene);
    ps.emitter = this.emitter;
    ps.minEmitBox = new Vector3(-0.35, 0, -0.5);
    ps.maxEmitBox = new Vector3(0.35, 0.1, 0.3);

    ps.color1 = new Color4(1, 1, 1, 0.95);
    ps.color2 = new Color4(0.86, 0.94, 1, 0.85);
    ps.colorDead = new Color4(1, 1, 1, 0);

    ps.minSize = 0.16;
    ps.maxSize = 0.55;
    ps.minLifeTime = 0.3;
    ps.maxLifeTime = 0.7;
    ps.emitRate = 0;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.gravity = new Vector3(0, -7, 0);
    // Directions are world space, so keep the cone mostly vertical and outward — it then
    // reads as a rooster tail whichever way the rider happens to be pointing.
    ps.direction1 = new Vector3(-1.8, 1.8, -1.8);
    ps.direction2 = new Vector3(1.8, 4.0, 1.8);
    ps.minEmitPower = 1.4;
    ps.maxEmitPower = 4.2;
    ps.updateSpeed = 0.016;
    ps.start();

    this.system = ps;
  }

  /**
   * `intensity` 0..1 — how hard the board is being driven into the snow right now.
   * `edge` -1..1 — which edge is being carved, so the spray comes off that side of the board
   * rather than from under the middle of it.
   */
  update(x: number, y: number, z: number, heading: number, intensity: number, edge = 0): void {
    // Babylon leaves `manualEmitCount` at 0 once it has consumed a burst, and its update
    // treats *any* value greater than -1 as "manual mode" — so it then emits zero particles
    // and never looks at emitRate again. One landing or crash burst would therefore kill all
    // rate-based spray for the rest of the page session. Restoring -1 hands control back.
    // Checking for exactly 0 matters: a burst queued earlier this frame is still pending.
    if (this.system.manualEmitCount === 0) this.system.manualEmitCount = -1;

    this.emitter.position.set(x, y, z);
    this.emitter.rotation.y = heading;

    const bias = clamp01(Math.abs(edge)) * Math.sign(edge) * 0.5;
    this.system.minEmitBox.x = -0.4 + bias;
    this.system.maxEmitBox.x = 0.4 + bias;

    const t = clamp01(intensity);
    this.system.emitRate = t * MAX_EMIT_RATE;
    // Harder carves throw bigger, longer-lived clumps, not just more of them
    this.system.maxSize = 0.5 + t * 0.5;
    this.system.maxLifeTime = 0.6 + t * 0.5;
  }

  burst(x: number, y: number, z: number): void {
    this.emitter.position.set(x, y, z);
    this.system.manualEmitCount = 160;
  }

  stop(): void {
    this.system.emitRate = 0;
  }

  dispose(): void {
    this.system.dispose();
    this.emitter.dispose();
  }
}
