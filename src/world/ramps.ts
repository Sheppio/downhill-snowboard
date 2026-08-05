/**
 * Speed ramps — short chevroned kickers laid along the racing line.
 *
 * A reward for holding the line rather than an obstacle to dodge. The line is already the
 * hardest thing to hold and the only guaranteed-clear path down the mountain; this pays for
 * holding it, so the skill the whole game is about has something to buy.
 *
 * **They sit on the racing line by construction, not by luck.** A ramp is defined as a stretch
 * of `gateX` rather than as a position of its own, so it curves with the line and can never be
 * generated somewhere the obstacle field has put a tree — the clear channel is 2.5m either
 * side at its narrowest and the ramp reaches 1m either side, so it fits inside the guarantee
 * with room to spare.
 *
 * **Not part of the height field**, which is where this started. A ramp in `heightAt` would be
 * ridden and launched off by the existing physics for free, and would render itself — but the
 * terrain is meshed at 2m per quad, so a ramp would be sampled by one or two vertices and look
 * like nothing at all. Raising the resolution enough to show it is not worth doing for a
 * feature that occupies four metres in every two hundred and fifty. So the ramp is its own
 * terrain-hugging ribbon, and what it does to the rider is applied directly.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { hashInts, makeRng } from "../core/rng";
import { gateX, type CourseParams } from "./course";
import type { TerrainField } from "./terrain";
import type { WorldOrigin } from "./origin";

/** How long a ramp is, in metres down the mountain. */
export const RAMP_LENGTH = 4;
/**
 * How wide, in metres.
 *
 * Still narrower than the clear channel it lives inside — that is 2.5m either side of the
 * racing line at its very narrowest, against 1m of ramp either side — so a ramp can no more
 * collide with a tree at this width than at the last one.
 */
export const RAMP_WIDTH = 2;

/**
 * Speed handed out for riding the full length, in m/s. 20 km/h.
 *
 * Paid out in proportion to how much of the ramp was actually covered, so clipping the last
 * half metre of one is worth a sixth of it rather than all or nothing. All-or-nothing would
 * make the edges of the ramp a cliff the player cannot see.
 */
export const RAMP_BOOST = 20 / 3.6;

/**
 * Upward kick at the lip, in m/s, for a full-length ride.
 *
 * Small on purpose. This is a speed pad that happens to pop, not a jump: about 0.3m of air
 * over a third of a second at speed, which reads as a kick without taking away the steering
 * for long enough to matter. Airborne riders keep only 35% of their turn authority, so a
 * generous ramp on the racing line would be a trap rather than a reward.
 */
export const RAMP_LIFT = 2.2;

/** How high the lip stands above the snow. Shallow — the boost is the point, not the air. */
const RAMP_RISE = 0.12;

/** Roughly one every this many metres. */
export const RAMP_SPACING = 250;
/** Wobble either side of that, so they are not metronomic. */
const RAMP_JITTER = 45;

/**
 * Tightest the racing line may curve under a ramp, in 1/m.
 *
 * **Ramps go on straights**, and this is what makes that true rather than hoped for. A rider
 * in the air keeps only 35% of their turn authority, so a kicker sitting in a corner does not
 * reward the line, it takes the steering away exactly where the line needs it — and the ramp
 * is *on* the racing line, so anyone riding well meets it.
 *
 * The number is measured, not chosen. Placing ramps anywhere, the reference pilot lost the
 * line at 2012m on one daily seed as soon as the lip kicked harder than 0.6 m/s, against a
 * 3000m completability guarantee. Sweeping the threshold against a full 2.2 m/s kick:
 *
 *   0.004   11 ramps per 8km   worst seed 4145m
 *   0.006   22 ramps per 8km   worst seed 3273m
 *   0.008   28 ramps per 8km   worst seed 3273m   <- here
 *   0.012   32 ramps per 8km   worst seed 2786m   guarantee broken
 *   none    34 ramps per 8km   worst seed 2012m
 *
 * So 0.008 is the loosest setting that keeps every seed completable, and it is the one that
 * places the most ramps. For scale, the line's curvature over a ramp-length window runs from
 * about 0.004 at the tenth percentile to 0.021 at the ninetieth, and the tightest corner in
 * the game is 0.039.
 */
const RAMP_MAX_CURVATURE = 0.008;

/** How many jittered positions to try before giving up on a ramp for this stretch. */
const PLACEMENT_ATTEMPTS = 6;

