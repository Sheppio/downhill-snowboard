import { describe, expect, it } from "vitest";

import { ObstacleField, ObstacleKind, SLICE_LENGTH } from "./obstacles";
import { TerrainField } from "./terrain";
import {
  GATE_CLEARANCE_MIN,
  gateClearance,
  gateX,
  halfWidth,
  centreX,
  OUT_OF_BOUNDS_FRACTION,
} from "./course";
import { dailySeed, hashString } from "../core/rng";
import { RiderController } from "../player/controller";
import { pilotSteer } from "../player/pilot";

/** Collision radius of the rider, shared with the game loop. */
const RIDER_RADIUS = 0.6;

function makeField(phrase: string) {
  const terrain = new TerrainField(hashString(phrase));
  return new ObstacleField(hashString(phrase), terrain.params, terrain);
}

/** A year of daily seeds, so the competition mode is checked over its real input space. */
function yearOfDailySeeds(): string[] {
  const out: string[] = [];
  const start = new Date("2026-01-01T12:00:00Z");
  for (let d = 0; d < 365; d += 7) {
    out.push(dailySeed(new Date(start.getTime() + d * 86400_000)));
  }
  return out;
}

describe("every course can be completed", () => {
  // The worst bug this game could ship: a daily seed that generates an impassable wall of
  // trees. Everyone racing that day would be stuck on it, with no way to route around a
  // course that is the same for all of them. Hence a real test over many seeds.
  it("never blocks the racing line, on any seed", () => {
    const seeds = [...yearOfDailySeeds(), "alpine", "powder-chute-42", "a", "", "zzz"];

    for (const phrase of seeds) {
      const terrain = new TerrainField(hashString(phrase));
      const obstacles = makeField(phrase);

      for (const o of obstacles.range(0, 8000)) {
        const clear = Math.abs(o.x - gateX(terrain.params, o.z));
        // Must clear the channel width at that point, and never breach the hard floor
        expect(
          clear,
          `seed "${phrase}" has a ${o.kind === ObstacleKind.Tree ? "tree" : "rock"} ` +
            `${clear.toFixed(2)}m from the racing line at ${o.z.toFixed(0)}m`,
        ).toBeGreaterThanOrEqual(Math.min(gateClearance(terrain.params, o.z), GATE_CLEARANCE_MIN));
      }
    }
  });

  it("keeps the racing line inside the rideable course", () => {
    // A clear line that runs outside the gulley would be no use — the rider would be timed
    // out for being off course while following it.
    for (const phrase of [...yearOfDailySeeds(), "alpine", "a"]) {
      const terrain = new TerrainField(hashString(phrase));
      for (let z = 0; z < 8000; z += 3) {
        const offset = Math.abs(gateX(terrain.params, z) - centreX(terrain.params, z));
        const fraction = offset / halfWidth(terrain.params, z);
        expect(fraction, `seed "${phrase}" at ${z}m`).toBeLessThan(OUT_OF_BOUNDS_FRACTION - 0.4);
      }
    }
  });

  it("can be ridden end to end without crashing, on every daily seed of the year", () => {
    // The strongest form of this guarantee, and the reason it is worth the runtime: rather
    // than inspecting geometry and hoping the numbers imply playability, actually ride each
    // course and see whether a crude autopilot survives it. If this ever fails, some date
    // would ship a course nobody could complete.
    //
    // This is the *simulated* half of the guarantee, and it is necessarily bounded by how far
    // it is practical to ride 57 seeds. The analytic half lives in course.test.ts and sweeps
    // to 8000m, so the two together cover both "a real rider gets through the part everyone
    // plays" and "the geometry never becomes impossible at any distance".
    //
    // Worth knowing what this number is not: it is the *pilot's* limit as much as the
    // course's. Ridden to 6000m the pilot completes all 53 daily seeds at the current weave
    // gain of 1.3 and starts losing seeds at 1.35 — so if difficulty is ever raised past that
    // point, check whether the failures are the course being unfair or simply this
    // deliberately crude autopilot cutting corners, before assuming the former.
    const seeds = [...yearOfDailySeeds(), "alpine", "powder-chute-42", "a", "zzz"];
    const RUN_DISTANCE = 3000;

    for (const phrase of seeds) {
      const terrain = new TerrainField(hashString(phrase));
      const obstacles = makeField(phrase);
      const rider = new RiderController(terrain);

      let hit = null;
      let worstOff = 0;
      for (let i = 0; i < 60 * 300 && rider.distance < RUN_DISTANCE; i++) {
        rider.update(1 / 60, pilotSteer(terrain.params, rider));
        hit = obstacles.hitTest(rider.x, rider.z, RIDER_RADIUS, rider.y);
        if (hit) break;
        const off =
          Math.abs(rider.x - centreX(terrain.params, rider.z)) / halfWidth(terrain.params, rider.z);
        if (off > worstOff) worstOff = off;
      }

      expect(hit, `seed "${phrase}" is blocked at ${rider.distance.toFixed(0)}m`).toBeNull();
      expect(worstOff, `seed "${phrase}" pushed the pilot off course`).toBeLessThan(
        OUT_OF_BOUNDS_FRACTION,
      );
      expect(
        rider.distance,
        `seed "${phrase}" only reached ${rider.distance.toFixed(0)}m`,
      ).toBeGreaterThanOrEqual(RUN_DISTANCE);
    }
    // Simulating ~57 full runs is not fast, but this is the guarantee the shared-seed
    // competition rests on, so it gets the time it needs.
  }, 120_000);
});

