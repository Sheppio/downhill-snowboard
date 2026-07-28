/**
 * Rocks and trees.
 *
 * Placement is generated per 12 m *slice* of course, from a slice-derived seed. Like the
 * terrain, this is order-independent: slice 240 contains the same obstacles whether the
 * player reached it in a fast clean run or a slow scrappy one.
 *
 * Everything is rendered with **thin instances** — one mesh for trees, one for rocks, every
 * copy drawn in a single call. On a phone this is the difference between a smooth 60fps and
 * a slideshow; hundreds of individual meshes would be hundreds of draw calls.
 *
 * Collision is an analytic circle test rather than a physics query, for a reason that matters
 * here specifically: the game's whole premise is that a seed plays out identically for
 * everybody. A deterministic distance check gives exactly that, where a physics engine's
 * contact callbacks vary with float behaviour across devices. Havok is still doing real work
 * — it drives the wipeout tumble in `wipeout.ts`.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

import { hashInts, makeRng } from "../core/rng";
import { clamp01, lerp } from "../core/math";
import {
  GATE_CLEARANCE,
  RUN_IN_LENGTH,
  gateX,
  centreX,
  halfWidth,
  type CourseParams,
} from "./course";
import type { TerrainField } from "./terrain";

/** Length of one generation slice, in metres. */
export const SLICE_LENGTH = 12;

// --- Difficulty ---------------------------------------------------------------------------
// These four numbers are the difficulty dial. Density is the honest lever; the clear channel
// in course.ts (GATE_CLEARANCE) is the safety net that keeps every seed completable, so raise
// density first and only narrow the channel once the tests still pass with margin.

/** Obstacles per slice, ramping with distance so the run starts gently and gets hard. */
const DENSITY_START = 3.2;
const DENSITY_MAX = 10;
const DENSITY_RAMP_END = 1300;

/** How far out from the centreline obstacles can appear, as a fraction of half-width. */
const MAX_LATERAL = 1.5;

/** Proportion of obstacles that are trees rather than rocks. */
const TREE_SHARE = 0.76;

/**
 * Clear snow required between two obstacles' edges, in metres.
 *
 * Without this there is nothing stopping two trees being generated on top of each other. At
 * the old density that was rare enough never to show; at ten per slice it would be constant,
 * and interpenetrating trees look broken rather than dense.
 *
 * Checked within a slice only. Two obstacles either side of a slice boundary can still land
 * close together, which is fine and actually welcome — clumps read as natural forest.
 */
const MIN_GAP = 0.9;

/** How many positions to try before giving up on placing an obstacle. */
const PLACEMENT_ATTEMPTS = 5;

export const enum ObstacleKind {
  Tree = 0,
  Rock = 1,
}

export interface Obstacle {
  x: number;
  z: number;
  y: number;
  /** Collision radius on the XZ plane. */
  radius: number;
  kind: ObstacleKind;
  scale: number;
  spin: number;
}

const TREE_RADIUS = 0.7;
const ROCK_RADIUS = 0.95;

/** Obstacles per slice at a given distance down the mountain. */
function densityAt(z: number): number {
  if (z < RUN_IN_LENGTH) return 0; // clean run-in so the player can settle
  const ramp = clamp01((z - RUN_IN_LENGTH) / DENSITY_RAMP_END);
  return lerp(DENSITY_START, DENSITY_MAX, ramp);
}

/**
 * Generates and caches obstacle placement. Pure with respect to (seed, slice), so it can be
 * asked for any slice at any time and always answers the same thing.
 */
export class ObstacleField {
  private readonly cache = new Map<number, Obstacle[]>();

  constructor(
    private readonly seed: number,
    private readonly params: CourseParams,
    private readonly field: TerrainField,
  ) {}

