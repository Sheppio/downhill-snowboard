import { describe, expect, it } from "vitest";

import {
  densityAt,
  ObstacleField,
  ObstacleKind,
  SLICE_LENGTH,
  ROCK_RADIUS,
  ROCK_SHAPES,
  TREE_HIT_RADII,
  TREE_SHAPES,
  VARIANTS,
} from "./obstacles";
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
import {
  RiderController,
  RIDER_HALF_LENGTH,
  RIDER_HALF_WIDTH,
} from "../player/controller";
import { pilotSteer } from "../player/pilot";

/**
 * `hitTest` with the rider's real capsule, pointing straight down the fall line by default.
 *
 * The dimensions are imported rather than restated, so a change to the rider's size is felt
 * here rather than quietly tested against the shape it used to be.
 */
function hitAt(field: ObstacleField, x: number, z: number, y: number, heading = 0) {
  return field.hitTest(x, z, y, heading, RIDER_HALF_WIDTH, RIDER_HALF_LENGTH);
}

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
  }, 120_000); // sweeps 57 seeds to 8000m — well past vitest's 5s default

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
  }, 60_000);

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
    // course's, and the pilot is a poor judge of most of what makes the course hard. It holds
    // the racing line to within about a metre, and the clear channel guarantees that line a
    // path — so denser trees and a narrower gulley, which is most of what a player feels, cost
    // it almost nothing. Only the line demanding more turn rate than it has really kills it.
    //
    // Measured across the 53 daily seeds with the escalation to 5km in place: the pilot dies
    // before 8000m on 12 of them, worst at 3616m. So this 3000m bound is where the guarantee
    // sits, and it clears the worst seed by 600m.
    //
    // That was 24 of 53 while the rider was a 0.6m circle. Giving it the board's real shape
    // cost 12 seeds' worth of pilot deaths and moved the worst seed by a single metre, which
    // says plainly what kills the pilot: the racing line asking for more turn rate than it
    // has, not the trees. The seeds it now survives are the ones it was clipping a trunk on
    // with a collider two and a half times wider than the rider.
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
        hit = hitAt(obstacles, rider.x, rider.z, rider.y, rider.heading);
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

    expect(hitAt(obstacles, first!.x, first!.z, first!.y)).toBe(first);
    // Well outside the combined reach on either axis, no hit
    expect(hitAt(obstacles, first!.x + first!.radius + 0.75, first!.z, first!.y)).toBeNull();
    expect(hitAt(obstacles, first!.x, first!.z + first!.radius + 1.6, first!.y)).toBeNull();
  });

  it("is forgiving by a tenth at the edges", () => {
    // A hit the player did not believe in is worse than one they got away with, because the
    // run ends on it. This checks the gap between what the mesh occupies and what actually
    // stops you — grazing the outer tenth of a tree has to be a miss.
    const obstacles = makeField("forgiveness");
    const [o] = obstacles.range(20, 600);
    expect(o).toBeDefined();

    // Against hitRadius, which is what forgiveness shaves, rather than the placement radius —
    // the two differ on the thin-trunked variants, and this has to hold for all of them.
    // Sideways, so the capsule's width is what answers.
    const graze = o!.hitRadius * 0.95 + RIDER_HALF_WIDTH;
    expect(hitAt(obstacles, o!.x + graze, o!.z, o!.y)).toBeNull();

    // Well inside it, still a hit — the forgiveness is a sliver, not a hole
    const solid = o!.hitRadius * 0.8 + RIDER_HALF_WIDTH;
    expect(hitAt(obstacles, o!.x + solid, o!.z, o!.y)).toBe(o);
  });

  it("is a board, not a circle: narrow across, long along", () => {
    // The fault this shape exists to fix. A 0.6m circle put a third of a metre of collider out
    // to each side of a rider a quarter of a metre wide, so trees the player had visibly
    // passed still ended the run — and it was simultaneously short of the board's own tips.
    const obstacles = makeField("capsule");
    const [o] = obstacles.range(20, 600);
    expect(o).toBeDefined();

    const reach = o!.hitRadius * 0.9;
    // Level with the trunk, a hand's width clear of it. The old circle crashed here.
    const beside = reach + RIDER_HALF_WIDTH + 0.1;
    expect(beside, "the gap this is about is inside the old 0.6m radius").toBeLessThan(
      reach + 0.6,
    );
    expect(hitAt(obstacles, o!.x + beside, o!.z, o!.y)).toBeNull();

    // Directly ahead at the same separation, the board's tip is into it — and the old circle
    // let this through.
    expect(hitAt(obstacles, o!.x, o!.z + beside, o!.y)).toBe(o);
  });

  it("turns with the rider", () => {
    // The capsule is useless if it does not rotate: sideways and ahead have to swap when the
    // board does. Nothing else in the suite would notice a heading that was ignored.
    const obstacles = makeField("capsule-turn");
    const [o] = obstacles.range(20, 600);
    expect(o).toBeDefined();

    // Far enough ahead to be off the end of a straight board, well inside its length
    const gap = o!.hitRadius * 0.9 + RIDER_HALF_WIDTH + 0.15;
    expect(hitAt(obstacles, o!.x, o!.z + gap, o!.y, 0)).toBe(o);
    // Turned across the hill, that same obstacle is now off to the side and clear
    expect(hitAt(obstacles, o!.x, o!.z + gap, o!.y, Math.PI / 2)).toBeNull();
  });

  it("keeps the forgiveness out of course generation", () => {
    // The same number must not quietly loosen how tightly the course packs. Obstacles are
    // spaced and held off the racing line by their full radius, so a seed generates exactly
    // the same mountain as it did before collision became generous.
    const terrain = new TerrainField(hashString("alpine"));
    const obstacles = makeField("alpine");
    for (const o of obstacles.range(0, 2000)) {
      const clear = Math.abs(o.x - gateX(terrain.params, o.z));
      expect(clear).toBeGreaterThanOrEqual(
        Math.min(gateClearance(terrain.params, o.z), GATE_CLEARANCE_MIN),
      );
    }
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
    expect(hitAt(obstacles, rock!.x, rock!.z, rock!.y)).toBe(rock);
    expect(hitAt(obstacles, tree!.x, tree!.z, tree!.y)).toBe(tree);

    // Just over the top of each, they pass underneath
    expect(hitAt(obstacles, rock!.x, rock!.z, rock!.y + rock!.height + 0.01)).toBeNull();
    expect(hitAt(obstacles, tree!.x, tree!.z, tree!.y + tree!.height + 0.01)).toBeNull();

    // Just below the top, they still hit — the test is the real height, not a blanket pass
    expect(hitAt(obstacles, rock!.x, rock!.z, rock!.y + rock!.height - 0.05)).toBe(rock);
    expect(hitAt(obstacles, tree!.x, tree!.z, tree!.y + tree!.height - 0.05)).toBe(tree);
  });

  it("makes rocks jumpable and trees essentially not", () => {
    // The gradient is the point: rocks reward a launch, trees have to be steered around.
    //
    // Both bounds come from what the rider can actually do. Measured across seeds, jumps peak
    // between 1.2m and 2.4m with a median of 0.25m, so anything up to about 1.2m is clearable
    // off a good launch and anything past ~2.6m is not clearable at all. The tree bound is 3.0
    // rather than the 2.6 that would just about do, to keep margin — and rather than the 3.5
    // it was, which described the single tree shape that used to exist rather than any
    // requirement. Five shapes at five heights now have to fit between these.
    const obstacles = makeField("heights");
    const all = obstacles.range(20, 2000);
    const rocks = all.filter((o) => o.kind === ObstacleKind.Rock);
    const trees = all.filter((o) => o.kind === ObstacleKind.Tree);

    for (const r of rocks) expect(r.height).toBeLessThan(1.2);
    for (const t of trees) expect(t.height).toBeGreaterThan(3.0);
  });

  it("draws on all five shapes of each kind, fairly evenly", () => {
    // A picker stuck on one value would look exactly like the forest this replaced, and every
    // other test would still pass.
    const obstacles = makeField("variety");
    const all = obstacles.range(20, 4000);
    for (const kind of [ObstacleKind.Tree, ObstacleKind.Rock]) {
      const counts = new Array<number>(VARIANTS).fill(0);
      for (const o of all.filter((o) => o.kind === kind)) counts[o.variant]!++;
      const total = counts.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(100);
      for (let v = 0; v < VARIANTS; v++) {
        const share = counts[v]! / total;
        expect(share, `variant ${v} of kind ${kind} is ${(share * 100).toFixed(1)}% of the mix`)
          .toBeGreaterThan(0.1);
      }
    }
  });

  it("keeps the same course when a seed gains new shapes", () => {
    // The variant is hashed from (seed, slice, index) rather than drawn from the placement
    // generator, precisely so that adding shapes did not consume a value from that stream and
    // silently reshuffle every course anyone had played. Position must depend only on
    // placement, never on which shape came out.
    const obstacles = makeField("stability");
    for (const o of obstacles.range(20, 800)) {
      expect(Number.isFinite(o.x)).toBe(true);
      expect(o.variant).toBeGreaterThanOrEqual(0);
      expect(o.variant).toBeLessThan(VARIANTS);
    }
    // A spot-check with known values, so a change to the placement stream shows up here
    const [first] = obstacles.range(20, 60);
    expect(first!.x).toBeCloseTo(-14.9269, 3);
    expect(first!.z).toBeCloseTo(33.3822, 3);
  });

  it("finds nothing on the clear racing line", () => {
    const terrain = new TerrainField(hashString("clear-line"));
    const obstacles = makeField("clear-line");
    for (let z = 20; z < 3000; z += 1.5) {
      const x = gateX(terrain.params, z);
      expect(hitAt(obstacles, x, z, terrain.heightAt(x, z))).toBeNull();
    }
  });
});

