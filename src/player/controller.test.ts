import { describe, expect, it } from "vitest";

import { RiderController } from "./controller";
import { TerrainField } from "../world/terrain";
import { centreX, halfWidth, OUT_OF_BOUNDS_FRACTION, lateralFraction } from "../world/course";
import { hashString } from "../core/rng";
import { angleDelta, clamp } from "../core/math";

function ride(seed: string, steer: number | ((t: number) => number), seconds: number) {
  const field = new TerrainField(hashString(seed));
  const rider = new RiderController(field);
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const s = typeof steer === "function" ? steer(i * dt) : steer;
    rider.update(dt, s);
  }
  return rider;
}

/**
 * Measure one second of riding from an identical starting state at a fixed steer.
 *
 * Deliberately not measured from steady state: at high steer the rider scrubs so much speed
 * that turn authority drops, which feeds back into how hard they can turn. That coupling is
 * good game design but it hides the underlying relationship, so these probes hold the
 * starting speed fixed and bypass input smoothing to look at the mechanic itself.
 */
function probe(steer: number, startSpeed = 22) {
  const field = new TerrainField(hashString("probe"));
  const rider = new RiderController(field);
  rider.speed = startSpeed;
  rider.steer = steer; // bypass smoothing so the whole window is at the target steer

  const h0 = rider.heading;
  const dt = 1 / 120;
  // A short window on purpose. Over a full second a hard turn swings the rider far off the
  // fall line, and the resulting loss of slope acceleration swamps the carve drag this is
  // trying to measure — enough to make full lock look cheaper than three-quarter lock.
  const steps = 30;
  for (let i = 0; i < steps; i++) rider.update(dt, steer);
  return {
    speedLost: startSpeed - rider.speed,
    turned: rider.heading - h0,
    seconds: steps * dt,
  };
}

/** A simple proportional pilot: aim at the centreline a little way ahead. */
function autopilot(field: TerrainField, rider: RiderController): number {
  const lookahead = clamp(rider.speed * 1.3, 12, 50);
  const targetZ = rider.z + lookahead;
  const desired = Math.atan2(centreX(field.params, targetZ) - rider.x, lookahead);
  return clamp(angleDelta(rider.heading, desired) * 2.0, -1, 1);
}

describe("carving costs speed", () => {
  // The headline mechanic the game is built around: how far right your finger is decides how
  // sharply you turn, and a sharper turn must cost more speed.
  it("loses more speed the tighter the turn", () => {
    const losses = [0, 0.25, 0.5, 0.75, 1].map((s) => probe(s).speedLost);

    for (let i = 1; i < losses.length; i++) {
      expect(
        losses[i]!,
        `steer ${i * 0.25} should cost more speed than steer ${(i - 1) * 0.25}`,
      ).toBeGreaterThan(losses[i - 1]!);
    }
  });

  it("makes a hard turn disproportionately expensive, not just linearly", () => {
    // If the cost were linear, "far right" would feel no different in kind from "a bit
    // right", and there would be no real decision for the player to make.
    const base = probe(0).speedLost; // friction and slope, common to every case
    const gentle = probe(0.25).speedLost - base;
    const hard = probe(1).speedLost - base;

    // carve drag ∝ |steer|^1.5, so 1.0 should cost roughly 8x what 0.25 does
    expect(hard / gentle).toBeGreaterThan(5);
  });

  it("turns proportionally to how far the finger is from centre", () => {
    const gentle = probe(0.25).turned;
    const hard = probe(1).turned;
    expect(gentle).toBeGreaterThan(0.02); // it turns at all over the short probe window
    // At a matched starting speed the turn rate is close to linear in steer
    expect(hard / gentle).toBeGreaterThan(2.5);
  });

  it("turns right for positive steer and left for negative", () => {
    expect(ride("dir-test", 0.6, 3).heading).toBeGreaterThan(0);
    expect(ride("dir-test", -0.6, 3).heading).toBeLessThan(0);
    // Symmetric: mirrored input gives mirrored heading
    expect(Math.abs(ride("dir-test", 0.6, 3).heading + ride("dir-test", -0.6, 3).heading)).toBeLessThan(
      0.3,
    );
  });
});

