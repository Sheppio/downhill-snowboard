import { describe, expect, it } from "vitest";

import { dailySeedDate, isDaily, normaliseSeed, seedLabel } from "./seed";
import { dailySeed } from "../core/rng";

describe("recognising a daily seed", () => {
  it("reads the format the game writes now", () => {
    expect(dailySeedDate("20260802")).toBe("2026-08-02");
    expect(dailySeedDate("20261231")).toBe("2026-12-31");
    expect(isDaily("20260802")).toBe(true);
  });

  it("still reads the format it wrote until August 2026", () => {
    // Those seeds are on people's devices and inside links already sent. A challenge someone
    // was handed in July is meant to keep working in September.
    expect(dailySeedDate("daily-2026-07-28")).toBe("2026-07-28");
    expect(isDaily("daily-2026-07-28")).toBe(true);
  });

  it("agrees with what the game actually generates, on both sides of the cutover", () => {
    // Derived rather than restated: if the writer and the reader ever disagree, a daily run
    // stops being recognised as one and quietly becomes a custom seed.
    for (const day of ["2026-01-01", "2026-08-01", "2026-08-02", "2027-06-15"]) {
      const seed = dailySeed(new Date(`${day}T09:00:00Z`));
      expect(dailySeedDate(seed), `seed "${seed}"`).toBe(day);
    }
  });

  it("rejects a date the calendar does not have", () => {
    // Eight digits in the right shape is not a date. `new Date` rolls 30 February forward to
    // 2 March rather than refusing, so a seed that looks like a day nobody can ever play would
    // otherwise be treated as a daily run — and be permanently unplayable, since it can never
    // be "today".
    expect(dailySeedDate("20260230")).toBeNull();
    expect(dailySeedDate("20261301")).toBeNull();
    expect(dailySeedDate("20260000")).toBeNull();
    expect(dailySeedDate("20260132")).toBeNull();
    // ...but a real leap day is a real day
    expect(dailySeedDate("20280229")).toBe("2028-02-29");
    expect(dailySeedDate("20260229"), "2026 is not a leap year").toBeNull();
  });

  it("leaves an ordinary seed alone", () => {
    for (const seed of ["powder-chute-42", "alpine", "2026", "202608021", "a", ""]) {
      expect(dailySeedDate(seed), `seed "${seed}"`).toBeNull();
      expect(isDaily(seed)).toBe(false);
    }
  });

  it("shows a daily run as the date it stands for, in either format", () => {
    // The raw seed is machine-shaped; nobody wants to read a list of those.
    expect(seedLabel("20260802")).toMatch(/2026/);
    expect(seedLabel("20260802")).toMatch(/aug/i);
    expect(seedLabel("20260802")).toBe(seedLabel("daily-2026-08-02"));
    expect(seedLabel("powder-chute-42")).toBe("powder-chute-42");
  });

  it("survives normalisation, which every typed seed goes through", () => {
    expect(isDaily(normaliseSeed(" 20260802 "))).toBe(true);
    expect(isDaily(normaliseSeed("DAILY-2026-07-28"))).toBe(true);
  });
});
