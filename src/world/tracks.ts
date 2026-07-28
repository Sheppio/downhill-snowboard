/**
 * The line the board cuts in the snow.
 *
 * A single ribbon mesh built from a ring buffer of the rider's recent positions. Rebuilt only
 * when a new sample is added — every 0.7m of travel rather than every frame — and the whole
 * thing is one draw call of a few hundred vertices.
 *
 * Two details do most of the work in making it read as a real track rather than a stripe:
 *
 *  - Each edge vertex takes its height from the terrain *at that vertex*, not from the
 *    rider's centre. On a bank the two edges of the board sit at noticeably different
 *    heights, and a ribbon that ignores that visibly floats on one side.
 *
 *  - No sample is laid while airborne, and the quad spanning a landing is dropped. Jumps
 *    therefore leave a clean gap in the trail, which sells the airtime better than the
 *    airtime itself does.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { clamp01 } from "../core/math";
import type { TerrainField } from "./terrain";

/** How many positions to remember. At 0.7m spacing this is a trail about 170m long. */
const MAX_SAMPLES = 240;
/** Distance the rider must cover before another sample is laid, in metres. */
const SAMPLE_SPACING = 0.7;

/** Half-width of the cut, in metres. The board is about 0.32m across. */
const BASE_HALF_WIDTH = 0.17;
/** Extra half-width at full lock — a hard carve digs a broader trench. */
const CARVE_HALF_WIDTH = 0.13;

/** Lift above the snow. Enough to beat depth precision, too small to see as a step. */
const HOVER = 0.045;

/** Fraction of the trail's length spent fading out at the far end. */
const FADE_FRACTION = 0.45;
const MAX_ALPHA = 0.5;

export class SnowTracks {
  private readonly mesh: Mesh;
  private readonly material: StandardMaterial;

  // Ring buffer. Each sample contributes two vertices, one per edge of the board.
  private readonly px = new Float32Array(MAX_SAMPLES * 2);
  private readonly py = new Float32Array(MAX_SAMPLES * 2);
  private readonly pz = new Float32Array(MAX_SAMPLES * 2);
  /** True where the sample begins a new stroke, so the quad before it is not drawn. */
  private readonly broken = new Uint8Array(MAX_SAMPLES);

  private head = 0;
  private count = 0;
  private lastX = 0;
  private lastZ = 0;
  private wasAirborne = false;

  private readonly positions = new Float32Array(MAX_SAMPLES * 2 * 3);
  private readonly colors = new Float32Array(MAX_SAMPLES * 2 * 4);

  constructor(
    scene: Scene,
    private readonly field: TerrainField,
  ) {
    const mesh = new Mesh("tracks", scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(MAX_SAMPLES * 2 * 3);
    vd.colors = new Float32Array(MAX_SAMPLES * 2 * 4);

    // Two triangles per gap between consecutive samples. The index buffer never changes;
    // unused or broken quads are hidden by collapsing their vertices and zeroing alpha.
    const indices: number[] = [];
    for (let i = 0; i < MAX_SAMPLES - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    vd.indices = indices;
    vd.normals = new Float32Array(MAX_SAMPLES * 2 * 3).fill(0);
    for (let i = 1; i < MAX_SAMPLES * 2 * 3; i += 3) vd.normals[i] = 1; // all facing up
    vd.applyToMesh(mesh, true);

    const mat = new StandardMaterial("tracksMat", scene);
    mat.disableLighting = true; // a flat tint reads as compressed snow; lighting muddies it
    mat.emissiveColor = new Color3(0.44, 0.6, 0.82);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    // Polygon offset. The ribbon is very nearly coplanar with the terrain, and the small
    // hover alone is not reliably enough to stop it z-fighting at distance.
    mat.zOffset = -6;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.hasVertexAlpha = true; // alpha comes from the vertex colours, for the fade
    mesh.alphaIndex = 5; // after the terrain, before the spray

    this.mesh = mesh;
    this.material = mat;
    this.clear();
  }

  /** Drop the whole trail. Called when a run starts. */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.wasAirborne = false;
    this.positions.fill(0);
    this.colors.fill(0);
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions, true);
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors);
  }

  setEnabled(on: boolean): void {
    this.mesh.setEnabled(on);
  }

  /**
   * Lay track under the rider. Safe to call every frame; it only does work when the rider
   * has covered enough ground for another sample.
   */
  update(x: number, z: number, heading: number, steer: number, airborne: boolean): void {
    if (airborne) {
      this.wasAirborne = true;
      return;
    }

    const moved = Math.hypot(x - this.lastX, z - this.lastZ);
    if (this.count > 0 && moved < SAMPLE_SPACING) return;

    // Perpendicular to travel: forward is (sin h, 0, cos h), so right is (cos h, 0, -sin h)
    const halfWidth = BASE_HALF_WIDTH + CARVE_HALF_WIDTH * clamp01(Math.abs(steer));
    const rx = Math.cos(heading) * halfWidth;
    const rz = -Math.sin(heading) * halfWidth;

    const slot = this.head;
    const a = slot * 2;
    const b = a + 1;

    // Terrain height sampled per edge, so the ribbon banks with the surface
    this.px[a] = x - rx;
    this.pz[a] = z - rz;
    this.py[a] = this.field.heightAt(this.px[a]!, this.pz[a]!) + HOVER;

    this.px[b] = x + rx;
    this.pz[b] = z + rz;
    this.py[b] = this.field.heightAt(this.px[b]!, this.pz[b]!) + HOVER;

    this.broken[slot] = this.wasAirborne || this.count === 0 ? 1 : 0;
    this.wasAirborne = false;

    this.head = (this.head + 1) % MAX_SAMPLES;
    if (this.count < MAX_SAMPLES) this.count++;
    this.lastX = x;
    this.lastZ = z;

    this.rebuild();
  }

  /** Write the ring buffer out in oldest-to-newest order. */
  private rebuild(): void {
    const { positions, colors, count } = this;
    const oldest = (this.head - count + MAX_SAMPLES) % MAX_SAMPLES;

    for (let i = 0; i < MAX_SAMPLES; i++) {
      const out = i * 2;

      if (i >= count) {
        // Unused slot: collapse it and make it invisible
        for (let k = 0; k < 2; k++) {
          positions[(out + k) * 3] = 0;
          positions[(out + k) * 3 + 1] = 0;
          positions[(out + k) * 3 + 2] = 0;
          colors[(out + k) * 4 + 3] = 0;
        }
        continue;
      }

      const slot = (oldest + i) % MAX_SAMPLES;
      const age = 1 - i / Math.max(1, count - 1); // 0 at the newest sample, 1 at the oldest
      // Hold full strength for the fresh part of the trail, then fade out
      const alpha = MAX_ALPHA * (1 - clamp01((age - (1 - FADE_FRACTION)) / FADE_FRACTION));

      // A quad is drawn from sample i to i+1, so a break at i+1 must hide the quad at i
      const nextSlot = (oldest + i + 1) % MAX_SAMPLES;
      const hidden = i + 1 < count && this.broken[nextSlot] === 1;

      for (let k = 0; k < 2; k++) {
        const src = slot * 2 + k;
        const dst = out + k;
        positions[dst * 3] = this.px[src]!;
        positions[dst * 3 + 1] = this.py[src]!;
        positions[dst * 3 + 2] = this.pz[src]!;
        colors[dst * 4] = 1;
        colors[dst * 4 + 1] = 1;
        colors[dst * 4 + 2] = 1;
        colors[dst * 4 + 3] = hidden ? 0 : alpha;
      }
    }

    this.mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, colors);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}
