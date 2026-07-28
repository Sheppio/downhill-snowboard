/**
 * The gulley.
 *
 * The course is defined by three pure functions of `z` (distance down the mountain) plus a
 * cross-section profile. Riding happens in a natural valley that snakes downhill, narrowing
 * into pinch points and opening into bowls.
 *
 * The key design property: **the banks are terrain, not walls.** They are part of the height
 * field, so riding up one is literally riding uphill. The rider controller's existing slope
 * term bleeds speed on the way up and gravity pulls the rider back down — bank turns and
 * catching air over the lip fall out of physics that has to exist anyway. There is no
 * boundary-collision code anywhere in this game.
 *
 * Axis convention, used consistently everywhere: the rider descends toward **+z**, so `z` is
 * simply distance travelled. This lines up with Babylon's own forward axis, which means a
 * rider mesh modelled facing +Z can take `rotation.y = heading` directly, `heading = 0` is
 * "pointing straight down the mountain", and +x is the rider's right.
 */

import { fbm1, noise1 } from "../core/noise";
import { clamp01, smoothstep } from "../core/math";

/** Constant fall-line gradient. tan(22°) ≈ 0.40 — steep, which is where the speed comes from. */
export const SLOPE = 0.40;

/** Nominal half-width of the rideable floor, in metres. */
const HALF_WIDTH_BASE = 20;
const HALF_WIDTH_MIN = 12;
const HALF_WIDTH_MAX = 32;

/** How high the banks climb above the floor before flattening off, in metres. */
const BANK_HEIGHT = 9;

/** Where the floor ends and the bank starts, as a fraction of half-width. */
const FLOOR_FRACTION = 0.6;

/** Beyond this multiple of half-width the rider counts as off course. */
export const OUT_OF_BOUNDS_FRACTION = 1.6;

/**
 * Straight, wide lead-in, so the course does not start mid-corner.
 *
 * Note this is the *shape* ramp, not the obstacle-free zone — obstacles start much sooner
 * (see OBSTACLE_FREE_LENGTH in obstacles.ts). The first stretch is therefore easy because
 * the course is straight and wide, not because it is empty.
 */
export const RUN_IN_LENGTH = 80;

export interface CourseParams {
  /** Amplitude/wavelength pairs for the three centreline waves. */
  waves: { amp: number; wavelength: number; phase: number }[];
  widthSeed: number;
  gateSeed: number;
}

/**
 * Derive the course shape from the world seed. Three sine waves of decreasing amplitude give
 * a centreline that has both long sweeping traverses and tighter kinks, without ever
 * repeating over the length of a run.
 *
 * The amplitude/wavelength pairs are not free parameters. A sine contributes up to
 * `2*PI*amp/wavelength` to the centreline's dx/dz, and those contributions add, so an
 * innocent-looking short-wavelength wave can demand a crossing angle no rider could hold at
 * speed. The pairs below keep the summed worst case near 0.9 (about 42° off the fall line);
 * an earlier, tighter set reached 1.41 and made some seeds genuinely unfollowable.
 */
export function makeCourseParams(seed: number): CourseParams {
  // Seeded but bounded: every seed is a *different* course, but all are rideable.
  const jitter = (i: number, spread: number) => noise1(seed + i * 7919, i * 13.37) * spread;

  return {
    waves: [
      { amp: 30 + jitter(1, 7), wavelength: 520 + jitter(2, 90), phase: noise1(seed, 1.5) * Math.PI },
      { amp: 11 + jitter(3, 3), wavelength: 250 + jitter(4, 45), phase: noise1(seed, 2.5) * Math.PI },
      { amp: 4.5 + jitter(5, 1.2), wavelength: 120 + jitter(6, 20), phase: noise1(seed, 3.5) * Math.PI },
    ],
    widthSeed: seed ^ 0x5bf03635,
    gateSeed: seed ^ 0x2c1b3c6d,
  };
}

/**
 * Lateral centre of the gulley at a given distance down the mountain.
 * The run-in is held straight so the player starts pointing down a clean line.
 */
export function centreX(params: CourseParams, z: number): number {
  const t = z; // z is distance travelled down the mountain
  const ramp = smoothstep(0, RUN_IN_LENGTH * 1.5, t);

  let x = 0;
  for (const w of params.waves) {
    x += w.amp * Math.sin((t / w.wavelength) * Math.PI * 2 + w.phase);
    x -= w.amp * Math.sin(w.phase); // anchor the start at x = 0
  }
  return x * ramp;
}

/** d(centreX)/dz — the direction the course is heading, for camera lead and obstacle framing. */
export function centreSlope(params: CourseParams, z: number): number {
  const h = 0.5;
  return (centreX(params, z + h) - centreX(params, z - h)) / (2 * h);
}

