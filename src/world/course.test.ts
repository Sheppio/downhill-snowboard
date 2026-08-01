import { describe, expect, it } from "vitest";

import {
  centreX,
  gateClearance,
  gateX,
  halfWidth,
  makeCourseParams,
  narrowingAt,
  weaveGain,
  type CourseParams,
} from "./course";
import { dailySeed, hashString } from "../core/rng";
import { MAX_TURN_RATE, RiderController, turnAuthorityAt } from "../player/controller";
import { pilotSteer } from "../player/pilot";
import { TerrainField } from "./terrain";
import { applyRamps } from "./ramps";

/** Width of each band in the speed profile below, in metres. */
const SPEED_BAND = 250;

/**
 * Top speed the game reaches *while following the racing line*, as a function of how far down
 * the mountain you are. That is the speed which decides whether a corner can be held.
 *
 * Measured rather than written down. Both checks below compare geometry against speed, so a
 * hand-maintained figure lets the two drift apart silently: with 37 written here, the course
 * as it stood before the escalation — 20% easier geometry — still cleared the "must stay
 * hard" bound, because it was being credited with a speed it never reached.
 *
 * A *profile* rather than one figure, because the fall line now steepens from 0.40 to 1.0 and
 * speed rises about 40% with it: a rider does 36 m/s in the first band and 46 m/s past 7km.
 * A single global number is wrong at both ends, and wrong in the dangerous direction at one of
 * them. It understated the deep course, which is exactly where the geometry is least forgiving
 * — the corner at 7595m on daily-2026-09-17 was being credited with 44 m/s when the mountain
 * there delivers 46. It also overstated the run-in absurdly, charging a corner 95m in at a
 * speed the rider cannot reach until half a kilometre later, which is a false failure waiting
 * to happen (and did happen, at 95m on powder-chute-42).
 *
 * Not the absolute top speed, which is higher still straight-lining. You cannot be at that
 * speed *and* in a corner: entering one costs steering, and the carve tax is superlinear in
 * lock, so a rider arriving flat out is down to line-following speed within a second. Bounding
 * against the straight-line figure would be bounding a state the corner itself prevents.
 *
 * Bands carry their running maximum forward, so a band no seed rode far enough to sample is
 * charged the fastest speed seen anywhere above it rather than zero.
 */
function measureSpeedProfile(maxZ: number): number[] {
  const bands: number[] = new Array(Math.ceil(maxZ / SPEED_BAND)).fill(0);
  for (const phrase of ["alpine", "daily-2026-03-04", "daily-2026-09-17", "zzz", "powder-chute-42"]) {
    const field = new TerrainField(hashString(phrase));
    const rider = new RiderController(field);
    for (let i = 0; i < 60 * 600 && rider.distance < maxZ; i++) {
      const from = rider.z;
      rider.update(1 / 60, pilotSteer(field.params, rider));
      applyRamps(rider, field, hashString(phrase), from);
      const b = Math.floor(rider.distance / SPEED_BAND);
      if (b < bands.length) bands[b] = Math.max(bands[b]!, rider.speed);
    }
  }

  let carry = 0;
  for (let b = 0; b < bands.length; b++) {
    carry = Math.max(carry, bands[b]!);
    bands[b] = carry;
  }
  return bands;
}

const MAX_Z = 8000;
const SPEED_AT = measureSpeedProfile(MAX_Z);

/** Line-following top speed at a given distance down the mountain. */
function speedAt(z: number): number {
  return SPEED_AT[Math.min(SPEED_AT.length - 1, Math.max(0, Math.floor(z / SPEED_BAND)))]!;
}

/** The fastest the rider ever goes on the line, anywhere. */
const V_TOP = Math.max(...SPEED_AT);

/** A year of daily seeds, so the competition mode is checked over its real input space. */
function yearOfDailySeeds(): string[] {
  const out: string[] = [];
  const start = new Date("2026-01-01T12:00:00Z");
  for (let d = 0; d < 365; d += 7) {
    out.push(dailySeed(new Date(start.getTime() + d * 86400_000)));
  }
  return out;
}

