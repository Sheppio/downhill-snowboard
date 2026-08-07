import { describe, expect, it } from "vitest";

import { CardCache, MAX_CARDS } from "./cardcache";
import type { CardResult } from "./sharecard";

/**
 * A stand-in for the renderer that hands back cards only when told to.
 *
 * Real drawing is a canvas and a second and a half, and neither is available or wanted here.
 * Holding the promises open is the point: the queue's whole job is deciding what to draw *next*,
 * which only means anything while something is still in flight.
 */
function harness(opts: { has?: (seed: string) => boolean } = {}) {
  const asked: string[] = [];
  const pending: { seed: string; resolve: (f: File | null) => void }[] = [];
  const cache = new CardCache({
    resultFor: (seed) =>
      opts.has && !opts.has(seed)
        ? null
        : ({ score: 1, distance: 1, seed, strap: "", url: "" } as CardResult),
    draw: (result) => {
      asked.push(result.seed);
      return new Promise<File | null>((resolve) => pending.push({ seed: result.seed, resolve }));
    },
  });
  /** Finish the render currently in flight, and let the queue move on. */
  const finish = async (file: File | null = { name: "card" } as unknown as File) => {
    const next = pending.shift();
    if (!next) throw new Error("nothing was being drawn");
    next.resolve(file);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { cache, asked, finish };
}

describe("drawing cards ahead of being asked", () => {
  it("draws one at a time, in the order the list gave them", async () => {
    const { cache, asked, finish } = harness();
    cache.queueAll(["a", "b", "c"]);
    expect(asked).toEqual(["a"]);

    await finish();
    expect(asked).toEqual(["a", "b"]);
    await finish();
    expect(asked).toEqual(["a", "b", "c"]);
  });

  it("hands back what it drew, and nothing for a seed it has not reached", async () => {
    const { cache, finish } = harness();
    cache.queueAll(["a", "b"]);
    expect(cache.get("a")).toBeNull();
    await finish();
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("b")).toBeNull();
  });

  /**
   * The press before a share. It does not buy the time — a press is a tenth of a second and a
   * card is over one — it just stops a list of thirty drawing twenty-nine others first.
   */
  it("jumps a seed to the front without drawing it twice", async () => {
    const { cache, asked, finish } = harness();
    cache.queueAll(["a", "b", "c", "d"]);
    await finish(); // "a" done, "b" now in flight

    cache.prioritise("d");
    await finish(); // "b" done
    expect(asked).toEqual(["a", "b", "d"]);
    await finish();
    expect(asked).toEqual(["a", "b", "d", "c"]);
  });

  it("does not redraw one it already has", async () => {
    const { cache, asked, finish } = harness();
    cache.queueAll(["a"]);
    await finish();
    cache.prioritise("a");
    cache.queueAll(["a"]);
    expect(asked).toEqual(["a"]);
  });

  /**
   * A card that could not be drawn is remembered as such. Otherwise every press on that row
   * starts the whole attempt again, forever.
   */
  it("remembers a failure rather than retrying it on every press", async () => {
    const { cache, asked, finish } = harness();
    cache.queueAll(["a"]);
    await finish(null);
    cache.prioritise("a");
    expect(asked).toEqual(["a"]);
    expect(cache.get("a")).toBeNull();
  });

  /**
   * A seed can lose its record between being queued and being reached — beaten on another run,
   * or cleared — so the skip is resolved when the queue gets there rather than when it went in.
   */
  it("skips a seed that has no record by the time it is reached", async () => {
    const live = new Set(["a", "b", "c"]);
    const { cache, asked, finish } = harness({ has: (s) => live.has(s) });
    cache.queueAll(["a", "b", "c"]);
    live.delete("b");
    await finish();
    expect(asked).toEqual(["a", "c"]);
  });

  it("stops when nothing left in the queue can be drawn", async () => {
    const { cache, asked, finish } = harness({ has: () => false });
    cache.queueAll(["a", "b"]);
    expect(asked).toEqual([]);
    await expect(finish()).rejects.toThrow();
  });

  it("takes no more than a list's worth, however long the list", async () => {
    const { cache, asked, finish } = harness();
    cache.queueAll(Array.from({ length: MAX_CARDS + 10 }, (_, i) => `s${i}`));

    // Drained to the end, because only one is ever in flight: checking what is being drawn
    // *now* says nothing about how many were taken, which is how the first version of this
    // passed against a cache with no cap at all.
    for (let i = 0; i < MAX_CARDS; i++) await finish();
    await expect(finish()).rejects.toThrow(); // nothing left to draw
    expect(asked).toHaveLength(MAX_CARDS);
    expect(asked).not.toContain(`s${MAX_CARDS}`);
  });

  /**
   * Oldest out first. The map keeps insertion order and the list is already sorted by how recent
   * a score is, so the oldest entry is the row furthest from the top — the one least likely to
   * be reached for next.
   */
  it("evicts the oldest once it is full", async () => {
    const { cache, finish } = harness();
    const seeds = Array.from({ length: MAX_CARDS }, (_, i) => `s${i}`);
    cache.queueAll(seeds);
    for (let i = 0; i < MAX_CARDS; i++) await finish();
    expect(cache.size).toBe(MAX_CARDS);
    expect(cache.get("s0")).not.toBeNull();

    cache.queueAll(["late"]);
    await finish();
    expect(cache.size).toBe(MAX_CARDS);
    expect(cache.get("s0")).toBeNull(); // the oldest went
    expect(cache.get("late")).not.toBeNull();
    expect(cache.get(`s${MAX_CARDS - 1}`)).not.toBeNull(); // the newest stayed
  });

  it("forgets a card whose score has been beaten", async () => {
    const { cache, asked, finish } = harness();
    cache.queueAll(["a"]);
    await finish();
    expect(cache.get("a")).not.toBeNull();

    cache.invalidate("a");
    expect(cache.get("a")).toBeNull();
    cache.queueAll(["a"]);
    expect(asked).toEqual(["a", "a"]); // and it is drawn again, from the record that replaced it
  });
});
