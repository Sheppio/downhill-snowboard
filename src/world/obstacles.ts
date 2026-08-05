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
 * Collision is an analytic distance test rather than a physics query, for a reason that
 * matters here specifically: the game's whole premise is that a seed plays out identically for
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
  gateClearance,
  gateX,
  centreX,
  halfWidth,
  type CourseParams,
} from "./course";
import type { TerrainField } from "./terrain";
import type { WorldOrigin } from "./origin";

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

// Past the first ramp the trees keep thickening, out to the distance the course is meant to
// be brutal at. The clear channel and the overlap rule both cap how many can actually land,
// so this asks for more than it will always get — the measured placement is what matters.
const DENSITY_DEEP = 15;
const DENSITY_DEEP_START = 2200;
const DENSITY_DEEP_END = 5000;

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
  /** Radius used to space obstacles apart and to hold them clear of the racing line. */
  radius: number;
  /** Radius the rider actually collides against. See TREE_HIT_RADII. */
  hitRadius: number;
  /** Height of the top above `y`. Clear this and you have jumped it. */
  height: number;
  kind: ObstacleKind;
  /** Which of the five shapes of this kind to draw. */
  variant: number;
  scale: number;
  spin: number;
}

/** How many distinct shapes exist per kind. */
export const VARIANTS = 5;

/**
 * How much of an obstacle's footprint actually stops the rider.
 *
 * Collision is generous by a tenth, because a hit that the player did not believe in is worse
 * than one they got away with: a run ends instantly, and being knocked off by a gap that
 * looked clear reads as the game being unfair rather than as a mistake.
 *
 * Applied here rather than to `radius` itself, deliberately. `radius` is also what spaces
 * obstacles apart and holds them clear of the racing line, and shrinking it there would let
 * the course generate tighter than it was tuned for — the same seeds would quietly become
 * harder. This way the mountain is untouched and only the test against it softens.
 *
 * Not applied to height. Clearing the top of something is already unambiguous on screen, and
 * a tenth off the top would mean visibly passing through the crown of a tree.
 */
const COLLIDER_FORGIVENESS = 0.9;

const TREE_RADIUS = 0.7;

/**
 * What the rider actually collides with, per tree variant.
 *
 * Separate from TREE_RADIUS because the two answer different questions. TREE_RADIUS spaces
 * obstacles apart and holds them off the racing line, where a uniform figure is right and
 * where changing anything would move every tree in the game. This is about what the player
 * can see, and the five firs do not look alike down where the rider is.
 *
 * Measured as the widest the mesh gets below 1.8m — roughly rider height — since foliage
 * above that is passed under, not through:
 *
 *   variant 0  1.30m      variant 1  0.95m      variant 2  1.55m
 *   variant 3  0.22m      variant 4  1.38m
 *
 * Four of them are broad canopies that sweep down past the rider, so a 0.7m collider sits
 * well inside the needles and reads as generous. Variant 3 is a stripped dead trunk with its
 * two remnant branches up at 2.7m and 3.6m, clean over the rider's head. At 0.7m it stopped
 * the rider well clear of visibly empty snow.
 *
 * 0.3 is the trunk plus a little, so it still stops you, but only once you are on it. With the
 * rider now a capsule 0.225m across rather than a 0.6m circle, the two fixes compound:
 * sideways the reach against this trunk is 0.50m between centres, against a trunk 0.22m wide.
 */
export const TREE_HIT_RADII = [TREE_RADIUS, TREE_RADIUS, TREE_RADIUS, 0.3, TREE_RADIUS];
export const ROCK_RADIUS = 0.95;

/**
 * Height of each built mesh at scale 1, measured from its geometry, so the collider matches
 * what the player can see. Indexed by variant.
 *
 * Trees stay effectively unjumpable and rocks stay clearable with a decent launch. That
 * gradient is the point — it gives airtime something to be *for* — so the ranges here are
 * bounded on purpose rather than spread for the sake of it: no tree drops near jumpable, and
 * no rock climbs out of reach.
 */
