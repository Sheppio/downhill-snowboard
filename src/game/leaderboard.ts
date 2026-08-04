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
  /**
   * The run's top speed, in metres per second.
   *
   * Kept only so a score shared from the list can show the same card as one shared from the
   * end screen. Nothing in the game reads it otherwise — the rows do not show it, and it has
   * no bearing on the score. Absent on bests set before it was kept, which show a dash.
   */
  topSpeed?: number;
  /** Which mountain it was set on. See COURSE_GENERATION. */
  gen: number;
}

/**
 * Which version of the course a score belongs to.
 *
 * Bumped whenever a change makes scores incomparable with the ones before it. Scores from an
 * older generation are deleted rather than left sitting at the top of a list nobody can reach
 * any more: a 9,000 set on the mountain as it was before it kept getting harder past 1300m is
 * not the same achievement as a 9,000 set now, and leaving the two side by side makes the
 * list meaningless.
 *
 * A generation rather than a cutoff date, which is what this started as. A date is only as
 * good as the clock on the phone — a device running a few days slow would stamp every *new*
 * score before the cutoff and silently throw all of them away. It also cannot tell a score
 * set on an old build that had not been reloaded yet from one set on the new course, and
 * those are exactly the scores this is meant to clear. Generation 1 is everything written
 * before this existed, which is precisely the set to drop.
 *
 *   1  everything before the stamp existed
 *   2  the mountain started escalating past 1300m, out to 5km
 *   3  the rider stopped colliding as a 0.6m circle and became the shape of a board
 *   4  speed ramps appeared on the racing line
 *   5  those ramps grew from 3x1m to 4x2m, so far more runs collect them
 *   6  the speed bonus stopped capping below normal riding, and ramps pay a bonus of their own
 *   7  the fall line started steepening with distance, toward 45° — a faster mountain, so a
 *      score on it is worth more ground than the same score was before
 */
export const COURSE_GENERATION = 7;

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
function parse(raw: string): { records: ScoreRecord[]; dropped: boolean } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { records: [], dropped: false };
  }
  if (!Array.isArray(data)) return { records: [], dropped: false };

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
    // Set on a different mountain, so not comparable with anything here. Anything written
    // before generations existed has no stamp at all, and is generation 1 by definition.
    if (Number(item.gen ?? 1) !== COURSE_GENERATION) continue;
    seen.add(item.seed);

    const record: ScoreRecord = { seed: item.seed, score, at, gen: COURSE_GENERATION };
    // Unlike the time, a missing distance does not disqualify a record: the score and when it
    // was set are what the row is *for*, and both are still there.
    const distance = Math.floor(Number(item.distance));
    if (Number.isFinite(distance) && distance > 0) record.distance = distance;
    const topSpeed = Number(item.topSpeed);
    if (Number.isFinite(topSpeed) && topSpeed > 0) record.topSpeed = topSpeed;
    out.push(record);
  }
  return { records: out, dropped: out.length !== data.length };
}

function load(): ScoreRecord[] {
  const s = store();
  if (!s) return [];

  try {
    const raw = s.getItem(STORE_KEY);
    if (raw === null) return [];

    const { records, dropped } = parse(raw);
    const sorted = sortRecords(records);
    // Written back rather than merely hidden, so a deleted score is actually gone from the
    // device instead of lingering until the next time something happens to be saved.
    if (dropped) save(sorted);
    return sorted;
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
  topSpeed: number,
  now: number = Date.now(),
): boolean {
  const value = Math.floor(score);
  if (value <= 0) return false;
  // The day was spent the moment the run was continued. Checked here rather than at every call
  // site so there is exactly one place a score can enter storage, and one place this can be
  // got wrong.
  if (hasContinued(seed)) return false;

  const records = load();
  const existing = records.find((r) => r.seed === seed);
  if (existing && value <= existing.score) return false;

  const record: ScoreRecord = { seed, score: value, at: now, gen: COURSE_GENERATION };
  const metres = Math.floor(distance);
  if (Number.isFinite(metres) && metres > 0) record.distance = metres;
  if (Number.isFinite(topSpeed) && topSpeed > 0) record.topSpeed = topSpeed;

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
 * How far a run got, wherever it is being shown.
 *
 * A best set before distances were kept shows a dash. There is no way to recover the number —
 * the run it belonged to is long over — and a zero would read as a run that went nowhere.
 *
 * Floored here rather than trusted to arrive whole. Records are stored floored, so for a long
 * time every caller happened to pass an integer and this did not need to care; the share card
 * then handed it a live `controller.distance` and put "4,139.7m" on a picture people send each
 * other. Metres, to the metre, is what the HUD and the end screen have always shown.
 */
export function formatDistance(distance: number | undefined): string {
  return distance === undefined ? "—" : `${Math.floor(distance).toLocaleString()}m`;
}

// --- The daily continue --------------------------------------------------------------------
//
// A daily run ends at the first mistake, which is what makes it a competition — but it also
// means almost nobody ever sees the deep mountain, where the fall line has tipped over and the
// speed is the whole point of the thing. Most attempts are over inside a kilometre.
//
// So a daily run can be continued from where it ended, once. The price is that the day stops
// counting: from the moment it is used, nothing on that day's course is recorded. That keeps
// the leaderboard honest — a continued run is not comparable with one that took the mountain
// in a single go — while letting anyone who wants to see 5km go and see it.
//
// One flag per seed rather than one for the day, because a player can hold a daily code from a
// link while the date has moved on, and the flag has to belong to the course that was ridden.

const CONTINUE_KEY = "downhill.continued.v1";

/** Seeds whose day has been spent, newest last. Bounded — this is a small, dull list. */
const MAX_CONTINUED = 60;

function readContinued(): string[] {
  const s = store();
  if (!s) return [];
  try {
    const raw = s.getItem(CONTINUE_KEY);
    if (raw === null) return [];
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Has this course already been continued, so its scores no longer count? */
export function hasContinued(seed: string): boolean {
  return readContinued().includes(seed);
}

/**
 * Spend the continue on a course. Idempotent — continuing twice is still one spent day.
 *
 * Deliberately irreversible for as long as the record lasts. The whole value of the guarantee
 * is that a score on a daily seed means the same thing for everybody, and it would mean nothing
 * if this could be quietly undone after a good run.
 */
export function markContinued(seed: string): void {
  const s = store();
  if (!s) return; // no storage: the flag cannot be kept, so the run simply is not recorded
  const seeds = readContinued().filter((v) => v !== seed);
  seeds.push(seed);
  try {
    s.setItem(CONTINUE_KEY, JSON.stringify(seeds.slice(-MAX_CONTINUED)));
  } catch {
    // Private browsing or a full quota. Nothing else to do; see the guard in `recordBest`.
  }
}
