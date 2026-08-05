/**
 * All UI, as a thin wrapper over the DOM elements declared in index.html.
 *
 * DOM overlay rather than Babylon's GUI: text stays crisp at any device pixel ratio, layout
 * and safe-area insets come for free, and none of it costs a draw call.
 */

import { formatDistance, formatWhen, readScores } from "../game/leaderboard";
import { dailyEntryError, dailyLabel, isDaily, normaliseSeed, seedLabel } from "../game/seed";

/**
 * Prose built as nodes, not markup.
 *
 * The confirmation names the course code, and a code is whatever the player typed. Assembling
 * the sentence with `innerHTML` would put that string through the HTML parser; these two never
 * can, whatever it contains.
 */
function text(value: string): Text {
  return document.createTextNode(value);
}

function strong(value: string): HTMLElement {
  const el = document.createElement("strong");
  el.textContent = value;
  return el;
}

/**
 * The share mark: one dot passing to two others.
 *
 * Built here rather than dropped into the markup so every place that offers a share draws the
 * same thing — the scores rows, the end screen's best, and the share button itself. It was an
 * "↗" on the rows and a word everywhere else, which read as three unrelated affordances.
 *
 * `currentColor` throughout, so it takes the colour of whatever it sits in and needs no variant
 * for the dark button, the pale row and the tinted best line.
 */
function shareIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "share-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  // The two arms first, so the dots sit on top of where they meet
  for (const [x1, y1, x2, y2] of [
    [8.2, 10.6, 15.8, 6.4],
    [8.2, 13.4, 15.8, 17.6],
  ]) {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2.1");
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
  }
  // The one, then the two it goes to
  for (const [cx, cy] of [[5.5, 12], [18.5, 5], [18.5, 19]]) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "3.1");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);
  }
  return svg;
}

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing UI element #${id}`);
  return el as T;
}

/**
 * How the score should be drawn.
 *
 *  - `counting`   — normal. Gold, climbing, and it will be kept.
 *  - `unrecorded` — climbing exactly as normal, but greyed, because nothing on screen is going
 *                   to be saved: either the run was continued, or the day was already spent and
 *                   this run has passed the best already stored.
 *
 * The score always counts. Grey is the only difference, and it means one thing: this number is
 * not being kept.
 */
export type ScoreDisplay = "counting" | "unrecorded";

export interface HudCallbacks {
  onRideDaily(): void;
  onRideSeed(seed: string): void;
  /** Share your best on a seed, from the scores list. */
  onShareSeed(seed: string): void;
  /** The press before that share: a chance to draw the card before it is needed. */
  onPrepareShareSeed(seed: string): void;
  /**
   * The scores list has opened, listing every seed on it, newest first.
   *
   * This is where the cards get drawn. A card takes over a second to render and a tap takes a
   * tenth of one, so anything that waits for the press has already lost — opening the list is
   * the last moment that buys enough time.
   */
  onScoresShown(seeds: string[]): void;
  onShuffle(): void;
  onRetry(): void;
  /** Pick the run up from where it ended, spending the day's scoring. Daily runs only. */
  onContinue(): void;
  onShare(): void;
  onBackToMenu(): void;
  onPause(): void;
  onResume(): void;
  onRestart(): void;
}

export class Hud {
  private readonly hud = must("hud");
  private readonly speed = must("hud-speed");
  private readonly score = must("hud-score");
  private readonly mult = must("hud-mult");
  private readonly scoreBlock = must("hud-score-block");
  private readonly topSpeed = must("hud-top-speed");
  private readonly best = must("hud-best");
  private readonly bestValue = must("hud-best-value");
  private readonly topSpeedValue = must("hud-top-speed-value");
  private readonly slope = must("hud-slope");
  private readonly slopeText = must("hud-slope-text");
  private readonly slopeFill = must<HTMLElement>("hud-slope-fill");
  private readonly boostBar = must("hud-boost");
  private readonly boostFill = must("hud-boost-fill");
  private readonly dist = must("hud-dist");
  private readonly fps = must("hud-fps");

  private readonly oob = must("oob");
  private readonly oobFill = must("oob-fill");