  /** Obstacles in one 12 m slice. Memoised; generation is deterministic either way. */
  slice(index: number): Obstacle[] {
    const cached = this.cache.get(index);
    if (cached) return cached;

    const out: Obstacle[] = [];
    const z0 = index * SLICE_LENGTH;
    const density = densityAt(z0);

    if (density > 0) {
      const rng = makeRng(hashInts(this.seed, index, 0x0b57));
      // Fractional density is resolved probabilistically, so it ramps smoothly rather than
      // jumping from 1 obstacle per slice to 2
      let count = Math.floor(density);
      if (rng.chance(density - count)) count++;

      for (let i = 0; i < count; i++) {
        const kind = rng.chance(TREE_SHARE) ? ObstacleKind.Tree : ObstacleKind.Rock;
        const scale = kind === ObstacleKind.Tree ? rng.range(0.8, 1.5) : rng.range(0.7, 1.4);
        const radius = (kind === ObstacleKind.Tree ? TREE_RADIUS : ROCK_RADIUS) * scale;

        // Try a few positions before giving up, so a crowded slice still fills in rather than
        // silently losing obstacles to the first unlucky roll.
        for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
          const z = z0 + rng.range(0, SLICE_LENGTH);
          const hw = halfWidth(this.params, z);

          // Obstacles are placed into the space either side of the racing line, rather than
          // placed anywhere and then rejected if they land on it. Two reasons: the clearance
          // guarantee then holds by construction instead of by a check that could be missed,
          // and widening the channel no longer silently thins the course out — rejection
          // would have deleted exactly the obstacles nearest the line.
          const cx = centreX(this.params, z);
          const gx = gateX(this.params, z);
          const clear = GATE_CLEARANCE + radius;

          const leftEdge = cx - MAX_LATERAL * hw;
          const rightEdge = cx + MAX_LATERAL * hw;
          const leftWidth = Math.max(0, gx - clear - leftEdge);
          const rightWidth = Math.max(0, rightEdge - (gx + clear));
          if (leftWidth + rightWidth <= 0) break; // pinch point with no room either side

          // Both types spread across the whole band, with rocks crowding in toward the clear
          // line. Trees used to be pushed hard outward to frame the banks, which looked good
          // but made most of them scenery the player never had to react to — the ones that
          // matter are the ones near the line you are threading.
          const t =
            kind === ObstacleKind.Tree ? Math.pow(rng.next(), 1.0) : Math.pow(rng.next(), 1.7);

          const x =
            rng.next() * (leftWidth + rightWidth) >= leftWidth
              ? gx + clear + t * rightWidth
              : gx - clear - t * leftWidth;

          if (this.overlaps(out, x, z, radius)) continue;

          out.push({
            x,
            z,
            y: this.field.heightAt(x, z),
            radius,
            kind,
            scale,
            spin: rng.range(0, Math.PI * 2),
          });
          break;
        }
      }
    }

    this.cache.set(index, out);
    // Bound the cache so a very long run cannot grow it without limit
    if (this.cache.size > 512) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return out;
  }

  /** True if a candidate position would intersect anything already placed in this slice. */
  private overlaps(placed: Obstacle[], x: number, z: number, radius: number): boolean {
    for (const other of placed) {
      const dx = x - other.x;
      const dz = z - other.z;
      const need = radius + other.radius + MIN_GAP;
      if (dx * dx + dz * dz < need * need) return true;
    }
    return false;
  }

  /** Every obstacle between two distances down the mountain. */
  range(zMin: number, zMax: number): Obstacle[] {
    const first = Math.floor(zMin / SLICE_LENGTH);
    const last = Math.floor(zMax / SLICE_LENGTH);
    const out: Obstacle[] = [];
    for (let i = first; i <= last; i++) out.push(...this.slice(i));
    return out;
  }

  /**
   * The obstacle the rider is currently hitting, if any.
   *
   * Only the few slices around the rider are considered, so this is a handful of distance
   * checks per frame regardless of how long the run gets.
   */
  hitTest(x: number, z: number, riderRadius: number): Obstacle | null {
    const first = Math.floor((z - 4) / SLICE_LENGTH);
    const last = Math.floor((z + 4) / SLICE_LENGTH);

    for (let i = first; i <= last; i++) {
      for (const o of this.slice(i)) {
        const dx = x - o.x;
        const dz = z - o.z;
        const reach = o.radius + riderRadius;
        if (dx * dx + dz * dz < reach * reach) return o;
      }
    }
    return null;
  }
}

// --- Rendering ----------------------------------------------------------------------------

const VIEW_AHEAD = 250;
const VIEW_BEHIND = 40;

/**
 * Bake a flat colour into a mesh's vertex colours.
 *
 * Colour is carried per-vertex rather than per-material so that a whole tree — trunk, three
 * tiers of foliage, snow cap — merges into *one* mesh with *one* material, and therefore
 * draws as a single thin-instanced call. Merging with multi-materials would split it into a
 * submesh per colour and give back most of what instancing just bought us.
 */
function paint(mesh: Mesh, colour: Color3): Mesh {
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    colors[i * 4] = colour.r;
    colors[i * 4 + 1] = colour.g;
    colors[i * 4 + 2] = colour.b;
    colors[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

/** Shared material for every obstacle: vertex colours do the work, lighting stays cheap. */
function createObstacleMaterial(scene: Scene, name: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(1, 1, 1);
  mat.emissiveColor = new Color3(0.13, 0.15, 0.18); // keeps colours vivid on the shadow side
  mat.specularColor = new Color3(0.08, 0.08, 0.1);
  return mat;
}

const TRUNK_COLOUR = new Color3(0.44, 0.27, 0.16);
const FOLIAGE_COLOURS = [new Color3(0.11, 0.62, 0.33), new Color3(0.15, 0.72, 0.38)];
const SNOW_COLOUR = new Color3(1, 1, 1);
const ROCK_COLOUR = new Color3(0.56, 0.6, 0.68);

/** Build one cartoon fir: stacked cones on a trunk, with a snow-capped tip. */
function createTreeMesh(scene: Scene): Mesh {
  const parts: Mesh[] = [];

  const trunk = CreateCylinder(
    "trunk",
    { height: 1.6, diameterTop: 0.26, diameterBottom: 0.42, tessellation: 6 },
    scene,
  );
  trunk.position.y = 0.8;
  parts.push(paint(trunk, TRUNK_COLOUR));

  const tiers = [
    { y: 1.9, d: 2.6, h: 1.8 },
    { y: 3.0, d: 2.0, h: 1.6 },
    { y: 4.0, d: 1.35, h: 1.4 },
  ];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]!;
    const cone = CreateCylinder(
      `tier${i}`,
      { height: t.h, diameterTop: 0, diameterBottom: t.d, tessellation: 7 },
      scene,
    );
    cone.position.y = t.y;
    parts.push(paint(cone, FOLIAGE_COLOURS[i % FOLIAGE_COLOURS.length]!));
  }

  const cap = CreateCylinder(
    "treeCap",
    { height: 0.55, diameterTop: 0, diameterBottom: 0.62, tessellation: 7 },
    scene,
  );
  cap.position.y = 4.5;
  parts.push(paint(cap, SNOW_COLOUR));

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) throw new Error("failed to build tree mesh");
  merged.name = "tree";
  merged.material = createObstacleMaterial(scene, "treeMat");
  merged.convertToFlatShadedMesh();
  merged.isPickable = false;
  return merged;
}

