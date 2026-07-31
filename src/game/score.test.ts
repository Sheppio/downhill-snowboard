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
    expect(speedMultiplier(34), "122 km/h is the ceiling").toBeCloseTo(1.35, 6);
    expect(speedMultiplier(60), "and it does not keep climbing past it").toBeCloseTo(1.35, 6);
  });

  it("rises smoothly in between rather than stepping", () => {
    const half = speedMultiplier(26);
    expect(half).toBeGreaterThan(1);
    expect(half).toBeLessThan(1.35);
    expect(half).toBeCloseTo(1.175, 3);
  });
});

describe("accruing score", () => {
  it("counts ground covered, not ground stood on", () => {
    const s = new Score();
    s.update(100, 40);
    s.update(100, 40);
    expect(s.value, "the second call covered no new ground").toBe(135);
  });

  it("earns nothing for going backwards", () => {
    // The rider can be pushed back up a bank. Losing ground should not pay, and must not be
    // able to pay *again* on the way back down over the same metres.
    const s = new Score();
    s.update(100, 40);
    s.update(80, 40);
    expect(s.value).toBe(135);
    s.update(100, 40);
    expect(s.value, "the same 20m must not be sold twice").toBe(135);
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
        score.update(rider.distance, rider.speed);
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
    perMetre.update(1000, 10); // no bonus
    perMetre.update(2000, 40); // full bonus
    expect(perMetre.value).toBe(1000 + 1350);
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
        for (let i = stride - 1; i < trace.length; i += stride) s.update(trace[i]!.d, trace[i]!.v);
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
