/**
 * Seed plumbing — how a course gets chosen, and how one gets shared.
 *
 * The whole competitive layer lives here and needs no backend at all. Everyone racing the
 * same seed rides the same mountain, and the daily seed is derived from the UTC date, so a
 * player in Auckland and a player in Los Angeles get the same course at the same moment with
 * nothing coordinating them.
 */

import { dailySeed, randomSeedPhrase } from "../core/rng";

const SEED_PARAM = "seed";

/** Seeds are normalised so "Alpine " and "alpine" are the same course, not two. */
export function normaliseSeed(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 24);
}

/** Today's shared seed. */
export function todaysSeed(): string {
  return dailySeed();
}

/** A human-friendly label for the daily seed, e.g. "28 Jul 2026". */
export function dailyLabel(now: Date = new Date()): string {
  return now.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function isDaily(seed: string): boolean {
  return seed.startsWith("daily-");
}

/**
 * How a seed should be shown to a player.
 *
 * Daily seeds are machine-shaped (`daily-2026-07-29`) because they have to be derived from
 * the date without coordination. Nobody wants to read a list of those, so they are turned
 * back into the date they encode.
 */
export function seedLabel(seed: string): string {
  if (!isDaily(seed)) return seed;
  const date = new Date(`${seed.slice("daily-".length)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? seed : dailyLabel(date);
}

/**
 * The seed to open with: whatever is in the URL, otherwise today's run.
 *
 * Defaulting to the daily seed rather than a random one matters — it means a first-time
 * player lands directly on the course everyone else is racing.
 */
export function initialSeed(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(SEED_PARAM);
    if (fromUrl) {
      const seed = normaliseSeed(fromUrl);
      if (seed) return seed;
    }
  } catch {
    // Malformed URL — fall through to the daily seed
  }
  return todaysSeed();
}

export function randomSeed(): string {
  return randomSeedPhrase();
}

/** A shareable link that drops someone straight onto this course. */
export function shareUrl(seed: string): string {
  const url = new URL(window.location.href);
  url.search = ""; // drop anything else that was hanging off the URL
  url.searchParams.set(SEED_PARAM, seed);
  url.hash = "";
  return url.toString();
}

/**
 * Reflect the current seed in the address bar without adding history entries.
 *
 * `replaceState` rather than `pushState` so the back button leaves the game rather than
 * walking back through every seed the player tried.
 */
export function syncUrl(seed: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(SEED_PARAM, seed);
    window.history.replaceState(null, "", url.toString());
  } catch {
    // History API unavailable; the game is unaffected
  }
}

/**
 * Copy a challenge link, falling back to a prompt where the clipboard API is blocked.
 *
 * Takes the link rather than the seed. The caller already has one — it is on the card and it
 * went to the share sheet — and deriving a second one here could disagree with it.
 */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // Clipboard needs a secure context and a user gesture; neither is guaranteed
    try {
      window.prompt("Copy this challenge link:", url);
    } catch {
      /* nothing else to try */
    }
    return false;
  }
}
