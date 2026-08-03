import { describe, expect, it } from "vitest";

import { TerrainField } from "./terrain";
import {
  SLOPE_START,
  SLOPE_DEEP,
  slopeAt,
  dropTo,
  centreX,
  halfWidth,
  makeCourseParams,
  bankProfile,
} from "./course";
import { dailySeed, hashString, makeChunkRng, makeRng } from "../core/rng";

const SEEDS = ["powder-chute-42", "alpine", "daily-2026-07-28", "a", "", "🏂-emoji-seed"];

describe("seeded determinism", () => {
  it("gives identical terrain for the same seed", () => {
    for (const phrase of SEEDS) {
      const a = new TerrainField(hashString(phrase));
      const b = new TerrainField(hashString(phrase));
      for (let i = 0; i < 200; i++) {
        const x = -80 + i * 0.9;
        const z = i * 13.7;
        expect(b.heightAt(x, z)).toBe(a.heightAt(x, z));
      }
    }
  });

  it("gives different terrain for different seeds", () => {
    const a = new TerrainField(hashString("alpine"));
    const b = new TerrainField(hashString("powder"));
    let differences = 0;
    for (let i = 0; i < 200; i++) {
      if (Math.abs(a.heightAt(i * 3, i * 11) - b.heightAt(i * 3, i * 11)) > 0.05) differences++;
    }
    expect(differences).toBeGreaterThan(150);
  });

  it("is independent of the order chunks are generated in", () => {
    // The real risk this guards: a shared PRNG stream would make a chunk's contents depend on
    // how many chunks were built before it, so two players taking different lines through the
    // same seed would see different worlds.
    const seed = hashString("order-independence");
    const forward: number[] = [];
    for (let cz = 0; cz < 12; cz++) forward.push(makeChunkRng(seed, 0, cz).next());

    const backward: number[] = [];
    for (let cz = 11; cz >= 0; cz--) backward.unshift(makeChunkRng(seed, 0, cz).next());

    expect(backward).toEqual(forward);
  });

  it("derives the daily seed from the UTC date, not local time", () => {
    // Same instant, two very different local dates — must still be one shared course.
    const instant = new Date("2026-08-05T11:30:00Z");
    expect(dailySeed(instant)).toBe("20260805");
    expect(dailySeed(new Date("2026-08-05T23:59:59Z"))).toBe("20260805");
    expect(dailySeed(new Date("2026-08-06T00:00:01Z"))).toBe("20260806");
  });

  it("keeps the old daily seeds exactly as they were, and switches on the cutover day", () => {
    // The seed string *is* the course, so rewriting the format for a date already played
    // would move that day's mountain and strand every best recorded on it.
    expect(dailySeed(new Date("2026-07-28T11:30:00Z"))).toBe("daily-2026-07-28");
    expect(dailySeed(new Date("2026-08-03T23:59:59Z"))).toBe("daily-2026-08-03");
    expect(dailySeed(new Date("2026-08-04T00:00:00Z"))).toBe("20260804");
    expect(dailySeed(new Date("2027-01-01T00:00:00Z"))).toBe("20270101");
  });
});

