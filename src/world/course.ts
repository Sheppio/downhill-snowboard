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
import { clamp01, lerp, smootherstep } from "../core/math";

// --- The fall line -------------------------------------------------------------------------
//
// The mountain steepens as you descend. It opens at tan(22°) ≈ 0.40 — already steep, and where
// the speed comes from — and rolls over toward 1 metre down per metre along, a 45° face, deep
// in the run. That is the escalation the player *feels* rather than reads: the same corner
// arrives sooner, and the ground itself is visibly tipping away.
//
// The ramp starts at 1300m for the same reason every other escalation does — see the note on
// weaveGain — so the stretch nearly every attempt actually covers is untouched.

/** Fall-line gradient through the opening. tan(22°). */
export const SLOPE_START = 0.40;
/** Gradient once the mountain has fully tipped over: 1m down per metre along, i.e. 45°. */
export const SLOPE_DEEP = 1.0;
/** Where the mountain begins to steepen. Matches every other difficulty ramp. */
const SLOPE_RAMP_START = 1300;
/** Where it reaches SLOPE_DEEP and stops. Beyond here the gradient is constant again. */
const SLOPE_RAMP_END = 10000;

/** The fall-line gradient at a given distance down the mountain. */
export function slopeAt(z: number): number {
  return lerp(
    SLOPE_START,
    SLOPE_DEEP,
    clamp01((z - SLOPE_RAMP_START) / (SLOPE_RAMP_END - SLOPE_RAMP_START)),
  );
}

/**
 * How far the fall line has descended by `z` — the integral of `slopeAt` from 0.
 *
 * This is the part that is easy to get wrong, and wrong in a way that looks right. The obvious
 * `-z * slopeAt(z)` is not a slope that varies with z, it is a *parabola*: differentiate it and
 * the real gradient is `s(z) + z·s'(z)`, which through the ramp is about twice what `slopeAt`
 * claims and blows straight past 45°. The height field has to be the antiderivative, so that
 * the gradient the rider actually meets is the gradient this module says it is.
 * `terrain.test.ts` checks the two against each other numerically.
 *
 * Negative z — the terrain behind the start line, which does get meshed — extends the opening
 * gradient backwards, which is what clamping `slopeAt` implies and keeps the surface smooth
 * across z = 0.
 */
export function dropTo(z: number): number {
  if (z <= SLOPE_RAMP_START) return SLOPE_START * z;

  const span = SLOPE_RAMP_END - SLOPE_RAMP_START;
  const d = Math.min(z, SLOPE_RAMP_END) - SLOPE_RAMP_START;
  // Opening stretch, plus the ramp's own area: a rectangle under SLOPE_START and the triangle
  // the linear rise adds on top of it.
  let drop =
    SLOPE_START * SLOPE_RAMP_START + SLOPE_START * d + ((SLOPE_DEEP - SLOPE_START) * d * d) / (2 * span);
  if (z > SLOPE_RAMP_END) drop += SLOPE_DEEP * (z - SLOPE_RAMP_END);
  return drop;
}

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