describe("the trees keep thickening out to 5km", () => {
  it("goes on asking for more past the opening ramp, then stops at 5km", () => {
    // The opening ramp finished by 1300m and that was the end of it — a run that got that far
    // met the same forest for the rest of its life, however long that was.
    // The first ramp completes just past 1300m; from there to 2200m is the old plateau.
    expect(densityAt(1400)).toBe(densityAt(2200));
    expect(densityAt(3500)).toBeGreaterThan(densityAt(2200));
    expect(densityAt(5000)).toBeGreaterThan(densityAt(3500));
    expect(densityAt(12_000), "difficulty tops out at 5km").toBe(densityAt(5000));
  });

  it("actually places them, rather than asking for trees that will not fit", () => {
    // Density is a request, not a result: the clear channel and the overlap rule both reject
    // candidates, and the gulley is narrowing over the same stretch, so asking for more can
    // easily deliver nothing. This counts what lands.
    const placed = (z: number) => {
      let total = 0;
      const seeds = ["alpine", "powder-chute-42", "daily-2026-03-04", "zzz"];
      for (const phrase of seeds) {
        const terrain = new TerrainField(hashString(phrase));
        const field = new ObstacleField(hashString(phrase), terrain.params, terrain);
        const first = Math.floor(z / SLICE_LENGTH);
        for (let i = first; i < first + 25; i++) total += field.slice(i).length;
      }
      return total / (seeds.length * 25);
    };

    const early = placed(1500);
    const deep = placed(5000);
    expect(deep, `${deep.toFixed(1)} per slice at 5km vs ${early.toFixed(1)} at 1.5km`).toBeGreaterThan(
      early * 1.3,
    );
  }, 30_000);
});

