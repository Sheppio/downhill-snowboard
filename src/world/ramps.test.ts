import { describe, expect, it } from "vitest";

import {
  applyRamps,
  RAMP_BOOST,
  RAMP_LENGTH,
  RAMP_LIFT,
  RAMP_SPACING,
  RAMP_WIDTH,
  rampReward,
  rampsBetween,
} from "./ramps";
import { ObstacleField } from "./obstacles";
import { TerrainField } from "./terrain";
import { GATE_CLEARANCE_MIN, gateX } from "./course";
import { dailySeed, hashString } from "../core/rng";

const SEED = hashString("alpine");
const field = new TerrainField(SEED);
const params = field.params;

/** A year of daily seeds, so the competition mode is checked over its real input space. */
function yearOfDailySeeds(): string[] {
  const out: string[] = [];
  const start = new Date("2026-01-01T12:00:00Z");
  for (let d = 0; d < 365; d += 7) out.push(dailySeed(new Date(start.getTime() + d * 86400_000)));
  return out;
}

describe("where the ramps are", () => {
  it("puts one roughly every 250m, without being metronomic", () => {
    // "Roughly" is doing real work. A stretch that is corner all the way through gets no ramp
    // at all — see RAMP_MAX_CURVATURE — so the average gap is nearer 290m than 250m, and the
    // occasional stretch goes without. That is the intended trade: better a stretch with no
    // reward than one with a kicker in the middle of a corner.
    const ramps = rampsBetween(params, SEED, 0, 8000);
    expect(ramps.length, "a whole 8km should still be full of them").toBeGreaterThan(20);

    const gaps = ramps.slice(1).map((r, i) => r.z - ramps[i]!.z);
    for (const gap of gaps) {
      expect(gap, "two ramps close enough to run together").toBeGreaterThan(RAMP_LENGTH * 20);
      expect(gap, "a stretch with no ramp for miles").toBeLessThan(RAMP_SPACING * 4);
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(RAMP_SPACING * 0.9);
    expect(mean).toBeLessThan(RAMP_SPACING * 1.35);

    // Varied, or the jitter is doing nothing and they are a metronome
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(40);
  });

  it("only ever lands on a straight", () => {
    // The rule the completability guarantee rests on. A rider in the air keeps 35% of their
    // turn authority, so a kicker in a corner takes the steering away exactly where the line
    // needs it — and the ramp is *on* the line, so good riding is what meets it.
    const curvature = (p: typeof params, z: number) => {
      const g0 = gateX(p, z - 1);
      const g1 = gateX(p, z);
      const g2 = gateX(p, z + 1);
      const slope = (g2 - g0) / 2;
      return Math.abs(g2 - 2 * g1 + g0) / Math.pow(1 + slope * slope, 1.5);
    };
    for (const phrase of [...yearOfDailySeeds().slice(0, 10), "alpine", "zzz"]) {
      const p = new TerrainField(hashString(phrase)).params;
      for (const ramp of rampsBetween(p, hashString(phrase), 0, 5000)) {
        for (let s = 0; s <= RAMP_LENGTH; s += 0.5) {
          expect(
            curvature(p, ramp.z + s),
            `seed "${phrase}": the ramp at ${ramp.z.toFixed(0)}m is in a corner`,
          ).toBeLessThanOrEqual(0.008);
        }
      }
    }
  }, 60_000);

  it("leaves the opening alone", () => {
    // The first thing a new player meets should be the plain mountain, not a mechanic.
    expect(rampsBetween(params, SEED, 0, 150)).toEqual([]);
  });

  it("builds the same ramps for the same seed, and different ones for another", () => {
    expect(rampsBetween(params, SEED, 0, 2000)).toEqual(rampsBetween(params, SEED, 0, 2000));
    expect(rampsBetween(params, hashString("zzz"), 0, 2000)).not.toEqual(rampsBetween(params, SEED, 0, 2000));
  });

  it("finds a ramp whichever window is asked for", () => {
    // The jitter can push a ramp most of the way to its neighbour's slot, so a search that
    // only looked in the obvious band would drop them near the edges.
    const all = rampsBetween(params, SEED, 0, 4000);
    for (const ramp of all) {
      const tight = rampsBetween(params, SEED, ramp.z + 0.5, ramp.z + 1);
      expect(tight.map((r) => r.index), `ramp ${ramp.index} at ${ramp.z}m`).toContain(ramp.index);
    }
  });

  it("never puts a ramp where an obstacle could be", () => {
    // Ramps live on the racing line, which the obstacle field keeps clear by construction. The
    // guarantee is worth stating: a tree growing out of a speed pad would be the cruellest
    // thing in the game.
    for (const phrase of [...yearOfDailySeeds().slice(0, 12), "alpine", "zzz"]) {
      const terrain = new TerrainField(hashString(phrase));
      const seed = hashString(phrase);
      const obstacles = new ObstacleField(seed, terrain.params, terrain);
      for (const ramp of rampsBetween(terrain.params, seed, 0, 4000)) {
        for (let t = 0; t <= 1; t += 0.25) {
          const z = ramp.z + t * RAMP_LENGTH;
          const x = gateX(terrain.params, z);
          for (const o of obstacles.range(z - 6, z + 6)) {
            const gap = Math.hypot(o.x - x, o.z - z);
            expect(
              gap,
              `seed "${phrase}": a ${o.kind === 0 ? "tree" : "rock"} ${gap.toFixed(2)}m from the ` +
                `ramp at ${ramp.z.toFixed(0)}m`,
            ).toBeGreaterThan(RAMP_WIDTH / 2);
          }
        }
      }
    }
    // The clear channel is what makes that true, and it is wider than the ramp with room over
    expect(GATE_CLEARANCE_MIN).toBeGreaterThan(RAMP_WIDTH);
  }, 60_000);
});

describe("what a ramp pays", () => {
  const ramp = rampsBetween(params, SEED, 0, 400)[0]!;
  /** Dead on the racing line at a given point. */
  const onLine = (z: number) => gateX(params, z);

  it("pays the full boost for the full length", () => {
    const end = ramp.z + RAMP_LENGTH;
    const got = rampReward(params, SEED, onLine(end), ramp.z, end);
    expect(got.boost).toBeCloseTo(RAMP_BOOST, 6);
    expect(RAMP_BOOST * 3.6, "20 km/h, as asked for").toBeCloseTo(20, 6);
  });

  it("pays in proportion to how much was ridden", () => {
    // Not all-or-nothing: the edge of a ramp would otherwise be a cliff the player cannot see.
    const third = ramp.z + RAMP_LENGTH / 3;
    expect(rampReward(params, SEED, onLine(third), ramp.z, third).boost).toBeCloseTo(
      RAMP_BOOST / 3,
      6,
    );
  });

  it("pays the same however the frame rate chops it up", () => {
    // A per-frame award would be worth twice as much at 120fps as at 60. On a leaderboard
    // everyone shares, that is not a rounding error.
    const end = ramp.z + RAMP_LENGTH;
    let stepped = 0;
    const STEPS = 37; // deliberately not a divisor of the length
    for (let i = 0; i < STEPS; i++) {
      const a = ramp.z + (RAMP_LENGTH * i) / STEPS;
      const b = ramp.z + (RAMP_LENGTH * (i + 1)) / STEPS;
      stepped += rampReward(params, SEED, onLine(b), a, b).boost;
    }
    expect(stepped).toBeCloseTo(rampReward(params, SEED, onLine(end), ramp.z, end).boost, 6);
  });

  it("pays nothing to a rider who is not on the line", () => {
    const end = ramp.z + RAMP_LENGTH;
    const off = onLine(end) + RAMP_WIDTH / 2 + 0.05;
    expect(rampReward(params, SEED, off, ramp.z, end).boost).toBe(0);
    // ...and everything to one who is only just on it
    const just = onLine(end) + RAMP_WIDTH / 2 - 0.05;
    expect(rampReward(params, SEED, just, ramp.z, end).boost).toBeGreaterThan(0);
  });

  it("pays nothing at all away from a ramp", () => {
    const z = ramp.z - 40;
    expect(rampReward(params, SEED, onLine(z), z, z + 1)).toEqual({ boost: 0, lift: 0 });
  });

  it("kicks only at the lip, and only once", () => {
    const end = ramp.z + RAMP_LENGTH;
    // Across the middle: speed, no kick
    const middle = rampReward(params, SEED, onLine(end - 0.5), ramp.z, end - 0.5);
    expect(middle.boost).toBeGreaterThan(0);
    expect(middle.lift).toBe(0);

    // Over the lip: the kick, sized by how much of the ramp was ridden
    expect(rampReward(params, SEED, onLine(end), ramp.z, end + 0.5).lift).toBeCloseTo(
      RAMP_LIFT,
      6,
    );
    // Past it, nothing left to collect
    expect(rampReward(params, SEED, onLine(end + 1), end + 0.5, end + 1)).toEqual({
      boost: 0,
      lift: 0,
    });
  });

  it("kicks the same whatever the frame rate, unlike the boost", () => {
    // The bug this is here for: the kick was scaled by the same per-call share as the boost.
    // The boost is spread along the ramp and has a share to be proportional to; the kick lands
    // in the single frame that crosses the lip, so scaling it by that frame's slice made it a
    // twentieth of itself at speed. The unit tests missed it by calling once for the whole
    // ramp — a full-length interval and a full share are the same thing — and the browser
    // check, riding a real ramp through the real loop, reported a 0.1 m/s kick instead of 2.2.
    const end = ramp.z + RAMP_LENGTH;
    const stepped = (steps: number) => {
      let lift = 0;
      for (let i = 0; i < steps; i++) {
        const a = ramp.z + ((RAMP_LENGTH + 0.5) * i) / steps;
        const b = ramp.z + ((RAMP_LENGTH + 0.5) * (i + 1)) / steps;
        lift += rampReward(params, SEED, onLine(Math.min(b, end)), a, b).lift;
      }
      return lift;
    };
    expect(stepped(1)).toBeCloseTo(RAMP_LIFT, 6);
    expect(stepped(7), "a slow frame rate").toBeCloseTo(RAMP_LIFT, 6);
    expect(stepped(60), "a fast one").toBeCloseTo(RAMP_LIFT, 6);
  });
});

describe("collecting a ramp", () => {
  const ramp = rampsBetween(params, SEED, 0, 400)[0]!;

  /** A stand-in rider, since only four of its properties matter here. */
  const rider = (over: Partial<{ x: number; y: number; z: number }> = {}) => {
    const z = ramp.z + RAMP_LENGTH;
    const x = gateX(params, z);
    return {
      x,
      y: field.heightAt(x, z),
      z,
      gained: 0,
      lifted: 0,
      boost(speed: number, lift: number) {
        this.gained += speed;
        this.lifted += lift;
      },
      ...over,
    };
  };

  it("hands the boost to a rider on the snow", () => {
    const r = rider();
    applyRamps(r, field, SEED, ramp.z);
    expect(r.gained).toBeCloseTo(RAMP_BOOST, 6);
    expect(r.lifted).toBeGreaterThan(0);
  });

  it("still pays a rider skimming the ripples", () => {
    // The obvious rule was "not while airborne", and it is wrong. This mountain undulates
    // enough that the rider is technically off the ground about a fifth of the time — four of
    // the six frames spent crossing one ramp, measured — so that rule paid a third of the
    // boost on a clean pass straight down the middle of the line.
    const r = rider();
    r.y += 0.3;
    applyRamps(r, field, SEED, ramp.z);
    expect(r.gained).toBeCloseTo(RAMP_BOOST, 6);
  });

  it("pays nothing to a rider sailing over the top", () => {
    const r = rider();
    r.y += 3;
    applyRamps(r, field, SEED, ramp.z);
    expect(r.gained).toBe(0);
    expect(r.lifted).toBe(0);
  });
});