/** Build one cartoon boulder: a lumpy low-poly sphere wearing a hat of snow. */
function createRockMesh(scene: Scene): Mesh {
  const body = CreateSphere("rockBody", { diameter: 2, segments: 3 }, scene);
  body.scaling = new Vector3(1.15, 0.74, 1);
  body.bakeCurrentTransformIntoVertices();
  paint(body, ROCK_COLOUR);

  // Cap deliberately much smaller than the body. At near-body size the snow swallowed the
  // whole boulder and they read as harmless snow mounds rather than something to dodge.
  const cap = CreateSphere("rockCap", { diameter: 1.35, segments: 3, slice: 0.42 }, scene);
  cap.scaling = new Vector3(1.0, 0.62, 0.9);
  cap.bakeCurrentTransformIntoVertices();
  cap.position.y = 0.34;
  paint(cap, SNOW_COLOUR);

  const merged = Mesh.MergeMeshes([body, cap], true, true, undefined, false, false);
  if (!merged) throw new Error("failed to build rock mesh");
  merged.name = "rock";
  merged.material = createObstacleMaterial(scene, "rockMat");
  merged.convertToFlatShadedMesh();
  merged.isPickable = false;
  return merged;
}

export class ObstacleRenderer {
  private readonly tree: Mesh;
  private readonly rock: Mesh;
  private lastFirstSlice = Number.NaN;
  private lastLastSlice = Number.NaN;

  constructor(
    scene: Scene,
    private readonly obstacles: ObstacleField,
  ) {
    this.tree = createTreeMesh(scene);
    this.rock = createRockMesh(scene);
    // Base meshes are only templates; nothing is drawn until instances exist
    this.tree.thinInstanceCount = 0;
    this.rock.thinInstanceCount = 0;
  }

  /**
   * Refresh the instance buffers if the visible slice window has moved.
   *
   * Rebuilding only on a slice boundary means this runs about once every 12 m of travel
   * rather than every frame.
   */
  update(playerZ: number): void {
    const first = Math.floor((playerZ - VIEW_BEHIND) / SLICE_LENGTH);
    const last = Math.floor((playerZ + VIEW_AHEAD) / SLICE_LENGTH);
    if (first === this.lastFirstSlice && last === this.lastLastSlice) return;
    this.lastFirstSlice = first;
    this.lastLastSlice = last;

    const trees: Obstacle[] = [];
    const rocks: Obstacle[] = [];
    for (let i = first; i <= last; i++) {
      for (const o of this.obstacles.slice(i)) {
        (o.kind === ObstacleKind.Tree ? trees : rocks).push(o);
      }
    }

    this.writeInstances(this.tree, trees);
    this.writeInstances(this.rock, rocks);
  }

  private writeInstances(mesh: Mesh, list: Obstacle[]): void {
    if (list.length === 0) {
      mesh.thinInstanceCount = 0;
      return;
    }

    const data = new Float32Array(list.length * 16);
    const matrix = Matrix.Identity();
    const scale = Vector3.Zero();
    const translation = Vector3.Zero();
    // Yaw only. A tree tilted off vertical reads as broken rather than natural, and rocks get
    // their variety from non-uniform scale instead.
    const rotation = Quaternion.Identity();

    for (let i = 0; i < list.length; i++) {
      const o = list[i]!;
      scale.set(o.scale, o.scale, o.scale);
      translation.set(o.x, o.y, o.z);
      Quaternion.RotationYawPitchRollToRef(o.spin, 0, 0, rotation);
      Matrix.ComposeToRef(scale, rotation, translation, matrix);
      matrix.copyToArray(data, i * 16);
    }

    // Setting the matrix buffer also sets thinInstanceCount from the buffer length
    mesh.thinInstanceSetBuffer("matrix", data, 16, false);
  }

  dispose(): void {
    this.tree.dispose();
    this.rock.dispose();
  }
}
