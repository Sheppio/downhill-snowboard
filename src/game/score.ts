/**
 * Scoring.
 *
 * Distance is the score. Speed adds a small multiplier on top, so a fast clean line beats a
 * slow cautious one over the same ground — but only modestly, because distance has to stay
 * the thing players are chasing. Carving hard to survive should always be worth more than
 * straight-lining into a tree for the bonus.
 *
 * The multiplier is applied *per metre as it is travelled*, not to the final total. Applying
 * it at the end would score a whole run at whatever speed it happened to finish at, which
 * would be both wrong and easy to game.
 */

import { clamp01 } from "../core/math";

/** Below this speed there is no bonus at all. About 65 km/h. */
const CRUISE_SPEED = 18;
/** Speed at which the bonus is maxed out. About 122 km/h — a genuinely quick run. */
const FAST_SPEED = 34;
/** Maximum bonus. Deliberately small — this is a distance game with a speed kicker. */
const MAX_BONUS = 0.35;

export interface ScoreSummary {
  score: number;
  distance: number;
  topSpeed: number;
  seed: string;
}

/** Live multiplier for a given speed, in [1, 1 + MAX_BONUS]. */
export function speedMultiplier(speed: number): number {
  return 1 + MAX_BONUS * clamp01((speed - CRUISE_SPEED) / (FAST_SPEED - CRUISE_SPEED));
}

export class Score {
  private total = 0;
  private lastDistance = 0;

  reset(): void {
    this.total = 0;
    this.lastDistance = 0;
  }

  /** Accrue score for the ground covered since the last call. */
  update(distance: number, speed: number): void {
    const delta = distance - this.lastDistance;
    this.lastDistance = distance;
    if (delta <= 0) return; // riding back uphill earns nothing
    this.total += delta * speedMultiplier(speed);
  }

  get value(): number {
    return Math.floor(this.total);
  }
}

// --- Personal bests -----------------------------------------------------------------------

const STORAGE_PREFIX = "downhill.best.";

/**
 * Bests are stored per seed, because that is the unit of competition — your best on today's
 * run says nothing about your best on some other mountain.
 *
 * Storage is wrapped because localStorage throws rather than no-ops in Safari private mode,
 * and losing a high score is never worth crashing a game over.
 */
export function readBest(seed: string): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + seed);
    const value = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Record a score if it beats the stored best. Returns true if it was a new record. */
export function writeBest(seed: string, score: number): boolean {
  if (score <= readBest(seed)) return false;
  try {
    localStorage.setItem(STORAGE_PREFIX + seed, String(score));
  } catch {
    // Private browsing, storage full, or storage disabled — the run still counted
  }
  return true;
}
