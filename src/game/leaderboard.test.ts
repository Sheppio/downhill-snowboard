import { beforeEach, describe, expect, it } from "vitest";

import { formatWhen, readBest, readRecord, readScores, recordBest } from "./leaderboard";

/**
 * An in-memory localStorage.
 *
 * The suite runs in node, which has no storage at all, and a real browser's would carry state
 * between tests anyway. This implements the parts of the Storage interface the leaderboard
 * uses — including `length`/`key`, which the migration walks to find the old per-seed keys.
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
    expect(recordBest("alpine", 1200, t(0))).toBe(true);
    expect(readRecord("alpine")).toEqual({ seed: "alpine", score: 1200, at: t(0) });
    expect(readBest("alpine")).toBe(1200);
  });

  it("replaces the record when it is beaten, with the new time", () => {
    recordBest("alpine", 1200, t(0));
    expect(recordBest("alpine", 1800, t(5))).toBe(true);

    expect(readScores(), "one row per seed, not one per run").toHaveLength(1);
    expect(readRecord("alpine")).toEqual({ seed: "alpine", score: 1800, at: t(5) });
  });

  it("leaves the record and its time alone when the run does not beat it", () => {
    recordBest("alpine", 1800, t(0));
    expect(recordBest("alpine", 900, t(5))).toBe(false);
    // Equalling a best is not a new achievement, so it must not restamp it either — otherwise
    // a repeated run would shuffle the seed back to the top of a list ordered by recency.
    expect(recordBest("alpine", 1800, t(6))).toBe(false);

    expect(readRecord("alpine")).toEqual({ seed: "alpine", score: 1800, at: t(0) });
  });

  it("does not record a scoreless run", () => {
    expect(recordBest("alpine", 0, t(0))).toBe(false);
    expect(readScores()).toEqual([]);
  });

  it("keeps seeds apart", () => {
    recordBest("alpine", 1200, t(0));
    recordBest("powder-bowl-12", 400, t(1));

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
    recordBest("first", 300, t(0));
    recordBest("second", 200, t(1));
    recordBest("third", 100, t(2));

    expect(readScores().map((r) => r.seed)).toEqual(["third", "second", "first"]);
  });

  it("lifts a seed back to the top when its best is beaten", () => {
    // The point of ordering by achievement rather than by score: the list shows what you have
    // been doing lately, so an old seed you have just improved on comes back into view.
    recordBest("old", 5000, t(0));
    recordBest("new", 100, t(1));
    expect(readScores().map((r) => r.seed)).toEqual(["new", "old"]);

    recordBest("old", 5100, t(2));
    expect(readScores().map((r) => r.seed)).toEqual(["old", "new"]);
  });
});

describe("bests carried over from before timestamps existed", () => {
  const legacy = (seed: string, score: number) =>
    storage.setItem(`downhill.best.${seed}`, String(score));

  it("brings them across, with an unknown time", () => {
    legacy("alpine", 1234);
    legacy("glacier-run-77", 890);

    const scores = readScores();
    expect(scores).toHaveLength(2);
    expect(readBest("alpine")).toBe(1234);
    expect(scores.every((r) => r.at === 0), "there is no honest time for these").toBe(true);
  });

  it("sorts them below anything with a real time", () => {
    // Inventing "now" for them would put every old score above every new one and make the
    // ordering a lie on the first run after upgrading.
    legacy("ancient", 9999);
    recordBest("fresh", 10, t(0));

    expect(readScores().map((r) => r.seed)).toEqual(["fresh", "ancient"]);
  });

  it("only migrates once, so a beaten legacy best does not come back", () => {
    legacy("alpine", 1000);
    expect(readBest("alpine")).toBe(1000);

    recordBest("alpine", 2000, t(0));
    expect(readBest("alpine")).toBe(2000);
    expect(readScores()).toHaveLength(1);
  });

  it("ignores keys that are not a score", () => {
    storage.setItem("downhill.best.broken", "not a number");
    storage.setItem("unrelated.key", "42");

    expect(readScores()).toEqual([]);
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
        { seed: "good", score: 10, at: t(0) },
        { seed: "", score: 10, at: t(0) },
        { seed: "no-score", at: t(0) },
        { score: 10, at: t(0) },
        null,
        { seed: "bad-time", score: 10, at: "yesterday" },
      ]),
    );
    expect(readScores().map((r) => r.seed).sort()).toEqual(["bad-time", "good"]);
    expect(readRecord("bad-time")?.at).toBe(0);
  });

  it("does not throw when storage itself does", () => {
    // Safari in private mode, and any browser with storage blocked: the property access and
    // every method throw. A high score is never worth crashing a game over.
    storage.broken = true;

    expect(() => recordBest("alpine", 1200, t(0))).not.toThrow();
    expect(readScores()).toEqual([]);
    expect(readBest("alpine")).toBe(0);
  });

  it("does not throw when there is no storage at all", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;

    expect(() => recordBest("alpine", 1200, t(0))).not.toThrow();
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

  it("says nothing precise when the time is unknown", () => {
    expect(formatWhen(0, now)).toBe("earlier");
  });

  it("does not report the future as a negative age", () => {
    // Phones change timezone and get their clocks corrected; a record can end up ahead of now.
    expect(formatWhen(now + 3600_000, now)).toBe("just now");
  });
});