  private readonly start = must("start");
  private readonly seedInput = must<HTMLInputElement>("seed-input");
  private readonly seedError = must<HTMLParagraphElement>("seed-error");
  private readonly continueBtn = must<HTMLButtonElement>("btn-continue");
  private readonly continueNote = must<HTMLParagraphElement>("continue-note");
  private readonly continueSub = must("continue-sub");
  private readonly confirmContinue = must("confirm-continue");
  private readonly confirmBody = must("confirm-continue-body");
  private readonly dailyLabelEl = must("daily-label");
  private readonly startBest = must("start-best");

  private readonly end = must("end");
  private readonly endTitle = must("end-title");
  private readonly endScore = must("end-score");
  private readonly endBest = must("end-best");
  private readonly endDist = must("end-dist");
  private readonly endTop = must("end-top");
  private readonly endSeed = must("end-seed");
  private readonly endRecord = must("end-record");
  private readonly endRecordText = must("end-record-text");
  private readonly shareBestBtn = must<HTMLButtonElement>("btn-share-best");

  private readonly scores = must("scores");
  private readonly scoresList = must("scores-list");
  private readonly scoresEmpty = must("scores-empty");

  private readonly paused = must("paused");
  private readonly pauseDist = must("pause-dist");
  private readonly pauseScore = must("pause-score");

  private readonly loading = must("loading");
  private readonly broken = must("broken");
  private readonly brokenDetail = must("broken-detail");
  private readonly shareBtn = must<HTMLButtonElement>("btn-share");
  /** What the share button says when it is not flashing a confirmation. */
  private shareLabel = "Copy challenge link";

  /** Kept because the leaderboard rows are built later and each one starts a run. */
  private readonly callbacks: HudCallbacks;

  /**
   * Whether the day on the course now showing its end screen has already been spent.
   *
   * This is exactly the flag the confirmation turns on: the first continue on a code is the one
   * that costs the day, and every one after it costs nothing, so `spent` is both "has this been
   * warned about" and "is there anything left to warn about". It comes from storage, keyed by
   * seed, which is what makes the question come back on the next code rather than never again.
   */
  private endSpent = false;

  /** The course the end screen is showing, so its best can be shared from here. */
  private endSeedValue = "";

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    must<HTMLButtonElement>("btn-daily").addEventListener("click", () => callbacks.onRideDaily());
    must<HTMLButtonElement>("btn-ride").addEventListener("click", () => this.rideTyped());
    must<HTMLButtonElement>("btn-shuffle").addEventListener("click", () => callbacks.onShuffle());

    // Opening and closing the leaderboard is the panel's own business — it reads storage and
    // changes nothing. Only its rows reach into the game, to ride the seed they name.
    must<HTMLButtonElement>("btn-scores").addEventListener("click", () => this.showScores());
    must<HTMLButtonElement>("btn-scores-back").addEventListener("click", () => this.hideScores());

    must<HTMLButtonElement>("btn-reload").addEventListener("click", () => location.reload());
    must<HTMLButtonElement>("btn-retry").addEventListener("click", () => callbacks.onRetry());
    // The first continue on a code is asked about; the rest go straight through. Nothing is
    // remembered here beyond the end screen currently up — `endSpent` is refreshed from storage
    // by every `showEnd`, so a different code asks again.
    this.continueBtn.addEventListener("click", () => {
      if (this.endSpent) callbacks.onContinue();
      else this.confirmContinue.hidden = false;
    });
    must<HTMLButtonElement>("btn-cancel-continue").addEventListener("click", () => {
      this.confirmContinue.hidden = true;
    });
    must<HTMLButtonElement>("btn-confirm-continue").addEventListener("click", () => {
      this.confirmContinue.hidden = true;
      callbacks.onContinue();
    });
    this.shareBtn.addEventListener("click", () => callbacks.onShare());

    // Shares the score that *stands* on this course, not the run just finished — which is the
    // whole reason it is offered here. Same two-step as the scores rows: the press only moves
    // this seed to the front of the drawing queue, because a card takes longer to draw than a
    // tap takes to happen. What buys the time is `showEnd`, which asks for it up front.
    this.shareBestBtn.replaceChildren(shareIcon());
    this.shareBestBtn.addEventListener("pointerdown", () => {
      if (this.endSeedValue) callbacks.onPrepareShareSeed(this.endSeedValue);
    });
    this.shareBestBtn.addEventListener("click", () => {
      if (this.endSeedValue) callbacks.onShareSeed(this.endSeedValue);
    });
    must<HTMLButtonElement>("btn-menu").addEventListener("click", () => callbacks.onBackToMenu());