/** How sharply the racing line bends at a point, in 1/m — the same measure course.test.ts uses. */
function lineCurvature(params: CourseParams, z: number): number {
  const h = 1;
  const g0 = gateX(params, z - h);
  const g1 = gateX(params, z);
  const g2 = gateX(params, z + h);
  const slope = (g2 - g0) / (2 * h);
  const second = (g2 - 2 * g1 + g0) / (h * h);
  return Math.abs(second) / Math.pow(1 + slope * slope, 1.5);
}

/** True if the line is straight enough along a whole ramp to be worth kicking off. */
function straightEnough(params: CourseParams, z: number): boolean {
  // Sampled across the ramp *and* a little past its lip, because what matters is having the
  // steering back before the next thing the line asks for.
  for (let s = -1; s <= RAMP_LENGTH + 8; s += 1) {
    if (lineCurvature(params, z + s) > RAMP_MAX_CURVATURE) return false;
  }
  return true;
}

/** Clear of the run-in, so the first thing a new player meets is still the plain mountain. */
const FIRST_RAMP = 1;

/** Lift off the snow, to keep the ribbon out of the terrain's z-buffer. */
const DECAL_LIFT = 0.03;

/** Segments along a ramp's length. Enough to hug the undulation under it. */
const SEGMENTS = 8;

export interface Ramp {
  /** Which ramp down the mountain this is; the first is 1. */
  index: number;
  /** Distance down the mountain of the near, uphill edge. */
  z: number;
}

/**
 * Where the nth ramp starts.
 *
 * Pure and closed-form, so any point on the mountain can ask which ramp is near it without
 * generating anything — the same property the terrain and the racing line have, and the reason
 * a seed plays out identically for everyone.
 */
export function rampZ(params: CourseParams, seed: number, index: number): number | null {
  const rng = makeRng(hashInts(seed, index, 0x7a4b5d));
  // A few jittered candidates, taking the first that lands on a straight. Some stretches of
  // some seeds are corner all the way through and get no ramp at all, which is the right
  // answer: a stretch with no reward is better than one with a trap in it.
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const z = index * RAMP_SPACING + rng.range(-RAMP_JITTER, RAMP_JITTER);
    if (straightEnough(params, z)) return z;
  }
  return null;
}

/** Every ramp between two distances down the mountain, in order. */
export function rampsBetween(
  params: CourseParams,
  seed: number,
  zMin: number,
  zMax: number,
): Ramp[] {
  // The jitter can move a ramp by up to RAMP_JITTER either way, so the search widens by that
  // much at both ends or a ramp near a boundary is missed.
  const first = Math.max(FIRST_RAMP, Math.floor((zMin - RAMP_JITTER) / RAMP_SPACING));
  const last = Math.ceil((zMax + RAMP_JITTER) / RAMP_SPACING);
  const out: Ramp[] = [];
  for (let i = first; i <= last; i++) {
    const z = rampZ(params, seed, i);
    if (z !== null && z + RAMP_LENGTH >= zMin && z <= zMax) out.push({ index: i, z });
  }
  return out;
}

/** What riding a stretch of mountain earned. */
export interface RampReward {
  /** Extra speed, m/s. */
  boost: number;
  /** Upward kick, m/s, non-zero only on leaving the far lip. */
  lift: number;
}

const NOTHING: RampReward = { boost: 0, lift: 0 };

/**
 * What the rider earns for moving from `zFrom` to `zTo` at lateral position `x`.
 *
 * Measured over the interval rather than sampled at a point, so the payout is the same whether
 * the game is running at 30fps or 120 — a per-frame award would hand out twice as much on a
 * fast device, which on a shared-seed leaderboard is not a rounding error but a cheat.
 */