describe("rng", () => {
  it("stays within range", () => {
    const r = makeRng(12345);
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("produces well-spread values", () => {
    const r = makeRng(999);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) buckets[Math.floor(r.next() * 10)]++;
    for (const b of buckets) expect(b).toBeGreaterThan(1500);
  });

  it("separates neighbouring chunks", () => {
    const seed = hashString("neighbours");
    const seen = new Set<number>();
    for (let cx = -6; cx <= 6; cx++) {
      for (let cz = -6; cz <= 6; cz++) seen.add(makeChunkRng(seed, cx, cz).next());
    }
    expect(seen.size).toBe(13 * 13); // no collisions across adjacent chunks
  });
});

describe("the mountain always descends", () => {
  // This is a hard gameplay invariant, not a nicety. If undulation can out-steepen the fall
  // line, the rider meets a counter-slope, stalls, and the run is dead with no way to
  // recover — the game has no way to push. UNDULATION_AMP in terrain.ts is bounded by this.
  it("never turns uphill along the centreline", () => {
    for (const phrase of SEEDS) {
      const field = new TerrainField(hashString(phrase));
      const params = field.params;

      let worst = -Infinity;
      let worstAt = 0;

      for (let t = 0; t < 4000; t += 1.5) {
        const z = t;
        const x = centreX(params, z);
        // The rider advances toward +z, so descending means dh/dz < 0. `worst` is the least
        // steep point on the run — the closest the mountain ever comes to flattening out.
        const [, dz] = field.gradientAt(x, z);
        if (dz > worst) {
          worst = dz;
          worstAt = t;
        }
      }

      // Require real margin, not merely "not uphill" — otherwise tuning can creep right up
      // to flat and the failure only shows as a mysteriously stalling rider in playtesting.
      expect(
        worst,
        `seed "${phrase}" flattens too far at ${worstAt.toFixed(0)}m (descent ${(-worst).toFixed(3)})`,
      ).toBeLessThan(-0.05);
    }
  });

  it("keeps a usable average pitch", () => {
    // Guard the other direction: terrain so flat the rider never builds speed is just as bad.
    // Measured along the centreline, since anywhere else is partway up a bank. The opening
    // kilometre is below where the mountain starts steepening, so it is still flat SLOPE_START.
    const field = new TerrainField(hashString("pitch-check"));
    const start = field.heightAt(centreX(field.params, 0), 0);
    const end = field.heightAt(centreX(field.params, 1000), 1000);
    const drop = start - end;
    expect(drop).toBeGreaterThan(1000 * SLOPE_START * 0.9);
    expect(drop).toBeLessThan(1000 * SLOPE_START * 1.1);
  });
});

describe("the mountain steepens as you descend", () => {
  it("has a height field whose gradient is the gradient it claims", () => {
    // The one that would fail silently and look fine. `heightAt` uses `dropTo`, and `dropTo`
    // has to be the *integral* of `slopeAt` — write the obvious `z * slopeAt(z)` instead and
    // the ground the rider actually meets is `s(z) + z·s'(z)`, roughly twice as steep through
    // the ramp and well past 45° by the end. Nothing else in the game would notice: the
    // terrain still descends, still renders, still streams. It would just be a different
    // mountain from the one every comment and constant here describes.
    for (let z = -300; z < 12_000; z += 7) {
      const h = 0.5;
      const measured = (dropTo(z + h) - dropTo(z - h)) / (2 * h);
      expect(measured, `gradient at ${z}m`).toBeCloseTo(slopeAt(z), 3);
    }
  });

  it("reaches 1m down per metre along by 10km, and stops there", () => {
    expect(slopeAt(10_000)).toBeCloseTo(SLOPE_DEEP, 6);
    expect(slopeAt(10_000)).toBe(1);
    // Held beyond, rather than tipping past vertical on a long enough run
    expect(slopeAt(20_000)).toBe(slopeAt(10_000));
    expect(slopeAt(1e6)).toBe(slopeAt(10_000));
  });

  it("leaves the opening exactly as it was, then only ever steepens", () => {
    // Same contract as every other escalation: nothing below 1300m moves. See weaveGain.
    expect(slopeAt(0)).toBe(SLOPE_START);
    expect(slopeAt(600)).toBe(SLOPE_START);
    expect(slopeAt(1300)).toBe(SLOPE_START);
    expect(slopeAt(1301)).toBeGreaterThan(SLOPE_START);
    // And the drop over that stretch is the flat-slope drop, to the millimetre
    expect(dropTo(1300)).toBeCloseTo(1300 * SLOPE_START, 9);

    let prev = -Infinity;
    for (let z = 0; z < 12_000; z += 25) {
      expect(slopeAt(z), `gradient went backwards at ${z}m`).toBeGreaterThanOrEqual(prev);
      prev = slopeAt(z);
    }
  });

  it("descends monotonically, including behind the start line", () => {
    // Negative z is meshed — the renderer keeps chunks behind the rider — so the extension
    // backwards has to be a real descent rather than a fold.
    let prev = -Infinity;
    for (let z = -300; z < 12_000; z += 3) {
      const drop = dropTo(z);
      expect(drop, `the fall line stopped descending at ${z}m`).toBeGreaterThan(prev);
      prev = drop;
    }
    // No step in the ground where the ramp starts or ends. Checked as "the drop across a
    // 2mm window is what the gradient there says it should be" rather than as two heights
    // being equal, which they are not and should not be — the mountain is descending.
    for (const at of [1300, 10_000]) {
      const h = 0.001;
      expect(dropTo(at + h) - dropTo(at - h), `step at ${at}m`).toBeCloseTo(2 * h * slopeAt(at), 9);
    }
  });

  it("still never turns uphill once the mountain is steep", () => {
    // The no-stall invariant, checked deep rather than only over the opening kilometres.
    // Steeper ground makes this *easier*, so the binding case stays the opening — but the
    // undulation is unchanged out there and this is what proves it.
    for (const phrase of SEEDS) {
      const field = new TerrainField(hashString(phrase));
      let worst = -Infinity;
      let worstAt = 0;
      for (let z = 4000; z < 11_000; z += 3) {
        const [, dz] = field.gradientAt(centreX(field.params, z), z);
        if (dz > worst) {
          worst = dz;
          worstAt = z;
        }
      }
      expect(worst, `seed "${phrase}" flattens at ${worstAt.toFixed(0)}m`).toBeLessThan(-0.05);
    }
  });
});

describe("the gulley", () => {
  it("starts centred and straight so the run-in is fair", () => {
    for (const phrase of SEEDS) {
      const params = makeCourseParams(hashString(phrase));
      expect(Math.abs(centreX(params, 0))).toBeLessThan(0.001);
      expect(Math.abs(centreX(params, 20))).toBeLessThan(2);
    }
  });

  it("keeps the corridor within sane width everywhere", () => {
    for (const phrase of SEEDS) {
      const params = makeCourseParams(hashString(phrase));
      for (let t = 0; t < 4000; t += 7) {
        const hw = halfWidth(params, t);
        expect(hw).toBeGreaterThanOrEqual(12);
        expect(hw).toBeLessThanOrEqual(32 + 10.001); // +10 is the run-in widening
      }
    }
  });

  it("has a flat floor and rising banks with no crease between them", () => {
    const hw = 20;
    expect(bankProfile(0, hw)).toBe(0);
    expect(bankProfile(hw * 0.6, hw)).toBe(0);

    // Monotonically rising outward, and continuous across the lip
    let prev = 0;
    for (let d = 0; d < hw * 3; d += 0.25) {
      const h = bankProfile(d, hw);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = h;
    }
    const atLip = bankProfile(hw, hw);
    expect(Math.abs(bankProfile(hw + 0.01, hw) - atLip)).toBeLessThan(0.02);
  });

  it("makes leaving the course uphill, which is what pulls the rider back", () => {
    const field = new TerrainField(hashString("bank-check"));
    const z = 500;
    const cx = centreX(field.params, z);
    const hw = halfWidth(field.params, z);

    // Moving outward from the floor edge must gain height
    const atFloor = field.heightAt(cx + hw * 0.5, z);
    const atLip = field.heightAt(cx + hw, z);
    const beyond = field.heightAt(cx + hw * 2, z);

    expect(atLip).toBeGreaterThan(atFloor + 2);
    expect(beyond).toBeGreaterThan(atLip + 2);
  });
});