const TREE_HEIGHTS = [4.78, 6.15, 3.88, 4.15, 5.05];
const ROCK_HEIGHTS = [0.76, 0.5, 0.84, 0.66, 0.62];

/**
 * Distance at the top of the mountain with no obstacles at all.
 *
 * Only long enough to get moving and get a hand on the screen. The opening is still gentle
 * after this, because course.ts holds the gulley straight and wide for its own longer ramp —
 * so the first stretch is easy without being empty.
 */
const OBSTACLE_FREE_LENGTH = 20;

/** Obstacles per slice at a given distance down the mountain. */
export function densityAt(z: number): number {
  if (z < OBSTACLE_FREE_LENGTH) return 0;
  const ramp = clamp01((z - OBSTACLE_FREE_LENGTH) / DENSITY_RAMP_END);
  const deep = clamp01((z - DENSITY_DEEP_START) / (DENSITY_DEEP_END - DENSITY_DEEP_START));
  return lerp(DENSITY_START, DENSITY_MAX, ramp) + (DENSITY_DEEP - DENSITY_MAX) * deep;
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

        // Drawn from a hash of (seed, slice, index) rather than from `rng`, so that adding
        // shapes did not consume a value from the placement stream and reshuffle every course
        // that has ever been played. Same seed, same mountain — just no longer all one tree.
        const variant = hashInts(this.seed, index, i * 0x2545f491) % VARIANTS;
        const height =
          (kind === ObstacleKind.Tree ? TREE_HEIGHTS[variant]! : ROCK_HEIGHTS[variant]!) * scale;

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
          const clear = gateClearance(this.params, z) + radius;

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
            hitRadius:
              kind === ObstacleKind.Tree ? TREE_HIT_RADII[variant]! * scale : ROCK_RADIUS * scale,
            height,
            kind,
            variant,
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
   *
   * `riderY` is the height of the board. Without it this was a pure XZ test, which made every
   * collider an infinitely tall cylinder: you could clear a tree by a wide margin and still be
   * knocked off it, and no amount of air ever got you over anything.
   *
   * The rider is a **capsule lying along the board**, not a circle. A circle cannot describe a
   * 1.6m board a quarter of a metre wide: the one that was here had to be a compromise between
   * the two, so it was far too wide sideways — which is the axis you dodge on — while still
   * falling short of the tips. A capsule is the board's actual shape, and the test against it
   * is exact rather than an approximation: clamp the obstacle's offset to the segment and it
   * is a point-to-point distance again.
   *
   * An ellipse would have been the other way to say "long and thin", and was rejected for
   * being neither. Circle-against-ellipse has no closed form, so it needs an iterative solve
   * or the usual offset-ellipse approximation — and that approximation is *generous* at the
   * diagonals, which would crash the player early in exactly the direction this exists to fix.
   */
  hitTest(
    x: number,
    z: number,
    riderY: number,
    heading: number,
    halfWidth: number,
    halfLength: number,
  ): Obstacle | null {
    const first = Math.floor((z - 4) / SLICE_LENGTH);
    const last = Math.floor((z + 4) / SLICE_LENGTH);

    // Heading 0 points down the mountain (+z), matching the rider controller.
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    // The capsule's rounded ends are what reach the tips, so the segment itself stops short
    // of them by exactly the radius.
    const halfSegment = Math.max(halfLength - halfWidth, 0);

    for (let i = first; i <= last; i++) {
      for (const o of this.slice(i)) {
        // Cleared the top, so it passes underneath
        if (riderY >= o.y + o.height) continue;

        const dx = o.x - x;
        const dz = o.z - z;
        // Split the offset into "along the board" and "across it"
        const along = dx * fx + dz * fz;
        const across = dx * fz - dz * fx;
        // Off the end of the segment, the rounded cap takes over
        const overhang = Math.abs(along) - halfSegment;
        const beyond = overhang > 0 ? overhang : 0;

        const reach = o.hitRadius * COLLIDER_FORGIVENESS + halfWidth;
        if (beyond * beyond + across * across < reach * reach) return o;
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

/** A dead standing trunk, and the pale green of a tree carrying a lot of snow. */
const DEAD_WOOD_COLOUR = new Color3(0.42, 0.35, 0.3);
const LADEN_FOLIAGE_COLOUR = new Color3(0.42, 0.68, 0.5);

interface TreeShape {
  /** Trunk height and its top/bottom diameters. */
  trunk: [height: number, top: number, bottom: number];
  /** Foliage cones, bottom to top: [centreY, diameter, height]. */
  tiers: [y: number, d: number, h: number][];
  /** Snow cap: [baseY, diameter, height]. Omitted for a bare tree. */
  cap?: [y: number, d: number, h: number];
  foliage: Color3[];
  trunkColour?: Color3;
}

/**
 * The five firs, in the order the variant index picks them.
 *
 * Silhouette does the work here, not colour: at a distance and at speed, what separates one
 * tree from another is its outline against the snow. So they differ in height, taper and tier
 * count first, and only then in shade.
 *
 * None of this touches collision. TREE_RADIUS is 0.7 while the widest foliage reaches 1.3, so
 * the collider has always described the trunk rather than the branches — you brush through the
 * outer needles. That is what makes it safe to vary the canopy this freely.
 */
export const TREE_SHAPES: TreeShape[] = [
  {
    // 0. The classic: three even tiers, snow-tipped
    trunk: [1.6, 0.26, 0.42],
    tiers: [
      [1.9, 2.6, 1.8],
      [3.0, 2.0, 1.6],
      [4.0, 1.35, 1.4],
    ],
    cap: [4.5, 0.62, 0.55],
    foliage: FOLIAGE_COLOURS,
  },
  {
    // 1. A tall narrow spire — four close tiers on a long trunk
    trunk: [2.1, 0.22, 0.38],
    tiers: [
      [2.3, 1.9, 1.9],
      [3.4, 1.6, 1.7],
      [4.4, 1.25, 1.5],
      [5.3, 0.9, 1.3],
    ],
    cap: [5.85, 0.5, 0.5],
    foliage: [FOLIAGE_COLOURS[0]!, FOLIAGE_COLOURS[1]!, FOLIAGE_COLOURS[0]!],
    },
  {
    // 2. Squat and broad, the one that reads as an old tree low on the slope
    trunk: [1.3, 0.34, 0.56],
    tiers: [
      [1.6, 3.1, 1.9],
      [2.9, 2.3, 1.7],
    ],
    cap: [3.6, 0.8, 0.55],
    foliage: [new Color3(0.09, 0.5, 0.28), new Color3(0.12, 0.6, 0.32)],
  },
  {
    // 3. Bare and dead: a stripped trunk with two thin remnants, no snow on top
    trunk: [3.0, 0.2, 0.44],
    tiers: [
      [2.7, 1.5, 1.3],
      [3.6, 1.0, 1.1],
    ],
    foliage: [DEAD_WOOD_COLOUR, new Color3(0.36, 0.3, 0.26)],
    trunkColour: DEAD_WOOD_COLOUR,
  },
  {
    // 4. Snow-laden: pale, heavy tiers under a deep cap
    trunk: [1.5, 0.28, 0.46],
    tiers: [
      [1.8, 2.75, 1.9],
      [3.05, 2.15, 1.7],
      [4.15, 1.5, 1.5],
    ],
    cap: [4.6, 1.05, 0.9],
    foliage: [LADEN_FOLIAGE_COLOUR, new Color3(0.5, 0.74, 0.58)],
  },
];

/** Build one cartoon fir: stacked cones on a trunk, usually with a snow-capped tip. */
function createTreeMesh(scene: Scene, variant: number): Mesh {
  const shape = TREE_SHAPES[variant]!;
  const parts: Mesh[] = [];

  const [th, tTop, tBottom] = shape.trunk;
  const trunk = CreateCylinder(
    "trunk",
    { height: th, diameterTop: tTop, diameterBottom: tBottom, tessellation: 6 },
    scene,
  );
  trunk.position.y = th / 2;
  parts.push(paint(trunk, shape.trunkColour ?? TRUNK_COLOUR));

  for (let i = 0; i < shape.tiers.length; i++) {
    const [y, d, h] = shape.tiers[i]!;
    const cone = CreateCylinder(
      `tier${i}`,
      { height: h, diameterTop: 0, diameterBottom: d, tessellation: 7 },
      scene,
    );
    cone.position.y = y;
    parts.push(paint(cone, shape.foliage[i % shape.foliage.length]!));
  }

  if (shape.cap) {
    const [y, d, h] = shape.cap;
    const cap = CreateCylinder(
      "treeCap",
      { height: h, diameterTop: 0, diameterBottom: d, tessellation: 7 },
      scene,
    );
    cap.position.y = y;
    parts.push(paint(cap, SNOW_COLOUR));
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) throw new Error("failed to build tree mesh");
  merged.name = `tree${variant}`;
  merged.material = createObstacleMaterial(scene, `treeMat${variant}`);
  merged.convertToFlatShadedMesh();
  merged.isPickable = false;
  return merged;
}

const DARK_ROCK_COLOUR = new Color3(0.4, 0.42, 0.5);
const PALE_ROCK_COLOUR = new Color3(0.66, 0.69, 0.74);

export interface RockLump {
  /** Sphere diameter, and how many segments — 2 is angular, 4 is rounded. */
  diameter: number;
  segments: number;
  scaling: [x: number, y: number, z: number];
  offset?: [x: number, y: number, z: number];
  /** Fraction of the sphere kept, for a dome sitting on the snow. */
  slice?: number;
  colour: Color3;
}

/**
 * The five boulders.
 *
 * Rocks are constrained where trees are not: ROCK_RADIUS is 0.95 against a body that reaches
 * about 1.15, so the collider closely tracks the mesh, so their footprints have to stay
 * close to one another or a hit stops matching what is drawn. So these vary mostly in *height* and
 * profile — which is the axis that matters anyway, because it decides what a launch can clear.
 */
export const ROCK_SHAPES: RockLump[][] = [
  // 0. The classic boulder with its hat of snow
  [
    { diameter: 2, segments: 3, scaling: [1.15, 0.74, 1], colour: ROCK_COLOUR },
    {
      diameter: 1.35,
      segments: 3,
      scaling: [1.0, 0.62, 0.9],
      offset: [0, 0.34, 0],
      slice: 0.42,
      colour: SNOW_COLOUR,
    },
  ],
  // 1. A flat slab, barely proud of the snow — the one you can clear almost casually
  [
    { diameter: 2.1, segments: 3, scaling: [1.1, 0.4, 1.05], colour: PALE_ROCK_COLOUR },
    {
      diameter: 1.5,
      segments: 3,
      scaling: [1.0, 0.34, 0.95],
      offset: [0.05, 0.16, 0],
      slice: 0.4,
      colour: SNOW_COLOUR,
    },
  ],
  // 2. Tall and angular, the tallest thing still worth jumping
  [
    { diameter: 1.9, segments: 2, scaling: [1.05, 0.89, 1.0], colour: DARK_ROCK_COLOUR },
    {
      diameter: 1.0,
      segments: 2,
      scaling: [0.95, 0.62, 0.9],
      offset: [0.1, 0.5, 0.05],
      slice: 0.45,
      colour: SNOW_COLOUR,
    },
  ],
  // 3. Twin lumps, one shouldering the other
  [
    { diameter: 1.6, segments: 3, scaling: [1.05, 0.82, 1], offset: [-0.35, 0, 0.1], colour: ROCK_COLOUR },
    { diameter: 1.25, segments: 3, scaling: [1, 0.66, 1], offset: [0.5, -0.05, -0.15], colour: DARK_ROCK_COLOUR },
    {
      diameter: 1.1,
      segments: 3,
      scaling: [1, 0.5, 0.9],
      offset: [-0.3, 0.38, 0.1],
      slice: 0.4,
      colour: SNOW_COLOUR,
    },
  ],
  // 4. A rounded, mostly buried stone with no cap at all
  [
    { diameter: 2.2, segments: 4, scaling: [1.05, 0.5, 1.0], colour: PALE_ROCK_COLOUR },
    { diameter: 1.1, segments: 4, scaling: [0.9, 0.42, 0.9], offset: [0.45, 0.06, 0.3], colour: ROCK_COLOUR },
  ],
];

/** Build one cartoon boulder out of lumpy low-poly spheres. */
function createRockMesh(scene: Scene, variant: number): Mesh {
  const parts: Mesh[] = [];
  const lumps = ROCK_SHAPES[variant]!;

  for (let i = 0; i < lumps.length; i++) {
    const l = lumps[i]!;
    const mesh = CreateSphere(
      `rockLump${i}`,
      l.slice === undefined
        ? { diameter: l.diameter, segments: l.segments }
        : { diameter: l.diameter, segments: l.segments, slice: l.slice },
      scene,
    );
    mesh.scaling = new Vector3(l.scaling[0], l.scaling[1], l.scaling[2]);
    mesh.bakeCurrentTransformIntoVertices();
    if (l.offset) mesh.position.set(l.offset[0], l.offset[1], l.offset[2]);
    // Snow caps stay deliberately smaller than the stone under them. At near-body size the
    // snow swallowed the whole boulder and they read as harmless mounds rather than hazards.
    parts.push(paint(mesh, l.colour));
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) throw new Error("failed to build rock mesh");
  merged.name = `rock${variant}`;
  merged.material = createObstacleMaterial(scene, `rockMat${variant}`);
  merged.convertToFlatShadedMesh();
  merged.isPickable = false;
  return merged;
}

export class ObstacleRenderer {
  /** One template per shape, each with its own instance buffer. */
  private readonly trees: Mesh[] = [];
  private readonly rocks: Mesh[] = [];
  private lastFirstSlice = Number.NaN;
  private lastLastSlice = Number.NaN;
  /** The drawing frame the instance matrices were written in. */
  private originVersion = -1;

  constructor(
    scene: Scene,
    private readonly obstacles: ObstacleField,
    private readonly origin: WorldOrigin,
  ) {
    // Ten templates rather than two, so ten draw calls rather than two. That is still nothing
    // next to the hundreds it would take to draw each tree as its own mesh, and it is what
    // buys a forest that does not look stamped from a single mould.
    for (let v = 0; v < VARIANTS; v++) {
      const tree = createTreeMesh(scene, v);
      const rock = createRockMesh(scene, v);
      // Base meshes are only templates; nothing is drawn until instances exist
      tree.thinInstanceCount = 0;
      rock.thinInstanceCount = 0;
      this.trees.push(tree);
      this.rocks.push(rock);
    }
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
    // The instance matrices hold positions in the drawing frame, so a rebase invalidates every
    // one of them — the same slice window has to be written out again against the new origin.
    const moved = this.originVersion !== this.origin.version;
    if (!moved && first === this.lastFirstSlice && last === this.lastLastSlice) return;
    this.lastFirstSlice = first;
    this.lastLastSlice = last;
    this.originVersion = this.origin.version;

    const treeBuckets: Obstacle[][] = this.trees.map(() => []);
    const rockBuckets: Obstacle[][] = this.rocks.map(() => []);
    for (let i = first; i <= last; i++) {
      for (const o of this.obstacles.slice(i)) {
        const buckets = o.kind === ObstacleKind.Tree ? treeBuckets : rockBuckets;
        buckets[o.variant]!.push(o);
      }
    }

    for (let v = 0; v < VARIANTS; v++) {
      this.writeInstances(this.trees[v]!, treeBuckets[v]!);
      this.writeInstances(this.rocks[v]!, rockBuckets[v]!);
    }
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
      translation.set(o.x - this.origin.x, o.y - this.origin.y, o.z - this.origin.z);
      Quaternion.RotationYawPitchRollToRef(o.spin, 0, 0, rotation);
      Matrix.ComposeToRef(scale, rotation, translation, matrix);
      matrix.copyToArray(data, i * 16);
    }

    // Setting the matrix buffer also sets thinInstanceCount from the buffer length
    mesh.thinInstanceSetBuffer("matrix", data, 16, false);
  }

  dispose(): void {
    for (const mesh of [...this.trees, ...this.rocks]) mesh.dispose();
  }
}
