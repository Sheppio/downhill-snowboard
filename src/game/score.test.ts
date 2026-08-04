import { describe, expect, it } from "vitest";

import { Score, speedMultiplier } from "./score";
import { TerrainField } from "../world/terrain";
import { applyRamps } from "../world/ramps";
import { hashString } from "../core/rng";
import { RiderController } from "../player/controller";
import { pilotSteer } from "../player/pilot";

describe("the speed bonus", () => {
  it("pays nothing below a cruise, and maxes out at a genuinely quick pace", () => {
    expect(speedMultiplier(0)).toBe(1);
    expect(speedMultiplier(18), "65 km/h is the floor").toBe(1);
    expect(speedMultiplier(42), "151 km/h is the ceiling").toBeCloseTo(1.55, 6);
    expect(speedMultiplier(60), "and it does not keep climbing past it").toBeCloseTo(1.55, 6);
  });

  it("rises smoothly in between rather than stepping", () => {
    const half = speedMultiplier(30);
    expect(half).toBeGreaterThan(1);
    expect(half).toBeLessThan(1.55);
    expect(half).toBeCloseTo(1.275, 3);
  });

  it("has headroom above the speed people actually ride at", () => {
    // The bug this range exists to fix. The ceiling used to be 34 m/s while the rider sits at
    // about 31 for most of a run and a ramp adds 5.6 — so the boost overshot into a dead zone
    // and a ramp moved the multiplier by 0.08 before stopping dead.
    const cruising = speedMultiplier(31);
    const boosted = speedMultiplier(31 + 20 / 3.6);

    expect(cruising, "normal riding is left where it was").toBeCloseTo(1.3, 2);
    expect(boosted, "and a ramp's speed is still on the scale").toBeGreaterThan(cruising + 0.1);
    expect(boosted, "with room left above it").toBeLessThan(speedMultiplier(42));
  });
});

describe("accruing score", () => {
  it("counts ground covered, not ground stood on", () => {
    const s = new Score();
    s.update(100, 40, 0);
    s.update(100, 40, 0);
    expect(s.value, "the second call covered no new ground").toBe(150);
  });

  it("earns nothing for going backwards", () => {
    // The rider can be pushed back up a bank. Losing ground should not pay, and must not be
    // able to pay *again* on the way back down over the same metres.
    const s = new Score();
    s.update(100, 40, 0);
    s.update(80, 40, 0);
    expect(s.value).toBe(150);
    s.update(100, 40, 0);
    expect(s.value, "the same 20m must not be sold twice").toBe(150);
  });

  it("cannot be farmed by circling, with a real rider", () => {
    // The synthetic case above states the rule; this one proves it is reachable. Holding full
    // lock carries the rider past 90° off the fall line, at which point `z` decreases and the
    // same metres come round again. Before the high-water mark it scored 91 for 82m of ground
    // — 11% free, and compounding for as long as the player kept turning.
    for (const phrase of ["alpine", "zzz"]) {
      const terrain = new TerrainField(hashString(phrase));
      const rider = new RiderController(terrain);
      const score = new Score();

      let furthest = 0;
      let retreat = 0;
      for (let i = 0; i < 120 * 25; i++) {
        rider.update(1 / 120, 1); // full lock, held, which is what a panicking player does
        score.update(rider.distance, rider.speed, 0);
        furthest = Math.max(furthest, rider.distance);
        retreat = Math.max(retreat, furthest - rider.distance);
      }

      expect(retreat, `seed "${phrase}" never went backwards, so this proved nothing`)
        .toBeGreaterThan(1);
      // At these speeds the bonus is 1, so the score is the ground and nothing more. The
      // bound is 1.02 against the 1.11 the double-counting produced.
      expect(
        score.value / furthest,
        `seed "${phrase}" scored ${score.value} for ${furthest.toFixed(1)}m of ground`,
      ).toBeLessThan(1.02);
    }
  }, 60_000);

  it("applies the bonus per metre, not to the finished total", () => {
    // Slow for the first half, fast for the second. Scoring the whole run at the speed it
    // happened to finish at would be both wrong and trivial to game — coast to the line.
    const perMetre = new Score();
    perMetre.update(1000, 10, 0); // no bonus
    perMetre.update(2000, 40, 0); // full bonus
    expect(perMetre.value).toBe(1000 + 1504);
  });
});

