/**
 * Terrain: the height field, and the streaming mesh that renders it.
 *
 * Two distinct jobs live here, deliberately kept separate:
 *
 *  1. `TerrainField` — the pure maths. `heightAt(x, z)` is a stateless function that anyone
 *     can call for any point at any time. The rider samples it directly instead of colliding
 *     with a physics heightfield, which is exact, cheap, and immune to the seam-catching and
 *     tunnelling that plague rigid bodies on streamed terrain.
 *
 *  2. `TerrainRenderer` — pooled chunk meshes that follow the player. Purely cosmetic; the
 *     game would play identically with the meshes switched off.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { fbm2 } from "../core/noise";
import { clamp01, lerp } from "../core/math";
import {
  SLOPE,
  bankProfile,
  centreX,
  halfWidth,
  makeCourseParams,
  type CourseParams,
} from "./course";

// --- Height field tuning ------------------------------------------------------------------
//
// UNDULATION_AMP is bounded by a hard gameplay invariant: the mountain must *always* descend
// along the fall line, or the rider can stall on a counter-slope and the run dies. For fBm
// with gain 0.5 and lacunarity 2, every octave contributes about equally to the gradient, so
// the worst-case along-track slope is roughly `UNDULATION_AMP * 2*PI * octaves / scaleZ`.
// Stretching the features along z (scaleZ > scaleX) buys visible rolling terrain while
// keeping that number under SLOPE. `terrain.test.ts` asserts the invariant numerically across
// many seeds — if you raise these, that test is what will catch you.

// Measured: at 3.6 the steepest roller still descends at ~0.10 against a 0.268 fall line,
// giving a comfortable margin. Roughly 2.25 would reach flat.
const UNDULATION_AMP = 3.6;
const UNDULATION_SCALE_X = 38;
const UNDULATION_SCALE_Z = 95;

/** Fine ripples for surface interest. Small enough not to affect the gradient meaningfully. */
const RIPPLE_AMP = 0.22;
const RIPPLE_SCALE = 7;

/** Undulation is flattened on the banks so the walls stay clean and readable. */
const BANK_UNDULATION_DAMP = 0.25;

export class TerrainField {
  readonly params: CourseParams;
  private readonly undulationSeed: number;
  private readonly rippleSeed: number;

  constructor(readonly seed: number) {
    this.params = makeCourseParams(seed);
    this.undulationSeed = seed ^ 0x1f83d9ab;
    this.rippleSeed = seed ^ 0x5be0cd19;
  }

  /**
   * Ground height at any point. Pure function of the seed and coordinates — no state, no
   * ordering, so every player on a seed gets the identical mountain.
   */
  heightAt(x: number, z: number): number {
    const cx = centreX(this.params, z);
    const hw = halfWidth(this.params, z);
    const dist = Math.abs(x - cx);

    // Banks
    const bank = bankProfile(dist, hw);

    // Flatten the rolling undulation as we climb out of the floor onto the walls
    const bankT = clamp01((dist - hw * 0.6) / (hw * 0.4));
    const amp = lerp(UNDULATION_AMP, UNDULATION_AMP * BANK_UNDULATION_DAMP, bankT);

    const undulation =
      fbm2(this.undulationSeed, x, z, {
        octaves: 3,
        gain: 0.5,
        scale: UNDULATION_SCALE_X,
        scaleZ: UNDULATION_SCALE_Z,
      }) * amp;

    const ripple =
      fbm2(this.rippleSeed, x, z, { octaves: 2, gain: 0.5, scale: RIPPLE_SCALE }) * RIPPLE_AMP;

    // The rider descends toward +z, so height falls as z rises.
    return -z * SLOPE + bank + undulation + ripple;
  }

  /**
   * Surface gradient by central differences: [dh/dx, dh/dz].
   *
   * Central rather than forward differences because the bank profile has a smooth but rapidly
   * changing second derivative, and forward differences visibly lag on it.
   */
  gradientAt(x: number, z: number, eps = 0.6): [number, number] {
    const dx = (this.heightAt(x + eps, z) - this.heightAt(x - eps, z)) / (2 * eps);
    const dz = (this.heightAt(x, z + eps) - this.heightAt(x, z - eps)) / (2 * eps);
    return [dx, dz];
  }

  /** Unit downhill direction on the XZ plane, i.e. the fall line at this point. */
  fallLine(x: number, z: number): [number, number] {
    const [dx, dz] = this.gradientAt(x, z);
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return [0, -1];
    return [-dx / len, -dz / len];
  }
}

// --- Rendering ----------------------------------------------------------------------------

/** Chunk footprint in metres. */
const CHUNK_SIZE = 64;
/** Quads per side. 32 → 2 m grid, fine enough to render the bank transition cleanly. */
const CHUNK_SUBDIV = 32;

/** How far ahead of the rider terrain exists. Fog is tuned to hide the far edge. */
const VIEW_AHEAD = 260;
const VIEW_BEHIND = 70;

/** Lateral margin beyond the out-of-bounds line, so the player never sees the world end. */
const LATERAL_MARGIN = 70;

