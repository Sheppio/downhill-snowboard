import { describe, expect, it } from "vitest";

import { ORIGIN_GRID, REBASE_DISTANCE, WorldOrigin } from "./origin";
import { TerrainField } from "./terrain";
import { hashString } from "../core/rng";

describe("the drawing frame", () => {
  it("starts on top of whatever it is reset to", () => {
    const o = new WorldOrigin();
    o.reset(0, -1234, 5678);
    expect(o.x).toBe(0);
    expect(o.y).toBe(-1280); // both snapped to the grid
    expect(o.z).toBe(5632);
  });

  it("snaps to the grid, so a run rebases in the same places every time", () => {
    for (const v of [7, 260, -900, 4321]) {
      const o = new WorldOrigin();
      o.reset(v, v, v);
      // Math.abs, because a negative multiple lands on -0 and Object.is says that is not 0
      expect(Math.abs(o.x % ORIGIN_GRID)).toBe(0);
      expect(Math.abs(o.y % ORIGIN_GRID)).toBe(0);
      expect(Math.abs(o.z % ORIGIN_GRID)).toBe(0);
    }
  });

  it("stays put while the rider is close, and moves once they are not", () => {
    const o = new WorldOrigin();
    o.reset(0, 0, 0);
    const before = o.version;

    expect(o.follow(0, 0, REBASE_DISTANCE)).toBe(false);
    expect(o.version).toBe(before);

    expect(o.follow(0, 0, REBASE_DISTANCE + 1)).toBe(true);
    expect(o.version).toBe(before + 1);
  });

  /**
   * The drop is what makes this course unusual. By 9.5km the rider is 6.1km *below* where they
   * started — further from the origin vertically than most games ever get horizontally — and a
   * rebase rule that only watched x and z would leave all of that precision on the floor.
   */
  it("follows the rider down as well as along", () => {
    const o = new WorldOrigin();
    o.reset(0, 0, 0);
    expect(o.follow(0, -(REBASE_DISTANCE + 1), 0)).toBe(true);
    expect(o.y).toBeLessThan(-REBASE_DISTANCE + ORIGIN_GRID);
  });

  /**
   * The point of the whole exercise, stated as a number.
   *
   * Riding the real height field from the top to well past 10km, nothing the GPU is asked to
   * transform may stray far from zero — not the rider, and not the terrain a quarter-kilometre
   * ahead of them, which is the furthest thing in shot.
   *
   * The bound is what buys the precision: a float32 near 1000 resolves to about 0.06mm, against
   * the 2mm it resolved to at the 11,300m the rider used to reach. The shimmer on the snow caps
   * was that 2mm, moving.
   */
  it("keeps everything drawn within a kilometre of the origin, all the way down", () => {
    const field = new TerrainField(hashString("alpine"));
    const o = new WorldOrigin();
    o.reset(0, field.heightAt(0, 0), 0);

    const VIEW_AHEAD = 260; // the furthest terrain built ahead of the rider
    let worst = 0;
    let worstAbsolute = 0;

    for (let z = 0; z <= 11000; z += 10) {
      const y = field.heightAt(0, z);
      o.follow(0, y, z);
      // The rider, and the far edge of what is built in front of them
      for (const az of [z, z + VIEW_AHEAD]) {
        const ay = field.heightAt(0, az);
        worst = Math.max(worst, Math.abs(ay - o.y), Math.abs(az - o.z));
        worstAbsolute = Math.max(worstAbsolute, Math.hypot(az, ay));
      }
    }

    // What it would have been without any of this — the number the shimmer came from
    expect(worstAbsolute).toBeGreaterThan(11000);
    expect(worst).toBeLessThan(1000);
  });
});
