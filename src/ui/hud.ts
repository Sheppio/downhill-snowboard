/**
 * All UI, as a thin wrapper over the DOM elements declared in index.html.
 *
 * DOM overlay rather than Babylon's GUI: text stays crisp at any device pixel ratio, layout
 * and safe-area insets come for free, and none of it costs a draw call.
 */

import { formatDistance, formatWhen, readScores } from "../game/leaderboard";
import { speedMultiplier } from "../game/score";
import { dailyLabel, isDaily, seedLabel } from "../game/seed";

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing UI element #${id}`);
  return el as T;
}

export interface HudCallbacks {
  onRideDaily(): void;
  onRideSeed(seed: string): void;
  onShuffle(): void;
  onRetry(): void;
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
  private readonly dist = must("hud-dist");
  private readonly fps = must("hud-fps");

  private readonly oob = must("oob");
  private readonly oobFill = must("oob-fill");

  private readonly start = must("start");
  private readonly seedInput = must<HTMLInputElement>("seed-input");
  private readonly dailyLabelEl = must("daily-label");
  private readonly startBest = must("start-best");

  private readonly end = must("end");
  private readonly endTitle = must("end-title");
  private readonly endScore = must("end-score");
  private readonly endBest = must("end-best");
  private readonly endDist = must("end-dist");
  private readonly endTop = must("end-top");
  private readonly endSeed = must("end-seed");

  private readonly scores = must("scores");
  private readonly scoresList = must("scores-list");
  private readonly scoresEmpty = must("scores-empty");

  private readonly paused = must("paused");
  private readonly pauseDist = must("pause-dist");
  private readonly pauseScore = must("pause-score");

  private readonly loading = must("loading");
  private readonly shareBtn = must<HTMLButtonElement>("btn-share");
  /** What the share button says when it is not flashing a confirmation. */
  private shareLabel = "Copy challenge link";

  /** Kept because the leaderboard rows are built later and each one starts a run. */
  private readonly callbacks: HudCallbacks;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    must<HTMLButtonElement>("btn-daily").addEventListener("click", () => callbacks.onRideDaily());
    must<HTMLButtonElement>("btn-ride").addEventListener("click", () =>
      callbacks.onRideSeed(this.seedInput.value),
    );
    must<HTMLButtonElement>("btn-shuffle").addEventListener("click", () => callbacks.onShuffle());

    // Opening and closing the leaderboard is the panel's own business — it reads storage and
    // changes nothing. Only its rows reach into the game, to ride the seed they name.
    must<HTMLButtonElement>("btn-scores").addEventListener("click", () => this.showScores());
    must<HTMLButtonElement>("btn-scores-back").addEventListener("click", () => this.hideScores());

    must<HTMLButtonElement>("btn-retry").addEventListener("click", () => callbacks.onRetry());
    this.shareBtn.addEventListener("click", () => callbacks.onShare());
    must<HTMLButtonElement>("btn-menu").addEventListener("click", () => callbacks.onBackToMenu());

    must<HTMLButtonElement>("btn-pause").addEventListener("click", () => callbacks.onPause());
    must<HTMLButtonElement>("btn-resume").addEventListener("click", () => callbacks.onResume());
    must<HTMLButtonElement>("btn-restart").addEventListener("click", () => callbacks.onRestart());
    must<HTMLButtonElement>("btn-quit").addEventListener("click", () => callbacks.onBackToMenu());

    // Enter in the seed box starts the run, and blurs so the mobile keyboard gets out of the way
    this.seedInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.seedInput.blur();
        callbacks.onRideSeed(this.seedInput.value);
      }
    });

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

  showStart(seed: string, best: number): void {
    this.seedInput.value = seed;
    this.startBest.textContent = best > 0 ? `Your best on this seed: ${best.toLocaleString()}` : "";
    this.start.hidden = false;
    this.end.hidden = true;
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
        ride.setAttribute("aria-label", `Ride ${label}, your best ${r.score} over ${far}`);
        ride.append(
          cell("score-seed", label),
          cell("score-value", r.score.toLocaleString()),
          cell("score-when", isDaily(r.seed) ? `Daily · ${when}` : when),
          cell("score-dist", far),
          cell("score-go", "›"),
        );
        ride.addEventListener("click", () => this.callbacks.onRideSeed(r.seed));

        const row = document.createElement("li");
        row.append(ride);
        return row;
      }),
    );

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
  updateHud(speedMs: number, distance: number, score: number, fps: number): void {
    this.fps.textContent = String(Math.round(fps));
    this.speed.textContent = String(Math.round(speedMs * 3.6));
    this.dist.textContent = String(Math.floor(distance));
    this.score.textContent = score.toLocaleString();

    const mult = speedMultiplier(speedMs);
    if (mult > 1.02) {
      this.mult.hidden = false;
      this.mult.textContent = `×${mult.toFixed(2)}`;
    } else {
      this.mult.hidden = true;
    }
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
  }): void {
    this.hud.hidden = true;
    this.oob.hidden = true;
    this.paused.hidden = true;
    this.end.hidden = false;

    this.endTitle.textContent = opts.reason === "crash" ? "WIPEOUT" : "OFF COURSE";
    this.endScore.textContent = opts.score.toLocaleString();
    this.endBest.textContent = opts.isRecord
      ? "New personal best!"
      : `Best on this seed: ${opts.best.toLocaleString()}`;

    this.endDist.textContent = `${Math.floor(opts.distance)}m`;
    this.endTop.textContent = `${Math.round(opts.topSpeed * 3.6)}km/h`;
    this.endSeed.textContent = isDaily(opts.seed) ? "Today" : opts.seed;
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

  /** Momentary confirmation on the share button — cheaper than a toast, and clearer. */
  flashShare(message: string): void {
    this.shareBtn.textContent = message;
    window.setTimeout(() => {
      this.shareBtn.textContent = this.shareLabel;
    }, 1600);
  }
}