export function rampReward(
  params: CourseParams,
  seed: number,
  x: number,
  zFrom: number,
  zTo: number,
): RampReward {
  if (zTo <= zFrom) return NOTHING;

  let boost = 0;
  let lift = 0;
  for (const ramp of rampsBetween(params, seed, zFrom, zTo)) {
    const end = ramp.z + RAMP_LENGTH;
    const covered = Math.min(zTo, end) - Math.max(zFrom, ramp.z);
    if (covered <= 0) continue;
    // The ramp *is* a stretch of the racing line, so being on it means being on the line —
    // measured at the far end of the interval, which is where the rider actually is now.
    const along = Math.min(Math.max(zTo, ramp.z), end);
    if (Math.abs(x - gateX(params, along)) > RAMP_WIDTH / 2) continue;

    boost += RAMP_BOOST * (covered / RAMP_LENGTH);
    // The kick belongs to the lip, whole, and only to a rider still on the ramp when they
    // reach it. Not scaled like the boost is: the boost is spread over the ramp and so has a
    // share of it to be proportional *to*, where the kick happens in the one frame that
    // crosses the end — and scaling it by that frame's slice of the ramp made it a
    // twentieth of itself at speed. A rider on a 1m lane at the lip rode the ramp.
    if (zFrom < end && zTo >= end) lift += RAMP_LIFT;
  }
  return boost > 0 || lift > 0 ? { boost, lift } : NOTHING;
}

/**
 * How far off the snow the rider can be and still be riding the ramp, in metres.
 *
 * Not `airborne`, which was the obvious test and is the wrong one. This mountain undulates,
 * and at 105 km/h the rider is technically off the ground about a fifth of the time — measured
 * over a single ramp, four of the six frames on it. Skipping those paid out a third of the
 * boost on a clean pass down the middle of the line, which reads as the pad being broken
 * rather than as a rule.
 *
 * A height instead of a flag: skimming over the ripples still counts, sailing over the whole
 * thing off a roller does not.
 */
const RAMP_REACH = 0.6;

/**
 * Give the rider whatever the ground it just covered was worth.
 *
 * Call with the `z` the rider had *before* `update`. Exported and used by the game loop and by
 * every test that rides a course, so the autopilot the difficulty guarantees are measured
 * against is on the same mountain as the player. Without it those tests would keep measuring a
 * top speed the game no longer has, and the racing line would be checked against the wrong one.
 */
export function applyRamps(
  rider: { x: number; y: number; z: number; boost(speed: number, lift: number): void },
  field: TerrainField,
  seed: number,
  fromZ: number,
): RampReward {
  if (rider.y - field.heightAt(rider.x, rider.z) > RAMP_REACH) return NOTHING;
  const earned = rampReward(field.params, seed, rider.x, fromZ, rider.z);
  if (earned.boost > 0 || earned.lift > 0) rider.boost(earned.boost, earned.lift);
  // Returned rather than left to the caller to infer from the rider's speed going up: the
  // rider accelerates downhill anyway, by more in a single 120Hz step than a threshold could
  // reliably tell from a ramp, so "did the speed rise" answers yes almost every frame.
  return earned;
}

// --- Rendering ------------------------------------------------------------------------------

const VIEW_AHEAD = 260;
const VIEW_BEHIND = 30;

/**
 * How many texture tiles fit along a ramp — two chevrons each.
 *
 * 1.5, so three arrows over three metres. Six read as horizontal stripes rather than as
 * arrows at the angle and distance a rider actually sees them from, which loses the one thing
 * the marking is for: saying which way to go, and that going that way is fast.
 */
const CHEVRONS = 1.5;
/** Chevrons per second of travel down the ribbon. */
const CHEVRON_SPEED = 1.4;

/**
 * The chevron strip, drawn once into a texture and scrolled.
 *
 * Scrolled rather than redrawn: the arrows have to move to be inviting, and moving a `vOffset`
 * costs nothing where redrawing a canvas every frame on a phone costs a great deal.
 */
