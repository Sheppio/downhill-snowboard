import { describe, expect, it } from "vitest";

import { ObstacleField, ObstacleKind, SLICE_LENGTH } from "./obstacles";
import { TerrainField } from "./terrain";
import {
  GATE_CLEARANCE,
  RUN_IN_LENGTH,
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

      for (const o of obstacles.range(0, 5000)) {
        const clear = Math.abs(o.x - gateX(terrain.params, o.z));
        expect(
          clear,
          `seed "${phrase}" has a ${o.kind === ObstacleKind.Tree ? "tree" : "rock"} ` +
            `${clear.toFixed(2)}m from the racing line at ${o.z.toFixed(0)}m`,
        ).toBeGreaterThanOrEqual(GATE_CLEARANCE);
      }
    }
  });

  it("keeps the racing line inside the rideable course", () => {
    // A clear line that runs outside the gulley would be no use — the rider would be timed
    // out for being off course while following it.
    for (const phrase of [...yearOfDailySeeds(), "alpine", "a"]) {
      const terrain = new TerrainField(hashString(phrase));
      for (let z = 0; z < 5000; z += 3) {
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
        hit = obstacles.hitTest(rider.x, rider.z, RIDER_RADIUS);
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
  it("leaves the run-in completely clear", () => {
    for (const phrase of ["alpine", "daily-2026-07-28", "zzz"]) {
      const obstacles = makeField(phrase);
      expect(obstacles.range(0, RUN_IN_LENGTH - 1)).toHaveLength(0);
    }
  });

  it("gets harder the further you go", () => {
    const obstacles = makeField("difficulty");
    const early = obstacles.range(RUN_IN_LENGTH, RUN_IN_LENGTH + 600).length;
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
    const count = obstacles.range(RUN_IN_LENGTH, 2000).length;
    const slices = (2000 - RUN_IN_LENGTH) / SLICE_LENGTH;
    expect(count / slices).toBeGreaterThan(0.8);
  });
});

describe("collision", () => {
  it("detects a hit exactly at the obstacle", () => {
    const obstacles = makeField("collide");
    const [first] = obstacles.range(RUN_IN_LENGTH, 600);
    expect(first).toBeDefined();

    expect(obstacles.hitTest(first!.x, first!.z, 0.6)).toBe(first);
    // Just outside the combined radius, no hit
    expect(obstacles.hitTest(first!.x + first!.radius + 0.75, first!.z, 0.6)).toBeNull();
  });

  it("finds nothing on the clear racing line", () => {
    const terrain = new TerrainField(hashString("clear-line"));
    const obstacles = makeField("clear-line");
    for (let z = RUN_IN_LENGTH; z < 3000; z += 1.5) {
      expect(obstacles.hitTest(gateX(terrain.params, z), z, 0.6)).toBeNull();
    }
  });
});