describe("speed behaves", () => {
  it("accelerates from the start and settles at a sane top speed", () => {
    // Measured with the autopilot holding the course. A zero-steer rider drifts up the banks
    // and never reaches terminal speed, which would make this a test of the wrong thing.
    const field = new TerrainField(hashString("speed-test"));
    const rider = new RiderController(field);
    for (let i = 0; i < 60 * 60; i++) rider.update(1 / 60, autopilot(field, rider));

    expect(rider.topSpeed).toBeGreaterThan(20); // > 72 km/h — genuinely quick
    expect(rider.topSpeed).toBeLessThan(36); // but not uncontrollable
  });

  it("makes real downhill progress", () => {
    const rider = ride("progress-test", 0, 30);
    expect(rider.distance).toBeGreaterThan(400);
  });

  it("never stalls permanently, even after scrubbing all speed", () => {
    // Hold full lock long enough to kill all speed, then let go. Gravity must recover the run.
    const rider = ride("stall-test", (t) => (t < 14 ? 1 : 0), 30);
    expect(rider.speed).toBeGreaterThan(8);
  });

  it("recovers even if the rider ends up pointing across the mountain at zero speed", () => {
    const field = new TerrainField(hashString("hard-stall"));
    const rider = new RiderController(field);
    rider.speed = 0;
    rider.heading = Math.PI / 2; // straight across the fall line
    for (let i = 0; i < 60 * 12; i++) rider.update(1 / 60, 0);
    expect(rider.speed).toBeGreaterThan(5);
    expect(Math.abs(rider.heading)).toBeLessThan(1.2); // pulled back toward the fall line
  });
});

describe("the banks work without any collision code", () => {
  it("slows the rider and returns them to the floor", () => {
    const field = new TerrainField(hashString("bank-physics"));
    const rider = new RiderController(field);

    // Get up to speed first
    for (let i = 0; i < 60 * 12; i++) rider.update(1 / 60, 0);
    const floorSpeed = rider.speed;

    // Steer hard at the bank, then release and let the terrain do the work
    for (let i = 0; i < 60 * 3; i++) rider.update(1 / 60, 0.85);
    const offCentre = lateralFraction(field.params, rider.x, rider.z);
    expect(offCentre).toBeGreaterThan(0.4); // actually climbed the bank
    expect(rider.speed).toBeLessThan(floorSpeed); // and it cost speed

    for (let i = 0; i < 60 * 6; i++) rider.update(1 / 60, 0);
    // Gravity brought them back down toward the middle without any wall to bounce off
    expect(lateralFraction(field.params, rider.x, rider.z)).toBeLessThan(offCentre);
  });

  it("requires the player to actually steer — doing nothing leaves the course", () => {
    // Not a defect: the gulley snakes, so holding a straight line rides you up the outside
    // and eventually out. If this ever started passing, the course would have no game in it.
    const field = new TerrainField(hashString("straight-line"));
    const rider = new RiderController(field);
    let worst = 0;
    for (let i = 0; i < 60 * 40; i++) {
      rider.update(1 / 60, 0);
      worst = Math.max(worst, lateralFraction(field.params, rider.x, rider.z));
    }
    expect(worst).toBeGreaterThan(OUT_OF_BOUNDS_FRACTION);
  });
});

describe("every seed produces a course that can actually be ridden", () => {
  // This is the one that protects the daily-seed competition. If some date generated a
  // corner too tight to follow, everyone racing that day would be stuck with it.
  const seeds = ["daily-2026-07-28", "daily-2026-12-25", "alpine", "powder-chute-42", "a", "zzz"];

  it("lets a competent rider hold the gulley for 3km", () => {
    for (const phrase of seeds) {
      const field = new TerrainField(hashString(phrase));
      const rider = new RiderController(field);

      let worst = 0;
      let worstAt = 0;
      for (let i = 0; i < 60 * 240 && rider.distance < 3000; i++) {
        rider.update(1 / 60, autopilot(field, rider));
        const off = lateralFraction(field.params, rider.x, rider.z);
        if (off > worst) {
          worst = off;
          worstAt = rider.distance;
        }
      }

      expect(rider.distance, `seed "${phrase}" did not reach 3km`).toBeGreaterThanOrEqual(3000);
      expect(
        worst,
        `seed "${phrase}" pushed the rider to ${worst.toFixed(2)} half-widths at ${worstAt.toFixed(0)}m`,
      ).toBeLessThan(OUT_OF_BOUNDS_FRACTION);
    }
  });

  it("still rewards the rider with real speed while following the course", () => {
    const field = new TerrainField(hashString("daily-2026-07-28"));
    const rider = new RiderController(field);
    let total = 0;
    let samples = 0;
    for (let i = 0; i < 60 * 120 && rider.distance < 2000; i++) {
      rider.update(1 / 60, autopilot(field, rider));
      total += rider.speed;
      samples++;
    }
    expect(total / samples).toBeGreaterThan(14); // ~50 km/h average, not a crawl
  });
});