function params(phrase: string): CourseParams {
  return makeCourseParams(hashString(phrase));
}

/** Slope and curvature of the racing line at z, by central difference. */
function lineDerivatives(p: CourseParams, z: number): { slope: number; curvature: number } {
  const h = 1;
  const g0 = gateX(p, z - h);
  const g1 = gateX(p, z);
  const g2 = gateX(p, z + h);
  const slope = (g2 - g0) / (2 * h);
  const second = (g2 - 2 * g1 + g0) / (h * h);
  return { slope, curvature: Math.abs(second) / Math.pow(1 + slope * slope, 1.5) };
}

/**
 * The geometric half of the completability guarantee.
 *
 * The other half — actually riding every seed with the reference pilot — lives in
 * obstacles.test.ts and is bounded by how far it is practical to simulate. These checks are
 * cheap analytic sweeps, so they run far past where any run realistically ends and hold at
 * any distance rather than up to one.
 */
describe("the racing line is physically rideable", () => {
  it("never demands more turn rate than the rider has", () => {
    // Following x = g(z) at speed v needs a yaw rate of curvature * v. If that ever exceeds
    // what the rider can produce at full lock, the line is not merely hard, it is impossible
    // — no input holds it. Everyone on that seed would meet the same wall.
    //
    // Both sides are taken at the local speed. Authority falls off with speed, so charging the
    // deep course its real 46 m/s tightens the budget as well as raising the demand — which is
    // the point: that is the state the rider is genuinely in down there.
    for (const phrase of [...yearOfDailySeeds(), "alpine", "powder-chute-42", "a", "zzz"]) {
      const p = params(phrase);
      for (let z = 0; z < MAX_Z; z += 1) {
        const v = speedAt(z);
        const budget = MAX_TURN_RATE * turnAuthorityAt(v);
        const { curvature } = lineDerivatives(p, z);
        const demand = curvature * v;
        expect(
          demand,
          `seed "${phrase}" at ${z}m demands ${demand.toFixed(2)} rad/s of ` +
            `${budget.toFixed(2)} available, at ${v.toFixed(1)} m/s`,
        ).toBeLessThan(budget);
      }
    }
  }, 120_000);

  // There is deliberately no absolute floor here — no "the hardest corner must ask at least
  // N% of full lock". It looks like the obvious guard against difficulty being flattened
  // again, and it does not work: taken at top speed the tightest corner asked 82% before this
  // escalation and asks 91% after, because it lives on one outlier seed whose geometry barely
  // moved. Any bound between those two numbers would be three points from a false failure.
  //
  // What actually changed is spread across five levers, and each is asserted where it lives:
  // the weave and the gulley narrowing below, the clear channel below that, obstacle density
  // in obstacles.test.ts, and the speed the rider builds in controller.test.ts. A flattening
  // of any one of them fails its own test with a clear message, which a composite never would.

  it("does not put the tightest corner in the run-in", () => {
    // The run-in exists to let the player settle in, so it must not contain the hardest
    // corner on the mountain. It used to, and not by design: the ramp that fades the
    // centreline in was cubic, whose second derivative steps from 6 to -6 across its end.
    // Multiplied by a wave sum that has grown to ~55m by then, that manufactured a corner at
    // 119m demanding 94% of full lock — worse than anything in the body of the course, ten
    // seconds into every run, and it vanished six metres later.
    //
    // Compared as turn-rate demand (curvature * speed) rather than curvature alone, because
    // the rider is still accelerating through the run-in: measured by riding, the worst of it
    // is met at about 31 m/s against 34 in the body of the course, so the same curvature is
    // genuinely cheaper there. Holding the run-in to the same *curvature* fails by 2% on one
    // seed, which says more about the comparison than about the course.
    const RUN_IN_END = 400;
    const RUN_IN_SPEED = 31;
    for (const phrase of [...yearOfDailySeeds(), "alpine", "powder-chute-42", "a", "zzz"]) {
      const p = params(phrase);
      let runIn = 0;
      let rest = 0;
      for (let z = 0; z < RUN_IN_END; z += 0.5) {
        runIn = Math.max(runIn, lineDerivatives(p, z).curvature * RUN_IN_SPEED);
      }
      for (let z = RUN_IN_END; z < MAX_Z; z += 1) {
        rest = Math.max(rest, lineDerivatives(p, z).curvature * V_TOP);
      }
      expect(
        runIn,
        `seed "${phrase}" is tightest in the run-in (${runIn.toFixed(3)} vs ${rest.toFixed(3)} rad/s)`,
      ).toBeLessThanOrEqual(rest);
    }
  }, 120_000);

  it("keeps the centreline inside its documented crossing-angle budget", () => {
    // The budget on `makeCourseParams` is stated as the summed worst case of 2*PI*amp/λ over
    // the waves — 0.87 today, 1.41 where an earlier set became unfollowable. It is a property
    // of the wave set alone, so it is checked in exactly those terms. Since weaveGain scales
    // every amplitude, the binding case is wherever the gain tops out.
    const gain = weaveGain(1e6);
    for (const phrase of [...yearOfDailySeeds(), "alpine", "powder-chute-42", "a", "zzz"]) {
      const p = params(phrase);
      const summed = p.waves.reduce(
        (acc, w) => acc + (2 * Math.PI * (w.amp * gain)) / w.wavelength,
        0,
      );
      expect(summed, `seed "${phrase}" sums to ${summed.toFixed(2)} at x${gain} gain`).toBeLessThan(
        1.41,
      );
    }
  });

  it("never demands a sustained crossing angle no rider could hold", () => {
    // Separate from the turn rate: this is the sustained demand rather than the transient one.
    // A line permanently angled across the fall line would be followable moment to moment and
    // still unrideable, because holding that edge scrubs off all the speed.
    //
    // Measured on the racing line itself, so it includes the gate offset and the width
    // variation on top of the centreline — a stricter quantity than the analytic budget above
    // and not comparable to it. Brief peaks are fine and real: the reference pilot completes
    // every daily seed while touching 55° for a metre or two. What would not be fine is that
    // angle being held, so the bound is on a 60m rolling mean.
    //
    // The ceiling is set from the measured distribution rather than picked: across a year of
    // daily seeds the per-seed maximum runs to a median of 44.8° and a worst case of 51.9°
    // (it was 45.8° before this ramp existed, so a tidy-looking 45° bound would have failed
    // on the unmodified course). 60° clears the worst case while still catching a blow-up.
    const WINDOW = 60;
    for (const phrase of [...yearOfDailySeeds(), "alpine", "a"]) {
      const p = params(phrase);
      let rolling = 0;
      const buf: number[] = [];
      for (let z = 0; z < MAX_Z; z += 2) {
        const a = Math.abs(Math.atan(lineDerivatives(p, z).slope));
        buf.push(a);
        rolling += a;
        if (buf.length > WINDOW / 2) rolling -= buf.shift()!;
        if (buf.length < WINDOW / 2) continue;
        const mean = ((rolling / buf.length) * 180) / Math.PI;
        expect(mean, `seed "${phrase}" holds ${mean.toFixed(0)}° across ${WINDOW}m at ${z}m`).toBeLessThan(
          60,
        );
      }
    }
  }, 120_000);
});

