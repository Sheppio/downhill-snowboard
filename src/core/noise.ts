/**
 * Seeded gradient noise.
 *
 * Every function here is a *pure function* of (seed, coordinates) — there is no internal
 * state and no sequence. That is deliberate: terrain height must be answerable for any point
 * at any time, in any order, and give the same answer to every player on the same seed. A
 * stateful generator could not do that.
 *
 * Gradient ("Perlin-style") noise rather than value noise: value noise has a visible axis-
 * aligned blockiness that reads badly on wide-open snow.
 */

import { smoothLerp } from "./math";

/** Fast 2D integer hash → uint32. Inlined rather than reusing rng.hashInts, which loops. */
function hash2(seed: number, ix: number, iz: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

function hash1(seed: number, ix: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * 16 unit vectors on the circle. Using a table rather than sin/cos per lookup keeps the
 * noise cheap, and 16 directions is plenty to avoid the directional banding you get with the
 * classic 4- or 8-gradient sets.
 */
const GRAD_X = new Float32Array(16);
const GRAD_Z = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Z[i] = Math.sin(a);
}

/** Dot of the lattice gradient at (ix, iz) with the offset to the sample point. */
function gradDot(seed: number, ix: number, iz: number, dx: number, dz: number): number {
  const g = hash2(seed, ix, iz) & 15;
  return GRAD_X[g]! * dx + GRAD_Z[g]! * dz;
}

/** 2D gradient noise, roughly in [-1, 1]. Lattice spacing is 1 unit. */
export function noise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;

  const n00 = gradDot(seed, ix, iz, fx, fz);
  const n10 = gradDot(seed, ix + 1, iz, fx - 1, fz);
  const n01 = gradDot(seed, ix, iz + 1, fx, fz - 1);
  const n11 = gradDot(seed, ix + 1, iz + 1, fx - 1, fz - 1);

  const nx0 = smoothLerp(n00, n10, fx);
  const nx1 = smoothLerp(n01, n11, fx);
  // Gradient noise peaks near ±0.707 in 2D; scale so the usable range is about [-1, 1]
  return smoothLerp(nx0, nx1, fz) * 1.4142;
}

/** 1D gradient noise, roughly in [-1, 1]. Used for slowly-varying course parameters. */
export function noise1(seed: number, x: number): number {
  const ix = Math.floor(x);
  const fx = x - ix;
  // Gradient in 1D is just a signed slope in [-1, 1]
  const g0 = (hash1(seed, ix) / 4294967296) * 2 - 1;
  const g1 = (hash1(seed, ix + 1) / 4294967296) * 2 - 1;
  return smoothLerp(g0 * fx, g1 * (fx - 1), fx) * 2;
}

export interface FbmOptions {
  /** Number of noise layers. More octaves = more fine detail, linearly more cost. */
  octaves?: number;
  /** Frequency multiplier per octave. */
  lacunarity?: number;
  /** Amplitude multiplier per octave. */
  gain?: number;
  /** Size of the largest feature, in world metres. */
  scale?: number;
  /**
   * Optional separate feature size along z. Stretching features down the mountain lowers the
   * *along-track* gradient without flattening the terrain visually — which is what keeps the
   * slope from ever turning uphill and stalling the rider. See world/terrain.ts.
   */
  scaleZ?: number;
}

/**
 * Fractal Brownian motion — stacked octaves of noise2, normalised to about [-1, 1].
 *
 * Each octave gets its own derived seed so that changing the octave count doesn't reshuffle
 * the layers that were already there.
 */
export function fbm2(seed: number, x: number, z: number, opts: FbmOptions = {}): number {
  const { octaves = 4, lacunarity = 2.0, gain = 0.5, scale = 100 } = opts;
  const scaleZ = opts.scaleZ ?? scale;

  let freqX = 1 / scale;
  let freqZ = 1 / scaleZ;
  let amp = 1;
  let sum = 0;
  let norm = 0;

  for (let o = 0; o < octaves; o++) {
    sum += noise2(seed + o * 0x9e3779b1, x * freqX, z * freqZ) * amp;
    norm += amp;
    freqX *= lacunarity;
    freqZ *= lacunarity;
    amp *= gain;
  }

  return norm > 0 ? sum / norm : 0;
}

/** fBm over one dimension, same normalisation. */
export function fbm1(seed: number, x: number, opts: FbmOptions = {}): number {
  const { octaves = 3, lacunarity = 2.0, gain = 0.5, scale = 100 } = opts;

  let freq = 1 / scale;
  let amp = 1;
  let sum = 0;
  let norm = 0;

  for (let o = 0; o < octaves; o++) {
    sum += noise1(seed + o * 0x9e3779b1, x * freq) * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }

  return norm > 0 ? sum / norm : 0;
}
