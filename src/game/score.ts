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
/**
 * Speed at which the speed bonus is maxed out. About 151 km/h.
 *
 * This was 34 m/s, and had been since before the mountain learned to keep getting faster.
 * Measured after speed ramps, the rider sits at 31 m/s for most of a run and peaks at 41 — so
 * the ceiling sat three metres a second above normal riding, and a ramp's 5.6 m/s boost
 * overshot it into a dead zone where the extra speed counted for nothing. A ramp moved the
 * multiplier from ×1.27 to ×1.35 and stopped, which is what "no real benefit" felt like.
 *
 * 42 is just above what a boosted rider actually reaches, so the whole range of speeds the
 * game produces now maps onto the bonus instead of piling up against its top.
 */
const FAST_SPEED = 42;
/**
 * Maximum speed bonus.
 *
 * Raised with the ceiling rather than instead of it, and by exactly enough to leave normal
 * riding where it was: at 31 m/s this still reads ×1.30, as it did with the old 0.35 over the
 * old narrower range. What changed is the headroom above that — a ramp now reaches ×1.42 on
 * speed alone instead of hitting a wall at ×1.35.
 */
const MAX_BONUS = 0.55;

/**
 * Extra multiplier for having just ridden a ramp, on top of whatever the speed is worth.
 *
 * The speed bonus alone could not make a ramp feel like something without turning this into a
 * speed game: to move the multiplier by half you would need a slope that also pays hugely for
 * simply pointing downhill, and distance has to stay the thing players chase. So the ramp pays
 * for *itself*, directly, and the speed curve keeps its own job.
 *
 * Drains rather than dropping, so carrying the speed away from the ramp is worth something and
 * crashing two metres past it is not.
 */
const BOOST_BONUS = 0.6;
/** How long the ramp bonus takes to drain away, in seconds. */
const BOOST_DURATION = 3;

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
  /** Seconds of ramp bonus left to drain. */
  private boostLeft = 0;
  /**
   * Whether the score has stopped counting.
   *
   * Set when a daily run is continued. Nothing on a continued day is recorded, and a score that
   * keeps climbing while nothing is being kept is a lie told forty times a second — it was
   * still climbing when the run ended, it went onto the end screen, and it went onto a card
   * somebody could send to a friend. Freezing it says what is true: the run goes on, the
   * scoring does not.
   *
   * The bonus keeps draining while frozen. It is a timer, and stopping it would leave the HUD's
   * boost bar stuck part-full for the rest of the run.
   */
  private frozen = false;

  reset(): void {
    this.total = 0;
    this.furthest = 0;
    this.boostLeft = 0;
    this.frozen = false;
  }

  /** Stop counting. There is no way back short of `reset` — see the note on `frozen`. */
  freeze(): void {
    this.frozen = true;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /** A ramp was ridden. Refreshes the bonus rather than stacking it. */
  awardBoost(): void {
    this.boostLeft = BOOST_DURATION;
  }

  /** What the next metre is worth: the speed bonus plus whatever the ramp bonus has left. */
  multiplierAt(speed: number): number {
    return speedMultiplier(speed) + BOOST_BONUS * (this.boostLeft / BOOST_DURATION);
  }

  /** How much of the ramp bonus is left, in [0, 1]. Drives the HUD's boost bar. */
  get boost(): number {
    return this.boostLeft / BOOST_DURATION;
  }

  /**
   * Accrue score for any new ground covered since the last call, and drain the ramp bonus.
   *
   * `dt` is real time, and only the bonus uses it — the score itself is paid per metre, so a
   * slow frame earns exactly as much as the fast frames it replaces.
   */
  update(distance: number, speed: number, dt: number): void {
    // The high-water mark still advances while frozen, so ground covered during a continued
    // run is not paid for again if the score is ever unfrozen by a fresh run over the same
    // metres. It costs nothing and closes the loophole before it exists.
    if (distance > this.furthest) {
      const delta = distance - this.furthest;
      this.furthest = distance;
      if (!this.frozen) this.total += delta * this.multiplierAt(speed);
    }
    // Drained after paying, so the frame a ramp is collected on is worth the full bonus
    this.boostLeft = Math.max(0, this.boostLeft - dt);
  }

  get value(): number {
    return Math.floor(this.total);
  }
}

// Where a score goes once the run ends — the per-seed bests — lives in ./leaderboard.
