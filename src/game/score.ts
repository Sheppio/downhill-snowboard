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
  /**
   * The furthest down the mountain the run has ever been — a high-water mark, not the last
   * position, and the difference matters.
   *
   * Tracking the last position paid for ground *twice* when the rider went backwards and came
   * forward again over the same metres. That is not a corner case: a full-lock turn held for a
   * few seconds carries the rider past 90° off the fall line, at which point `z` decreases.
   * Measured, holding full lock for twenty seconds retreated 9.1m and scored 91 points for 82m
   * of ground — 11% free, compounding for as long as the player kept circling.
   *
   * As a high-water mark, a metre is paid for once and losing ground is simply worth nothing
   * until it has been won back, which is what the run is.
   */
  private furthest = 0;

  reset(): void {
    this.total = 0;
    this.furthest = 0;
  }

  /** Accrue score for any new ground covered since the last call. */
  update(distance: number, speed: number): void {
    if (distance <= this.furthest) return; // no new ground; riding back uphill earns nothing
    const delta = distance - this.furthest;
    this.furthest = distance;
    this.total += delta * speedMultiplier(speed);
  }

  get value(): number {
    return Math.floor(this.total);
  }
}

// Where a score goes once the run ends — the per-seed bests — lives in ./leaderboard.
