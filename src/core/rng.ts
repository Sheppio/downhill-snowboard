/**
 * Deterministic random numbers.
 *
 * The whole competitive premise of the game — two people entering the same seed ride the
 * identical course — rests on this file. The rule that makes it work:
 *
 *   Never draw world content from one long shared PRNG stream.
 *
 * Chunks are generated in whatever order the player happens to ride, so a shared stream
 * would hand chunk A different numbers depending on whether the player reached it before or
 * after chunk B. Instead every chunk derives its own generator from (worldSeed, chunkX,
 * chunkZ), which makes generation order irrelevant by construction.
 */

/** Hash an arbitrary seed string to a uint32. FNV-1a: tiny, fast, well-mixed enough here. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, via shifts to stay inside 32-bit integer math
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Mix several integers into one uint32. Used to derive per-chunk seeds from the world seed. */
export function hashInts(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    // Fold the full 32 bits of each value in one byte at a time
    let x = v >>> 0;
    for (let b = 0; b < 4; b++) {
      h ^= x & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      x >>>= 8;
    }
  }
  // Final avalanche so neighbouring chunk coordinates land far apart
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

/**
 * mulberry32 — 32-bit state, excellent distribution for its size, and identical across every
 * JS engine because it only uses integer ops and a single float divide.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

/**
 * A generator for one chunk of world. Order-independent: the same (worldSeed, cx, cz) always
 * produces the same sequence no matter when the chunk is built. `salt` separates independent
 * uses within a chunk (e.g. trees vs rocks) so adding one never shifts the other.
 */
export function makeChunkRng(worldSeed: number, cx: number, cz: number, salt = 0): Rng {
  return makeRng(hashInts(worldSeed, cx, cz, salt));
}

const SEED_WORDS_A = [
  "powder", "alpine", "glacier", "summit", "cornice", "blizzard", "frost", "aurora",
  "avalanche", "crystal", "drift", "everest", "flurry", "granite", "hollow", "icefall",
];

const SEED_WORDS_B = [
  "run", "chute", "bowl", "ridge", "gully", "face", "pass", "spur",
  "traverse", "line", "drop", "col", "peak", "shelf", "notch", "couloir",
];

/** A friendly, typeable, shareable random seed like "powder-chute-42". */
export function randomSeedPhrase(): string {
  const r = makeRng((Math.random() * 0xffffffff) >>> 0);
  return `${r.pick(SEED_WORDS_A)}-${r.pick(SEED_WORDS_B)}-${r.int(10, 99)}`;
}

/**
 * The first UTC date whose daily seed is a bare `YYYYMMDD`.
 *
 * A cutover rather than a rename, because the seed string *is* the course: it is hashed to
 * build the mountain, so `daily-2026-08-01` and `20260801` are two different days out on two
 * different hills. Rewriting the format retroactively would swap the course under everyone
 * playing today's run, halfway through the day, and orphan every daily best already recorded.
 *
 * So the old shape stays true for every date it was ever used on, and the new one starts on a
 * day that has not happened yet. Both are read everywhere; only one is ever written.
 */
const COMPACT_DAILY_FROM = "2026-08-02";

/**
 * The seed everyone races on a given day. Derived from the UTC date so a player in Auckland
 * and a player in Los Angeles get the same mountain at the same moment — and it needs no
 * server to coordinate.
 *
 * ISO dates compare correctly as plain strings — fixed width, largest field first — so the
 * cutover needs no date arithmetic to get wrong.
 */
export function dailySeed(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  return iso >= COMPACT_DAILY_FROM ? iso.replace(/-/g, "") : `daily-${iso}`;
}
