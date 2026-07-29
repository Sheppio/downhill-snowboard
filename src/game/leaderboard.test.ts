import { beforeEach, describe, expect, it } from "vitest";

import {
  COURSE_GENERATION,
  formatDistance,
  formatWhen,
  readBest,
  readRecord,
  readScores,
  recordBest,
} from "./leaderboard";

/**
 * An in-memory localStorage.
 *
 * The suite runs in node, which has no storage at all, and a real browser's would carry state
 * between tests anyway. This implements the parts of the Storage interface the leaderboard
 * uses, plus a switch to make every call throw — which is what a browser with storage
 * disabled actually does.
 */
class MemoryStorage {
  readonly map = new Map<string, string>();
  /** Set to make every operation throw, as Safari does with storage disabled. */
  broken = false;

  private guard(): void {
    if (this.broken) throw new Error("storage disabled");
  }

  get length(): number {
    this.guard();
    return this.map.size;
  }

  key(i: number): string | null {
    this.guard();
    return [...this.map.keys()][i] ?? null;
  }

  getItem(key: string): string | null {
    this.guard();
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.guard();
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.guard();
    this.map.delete(key);
  }

  clear(): void {
    this.guard();
    this.map.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

/** Readable timestamps: `t(0)` is a fixed instant, `t(1)` an hour later, and so on. */
const BASE = Date.UTC(2026, 6, 20, 9, 0, 0);
const t = (hours: number) => BASE + hours * 3600_000;

describe("recording a best", () => {
  it("keeps the score and when it was set", () => {
    expect(recordBest("alpine", 1200, 940.7, t(0))).toBe(true);
    expect(readRecord("alpine")).toEqual({
      seed: "alpine",
      score: 1200,
      at: t(0),
      distance: 940,
      gen: COURSE_GENERATION,
    });
    expect(readBest("alpine")).toBe(1200);
  });

  it("replaces the record when it is beaten, with the new time", () => {
    recordBest("alpine", 1200, 500, t(0));
    expect(recordBest("alpine", 1800, 500, t(5))).toBe(true);

    expect(readScores(), "one row per seed, not one per run").toHaveLength(1);
    expect(readRecord("alpine")).toEqual({
      seed: "alpine",
      score: 1800,
      at: t(5),
      distance: 500,
      gen: COURSE_GENERATION,
    });
  });

  it("leaves the record and its time alone when the run does not beat it", () => {
    recordBest("alpine", 1800, 500, t(0));
    expect(recordBest("alpine", 900, 500, t(5))).toBe(false);
    // Equalling a best is not a new achievement, so it must not restamp it either — otherwise
    // a repeated run would shuffle the seed back to the top of a list ordered by recency.
    expect(recordBest("alpine", 1800, 500, t(6))).toBe(false);

    // The distance belongs to the run that set the record, so it stays put with everything else
    expect(readRecord("alpine")).toEqual({
      seed: "alpine",
      score: 1800,
      at: t(0),
      distance: 500,
      gen: COURSE_GENERATION,
    });
  });

  it("keeps the distance of the run that set the record", () => {
    recordBest("alpine", 100, 80, t(0));
    expect(readRecord("alpine")?.distance).toBe(80);

    recordBest("alpine", 900, 720, t(1));
    expect(readRecord("alpine")?.distance, "the new record's run, not the old one").toBe(720);
  });

  it("records a score whose distance is missing rather than dropping it", () => {
    // A row can say "—" for how far; it cannot say nothing for the score.
    expect(recordBest("alpine", 1200, Number.NaN, t(0))).toBe(true);
    expect(readBest("alpine")).toBe(1200);
    expect(readRecord("alpine")?.distance).toBeUndefined();
  });

  it("does not record a scoreless run", () => {
    expect(recordBest("alpine", 0, 500, t(0))).toBe(false);
    expect(readScores()).toEqual([]);
  });

  it("keeps seeds apart", () => {
    recordBest("alpine", 1200, 500, t(0));
    recordBest("powder-bowl-12", 400, 500, t(1));

    expect(readBest("alpine")).toBe(1200);
    expect(readBest("powder-bowl-12")).toBe(400);
    expect(readBest("never-ridden")).toBe(0);
    expect(readRecord("never-ridden")).toBeNull();
  });
});

describe("ordering", () => {
  it("puts the newest best at the top", () => {
    // Scores descend as the times ascend, so ordering by score would give exactly the
    // opposite list — the check would pass on either rule if they all scored the same.
    recordBest("first", 300, 500, t(0));
    recordBest("second", 200, 500, t(1));
    recordBest("third", 100, 500, t(2));

    expect(readScores().map((r) => r.seed)).toEqual(["third", "second", "first"]);
  });

  it("lifts a seed back to the top when its best is beaten", () => {
    // The point of ordering by achievement rather than by score: the list shows what you have
    // been doing lately, so an old seed you have just improved on comes back into view.
    recordBest("old", 5000, 500, t(0));
    recordBest("new", 100, 500, t(1));
    expect(readScores().map((r) => r.seed)).toEqual(["new", "old"]);

    recordBest("old", 5100, 500, t(2));
    expect(readScores().map((r) => r.seed)).toEqual(["old", "new"]);
  });
});

describe("scores with no time on them", () => {
  // Every row states when it was set, and that is what the list is ordered by. A score that
  // cannot say when has nothing to show in either column, so it is dropped rather than listed
  // under a placeholder. That covers the bests kept before this format — one key per seed
  // holding a bare number — and any row left undated by an older build.
  it("does not list a stored record without a real time", () => {
    storage.setItem(
      "downhill.scores.v1",
      JSON.stringify([
        { seed: "timed", score: 100, at: t(0), gen: COURSE_GENERATION },
        { seed: "undated", score: 9999, at: 0, gen: COURSE_GENERATION },
      ]),
    );

    expect(readScores().map((r) => r.seed)).toEqual(["timed"]);
    expect(readBest("undated")).toBe(0);
  });

  it("still lists a record set before distances were kept", () => {
    // A missing distance is not a missing record: the score and its time are both there, and
    // the row shows a dash for how far. Only a missing *time* disqualifies a row.
    storage.setItem(
      "downhill.scores.v1",
      JSON.stringify([{ seed: "before-distances", score: 4321, at: t(0), gen: COURSE_GENERATION }]),
    );

    expect(readBest("before-distances")).toBe(4321);
    expect(readRecord("before-distances")?.distance).toBeUndefined();
  });

  it("leaves bests in the old per-seed format where they are", () => {
    storage.setItem("downhill.best.old-favourite", "4321");

    expect(readScores()).toEqual([]);
    expect(readBest("old-favourite")).toBe(0);
  });
});

describe("storage that cannot be trusted", () => {
  it("survives contents that are not records at all", () => {
    storage.setItem("downhill.scores.v1", "{not json");
    expect(readScores()).toEqual([]);

    storage.setItem("downhill.scores.v1", JSON.stringify({ alpine: 12 }));
    expect(readScores()).toEqual([]);

    storage.setItem(
      "downhill.scores.v1",
      JSON.stringify([
        { seed: "good", score: 10, at: t(0), gen: COURSE_GENERATION },
        { seed: "", score: 10, at: t(0), gen: COURSE_GENERATION },
        { seed: "no-score", at: t(0), gen: COURSE_GENERATION },
        { score: 10, at: t(0), gen: COURSE_GENERATION },
        null,
        { seed: "bad-time", score: 10, at: "yesterday", gen: COURSE_GENERATION },
      ]),
    );
    expect(readScores().map((r) => r.seed)).toEqual(["good"]);
  });

  it("does not throw when storage itself does", () => {
    // Safari in private mode, and any browser with storage blocked: the property access and
    // every method throw. A high score is never worth crashing a game over.
    storage.broken = true;

    expect(() => recordBest("alpine", 1200, 500, t(0))).not.toThrow();
    expect(readScores()).toEqual([]);
    expect(readBest("alpine")).toBe(0);
  });

  it("does not throw when there is no storage at all", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;

    expect(() => recordBest("alpine", 1200, 500, t(0))).not.toThrow();
    expect(readScores()).toEqual([]);
  });
});

describe("how long ago", () => {
  const now = t(0);

  it("counts up through the units", () => {
    expect(formatWhen(now - 20_000, now)).toBe("just now");
    expect(formatWhen(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatWhen(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(formatWhen(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("gives a date once counting days stops meaning anything", () => {
    const label = formatWhen(now - 40 * 86_400_000, now);
    expect(label).not.toMatch(/ago/);
    expect(label).toMatch(/\d/);
  });

  it("does not report the future as a negative age", () => {
    // Phones change timezone and get their clocks corrected; a record can end up ahead of now.
    expect(formatWhen(now + 3600_000, now)).toBe("just now");
  });
});

describe("how far", () => {
  it("reads as metres", () => {
    expect(formatDistance(412)).toBe("412m");
    expect(formatDistance(4120)).toMatch(/^4.120m$/); // grouped in the runtime's locale
  });

  it("shows a dash when the run's distance was never recorded", () => {
    // Not "0m": that reads as a run that went nowhere, which is a different claim entirely.
    expect(formatDistance(undefined)).toBe("—");
  });
});

describe("scores set on an earlier version of the course", () => {
  const raw = () => JSON.parse(storage.getItem("downhill.scores.v1") ?? "[]") as unknown[];

  it("drops them, because they are not comparable with anything set now", () => {
    // The mountain now keeps getting harder out to 5km. A score set before that is a score
    // from a different game, and leaving the two side by side makes the list meaningless.
    storage.setItem(
      "downhill.scores.v1",
      JSON.stringify([
        { seed: "old-mountain", score: 9000, at: t(0) }, // no stamp: generation 1
        { seed: "old-explicit", score: 8000, at: t(1), gen: 1 },
        { seed: "current", score: 100, at: t(2), gen: COURSE_GENERATION },
      ]),
    );

    expect(readScores().map((r) => r.seed)).toEqual(["current"]);
    expect(readBest("old-mountain")).toBe(0);
  });

  it("deletes them from storage rather than just hiding them", () => {
    storage.setItem(
      "downhill.scores.v1",
      JSON.stringify([{ seed: "old-mountain", score: 9000, at: t(0) }]),
    );

    readScores();
    expect(raw(), "the row is gone from the device, not merely filtered on the way out").toEqual(
      [],
    );
  });

  it("lets the seed be scored on again from scratch", () => {
    storage.setItem(
      "downhill.scores.v1",
      JSON.stringify([{ seed: "alpine", score: 9000, at: t(0) }]),
    );

    // The old 9000 must not stand in the way of a new best on the harder course
    expect(recordBest("alpine", 500, 400, t(5))).toBe(true);
    expect(readBest("alpine")).toBe(500);
  });

  it("stamps everything it writes, so this can be done again", () => {
    recordBest("alpine", 1200, 900, t(0));
    expect((raw()[0] as { gen: number }).gen).toBe(COURSE_GENERATION);
  });
});