    must<HTMLButtonElement>("btn-pause").addEventListener("click", () => callbacks.onPause());
    must<HTMLButtonElement>("btn-resume").addEventListener("click", () => callbacks.onResume());
    must<HTMLButtonElement>("btn-restart").addEventListener("click", () => callbacks.onRestart());
    must<HTMLButtonElement>("btn-quit").addEventListener("click", () => callbacks.onBackToMenu());

    // Enter in the seed box starts the run, and blurs so the mobile keyboard gets out of the way
    this.seedInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.seedInput.blur();
        this.rideTyped();
      }
    });

    // Clear a refusal as soon as they start changing what they typed. Leaving it up while the
    // box says something different makes the message look like it is about the new text.
    this.seedInput.addEventListener("input", () => this.showSeedError(null));

    this.dailyLabelEl.textContent = dailyLabel();

    // Build stamp comes from git at build time, so it is always accurate for whatever is
    // actually deployed — nothing to remember to bump. Stamped into every [data-version]
    // slot, so the start and end screens stay in step without duplicating the wiring.
    for (const el of document.querySelectorAll("[data-version]")) {
      el.textContent = __APP_VERSION__;
    }
  }

  hideLoading(): void {
    this.loading.hidden = true;
  }

  /**
   * The game has stopped and is not coming back.
   *
   * Everything else is hidden, because a dead HUD over a frozen mountain reads as the game
   * still running and the player still riding. The message says the score was kept, since
   * that is the first thing anyone would want to know.
   */
  showBroken(err: unknown): void {
    const panels = [this.hud, this.oob, this.start, this.end, this.paused, this.scores];
    for (const panel of [...panels, this.confirmContinue]) {
      panel.hidden = true;
    }
    this.broken.hidden = false;
    // Enough to identify the fault in a screenshot someone sends, and no more — a stack trace
    // on a phone is unreadable and looks like the game has fallen apart completely.
    const message = err instanceof Error ? err.message : String(err);
    this.brokenDetail.textContent = `${__APP_VERSION__} · ${message}`.slice(0, 120);
  }

  showStart(seed: string, best: number): void {
    this.seedInput.value = seed;
    this.startBest.textContent = best > 0 ? `Your best on this run: ${best.toLocaleString()}` : "";
    this.start.hidden = false;
    this.end.hidden = true;
    this.confirmContinue.hidden = true;
    this.paused.hidden = true;
    this.scores.hidden = true;
    this.hud.hidden = true;
    this.oob.hidden = true;
  }

  /**
   * The local leaderboard, built fresh each time it is opened.
   *
   * Rows are assembled as nodes rather than as markup: a seed is whatever the player typed,
   * so it must never be able to become HTML on its way onto the screen.
   *
   * Each row is a button that rides that seed. The list is the only place a seed you rode
   * weeks ago still exists — including past dailies, which are otherwise unreachable once the
   * date has moved on — so being able to go straight back to one is the point of keeping it.
   */
  private showScores(): void {
    const records = readScores();
    const now = Date.now();

    const cell = (className: string, text: string): HTMLElement => {
      const el = document.createElement("span");
      el.className = className;
      el.textContent = text;
      return el;
    };

    this.scoresList.replaceChildren(
      ...records.map((r) => {
        // A custom seed is shown exactly as it was typed, so it can be read back, retyped or
        // shared. Only the daily seeds are relabelled — they are machine-shaped dates — and
        // they say so, otherwise a date in the seed column reads like a seed somebody chose.
        const label = seedLabel(r.seed);
        const when = formatWhen(r.at, now);

        const ride = document.createElement("button");
        ride.type = "button";
        ride.className = "score-row";
        const far = formatDistance(r.distance);
        ride.setAttribute(
          "aria-label",
          `Ride ${isDaily(r.seed) ? "the daily run for" : "slope code"} ${label}, ` +
            `your best ${r.score} over ${far}`,
        );
        ride.append(
          cell("score-seed", label),
          cell("score-value", r.score.toLocaleString()),
          cell("score-when", isDaily(r.seed) ? `Daily · ${when}` : when),
          cell("score-dist", far),
          cell("score-go", "›"),
        );
        ride.addEventListener("click", () => this.callbacks.onRideSeed(r.seed));

        // A sibling of the ride button rather than a child of it: a button inside a button is
        // invalid, and browsers resolve it by making the inner one unclickable.
        const share = document.createElement("button");
        share.type = "button";
        share.className = "score-share";
        share.replaceChildren(shareIcon());
        share.setAttribute("aria-label", `Share your best on ${label}`);
        share.dataset.shareSeed = r.seed;
        // The press only ever *reorders* the queue — it moves this seed to the front so a
        // list of thirty does not draw twenty-nine other cards before the one being asked for.
        // It is not what buys the time: a press is a tenth of a second and a card is over one,
        // so relying on this gap shipped a share sheet with no picture in it. See
        // `onScoresShown`, which is what actually gets the card drawn in time.
        share.addEventListener("pointerdown", () => this.callbacks.onPrepareShareSeed(r.seed));
        share.addEventListener("click", () => this.callbacks.onShareSeed(r.seed));

        const row = document.createElement("li");
        row.className = "score-item";
        row.append(ride, share);
        return row;
      }),
    );

    // Start drawing the cards now. Finding a row and tapping it takes a person a second or
    // two, which is the only window in this flow long enough to render one in.
    this.callbacks.onScoresShown(records.map((r) => r.seed));

    this.scoresEmpty.hidden = records.length > 0;
    // Shown instead of the menu rather than over it: two stacked dimmed backdrops read as a
    // smear, and there is nothing on the menu worth seeing through this.
    this.start.hidden = true;
    this.scores.hidden = false;
  }

  private hideScores(): void {
    this.scores.hidden = true;
    this.start.hidden = false;
  }

  showPlaying(): void {
    this.start.hidden = true;
    this.end.hidden = true;
    this.confirmContinue.hidden = true;
    this.paused.hidden = true;
    this.scores.hidden = true;
    this.hud.hidden = false;
  }

  showPaused(distance: number, score: number): void {
    this.pauseDist.textContent = `${Math.floor(distance)}m`;
    this.pauseScore.textContent = score.toLocaleString();
    this.paused.hidden = false;
    this.oob.hidden = true; // the off-course timer is frozen too; its warning would be a lie
  }

  hidePaused(): void {
    this.paused.hidden = true;
  }

  /** Called every frame while riding. Kept to plain text writes — no layout thrash. */
  /**
   * `multiplier` and `boost` come from the score rather than being recomputed here.
   *
   * The HUD used to derive the multiplier from speed on its own, which was fine while speed
   * was the only thing feeding it. A ramp bonus is not a function of speed, so a readout that
   * works it out from speed would show the wrong number at the one moment anybody is looking.
   */
  /**
   * The live readouts, once a frame.
   *
   * An object rather than nine positional arguments. It reached seven and the next three were
   * all numbers, at which point a transposed pair is a silent bug that reads perfectly well.
   */
  updateHud(v: {
    speedMs: number;
    /** The fastest this run has been, m/s. Shown under the live speed. */
    topSpeedMs: number;
    distance: number;
    /** Fall-line gradient here, as a ratio: 0.4 is 22°, 1.0 is 45°. */
    gradient: number;
    score: number;
    /** The score to beat on this course, or 0 if there is not one yet. */
    best: number;
    fps: number;
    multiplier: number;
    boost: number;
    display?: ScoreDisplay;
  }): void {
    const display = v.display ?? "counting";
    this.fps.textContent = String(Math.round(v.fps));
    this.speed.textContent = String(Math.round(v.speedMs * 3.6));
    this.dist.textContent = String(Math.floor(v.distance));
    this.score.textContent = v.score.toLocaleString();

    // Grey means one thing: this number is not being kept. A gold, climbing score is the
    // game's loudest claim that something is being earned, so it stops making that claim when
    // nothing is being saved — while still counting, because the riding is real and a player
    // deep in a continued run wants to know what it was worth.
    //
    // Distance and speed keep their normal colours throughout; they were never in question.
    this.scoreBlock.classList.toggle("is-unrecorded", display !== "counting");

    // The run's fastest, under the live speed. Hidden until it means something: for the first
    // seconds of a run the top speed *is* the current speed, and two identical numbers stacked
    // on top of each other read as a rendering fault.
    const top = Math.round(v.topSpeedMs * 3.6);
    const showTop = top > Math.round(v.speedMs * 3.6);
    this.topSpeed.hidden = !showTop;
    if (showTop) this.topSpeedValue.textContent = String(top);

    // The target. Hidden when there is not one — telling a first-time player their best is
    // zero is worse than saying nothing, and a run already past it has nothing left to chase.
    const showBest = v.best > 0 && v.score < v.best;
    this.best.hidden = !showBest;
    if (showBest) this.bestValue.textContent = v.best.toLocaleString();

    // How steep the ground is here, drawn as a wedge at that angle. The height is the gradient
    // itself, capped at the 1.0 the mountain builds to — so the picture is the hill, shallow at
    // the top and steep by the bottom, and it reads without the number beside it.
    const degrees = Math.round((Math.atan(v.gradient) * 180) / Math.PI);
    this.slope.hidden = false;
    this.slopeText.textContent = `${degrees}°`;
    this.slopeFill.style.transform = `scaleY(${Math.min(1, Math.max(0.05, v.gradient)).toFixed(3)})`;

    if (v.multiplier > 1.02) {
      this.mult.hidden = false;
      this.mult.textContent = `×${v.multiplier.toFixed(2)}`;
    } else {
      this.mult.hidden = true;
    }

    // The bar is the ramp bonus draining, so the player can see what they bought and how long
    // it lasts. Scaled rather than resized, which the compositor can do without a reflow.
    this.boostBar.hidden = v.boost <= 0;
    this.mult.classList.toggle("is-boosted", v.boost > 0);
    if (v.boost > 0) this.boostFill.style.transform = `scaleX(${v.boost})`;
  }

  /** `remaining` is 1 when the player has just left the course, 0 when the run ends. */
  setOutOfBounds(active: boolean, remaining: number): void {
    this.oob.hidden = !active;
    if (active) this.oobFill.style.transform = `scaleX(${Math.max(0, remaining)})`;
  }

  showEnd(opts: {
    reason: "crash" | "outOfBounds";
    score: number;
    distance: number;
    topSpeed: number;
    seed: string;
    best: number;
    isRecord: boolean;
    /** Offer to pick the run back up. Daily runs whose day is still worth something. */
    canContinue: boolean;
    /** The day has already been spent on this course, so nothing more will be recorded. */
    spent: boolean;
  }): void {
    this.hud.hidden = true;
    this.oob.hidden = true;
    this.paused.hidden = true;
    this.end.hidden = false;

    this.endTitle.textContent = opts.reason === "crash" ? "WIPEOUT" : "OFF COURSE";
    this.endScore.textContent = opts.score.toLocaleString();
    // Gold means kept. A spent day keeps nothing — not the continued run, and not a fresh one
    // from the top either — so the total wears the same grey it wore in the HUD on the way down.
    this.endScore.classList.toggle("is-unrecorded", opts.spent);
    // A spent day says so instead of quoting a best this run cannot have taken. Claiming a
    // record over a score that was never saved is worse than saying nothing at all, and that
    // claim also went onto the shared card — see the strap in `endRun`.
    this.endBest.textContent = opts.spent
      ? "Continued run — doesn't count towards your best"
      : opts.isRecord
        ? "New personal best!"
        : "";

    // Sharing is for a score worth sending. A run that beat nothing has the button taken away
    // and the standing best offered in its place — the same score the scores list would send,
    // shared the same way — so there is still something to pass on without dressing up a run
    // that did not earn it. A record shares itself, through the button below.
    // Nothing to say leaves nothing behind: an empty line still holds a row's height, and on a
    // run that beat nothing that was a blank gap under the score.
    this.endBest.hidden = this.endBest.textContent === "";

    this.endSeedValue = opts.seed;
    const canShareBest = !opts.isRecord && opts.best > 0;
    this.endRecord.hidden = !canShareBest;
    this.endRecordText.textContent = canShareBest
      ? `Your best: ${opts.best.toLocaleString()}`
      : "";
    this.shareBestBtn.setAttribute(
      "aria-label",
      `Share your best on ${seedLabel(opts.seed)}`,
    );
    this.shareBtn.hidden = !opts.isRecord;

    this.endDist.textContent = `${Math.floor(opts.distance)}m`;
    this.endTop.textContent = `${Math.round(opts.topSpeed * 3.6)}km/h`;
    this.endSeed.textContent = isDaily(opts.seed) ? "Today" : opts.seed;

    // Three states, and the middle one is the one that matters: the offer has to say what it
    // costs *before* it is taken, not after. Once spent, the button goes and the reason stays,
    // so a score that is not being saved never looks like one that is.
    this.continueSub.textContent = opts.spent
      ? "carry on down the mountain"
      : "today's score stops counting";
    this.continueBtn.hidden = !opts.canContinue;
    if (!opts.canContinue) {
      this.continueNote.hidden = true;
      this.continueNote.textContent = "";
    } else if (opts.spent) {
      // The price has already been paid, so the offer stops being a warning and becomes an
      // invitation. Carrying on saying "this will cost you the day" after the day is gone
      // reads as a threat the game cannot carry out.
      this.continueNote.hidden = false;
      this.continueNote.textContent =
        "Carry on as long as you like — today's runs no longer count towards your best.";
    } else {
      this.continueNote.hidden = false;
      this.continueNote.textContent =
        "Keep this run going from where it ended. Use it and today's runs stop counting " +
        "towards your best — for the rest of the day.";
    }

    // What the confirmation will ask, prepared here so the press itself only has to un-hide it.
    // The code is named because the cost is scoped to it: it is this course's day being spent,
    // not the game's, and the next code will still be worth riding for a score.
    this.endSpent = opts.spent;
    this.confirmContinue.hidden = true;
    this.confirmBody.replaceChildren(
      text("Continuing picks the run up from where it ended — but it "),
      strong("spends your scoring on " + seedLabel(opts.seed)),
      text(". Nothing you ride on this code counts towards your best after that, "),
      text("including fresh runs from the top."),
    );
  }

  setSeedInput(seed: string): void {
    this.seedInput.value = seed;
  }

  /**
   * Name the button after what pressing it will actually do.
   *
   * "Share result" where a share sheet exists, which on a phone is the whole point — the card
   * goes to WhatsApp and the link goes with it. On a desktop browser with no sheet the honest
   * label is still the old one, because copying a link is all that will happen.
   */
  setShareLabel(canShare: boolean): void {
    this.shareLabel = canShare ? "Share result" : "Copy challenge link";
    this.shareBtn.textContent = this.shareLabel;
  }

  /**
   * The same confirmation on a scores row, where there is no room for a word.
   *
   * A tick and a colour change, in place. The alternative — a toast — would cover the list the
   * player is still reading, for a message that only means "that worked".
   */
  flashScoreShare(seed: string): void {
    // The end screen offers the same share as the row does, so it gets the same confirmation.
    const chip =
      !this.end.hidden && !this.endRecord.hidden && this.endSeedValue === seed
        ? this.shareBestBtn
        : null;
    const button =
      chip ??
      [...this.scoresList.querySelectorAll<HTMLButtonElement>("[data-share-seed]")].find(
        (el) => el.dataset.shareSeed === seed,
      );
    if (!button) return;
    button.textContent = "✓";
    button.classList.add("is-done");
    window.setTimeout(() => {
      button.replaceChildren(shareIcon());
      button.classList.remove("is-done");
    }, 1600);
  }

  /** Momentary confirmation on the share button — cheaper than a toast, and clearer. */
  /**
   * Ride whatever is in the box, unless it is a date that is not today.
   *
   * Checked here rather than in the game, because the answer is a message on this panel: the
   * run simply does not start. The daily code is the competition, and it only is one while
   * nobody can practise tomorrow's course or re-attempt a day that has already been scored.
   */
  private rideTyped(): void {
    const typed = normaliseSeed(this.seedInput.value);
    const refusal = dailyEntryError(typed);
    this.showSeedError(refusal);
    if (refusal === null) this.callbacks.onRideSeed(this.seedInput.value);
  }

  private showSeedError(message: string | null): void {
    this.seedError.textContent = message ?? "";
    this.seedError.hidden = message === null;
  }

  flashShare(message: string): void {
    this.shareBtn.textContent = message;
    window.setTimeout(() => {
      this.shareBtn.textContent = this.shareLabel;
    }, 1600);
  }
}
