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
  /** When that best was set, epoch ms. Always a real time — see `parse`. */
  at: number;
  /**
   * How far that run got, in metres. Absent on bests set before this was kept — the run is
   * long gone, so there is nothing to fill it in from and the row simply says so.
   */
  distance?: number;
}

const STORE_KEY = "downhill.scores.v1";

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
    // A record with no usable time is dropped rather than shown undated. That covers the
    // bests the game kept before this format, which were a bare number per seed with nowhere
    // to put a time: there is no honest answer for when they were set, and a row that cannot
    // say when is not worth a line in a list whose whole ordering is when.
    const at = Number(item.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    seen.add(item.seed);

    const record: ScoreRecord = { seed: item.seed, score, at };
    // Unlike the time, a missing distance does not disqualify a record: the score and when it
    // was set are what the row is *for*, and both are still there.
    const distance = Math.floor(Number(item.distance));
    if (Number.isFinite(distance) && distance > 0) record.distance = distance;
    out.push(record);
  }
  return out;
}

function load(): ScoreRecord[] {
  const s = store();
  if (!s) return [];

  try {
    const raw = s.getItem(STORE_KEY);
    return raw === null ? [] : sortRecords(parse(raw));
  } catch {
    return [];
  }
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
 *
 * The distance belongs to the run that set the record, not to the seed, so it is replaced
 * wholesale along with the score rather than tracked as a best of its own. Score already
 * rises with distance — they would only come apart on a run that went further but slower.
 */
export function recordBest(
  seed: string,
  score: number,
  distance: number,
  now: number = Date.now(),
): boolean {
  const value = Math.floor(score);
  if (value <= 0) return false;

  const records = load();
  const existing = records.find((r) => r.seed === seed);
  if (existing && value <= existing.score) return false;

  const record: ScoreRecord = { seed, score: value, at: now };
  const metres = Math.floor(distance);
  if (Number.isFinite(metres) && metres > 0) record.distance = metres;

  save([...records.filter((r) => r.seed !== seed), record]);
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

/**
 * How far a recorded run got, for the leaderboard rows.
 *
 * A best set before distances were kept shows a dash. There is no way to recover the number —
 * the run it belonged to is long over — and a zero would read as a run that went nowhere.
 */
export function formatDistance(distance: number | undefined): string {
  return distance === undefined ? "—" : `${distance.toLocaleString()}m`;
}
