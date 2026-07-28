/** Small numeric helpers shared across the game. */

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, clamped: where does `v` sit between `a` and `b`, as 0..1? */
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

/** Hermite smoothstep between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/**
 * Quintic smoothstep — like `smoothstep`, but with zero *second* derivative at both edges.
 *
 * Worth the extra multiply wherever a ramp scales something large and the result is
 * differentiated twice. Cubic smoothstep's second derivative is 6 at t=0 and -6 at t=1, so a
 * ramp that fades a big value in leaves a curvature step at the moment it finishes. In the
 * course run-in that step was the single tightest corner in the game: the racing line's
 * demand jumped to 81% of the rider's full lock at 119m and fell back to 43% by 125m, purely
 * because the ramp ended there.
 */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Cosine interpolation — smoother than linear for value noise, and cheap enough. */
export function smoothLerp(a: number, b: number, t: number): number {
  return lerp(a, b, t * t * (3 - 2 * t));
}

/**
 * Frame-rate independent exponential damping.
 *
 * `lerp(a, b, 0.1)` per frame moves twice as fast at 120fps as at 60fps; this doesn't.
 * `smoothing` is the fraction of the remaining distance left after one second.
 */
export function expDamp(current: number, target: number, smoothing: number, dt: number): number {
  return target + (current - target) * Math.pow(smoothing, dt);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

/** Shortest signed angular difference from `a` to `b`. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Exponential damping around a circle, taking the short way round. */
export function dampAngle(current: number, target: number, smoothing: number, dt: number): number {
  return wrapAngle(current + angleDelta(current, target) * (1 - Math.pow(smoothing, dt)));
}

export const DEG = Math.PI / 180;