/** Half-width of the rideable floor at a given distance down the mountain. */
export function halfWidth(params: CourseParams, z: number): number {
  const t = z;
  // Slow variation: pinch points and bowls arrive every few hundred metres
  const n = fbm1(params.widthSeed, t, { octaves: 2, scale: 260 });
  const w = HALF_WIDTH_BASE + n * 11;
  const clamped = Math.max(HALF_WIDTH_MIN, Math.min(HALF_WIDTH_MAX, w));

  // Open the run-in wide so the first seconds are forgiving
  const ramp = smoothstep(0, RUN_IN_LENGTH, t);
  return clamped + (1 - ramp) * 10;
}

/**
 * Height added by the gulley walls, given lateral distance from the centreline.
 *
 * Flat out to 60% of half-width, then a smoothstepped rise to the lip, then a continuing
 * linear climb so that leaving the course is always uphill — that's what makes the soft
 * boundary self-correcting rather than something the player can simply drift out of.
 */
export function bankProfile(dist: number, hw: number): number {
  const floorEdge = hw * FLOOR_FRACTION;
  if (dist <= floorEdge) return 0;

  const lip = hw;
  if (dist <= lip) {
    // Smooth rise from floor to lip — no crease at the transition
    const t = (dist - floorEdge) / (lip - floorEdge);
    return BANK_HEIGHT * t * t * (3 - 2 * t) * 0.75;
  }

  // Past the lip: keep climbing, gently, forever
  const beyond = dist - lip;
  return BANK_HEIGHT * 0.75 + beyond * 0.35;
}

/**
 * The guaranteed-clear racing line, as a lateral fraction of half-width.
 *
 * Obstacles are never placed within `GATE_CLEARANCE` of this line, so a rideable path down
 * the mountain always exists. That matters far more than it sounds: everyone racing a daily
 * seed rides the same course, so a seed that generated a fully blocked corridor would be
 * unwinnable for every player that day. `obstacles.test.ts` asserts the clearance holds.
 *
 * It meanders *smoothly* rather than being re-rolled per slice — a line that jumped sideways
 * every few metres would be clear but physically impossible to follow.
 */
export function gateOffset(params: CourseParams, z: number): number {
  // Wavelength is bounded for the same reason the centreline waves are: this offset's
  // gradient stacks on top of the centreline's, and together they decide how sharply a rider
  // must cross the fall line to hold the clear line. Shorter than the centreline waves, so
  // the line genuinely weaves *within* the corridor instead of just drifting along with it.
  return fbm1(params.gateSeed, z, { octaves: 2, scale: 135 }) * 0.6;
}

/** World-space x of the clear racing line at a given distance down the mountain. */
export function gateX(params: CourseParams, z: number): number {
  return centreX(params, z) + gateOffset(params, z) * halfWidth(params, z);
}

// --- How much clear snow surrounds the racing line ------------------------------------------
//
// This was a single constant, and that is what made the course too easy: a fixed-width lane
// is legible from a long way off and holding it asks almost nothing of the player. It now
// tightens with distance *and* breathes, so a run has rhythm — stretches where the gap is
// genuinely narrow and you have to commit to a line, and stretches that open out again.
//
// GATE_CLEARANCE_MIN is the hard floor and the whole safety guarantee: the breathing term
// only ever widens the channel, never narrows it below the floor. That keeps "is every seed
// completable" a question about one number rather than about the behaviour of noise.

/** Clearance through the opening stretch. Forgiving while the player settles in. */
const GATE_CLEARANCE_START = 5.0;
/**
 * Floor once the course is at full difficulty.
 *
 * Sized against the top speed, not chosen in isolation: at 120 km/h the rider covers ground
 * 40% faster than they used to, so the same gap is proportionally tighter. The difficulty is
 * meant to come from the speed, not from a gap no reaction time can thread.
 */
export const GATE_CLEARANCE_MIN = 3.1;
/** Distance over which the channel tightens to its floor. */
const GATE_CLEARANCE_RAMP = 1200;
/** How far the widest relief stretches open beyond the floor. */
const GATE_BREATH = 2.4;

/** Half-width of the clear channel around the racing line at a given distance, in metres. */
export function gateClearance(params: CourseParams, z: number): number {
  const ramp = clamp01((z - RUN_IN_LENGTH) / GATE_CLEARANCE_RAMP);
  const base = GATE_CLEARANCE_START + (GATE_CLEARANCE_MIN - GATE_CLEARANCE_START) * ramp;

  // Only ever widens, so the floor above stays a guarantee rather than an average
  const breath = fbm1(params.gateSeed ^ 0x9e3779b1, z, { octaves: 2, scale: 210 });
  return base + Math.max(0, breath) * GATE_BREATH;
}

/** How far off the centreline the rider is, as a fraction of half-width (0 = centred). */
export function lateralFraction(params: CourseParams, x: number, z: number): number {
  return Math.abs(x - centreX(params, z)) / halfWidth(params, z);
}

/** 0 while on course, ramping to 1 as the rider strays past the out-of-bounds threshold. */
export function outOfBoundsAmount(params: CourseParams, x: number, z: number): number {
  return clamp01(
    (lateralFraction(params, x, z) - OUT_OF_BOUNDS_FRACTION) / 0.35,
  );
}
