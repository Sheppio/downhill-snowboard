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

/** Constant fall-line gradient. tan(15°) ≈ 0.268 — a comfortable intermediate pitch. */
export const SLOPE = 0.268;

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

/** Straight, obstacle-free run-in so the player can settle before the course begins. */
export const RUN_IN_LENGTH = 80;

export interface CourseParams {
  /** Amplitude/wavelength pairs for the three centreline waves. */
  waves: { amp: number; wavelength: number; phase: number }[];
  widthSeed: number;
}

/**
 * Derive the course shape from the world seed. Three sine waves of decreasing amplitude give
 * a centreline that has both long sweeping traverses and tighter kinks, without ever
 * repeating over the length of a run.
 */
export function makeCourseParams(seed: number): CourseParams {
  // Seeded but bounded: every seed is a *different* course, but all are rideable.
  const jitter = (i: number, spread: number) => noise1(seed + i * 7919, i * 13.37) * spread;

  return {
    waves: [
      { amp: 30 + jitter(1, 8), wavelength: 400 + jitter(2, 90), phase: noise1(seed, 1.5) * Math.PI },
      { amp: 12 + jitter(3, 4), wavelength: 150 + jitter(4, 35), phase: noise1(seed, 2.5) * Math.PI },
      { amp: 5 + jitter(5, 2), wavelength: 60 + jitter(6, 12), phase: noise1(seed, 3.5) * Math.PI },
    ],
    widthSeed: seed ^ 0x5bf03635,
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
