/**
 * All UI, as a thin wrapper over the DOM elements declared in index.html.
 *
 * DOM overlay rather than Babylon's GUI: text stays crisp at any device pixel ratio, layout
 * and safe-area insets come for free, and none of it costs a draw call.
 */

import { speedMultiplier } from "../game/score";
import { dailyLabel, isDaily } from "../game/seed";

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
}

export class Hud {
  private readonly hud = must("hud");
  private readonly speed = must("hud-speed");
  private readonly score = must("hud-score");
  private readonly mult = must("hud-mult");
  private readonly dist = must("hud-dist");

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

  private readonly loading = must("loading");
  private readonly shareBtn = must<HTMLButtonElement>("btn-share");

  constructor(callbacks: HudCallbacks) {
    must<HTMLButtonElement>("btn-daily").addEventListener("click", () => callbacks.onRideDaily());
    must<HTMLButtonElement>("btn-ride").addEventListener("click", () =>
      callbacks.onRideSeed(this.seedInput.value),
    );
    must<HTMLButtonElement>("btn-shuffle").addEventListener("click", () => callbacks.onShuffle());
    must<HTMLButtonElement>("btn-retry").addEventListener("click", () => callbacks.onRetry());
    this.shareBtn.addEventListener("click", () => callbacks.onShare());
    must<HTMLButtonElement>("btn-menu").addEventListener("click", () => callbacks.onBackToMenu());

    // Enter in the seed box starts the run, and blurs so the mobile keyboard gets out of the way
    this.seedInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.seedInput.blur();
        callbacks.onRideSeed(this.seedInput.value);
      }
    });

    this.dailyLabelEl.textContent = dailyLabel();

    // Build stamp comes from git at build time, so it is always accurate for whatever is
    // actually deployed — nothing to remember to bump.
    must("version").textContent = __APP_VERSION__;
  }

  hideLoading(): void {
    this.loading.hidden = true;
  }

  showStart(seed: string, best: number): void {
    this.seedInput.value = seed;
    this.startBest.textContent = best > 0 ? `Your best on this seed: ${best.toLocaleString()}` : "";
    this.start.hidden = false;
    this.end.hidden = true;
    this.hud.hidden = true;
    this.oob.hidden = true;
  }

  showPlaying(): void {
    this.start.hidden = true;
    this.end.hidden = true;
    this.hud.hidden = false;
  }

  /** Called every frame while riding. Kept to plain text writes — no layout thrash. */
  updateHud(speedMs: number, distance: number, score: number): void {
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

  /** Momentary confirmation on the share button — cheaper than a toast, and clearer. */
  flashShare(message: string): void {
    const original = "Copy challenge link";
    this.shareBtn.textContent = message;
    window.setTimeout(() => {
      this.shareBtn.textContent = original;
    }, 1600);
  }
}
