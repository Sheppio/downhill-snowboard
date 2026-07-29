/**
 * The local leaderboard: your best on every seed you have ridden, and when you set it.
 *
 * One row per seed, because the seed is the unit of competition — a best on today's mountain
 * says nothing about a best on some other one, and averaging across them would be meaningless.
 *
 * Rows are ordered by *when the best was set*, newest first, rather than by score. That makes
 * the list a record of what you have been doing lately: beating your best on a seed lifts it
 * back to the top, and a seed you have not improved on in weeks sinks whatever it is worth.
 * Sorting by score instead would freeze the same handful of lucky runs at the top forever.
 *
 * Everything here is wrapped in try/catch. localStorage is not merely absent in some browsers,
 * it *throws* — Safari in private mode throws on write, and a blocked-cookies setting throws
 * on the property access itself. Losing a high score is never worth crashing a game over.
 */

export interface ScoreRecord {
  /** The seed the run was on. */
  seed: string;
  /** The best score recorded on that seed. */
  score: number;
  /** When that best was set, epoch ms. 0 means unknown — see the migration below. */
  at: number;
}

const STORE_KEY = "downhill.scores.v1";

/** Where bests lived before they carried a timestamp: one key per seed, holding a number. */
const LEGACY_PREFIX = "downhill.best.";

/**
 * Nothing needs a thousand rows, and localStorage is a shared, small budget. Sorted newest
 * first, so the entries dropped when this is reached are the ones longest untouched.
 */
const MAX_RECORDS = 200;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage disabled entirely; the property access itself throws
  }
}

/** Newest first; ties broken by score then seed so the order is total and stable. */
function sortRecords(records: ScoreRecord[]): ScoreRecord[] {
  return records.sort((a, b) => b.at - a.at || b.score - a.score || a.seed.localeCompare(b.seed));
}

/**
 * Rebuild the list from whatever is in storage, discarding anything that does not look like a
 * record. The contents are user-writable and survive across versions of the game, so this
 * treats them as untrusted input rather than as something it wrote itself.
 */
function parse(raw: string): ScoreRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out: ScoreRecord[] = [];
  const seen = new Set<string>();
  for (const item of data as Partial<ScoreRecord>[]) {
    if (typeof item?.seed !== "string" || item.seed === "") continue;
    if (seen.has(item.seed)) continue; // one row per seed, first (newest) wins
    const score = Math.floor(Number(item.score));
    if (!Number.isFinite(score) || score <= 0) continue;
    const at = Number(item.at);
    seen.add(item.seed);
    out.push({ seed: item.seed, score, at: Number.isFinite(at) && at > 0 ? at : 0 });
  }
  return out;
}

/**
 * Carry bests forward from the per-seed keys the game used before timestamps existed.
 *
 * There is no honest answer for when those were set, so they get `at: 0`, sort to the bottom
 * and are dated only as "earlier". Inventing "now" for them would put every old score above
 * every real one and make the ordering a lie on the first run after an upgrade.
 */
function migrateLegacy(s: Storage): ScoreRecord[] {
  const out: ScoreRecord[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key === null || !key.startsWith(LEGACY_PREFIX)) continue;
      const score = Math.floor(Number(s.getItem(key)));
      if (!Number.isFinite(score) || score <= 0) continue;
      out.push({ seed: key.slice(LEGACY_PREFIX.length), score, at: 0 });
    }
  } catch {
    // Partial migration is still better than none
  }
  return out;
}

function load(): ScoreRecord[] {
  const s = store();
  if (!s) return [];

  let raw: string | null = null;
  try {
    raw = s.getItem(STORE_KEY);
  } catch {
    return [];
  }

  if (raw !== null) return sortRecords(parse(raw));

  // No store yet: either a new player, or one whose bests predate this format.
  const migrated = sortRecords(migrateLegacy(s));
  if (migrated.length > 0) save(migrated);
  return migrated;
}

function save(records: ScoreRecord[]): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(STORE_KEY, JSON.stringify(sortRecords(records).slice(0, MAX_RECORDS)));
  } catch {
    // Private browsing, quota exhausted, or storage disabled — the run still counted
  }
}

/** Every recorded best, newest first. */
export function readScores(): ScoreRecord[] {
  return load();
}

/** The record for one seed, or null if it has never been scored on. */
export function readRecord(seed: string): ScoreRecord | null {
  return load().find((r) => r.seed === seed) ?? null;
}

/** The best score on a seed, or 0. */
export function readBest(seed: string): number {
  return readRecord(seed)?.score ?? 0;
}

/**
 * Record a score if it beats the stored best. Returns true if it was a new record.
 *
 * A run that merely equals the best leaves the timestamp alone: the stamp marks when the
 * score was *achieved*, so repeating it is not a new achievement and must not reshuffle the
 * ordering. `now` is injectable so the ordering can be tested without waiting for a clock.
 */
export function recordBest(seed: string, score: number, now: number = Date.now()): boolean {
  const value = Math.floor(score);
  if (value <= 0) return false;

  const records = load();
  const existing = records.find((r) => r.seed === seed);
  if (existing && value <= existing.score) return false;

  save([...records.filter((r) => r.seed !== seed), { seed, score: value, at: now }]);
  return true;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a best was set, for the leaderboard rows.
 *
 * Relative for the first week, because that is the span over which "when" is what you
 * actually want to know, then an absolute date once counting days stops meaning anything.
 */
export function formatWhen(at: number, now: number = Date.now()): string {
  if (!(at > 0)) return "earlier";

  const ms = now - at;
  if (ms < MINUTE) return "just now"; // also covers a clock that has gone backwards
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d ago`;

  const then = new Date(at);
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