/** Chunk rebuilds are amortised — more than this per frame causes a visible hitch. */
const MAX_BUILDS_PER_FRAME = 2;

const VERTS_PER_CHUNK = CHUNK_SUBDIV * CHUNK_SUBDIV * 6; // non-indexed: 2 triangles per quad

interface Chunk {
  mesh: Mesh;
  cx: number;
  cz: number;
  key: string;
}

function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export class TerrainRenderer {
  private readonly material: StandardMaterial;
  private readonly live = new Map<string, Chunk>();
  private readonly pool: Chunk[] = [];
  private readonly pending: { cx: number; cz: number }[] = [];

  // Scratch buffers, reused for every chunk build so streaming allocates nothing
  private readonly heights = new Float32Array((CHUNK_SUBDIV + 1) * (CHUNK_SUBDIV + 1));
  private readonly positions = new Float32Array(VERTS_PER_CHUNK * 3);
  private readonly normals = new Float32Array(VERTS_PER_CHUNK * 3);
  private readonly colors = new Float32Array(VERTS_PER_CHUNK * 4);

  constructor(
    private readonly scene: Scene,
    private readonly field: TerrainField,
  ) {
    const mat = new StandardMaterial("snow", scene);
    // Vertex colours carry all the shading detail; the material just needs to not fight them.
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0.12, 0.16, 0.22);
    mat.specularPower = 64;
    mat.emissiveColor = new Color3(0.06, 0.09, 0.13); // lifts the shadow side out of mud
    mat.backFaceCulling = true;
    this.material = mat;
  }

  /**
   * Rebuild the set of live chunks around the rider. Call once per frame.
   *
   * Only `playerZ` matters: the lateral extent comes from where the corridor runs, not from
   * where the player happens to be standing.
   */
  update(playerZ: number): void {
    const czNear = Math.floor((playerZ - VIEW_BEHIND) / CHUNK_SIZE);
    const czFar = Math.floor((playerZ + VIEW_AHEAD) / CHUNK_SIZE);

    const wanted = new Set<string>();
    this.pending.length = 0;

    for (let cz = czNear; cz <= czFar; cz++) {
      // Only instantiate chunks the corridor actually passes through. The course snakes, so
      // this is a moving ribbon 2-3 chunks wide rather than a full grid — a large saving.
      const zA = cz * CHUNK_SIZE;
      const zB = (cz + 1) * CHUNK_SIZE;
      const cA = centreX(this.field.params, zA);
      const cB = centreX(this.field.params, zB);
      const cMid = centreX(this.field.params, (zA + zB) / 2);
      const hw = Math.max(
        halfWidth(this.field.params, zA),
        halfWidth(this.field.params, zB),
      );

      const span = hw + LATERAL_MARGIN;
      const minX = Math.min(cA, cB, cMid) - span;
      const maxX = Math.max(cA, cB, cMid) + span;

      const cxMin = Math.floor(minX / CHUNK_SIZE);
      const cxMax = Math.floor(maxX / CHUNK_SIZE);

      for (let cx = cxMin; cx <= cxMax; cx++) {
        const key = chunkKey(cx, cz);
        wanted.add(key);
        if (!this.live.has(key)) this.pending.push({ cx, cz });
      }
    }

    // Retire chunks that have fallen out of range, back into the pool
    for (const [key, chunk] of this.live) {
      if (!wanted.has(key)) {
        chunk.mesh.setEnabled(false);
        this.live.delete(key);
        this.pool.push(chunk);
      }
    }

    // Build nearest-first so what the player is about to ride into appears first
    this.pending.sort(
      (a, b) => Math.abs(b.cz * CHUNK_SIZE - playerZ) - Math.abs(a.cz * CHUNK_SIZE - playerZ),
    );

    let budget = MAX_BUILDS_PER_FRAME;
    while (this.pending.length > 0 && budget-- > 0) {
      const { cx, cz } = this.pending.pop()!;
      this.buildChunk(cx, cz);
    }
  }

  /**
   * Fill every pending chunk immediately. Used once at run start so the player never sees the
   * world pop in around them.
   */
  prime(playerZ: number): void {
    for (let i = 0; i < 128; i++) {
      this.update(playerZ);
      if (this.pending.length === 0) break;
    }
  }

  private buildChunk(cx: number, cz: number): void {
    const chunk = this.pool.pop() ?? this.createChunk();
    chunk.cx = cx;
    chunk.cz = cz;
    chunk.key = chunkKey(cx, cz);

    this.fillGeometry(cx, cz);

    const mesh = chunk.mesh;
    // Rewriting the existing buffers rather than rebuilding the mesh is what keeps streaming
    // free of GC hitches mid-run. `updateExtends` on the positions refreshes the bounding
    // box, without which frustum culling would still be using the previous chunk's bounds.
    mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions, true);
    mesh.updateVerticesData(VertexBuffer.NormalKind, this.normals);
    mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors);
    mesh.setEnabled(true);

    this.live.set(chunk.key, chunk);
  }

  private createChunk(): Chunk {
    const mesh = new Mesh(`chunk${this.pool.length}`, this.scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(VERTS_PER_CHUNK * 3);
    vd.normals = new Float32Array(VERTS_PER_CHUNK * 3);
    vd.colors = new Float32Array(VERTS_PER_CHUNK * 4);

    // The geometry is non-indexed (every triangle owns its vertices, which is what gives the
    // faceted shading), but Babylon still needs an index buffer to issue the draw — without
    // one the submesh has an index count of zero and the chunk silently renders nothing.
    // The order never changes, so this is built once per pooled mesh and then left alone.
    const indices = new Uint32Array(VERTS_PER_CHUNK);
    for (let i = 0; i < VERTS_PER_CHUNK; i++) indices[i] = i;
    vd.indices = indices;

    vd.applyToMesh(mesh, true); // updatable
    mesh.material = this.material;
    mesh.isPickable = false;
    // Deliberately NOT freezing the world matrix. The transform is identity — geometry is
    // baked in world space — so freezing looks free, but it also stops Babylon refreshing the
    // mesh's *world* bounding box when the vertex buffers are rewritten. Chunks then keep the
    // empty origin-point bounds they were created with and get frustum-culled: the mountain
    // renders as a couple of stray slivers and nothing else.
    return { mesh, cx: 0, cz: 0, key: "" };
  }

  /**
   * Emit non-indexed, flat-shaded geometry for one chunk.
   *
   * Non-indexed because flat shading needs per-face normals, and the faceted look *is* the
   * art direction. Heights are sampled once onto a grid and shared between the triangles
   * that reference them, so we do (n+1)^2 height samples rather than 6*n^2.
   */
  private fillGeometry(cx: number, cz: number): void {
    const { heights, positions, normals, colors, field } = this;
    const step = CHUNK_SIZE / CHUNK_SUBDIV;
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    const stride = CHUNK_SUBDIV + 1;

    for (let j = 0; j <= CHUNK_SUBDIV; j++) {
      const z = originZ + j * step;
      for (let i = 0; i <= CHUNK_SUBDIV; i++) {
        heights[j * stride + i] = field.heightAt(originX + i * step, z);
      }
    }

    let p = 0;
    let c = 0;

    for (let j = 0; j < CHUNK_SUBDIV; j++) {
      for (let i = 0; i < CHUNK_SUBDIV; i++) {
        const x0 = originX + i * step;
        const x1 = x0 + step;
        const z0 = originZ + j * step;
        const z1 = z0 + step;

        const h00 = heights[j * stride + i]!;
        const h10 = heights[j * stride + i + 1]!;
        const h01 = heights[(j + 1) * stride + i]!;
        const h11 = heights[(j + 1) * stride + i + 1]!;

        // Two triangles per quad, wound so they face *upward* in Babylon's default
        // left-handed system. Get this backwards and the entire mountain is back-facing:
        // it still streams, still culls, still reports correct bounds, and renders as
        // nothing but sky.
        p = this.emitTriangle(positions, p, x0, h00, z0, x1, h10, z0, x0, h01, z1);
        c = this.emitFace(normals, colors, p, c, x0, h00, z0, x1, h10, z0, x0, h01, z1);

        p = this.emitTriangle(positions, p, x1, h10, z0, x1, h11, z1, x0, h01, z1);
        c = this.emitFace(normals, colors, p, c, x1, h10, z0, x1, h11, z1, x0, h01, z1);
      }
    }
  }

  private emitTriangle(
    out: Float32Array,
    p: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): number {
    out[p++] = ax; out[p++] = ay; out[p++] = az;
    out[p++] = bx; out[p++] = by; out[p++] = bz;
    out[p++] = cx; out[p++] = cy; out[p++] = cz;
    return p;
  }

  /** Face normal + vertex colour for the three verts ending at `pEnd`. */
  private emitFace(
    normals: Float32Array,
    colors: Float32Array,
    pEnd: number,
    c: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): number {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;

    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // always face up

    const nStart = pEnd - 9;
    for (let k = 0; k < 3; k++) {
      normals[nStart + k * 3] = nx;
      normals[nStart + k * 3 + 1] = ny;
      normals[nStart + k * 3 + 2] = nz;
    }

    // Warm white on the flats falling to a rich cool blue as faces steepen.
    //
    // Slope is doing double duty here. It is the shading cue that reads at any time of day,
    // and — more importantly — it is what makes the gulley legible at speed: the banks are
    // the steep surfaces, so they colour themselves in and the player can see the shape of
    // the corridor ahead without any markers, gates or minimap.
    const steep = clamp01((1 - ny) * 3.0);
    const r = lerp(1.0, 0.46, steep);
    const g = lerp(0.995, 0.66, steep);
    const b = lerp(0.96, 0.93, steep);

    for (let k = 0; k < 3; k++) {
      colors[c++] = r;
      colors[c++] = g;
      colors[c++] = b;
      colors[c++] = 1;
    }
    return c;
  }

  dispose(): void {
    for (const chunk of this.live.values()) chunk.mesh.dispose();
    for (const chunk of this.pool) chunk.mesh.dispose();
    this.live.clear();
    this.pool.length = 0;
    this.material.dispose();
  }
}

export { CHUNK_SIZE };