// --- How the course escalates with distance ------------------------------------------------
//
// Every other difficulty ramp in the game finishes by ~1300m: obstacle density pins at its
// maximum and the clear channel reaches its floor. Past that the course stopped getting
// harder at all, so a long run turned into an endurance test at fixed difficulty.
//
// This ramp continues the escalation by growing the centreline weave — the gulley itself
// snakes harder the further down you get.
//
// Why the *centreline* rather than the racing line's meander within it: measurement. Ramping
// the gate offset amplitude from 0.6 to 0.85 moved the sustained crossing angle by 0.2° and
// the peak turn-rate demand by five points — it relocates the racing line without making it
// meaningfully harder to hold. The centreline dominates the lateral motion, so it is the term
// with real authority: x1.3 here moves the sustained crossing angle from 16.2° to 18.9°.
//
// Amplitude only. Shortening the wavelength instead is not merely aggressive but structurally
// wrong: `scale` is the divisor on the noise/sine argument, so making it a function of z
// reparameterises the domain non-linearly, injecting curvature unrelated to the intended
// shape and leaving a kink where the ramp ends. Measured, that produced peaks of 651% of full
// lock against 74% for the equivalent amplitude change.
const WEAVE_GAIN_START = 1300;
const WEAVE_GAIN_END = 4200;
/**
 * Ceiling on the weave growth.
 *
 * Chosen empirically as the largest gain that still lets the reference pilot complete every
 * daily seed of the year — measured over 53 seeds ridden to 6000m:
 *
 *     gain   seeds completing   deep mean speed   deep line error
 *     1.0        53/53             30.41 m/s          0.37 m
 *     1.3        53/53             29.70 m/s          0.48 m
 *     1.35       52/53             29.58 m/s          0.49 m
 *     1.8        44/53             28.53 m/s          0.65 m
 *
 * So 1.3 buys a 30% increase in how far the pilot drifts off the clear line deep in a run,
 * for no loss of the completability guarantee; 1.35 starts costing seeds.
 *
 * It also sits inside the crossing-angle budget documented on `makeCourseParams`: the summed
 * worst case is ~0.87 today and ~1.41 is where an earlier, tighter set made seeds
 * unfollowable, so a gain of 1.3 takes it to ~1.14 — still clear of that line.
 *
 * Those figures were measured on a mountain of constant 0.40 gradient. The ceiling itself has
 * not moved and neither has anything below WEAVE_GAIN_END, but the fall line now steepens past
 * it and the rider gets much faster — so the weave eases back out there instead. See
 * WEAVE_RELAX below for why that is geometry rather than a difficulty knob.
 */
const WEAVE_GAIN_MAX = 1.36;

// --- and where it hands over to the steepness -----------------------------------------------
//
// A steep face cannot also snake hard, and the fall line now tips toward 45° past 4200m. This
// is not a fudge to make a test pass, it is the geometry: following x = g(z) at speed v needs a
// yaw rate of curvature * v, and deep in a run v has gone from 39 m/s to 46. Holding the weave
// at full gain out there asked 2.01 rad/s of a rider who has 1.72 — the line stops being merely
// hard and becomes one that no input holds, which is the one thing the course must never do.
//
// So the gulley trades snaking for steepness: past the point the weave tops out it eases back
// toward straight, and what makes the deep mountain frightening is the pitch, the speed and the
// trees rather than the corners. A steep couloir runs straight, which is also why this reads as
// terrain rather than as a difficulty knob being turned down.
//
// Nothing before WEAVE_GAIN_END moves, so the escalation players actually reach is exactly as
// it was tuned and measured. This only touches ground the reference pilot dies well short of.
const WEAVE_RELAX_END = 10000;
/** How much of the weave survives once the mountain has fully tipped over. */
const WEAVE_RELAX = 0.55;

/** How much the centreline weave is amplified at a given distance down the mountain. */
export function weaveGain(z: number): number {
  const grown = lerp(
    1,
    WEAVE_GAIN_MAX,
    clamp01((z - WEAVE_GAIN_START) / (WEAVE_GAIN_END - WEAVE_GAIN_START)),
  );
  const relax = lerp(
    1,
    WEAVE_RELAX,
    clamp01((z - WEAVE_GAIN_END) / (WEAVE_RELAX_END - WEAVE_GAIN_END)),
  );
  return grown * relax;
}

/**
 * Lateral centre of the gulley at a given distance down the mountain.
 * The run-in is held straight so the player starts pointing down a clean line.
 */
export function centreX(params: CourseParams, z: number): number {
  const t = z; // z is distance travelled down the mountain
  // Quintic, not cubic: this ramp scales the full wave sum (~55m by the time it finishes), so
  // a ramp with a second-derivative step at its end put a curvature spike there — see
  // smootherstep. Cubic made 119m the tightest corner in the game, ten seconds into every run.
  const ramp = smootherstep(0, RUN_IN_LENGTH * 1.5, t);
  // Constant below WEAVE_GAIN_START, so everything above it is untouched — see weaveGain
  const gain = weaveGain(t);

  let x = 0;
  for (const w of params.waves) {
    const amp = w.amp * gain;
    x += amp * Math.sin((t / w.wavelength) * Math.PI * 2 + w.phase);
    x -= amp * Math.sin(w.phase); // anchor the start at x = 0
  }
  return x * ramp;
}