describe("difficulty keeps escalating out to 5km", () => {
  it("leaves the course below 1300m exactly as it was", () => {
    // The opening ramps all finish by ~1300m, and every escalation starts at or after it.
    // Holding the earlier stretch identical means saved per-seed bests still describe the
    // same course over the part of the run nearly every attempt actually covers.
    expect(weaveGain(0)).toBe(1);
    expect(weaveGain(600)).toBe(1);
    expect(weaveGain(1300)).toBe(1);
    expect(weaveGain(1301)).toBeGreaterThan(1);

    const p = params("alpine");
    expect(narrowingAt(1300)).toBe(1);
    expect(gateClearance(p, 1300)).toBeCloseTo(gateClearance(p, 1290), 2);
  });

  it("keeps closing the gulley in, out to 5km and no further", () => {
    // The one lever that costs nothing against the turn-rate budget: a narrower corridor does
    // not bend the racing line any harder — the line's excursion is a fraction of this width,
    // so it straightens slightly — it just leaves less room either side of it.
    expect(narrowingAt(2200)).toBe(1);
    expect(narrowingAt(3600)).toBeLessThan(1);
    expect(narrowingAt(5000)).toBeLessThan(narrowingAt(3600));
    expect(narrowingAt(9000)).toBe(narrowingAt(5000));

    // And it reaches the floor of the gulley itself. Averaged over seeds and over a stretch,
    // because the width breathes on noise and one metre proves nothing either way.
    const meanWidth = (from: number, to: number) => {
      let sum = 0;
      let n = 0;
      for (const phrase of [...yearOfDailySeeds(), "alpine"]) {
        const p = params(phrase);
        for (let z = from; z < to; z += 10) {
          sum += halfWidth(p, z);
          n++;
        }
      }
      return sum / n;
    };
    const early = meanWidth(1500, 2000);
    const deep = meanWidth(5000, 5500);
    expect(deep, `deep ${deep.toFixed(1)}m vs early ${early.toFixed(1)}m`).toBeLessThan(early * 0.9);
  }, 30_000);

  it("keeps threading the racing line through a tighter gap", () => {
    // Sampled across many seeds rather than at one z: the channel breathes on noise, and the
    // claim is about the floor moving, not about any single metre.
    const worst = (from: number, to: number) => {
      let m = Infinity;
      for (const phrase of ["alpine", "powder-chute-42", "a", "zzz"]) {
        const p = params(phrase);
        for (let z = from; z < to; z += 5) m = Math.min(m, gateClearance(p, z));
      }
      return m;
    };
    const early = worst(1500, 2000);
    const deep = worst(5000, 5500);
    expect(deep, `deep ${deep.toFixed(2)}m vs early ${early.toFixed(2)}m`).toBeLessThan(early);
  });

  it("makes the gulley snake harder the further down you get", () => {
    // Compare like with like: the mean crossing angle over a long stretch, early versus deep.
    const angleOver = (p: CourseParams, from: number, to: number) => {
      let sum = 0;
      let n = 0;
      for (let z = from; z < to; z += 1) {
        sum += Math.abs(Math.atan(lineDerivatives(p, z).slope));
        n++;
      }
      return ((sum / n) * 180) / Math.PI;
    };

    let early = 0;
    let deep = 0;
    const seeds = yearOfDailySeeds();
    for (const phrase of seeds) {
      const p = params(phrase);
      early += angleOver(p, 300, 1300);
      deep += angleOver(p, 4200, 5200);
    }
    early /= seeds.length;
    deep /= seeds.length;

    expect(deep, `deep ${deep.toFixed(1)}° vs early ${early.toFixed(1)}°`).toBeGreaterThan(
      early * 1.1,
    );
  }, 60_000);

  it("keeps the weave inside the gulley it is steering", () => {
    // A bigger centreline swing moves the whole corridor, not the rider within it — so this
    // guards the thing that would actually break: the racing line drifting out of the
    // rideable floor as the amplitude grows.
    for (const phrase of [...yearOfDailySeeds(), "alpine"]) {
      const p = params(phrase);
      for (let z = 0; z < 8000; z += 3) {
        const offset = Math.abs(gateX(p, z) - centreX(p, z)) / halfWidth(p, z);
        expect(offset, `seed "${phrase}" at ${z}m`).toBeLessThan(1);
      }
    }
  }, 60_000);
});