function createChevronTexture(scene: Scene): DynamicTexture {
  const W = 64;
  const H = 128;
  const tex = new DynamicTexture("rampChevrons", { width: W, height: H }, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;

  // Red against yellow, the loudest pair there is. Mint was the first choice and reads too
  // softly against bright snow at the distance a rider first sees a ramp from — which is the
  // one moment the marking has to work at all.
  //
  // A deeper red than the palette's berry, which is within a few percent of the rider's
  // jacket. Two saturated pinks a few metres apart on screen is one thing too many to parse
  // at speed, and the ramp is the one that has to be recognised instantly.
  ctx.fillStyle = "#e63946";
  ctx.fillRect(0, 0, W, H);

  // Two chevrons per tile, so the seam between repeats lands mid-gap rather than mid-arrow
  ctx.strokeStyle = "#ffd166";
  ctx.lineWidth = W * 0.26;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  for (let i = 0; i < 2; i++) {
    const base = (i + 0.25) * (H / 2);
    ctx.beginPath();
    ctx.moveTo(W * 0.06, base);
    ctx.lineTo(W * 0.5, base + H * 0.26);
    ctx.lineTo(W * 0.94, base);
    ctx.stroke();
  }

  tex.update(false);
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.hasAlpha = false;
  return tex;
}

/**
 * Draws the ramps near the rider.
 *
 * One mesh per visible ramp rather than thin instances of a template, because each one has to
 * follow the terrain and the racing line beneath it and no two are the same shape. There are
 * only ever one or two in view, so a handful of draw calls is the whole cost.
 */
export class RampRenderer {
  private readonly meshes: Mesh[] = [];
  private readonly material: StandardMaterial;
  private readonly texture: DynamicTexture;
  private drawn: number[] = [];
  /** The drawing frame the ribbons were baked in. */
  private originVersion = -1;

  constructor(
    private readonly scene: Scene,
    private readonly params: CourseParams,
    private readonly seed: number,
    private readonly field: TerrainField,
    private readonly origin: WorldOrigin,
  ) {
    this.texture = createChevronTexture(scene);
    const mat = new StandardMaterial("rampMat", scene);
    // Unlit and self-lit: the ramp has to read as a marking rather than as snow, and on a
    // white slope in flat light anything shaded the same way as the ground disappears.
    mat.disableLighting = true;
    mat.emissiveTexture = this.texture;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    // The ribbon lies within a few centimetres of the ground it is drawn over
    mat.zOffset = -2;
    mat.backFaceCulling = false;
    this.material = mat;
  }

  /** Rebuild the visible ramps if the set has changed, and scroll the chevrons. */
  update(playerZ: number, dt: number): void {
    this.texture.vOffset -= CHEVRON_SPEED * dt;

    const near = rampsBetween(this.params, this.seed, playerZ - VIEW_BEHIND, playerZ + VIEW_AHEAD);
    const wanted = near.map((r) => r.index);
    // Ribbon vertices are baked in the drawing frame, so a rebase means rebuilding them even
    // though the same ramps are still the visible ones.
    const moved = this.originVersion !== this.origin.version;
    if (
      !moved &&
      wanted.length === this.drawn.length &&
      wanted.every((v, i) => v === this.drawn[i])
    ) {
      return;
    }
    this.drawn = wanted;
    this.originVersion = this.origin.version;

    while (this.meshes.length < near.length) {
      const mesh = new Mesh(`ramp${this.meshes.length}`, this.scene);
      mesh.material = this.material;
      mesh.isPickable = false;
      this.meshes.push(mesh);
    }
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i]!;
      const ramp = near[i];
      mesh.setEnabled(ramp !== undefined);
      if (ramp) this.build(mesh, ramp);
    }
  }

  /** A ribbon of quads following the racing line and the snow under it. */
  private build(mesh: Mesh, ramp: Ramp): void {
    const rows = SEGMENTS + 1;
    const positions = new Float32Array(rows * 2 * 3);
    const uvs = new Float32Array(rows * 2 * 2);
    const indices = new Uint32Array(SEGMENTS * 6);

    for (let s = 0; s < rows; s++) {
      const t = s / SEGMENTS;
      const z = ramp.z + t * RAMP_LENGTH;
      const cx = gateX(this.params, z);
      // Flush with the snow at the near edge and rising to the lip, so a rider meets no step
      // on the way on. The lip is 0.12m, which is a kicker to look at and nothing to ride.
      const lift = DECAL_LIFT + RAMP_RISE * t;
      for (let side = 0; side < 2; side++) {
        const x = cx + (side === 0 ? -RAMP_WIDTH / 2 : RAMP_WIDTH / 2);
        const i = (s * 2 + side) * 3;
        positions[i] = x - this.origin.x;
        positions[i + 1] = this.field.heightAt(x, z) + lift - this.origin.y;
        positions[i + 2] = z - this.origin.z;
        const u = (s * 2 + side) * 2;
        uvs[u] = side;
        uvs[u + 1] = t * CHEVRONS;
      }
    }

    for (let s = 0; s < SEGMENTS; s++) {
      const a = s * 2;
      const o = s * 6;
      indices[o] = a;
      indices[o + 1] = a + 1;
      indices[o + 2] = a + 2;
      indices[o + 3] = a + 1;
      indices[o + 4] = a + 3;
      indices[o + 5] = a + 2;
    }

    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.uvs = uvs;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = new Float32Array(normals);
    data.applyToMesh(mesh, true);
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    this.meshes.length = 0;
    this.material.dispose();
    this.texture.dispose();
  }
}