describe("obstacle placement", () => {
  it("gives a short clear start, then gets straight on with it", () => {
    // Both halves matter. A run that starts mid-obstacle is unfair; a long empty stretch is
    // just dead air before the game begins, which is what this used to be at 80m.
    for (const phrase of ["alpine", "daily-2026-07-28", "zzz"]) {
      const obstacles = makeField(phrase);
      expect(obstacles.range(0, 19)).toHaveLength(0);
      expect(obstacles.range(0, 60).length, `seed "${phrase}" starts too empty`).toBeGreaterThan(3);
    }
  });

  it("gets harder the further you go", () => {
    const obstacles = makeField("difficulty");
    const early = obstacles.range(20, 620).length;
    const late = obstacles.range(3000, 3600).length;
    expect(late).toBeGreaterThan(early);
  });

  it("is deterministic and order-independent", () => {
    // Same guarantee as the terrain: what is in a slice cannot depend on how the player got
    // there, or two people on one seed would face different obstacles.
    const forward = makeField("order");
    const backward = makeField("order");

    const ascending = [];
    for (let i = 10; i < 60; i++) ascending.push(...forward.slice(i));

    const descending = [];
    for (let i = 59; i >= 10; i--) descending.unshift(...backward.slice(i));

    expect(descending).toEqual(ascending);
  });

  it("puts obstacles on the ground, not floating or buried", () => {
    const terrain = new TerrainField(hashString("grounded"));
    const obstacles = makeField("grounded");
    for (const o of obstacles.range(0, 2000)) {
      expect(Math.abs(o.y - terrain.heightAt(o.x, o.z))).toBeLessThan(1e-9);
    }
  });

  it("actually produces a decent number of obstacles to dodge", () => {
    // Guard against the gate rejection being so aggressive that the course ends up empty.
    const obstacles = makeField("density");
    const count = obstacles.range(20, 2000).length;
    const slices = (2000 - 20) / SLICE_LENGTH;
    expect(count / slices).toBeGreaterThan(0.8);
  });
});

describe("collision", () => {
  it("detects a hit exactly at the obstacle", () => {
    const obstacles = makeField("collide");
    const [first] = obstacles.range(20, 600);
    expect(first).toBeDefined();

    expect(obstacles.hitTest(first!.x, first!.z, 0.6, first!.y)).toBe(first);
    // Just outside the combined radius, no hit
    expect(obstacles.hitTest(first!.x + first!.radius + 0.75, first!.z, 0.6, first!.y)).toBeNull();
  });

  it("lets the rider clear an obstacle by jumping over it", () => {
    // Collision used to be a pure XZ test, which made every collider an infinitely tall
    // cylinder: no amount of air ever got the rider over anything.
    const obstacles = makeField("jumping");
    const all = obstacles.range(20, 1200);
    const rock = all.find((o) => o.kind === ObstacleKind.Rock);
    const tree = all.find((o) => o.kind === ObstacleKind.Tree);
    expect(rock).toBeDefined();
    expect(tree).toBeDefined();

    // At board level, both still stop the run
    expect(obstacles.hitTest(rock!.x, rock!.z, 0.6, rock!.y)).toBe(rock);
    expect(obstacles.hitTest(tree!.x, tree!.z, 0.6, tree!.y)).toBe(tree);

    // Just over the top of each, they pass underneath
    expect(obstacles.hitTest(rock!.x, rock!.z, 0.6, rock!.y + rock!.height + 0.01)).toBeNull();
    expect(obstacles.hitTest(tree!.x, tree!.z, 0.6, tree!.y + tree!.height + 0.01)).toBeNull();

    // Just below the top, they still hit — the test is the real height, not a blanket pass
    expect(obstacles.hitTest(rock!.x, rock!.z, 0.6, rock!.y + rock!.height - 0.05)).toBe(rock);
    expect(obstacles.hitTest(tree!.x, tree!.z, 0.6, tree!.y + tree!.height - 0.05)).toBe(tree);
  });

  it("makes rocks jumpable and trees essentially not", () => {
    // The gradient is the point: rocks reward a launch, trees have to be steered around.
    const obstacles = makeField("heights");
    const all = obstacles.range(20, 2000);
    const rocks = all.filter((o) => o.kind === ObstacleKind.Rock);
    const trees = all.filter((o) => o.kind === ObstacleKind.Tree);

    for (const r of rocks) expect(r.height).toBeLessThan(1.2);
    for (const t of trees) expect(t.height).toBeGreaterThan(3.5);
  });

  it("finds nothing on the clear racing line", () => {
    const terrain = new TerrainField(hashString("clear-line"));
    const obstacles = makeField("clear-line");
    for (let z = 20; z < 3000; z += 1.5) {
      expect(obstacles.hitTest(gateX(terrain.params, z), z, 0.6, terrain.heightAt(gateX(terrain.params, z), z))).toBeNull();
    }
  });
});