describe("a collider never claims more room than the obstacle occupies", () => {
  /**
   * The widest the shape gets below the rider's head, from the same tables the mesh is built
   * from. A cone tier is at its widest at its base and tapers to nothing at its tip, so
   * anything whose base is above the rider is passed under rather than through.
   */
  const RIDER_HEIGHT = 1.8;

  const widestBelowRider = (variant: number): number => {
    const shape = TREE_SHAPES[variant]!;
    const [th, dTop, dBottom] = shape.trunk;
    // The trunk spans 0..th, tapering from dBottom to dTop
    let widest = dBottom / 2;
    for (const [y, d, h] of shape.tiers) {
      if (y - h / 2 < RIDER_HEIGHT) widest = Math.max(widest, d / 2);
    }
    void th;
    void dTop;
    return widest;
  };

  it("keeps every tree's collider inside its own silhouette", () => {
    // The bug this exists for: all five firs shared one 0.7m collider, which is generous
    // against a broad canopy sweeping down past the rider and absurd against the bare dead
    // trunk, which is 0.22m wide down there. With the rider's own radius and the collider
    // forgiveness that put the crash 0.41m out into visibly empty snow, and it was reported
    // as crashing "when just being close to it".
    for (let v = 0; v < VARIANTS; v++) {
      const silhouette = widestBelowRider(v);
      const collider = TREE_HIT_RADII[v]!;
      expect(
        collider,
        `tree ${v} collides at ${collider.toFixed(2)}m but is only ${silhouette.toFixed(2)}m wide below ${RIDER_HEIGHT}m`,
      ).toBeLessThanOrEqual(silhouette + 0.1);
    }
  });

  it("keeps every rock's collider inside its silhouette too", () => {
    // Rocks all share ROCK_RADIUS, which is only safe while their footprints stay close to one
    // another. They are lumps of scaled spheres, so the widest a lump reaches is half its
    // diameter times the larger of its two horizontal scalings, plus however far it is offset
    // from the centre. Sitting on the snow, the whole rock is inside the band the rider
    // occupies, so there is no height to discount as there is with a canopy.
    for (let v = 0; v < VARIANTS; v++) {
      let widest = 0;
      for (const lump of ROCK_SHAPES[v]!) {
        const [sx, , sz] = lump.scaling;
        const [ox, , oz] = lump.offset ?? [0, 0, 0];
        widest = Math.max(
          widest,
          (lump.diameter / 2) * Math.max(sx, sz) + Math.hypot(ox, oz),
        );
      }
      // Slightly generous against the mesh, which is faceted: a segments-3 sphere puts its
      // vertices at or inside the ideal radius, so measured off the geometry rock 0 comes out
      // at 1.09 against the 1.15 computed here. The browser check does it that stricter way.
      expect(
        ROCK_RADIUS,
        `rock ${v} collides at ${ROCK_RADIUS}m but is only ${widest.toFixed(2)}m wide`,
      ).toBeLessThanOrEqual(widest + 0.1);
    }
  });

  it("still stops you when you actually reach the trunk", () => {
    // The other direction: forgiving is not the same as passable. A collider small enough to
    // ride through would turn the dead trees into scenery.
    for (let v = 0; v < VARIANTS; v++) {
      expect(TREE_HIT_RADII[v]!, `tree ${v} is barely there`).toBeGreaterThan(0.25);
    }
  });

  it("leaves where the trees are placed exactly as it was", () => {
    // The hit radius is deliberately separate from `radius`, which spaces obstacles apart and
    // holds them off the racing line. Changing that would move every tree in the game and
    // invalidate every score; this changes only what the rider collides with.
    const field = makeField("alpine");
    for (let i = 2; i < 60; i++) {
      for (const o of field.slice(i)) {
        expect(o.radius).toBe(o.kind === ObstacleKind.Tree ? 0.7 * o.scale : 0.95 * o.scale);
      }
    }
  });
});
