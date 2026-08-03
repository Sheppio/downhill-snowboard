import { describe, expect, it } from "vitest";

import { dailyEntryError, dailySeedDate, isDaily, normaliseSeed, seedLabel } from "./seed";
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
    for (const day of ["2026-01-01", "2026-08-03", "2026-08-04", "2027-06-15"]) {
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

describe("who may ride a date-shaped code", () => {
  const NOW = new Date("2026-08-06T09:30:00Z");

  it("lets today's code through, in either format", () => {
    expect(dailyEntryError("20260806", NOW)).toBeNull();
    // The old shape still names the same day, so it is still today
    expect(dailyEntryError("daily-2026-08-06", NOW)).toBeNull();
  });

  it("refuses a day that has not happened, so nobody practises tomorrow's course", () => {
    // The whole competition is that everyone meets the same mountain with the same warning.
    const refusal = dailyEntryError("20260807", NOW);
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/hasn't happened/i);
    expect(dailyEntryError("20261225", NOW)).not.toBeNull();
  });

  it("refuses a day that has already been scored", () => {
    const refusal = dailyEntryError("20260805", NOW);
    expect(refusal).not.toBeNull();
    expect(refusal, "says what to ride instead").toContain("20260806");
    expect(dailyEntryError("daily-2026-07-28", NOW)).not.toBeNull();
  });

  it("leaves every ordinary code alone", () => {
    // Custom courses are not the daily and are nobody's business but the player's — ride them
    // as often as you like.
    for (const seed of ["powder-chute-42", "alpine", "20260806-b", "2026080", "a"]) {
      expect(dailyEntryError(seed, NOW), `seed "${seed}"`).toBeNull();
    }
  });

  it("holds right up to the boundary, on UTC", () => {
    // The day rolls over at midnight UTC everywhere at once — that is what makes it one race.
    expect(dailyEntryError("20260806", new Date("2026-08-06T00:00:00Z"))).toBeNull();
    expect(dailyEntryError("20260806", new Date("2026-08-06T23:59:59Z"))).toBeNull();
    expect(dailyEntryError("20260806", new Date("2026-08-07T00:00:01Z"))).not.toBeNull();
    expect(dailyEntryError("20260806", new Date("2026-08-05T23:59:59Z"))).not.toBeNull();
  });

  it("names the day a player would recognise, not the raw code", () => {
    expect(dailyEntryError("20260807", NOW)).toMatch(/aug/i);
    expect(dailyEntryError("20260807", NOW)).toMatch(/2026/);
  });
});