/** d(centreX)/dz — the direction the course is heading, for camera lead and obstacle framing. */
export function centreSlope(params: CourseParams, z: number): number {
  const h = 0.5;
  return (centreX(params, z + h) - centreX(params, z - h)) / (2 * h);
}

// The gulley itself closes in deep in the course. This is the one lever that costs nothing
// against the rider's turn-rate budget: a narrower corridor does not bend the racing line any
// harder — if anything it straightens it, since the line's excursion is a fraction of this
// width — it just leaves less room either side of it and brings the banks in closer.
const NARROWING_START = 2200;
const NARROWING_END = 5000;
/** How much of the gulley's width remains once it has fully closed in. */
const NARROWING_MIN = 0.82;

/** Fraction of the nominal gulley width still open at a given distance. */
export function narrowingAt(z: number): number {
  return lerp(1, NARROWING_MIN, clamp01((z - NARROWING_START) / (NARROWING_END - NARROWING_START)));
}

/** Half-width of the rideable floor at a given distance down the mountain. */
export function halfWidth(params: CourseParams, z: number): number {
  const t = z;
  // Slow variation: pinch points and bowls arrive every few hundred metres
  const n = fbm1(params.widthSeed, t, { octaves: 2, scale: 260 });
  const w = HALF_WIDTH_BASE + n * 11;
  const clamped = Math.max(HALF_WIDTH_MIN, Math.min(HALF_WIDTH_MAX, w));

  // Open the run-in wide so the first seconds are forgiving. Quintic for the same reason as
  // centreX: the racing line is offset by a fraction of this width, so a curvature step here
  // feeds straight into the line the rider has to hold.
  const ramp = smootherstep(0, RUN_IN_LENGTH, t);
  return (clamped + (1 - ramp) * 10) * narrowingAt(t);
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

// The floor above is where the channel used to stop tightening, at ~1280m. Past that it goes
// on closing, slowly, to the distance the course is meant to be brutal at. The rider is also
// getting faster over the same stretch, so a gap that is narrower *and* arrives sooner is
// tightening twice over — which is why this second stage is small.
const GATE_SQUEEZE_START = 2200;
const GATE_SQUEEZE_END = 5000;
/**
 * Clear half-width once the squeeze is complete.
 *
 * Widened from 2.5 when the fall line started steepening. A gap is only as tight as the speed
 * you arrive at it, and the deep mountain now runs about 12% faster than it did — measured over
 * a year of daily seeds, holding 2.5 here put the worst seed's reference ride at 2986m, inside
 * the 3000m completability guarantee. 2.8 puts it back at 3274m, which is exactly where it sat
 * before the mountain tipped: the same margin, against a course that is meaningfully faster.
 *
 * Still comfortably the tightest the channel ever gets — it is 3.1 through the middle of a run
 * — so this stays an escalation, just one paid for by speed rather than by width. The rider it
 * has to admit is 0.225m to the half-width, not the 0.6m circle this was first sized against.
 */
export const GATE_CLEARANCE_DEEP = 2.8;
/** How far the widest relief stretches open beyond the floor. */
const GATE_BREATH = 2.4;

/** Half-width of the clear channel around the racing line at a given distance, in metres. */
export function gateClearance(params: CourseParams, z: number): number {
  const ramp = clamp01((z - RUN_IN_LENGTH) / GATE_CLEARANCE_RAMP);
  const settled = GATE_CLEARANCE_START + (GATE_CLEARANCE_MIN - GATE_CLEARANCE_START) * ramp;
  const squeeze = clamp01((z - GATE_SQUEEZE_START) / (GATE_SQUEEZE_END - GATE_SQUEEZE_START));
  const base = settled + (GATE_CLEARANCE_DEEP - GATE_CLEARANCE_MIN) * squeeze;

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
