/**
 * What a run is worth — the one place that decides it.
 *
 * This exists because the same rule was written down in four places and they drifted apart. The
 * authority on whether a score is kept is `recordBest`, which refuses outright on a course whose
 * day has been spent, and says so in its own comment: "checked here so there is exactly one place
 * a score can enter storage, and one place this can be got wrong."
 *
 * The end screen then got it wrong anyway, by computing its own answer — `score > bestAtStart` —
 * and announcing a new personal best over a score storage had just refused. That claim went onto
 * the shared card too, so a continued run could be sent to somebody as a clean one. The continue
 * button had the same shape of fault a week later: the offer was drawn from one condition and the
 * press guarded by another, so the button was there and dead.
 *
 * So there are exactly two rules here now, and they answer different questions:
 *
 *  - `outcomeOf` is about a run that is **over**. It does not decide anything — it reports what
 *    storage did. If the score went in, it was a record; that is not an opinion.
 *  - `scoreDisplay` is about a run still being **ridden**, where nothing has been stored yet and
 *    the HUD has to predict. It is the only rule in the game that is allowed to guess, which is
 *    why it lives next to the one that cannot and is tested against the same cases.
 */

/**
 * How the live score should be drawn.
 *
 *  - `counting`   — normal. Gold, climbing, and it will be kept.
 *  - `unrecorded` — climbing exactly as normal, but greyed, because nothing on screen is going
 *                   to be saved.
 *
 * The score always counts. Grey is the only difference, and it means one thing: this number is
 * not being kept.
 */
export type ScoreDisplay = "counting" | "unrecorded";

/**
 * What became of a finished run.
 *
 *  - `record`     — storage kept it, and it beat what was there.
 *  - `beaten`     — a clean run that did not beat the score already standing.
 *  - `unrecorded` — nothing on this course is being kept, because its day was spent.
 *
 * Three states, and the combinations that used to be expressible are not. A run cannot be both a
 * record and unrecorded, which is exactly the pair the end screen used to be able to claim.
 */
export type RunKind = "record" | "beaten" | "unrecorded";

export interface RunOutcome {
  readonly kind: RunKind;
  /** What this run scored. */
  readonly score: number;
  /** The best that stands on this course now the run is over — this run's, if it took it. */
  readonly best: number;
}

/**
 * Read a finished run's standing off what storage actually did with it.
 *
 * `saved` is `recordBest`'s own answer, not a second opinion about what it should have said.
 * That is the whole point: the two can no longer disagree, because there is only one of them.
 *
 * `spent` separates the two ways a score can fail to be saved — the day being gone, or the run
 * simply not being good enough — which the end screen has to tell apart because it says
 * different things about them.
 */
export function outcomeOf(opts: {
  score: number;
  best: number;
  saved: boolean;
  spent: boolean;
}): RunOutcome {
  const kind: RunKind = opts.saved ? "record" : opts.spent ? "unrecorded" : "beaten";
  return { kind, score: opts.score, best: opts.best };
}

/**
 * How to draw the score of a run still in progress.
 *
 * One rule: grey when the number on screen is not going to be kept. It always counts — stopping
 * it made a real run look broken, and a player deep in a continued descent still wants to know
 * what the riding was worth.
 *
 * A continued run greys the moment it resumes, because from there nothing can be recorded at
 * all. A *fresh* run on the same spent day is a clean attempt from the top and is drawn as one,
 * greying only once it passes the best already stored — that is where it crosses from "could not
 * have been a record anyway" into "would have been, and will not be saved". Below that line
 * there is nothing to warn anybody about.
 */
export function scoreDisplay(opts: {
  score: number;
  bestBefore: number;
  spent: boolean;
  continued: boolean;
}): ScoreDisplay {
  if (opts.continued) return "unrecorded";
  if (opts.spent && opts.score > opts.bestBefore) return "unrecorded";
  return "counting";
}