describe("determinism end to end", () => {
  it("reproduces an identical run from the same seed and inputs", () => {
    // The competitive promise: same seed + same inputs = same run, on any device.
    const inputs = (t: number) => Math.sin(t * 0.7) * 0.8;
    const a = ride("repeatable", inputs, 40);
    const b = ride("repeatable", inputs, 40);

    expect(b.x).toBe(a.x);
    expect(b.z).toBe(a.z);
    expect(b.speed).toBe(a.speed);
    expect(b.heading).toBe(a.heading);
  });

  it("produces genuinely different runs on different seeds", () => {
    const inputs = (t: number) => Math.sin(t * 0.7) * 0.8;
    const a = ride("seed-one", inputs, 40);
    const b = ride("seed-two", inputs, 40);
    expect(Math.abs(a.z - b.z)).toBeGreaterThan(1);
  });

  it("is frame-rate independent", () => {
    // A player on a 120Hz phone must not get a different run from one on a 30Hz phone.
    const field = new TerrainField(hashString("framerate"));
    const runAt = (fps: number) => {
      const rider = new RiderController(field);
      const dt = 1 / fps;
      for (let i = 0; i < Math.round(25 / dt); i++) rider.update(dt, 0.4);
      return rider;
    };
    const slow = runAt(30);
    const fast = runAt(144);
    // Not bit-identical (different accumulator remainders), but must agree closely
    expect(Math.abs(slow.z - fast.z)).toBeLessThan(slow.z * 0.02);
    expect(Math.abs(slow.speed - fast.speed)).toBeLessThan(1);
  });
});

describe("airtime", () => {
  it("gets airborne over rollers at speed but not while crawling", () => {
    const field = new TerrainField(hashString("air-test"));
    const rider = new RiderController(field);

    let airFrames = 0;
    for (let i = 0; i < 60 * 60; i++) {
      rider.update(1 / 60, 0);
      if (rider.airborne) airFrames++;
    }
    // Rollers should launch the rider sometimes, but the run must not be mostly airborne
    expect(airFrames).toBeGreaterThan(0);
    expect(airFrames).toBeLessThan(60 * 60 * 0.4);
  });

  it("stays glued to the ground at low speed", () => {
    const field = new TerrainField(hashString("glued"));
    const rider = new RiderController(field);
    rider.speed = 1;
    let airFrames = 0;
    for (let i = 0; i < 240; i++) {
      rider.update(1 / 60, 0);
      if (rider.airborne) airFrames++;
    }
    expect(airFrames).toBe(0);
  });
});

describe("course geometry sanity", () => {
  it("keeps the rider near the centreline height", () => {
    const field = new TerrainField(hashString("height-follow"));
    const rider = new RiderController(field);
    for (let i = 0; i < 60 * 20; i++) {
      rider.update(1 / 60, 0);
      if (!rider.airborne) {
        expect(Math.abs(rider.y - field.heightAt(rider.x, rider.z))).toBeLessThan(0.15);
      }
    }
  });

  it("has a centreline and width defined at the rider's position", () => {
    const field = new TerrainField(hashString("defined"));
    for (let z = 0; z < 3000; z += 137) {
      expect(Number.isFinite(centreX(field.params, z))).toBe(true);
      expect(Number.isFinite(halfWidth(field.params, z))).toBe(true);
    }
  });
});
