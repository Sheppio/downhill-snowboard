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

/**
 * The UTC date a daily seed stands for, as `YYYY-MM-DD`, or null if it is not one.
 *
 * Reads both shapes. `YYYYMMDD` is what the game writes now; `daily-YYYY-MM-DD` is what it
 * wrote until 2 Aug 2026, and those seeds are still on people's devices and in links already
 * sent — a shared challenge is meant to keep working.
 *
 * The calendar has the last word. `20260230` is eight digits in the right shape and not a day
 * that exists, and `new Date` will quietly hand back 2 March rather than refusing, so the only
 * honest test is whether the date agrees it is the date it was asked for. Without that,
 * February the thirtieth becomes a course you could ride but never on the day it claims.
 */
export function dailySeedDate(seed: string): string | null {
  let iso: string | null = null;
  if (/^daily-\d{4}-\d{2}-\d{2}$/.test(seed)) iso = seed.slice("daily-".length);
  else if (/^\d{8}$/.test(seed)) iso = `${seed.slice(0, 4)}-${seed.slice(4, 6)}-${seed.slice(6, 8)}`;
  if (iso === null) return null;

  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function isDaily(seed: string): boolean {
  return dailySeedDate(seed) !== null;
}

/**
 * How a seed should be shown to a player.
 *
 * Daily seeds are machine-shaped because they have to be derived from the date without
 * coordination. Nobody wants to read a list of those, so they are turned back into the date
 * they encode.
 */
export function seedLabel(seed: string): string {
  const iso = dailySeedDate(seed);
  return iso === null ? seed : dailyLabel(new Date(`${iso}T00:00:00Z`));
}

/** The UTC date, as `YYYY-MM-DD`. */
function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Why a typed course code cannot be ridden, or null if it can.
 *
 * The daily run is the competition, and it is only a competition because everybody meets the
 * same mountain on the same day with no more warning than anyone else. Typing a date in gives
 * away both halves of that: tomorrow's code is a practice run at a course nobody else has seen
 * yet, and last Tuesday's is an attempt at a day that has already been scored.
 *
 * Only the *date-shaped* codes are restricted. Anything else a player types is theirs to ride
 * as often as they like — the whole point of custom courses is that they are not the daily.
 */
export function dailyEntryError(seed: string, now: Date = new Date()): string | null {
  const iso = dailySeedDate(seed);
  if (iso === null) return null; // an ordinary course code, always fine

  const nowIso = today(now);
  if (iso === nowIso) return null;

  const when = dailyLabel(new Date(`${iso}T00:00:00Z`));
  return iso > nowIso
    ? `${when} hasn't happened yet — no early practice!`
    : `${when} is done and dusted. Today's run is ${dailySeed(now)}.`;
}

/**
 * The seed to open with: whatever is in the URL, otherwise today's run.
 *
 * Defaulting to the daily seed rather than a random one matters — it means a first-time
 * player lands directly on the course everyone else is racing.
 *
 * A link carrying a date that is not today falls back to today's run rather than being
 * refused. A URL is the obvious way around a restriction on the input box, so the rule has to
 * hold here too — but a challenge someone was sent last week should still open the game rather
 * than dead-end on an error, and today's course is the honest thing to offer them instead.
 */
export function initialSeed(now: Date = new Date()): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(SEED_PARAM);
    if (fromUrl) {
      const seed = normaliseSeed(fromUrl);
      if (seed && dailyEntryError(seed, now) === null) return seed;
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