describe("the ramp bonus", () => {
  it("is worth about as much again as riding fast", () => {
    // The point of it. The speed curve alone could not make a ramp feel like anything without
    // turning this into a speed game, so the ramp pays for itself on top.
    const s = new Score();
    const cruising = s.multiplierAt(31);
    s.awardBoost();
    expect(s.multiplierAt(31 + 20 / 3.6), "a ramp roughly doubles the bonus").toBeGreaterThan(1.9);
    expect(cruising).toBeCloseTo(1.3, 2);
  });

  it("drains away over a few seconds rather than dropping", () => {
    // Carrying the speed away from a ramp should be worth something; crashing two metres past
    // it should not pay the same as riding the next hundred.
    const s = new Score();
    s.awardBoost();
    expect(s.boost).toBe(1);

    s.update(0, 30, 1.5);
    expect(s.boost, "half gone at half the duration").toBeCloseTo(0.5, 6);

    s.update(0, 30, 5);
    expect(s.boost, "and it does not go negative").toBe(0);
    expect(s.multiplierAt(30)).toBeCloseTo(speedMultiplier(30), 6);
  });

  it("refreshes rather than stacking", () => {
    // Two ramps close together should not compound into a multiplier nothing else can reach.
    const s = new Score();
    s.awardBoost();
    const one = s.multiplierAt(30);
    s.awardBoost();
    s.awardBoost();
    expect(s.multiplierAt(30)).toBe(one);
  });

  it("pays the frame it is collected on", () => {
    // Draining before paying would lose the first frame of every boost, which is the one the
    // player actually connects with the ramp.
    const boosted = new Score();
    boosted.awardBoost();
    boosted.update(100, 30, 1 / 60);

    const plain = new Score();
    plain.update(100, 30, 1 / 60);

    expect(boosted.value).toBeGreaterThan(plain.value);
  });
});

describe("the score does not depend on the frame rate", () => {
  /**
   * The one number that must not vary by device: everyone races the same seed, and a run that
   * covers the same ground has to be worth the same whatever phone drew it.
   *
   * Score accrues once per rendered frame, so only the *multiplier* is sampled at frame
   * boundaries — the distance is exact, straight from the fixed 120Hz physics. That makes the
   * error second-order, and measuring it across 5.5km from 120fps down to 5fps put it at 0 to
   * 2 points in about 7,100. This pins that down; if the multiplier were ever made steeper, or
   * the speed sampled somewhere coarser, this is what would notice.
   */
  it("scores the same run alike from 120fps down to 5fps", () => {
    for (const phrase of ["alpine", "powder-chute-42", "daily-2026-04-23"]) {
      const terrain = new TerrainField(hashString(phrase));
      const seed = hashString(phrase);
      const rider = new RiderController(terrain);

      // One run, sampled at every physics step. Sampling a single trace is what isolates the
      // question: three separate runs at three frame rates would also differ because the
      // *steer* is sampled at different moments, which is a real difference and a different
      // one. 1/120 is exactly one fixed step per call.
      const trace: { d: number; v: number }[] = [];
      for (let i = 0; i < 120 * 200 && rider.distance < 4000; i++) {
        const from = rider.z;
        rider.update(1 / 120, pilotSteer(terrain.params, rider));
        applyRamps(rider, terrain, seed, from);
        trace.push({ d: rider.distance, v: rider.speed });
      }
      expect(trace.length, `seed "${phrase}" produced no run to score`).toBeGreaterThan(1000);

      /** Score the trace as a game running at `120 / stride` frames per second would. */
      const scoreAt = (stride: number): number => {
        const s = new Score();
        for (let i = stride - 1; i < trace.length; i += stride) s.update(trace[i]!.d, trace[i]!.v, 0);
        return s.value;
      };

      const scores = [1, 2, 4, 6, 24].map(scoreAt);
      const spread = Math.max(...scores) - Math.min(...scores);
      expect(
        spread / scores[0]!,
        `seed "${phrase}" scored ${scores.join(" / ")} at 120/60/30/20/5 fps`,
      ).toBeLessThan(0.002);
    }
  }, 120_000);
});

describe("a score that has stopped counting", () => {
  it("stops paying for ground once frozen", () => {
    const s = new Score();
    s.update(100, 30, 1);
    const earned = s.value;
    expect(earned).toBeGreaterThan(0);

    s.freeze();
    s.update(500, 30, 1);
    s.update(2000, 40, 1);
    expect(s.value, "the run went on; the scoring did not").toBe(earned);
  });

  it("says so, so the HUD can grey the number it has stopped moving", () => {
    const s = new Score();
    expect(s.isFrozen).toBe(false);
    s.freeze();
    expect(s.isFrozen).toBe(true);
  });

  it("keeps the high-water mark moving, so nothing is paid for twice", () => {
    // Ground covered while frozen must not become payable again if a later run unfreezes over
    // the same metres. Cheap to guarantee here; impossible to notice later.
    const s = new Score();
    s.freeze();
    s.update(1000, 30, 1);
    expect(s.value).toBe(0);

    // A fresh run resets both, which is the only way back
    s.reset();
    expect(s.isFrozen).toBe(false);
    s.update(1000, 30, 1);
    expect(s.value).toBeGreaterThan(0);
  });

  it("still drains the ramp bonus, so the boost bar does not stick", () => {
    const s = new Score();
    s.awardBoost();
    s.freeze();
    expect(s.boost).toBeGreaterThan(0);
    s.update(10, 30, 5);
    expect(s.boost, "a timer, not an earning — it has to run out").toBe(0);
  });
});
