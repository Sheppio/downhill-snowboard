import { beforeEach, describe, expect, it } from "vitest";

import { outcomeOf, scoreDisplay } from "./outcome";
import { markContinued, readBest, recordBest } from "./leaderboard";

describe("what a finished run was worth", () => {
  it("is a record when storage kept it", () => {
    expect(outcomeOf({ score: 900, best: 900, saved: true, spent: false }).kind).toBe("record");
  });

  it("is beaten when a clean run did not take the best", () => {
    expect(outcomeOf({ score: 400, best: 900, saved: false, spent: false }).kind).toBe("beaten");
  });

  it("is unrecorded when the day was spent", () => {
    expect(outcomeOf({ score: 9999, best: 900, saved: false, spent: true }).kind).toBe(
      "unrecorded",
    );
  });

  /**
   * The bug this file exists for, as a test.
   *
   * The end screen used to compute its own answer — `score > bestAtStart` — and announced a new
   * personal best over a score storage had just refused to keep, on the one screen whose claim
   * travels to other people. A continued run cannot be a record however far it goes, and the
   * only way to be sure of that is to take the answer from whatever did the keeping.
   */
  it("cannot call a run a record on a spent day, however big the score", () => {
    for (const score of [1, 1000, 10_000_000]) {
      expect(outcomeOf({ score, best: 500, saved: false, spent: true }).kind).not.toBe("record");
    }
  });
});

describe("how a run in progress is drawn", () => {
  it("counts normally on a clean day", () => {
    expect(scoreDisplay({ score: 5000, bestBefore: 100, spent: false, continued: false })).toBe(
      "counting",
    );
  });

  it("greys a continued run the moment it resumes, with nothing yet earned", () => {
    expect(scoreDisplay({ score: 0, bestBefore: 9999, spent: true, continued: true })).toBe(
      "unrecorded",
    );
  });

  /**
   * A fresh run on a spent day is a clean attempt from the top, so it is drawn as one — right up
   * to the point it passes the best already stored, which is where it crosses from "could not
   * have been a record anyway" into "would have been, and will not be saved".
   */
  it("draws a re-run on a spent day normally until it passes the standing best", () => {
    const at = (score: number) =>
      scoreDisplay({ score, bestBefore: 1000, spent: true, continued: false });
    expect(at(999)).toBe("counting");
    expect(at(1000)).toBe("counting"); // equalling it is not passing it
    expect(at(1001)).toBe("unrecorded");
  });
});

/**
 * The two rules meeting.
 *
 * `scoreDisplay` predicts and `recordBest` decides, and they are separate on purpose — a fresh
 * run below the best is drawn as counting because it still *could* become a record. What must
 * never happen is the prediction promising something storage then refuses: wherever the HUD says
 * a number is being kept, storage has to agree that a score at that level would be kept.
 */
describe("the prediction and the decision agree", () => {
  // The suite runs in node, which has no storage at all. Only the handful of calls the
  // leaderboard makes, so this stays a stub rather than a dependency.
  beforeEach(() => {
    const map = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    };
  });

  it("never says counting on a course where nothing can be recorded", () => {
    const seed = "20260101";
    recordBest(seed, 1000, 100, 20);
    markContinued(seed);
    const bestBefore = readBest(seed);

    // Past the standing best, which is the only region where the promise could be broken
    const score = bestBefore + 1;
    expect(scoreDisplay({ score, bestBefore, spent: true, continued: false })).toBe("unrecorded");
    expect(recordBest(seed, score, 100, 20)).toBe(false);
  });

  it("says counting exactly where a score would in fact be kept", () => {
    const seed = "powder-chute-42";
    recordBest(seed, 1000, 100, 20);
    const bestBefore = readBest(seed);

    const score = bestBefore + 1;
    expect(scoreDisplay({ score, bestBefore, spent: false, continued: false })).toBe("counting");
    expect(recordBest(seed, score, 100, 20)).toBe(true);
  });
});
