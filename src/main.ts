/**
 * Entry point: engine setup, the game state machine, and the render loop.
 */

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/thinInstanceMesh"; // side effect: enables thinInstanceSetBuffer

import { hashString } from "./core/rng";
import { clamp01 } from "./core/math";
import { TerrainField, TerrainRenderer } from "./world/terrain";
import { ObstacleField, ObstacleRenderer } from "./world/obstacles";
import { applyRamps, RampRenderer } from "./world/ramps";
import { createBackdrop, setupSky, SnowSpray } from "./world/scenery";
import { SnowTracks } from "./world/tracks";
import { OUT_OF_BOUNDS_FRACTION, gateX, lateralFraction } from "./world/course";
import { RiderController } from "./player/controller";
import { Rider } from "./player/rider";
import { ChaseCamera } from "./player/camera";
import { Wipeout, initPhysics } from "./player/wipeout";
import { SteerInput } from "./input/steer";
import { TouchMarkers } from "./ui/touchmarkers";
import { Score } from "./game/score";
import { hasContinued, markContinued, readBest, readRecord, recordBest } from "./game/leaderboard";
import { initialSeed, isDaily, normaliseSeed, randomSeed, shareUrl, syncUrl, todaysSeed } from "./game/seed";
import { prepareShareCard, shareMessage, shareRun } from "./game/share";
import type { CardResult } from "./game/sharecard";
import { Hud } from "./ui/hud";

/** Seconds off course before the run is ended. */
const OUT_OF_BOUNDS_GRACE = 3;

/** Lowest resolution we will fall back to: half CSS pixels. Blurry, but playable. */
const WORST_SCALE = 2.0;

/** How long the crash tumble plays before the score screen appears. */
const CRASH_DURATION = 2.4;

type GameState = "menu" | "playing" | "paused" | "crashing" | "ended";

class Game {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly hud: Hud;
  private readonly input: SteerInput;
  private readonly markers: TouchMarkers;
  private readonly camera: ChaseCamera;
  private readonly rider: Rider;
  private readonly spray: SnowSpray;
  private readonly score = new Score();

  // Rebuilt per seed
  private field!: TerrainField;
  private terrain!: TerrainRenderer;
  private obstacles!: ObstacleField;
  private obstacleRenderer!: ObstacleRenderer;
  private rampRenderer!: RampRenderer;
  /** Where the rider was last frame, so a ramp pays out per metre rather than per frame. */
  private lastRampZ = 0;
  private seedHash = 0;
  private controller!: RiderController;
  private wipeout!: Wipeout;
  private tracks!: SnowTracks;
  private backdrop!: import("@babylonjs/core/Meshes/mesh").Mesh;

  private state: GameState = "menu";
  private seed = initialSeed();
  /** The best on this seed when the current run started — what a new record has to beat. */
  private bestAtStart = 0;
  private oobTimer = 0;
  private crashTimer = 0;
  private endReason: "crash" | "outOfBounds" = "crash";
  /** The finished run the end screen is showing, and the card drawn from it. */
  private lastResult: CardResult | null = null;
  private shareCard: File | null = null;
  /**
   * Cards for the scores list, by seed. A stored `null` is a seed whose card could not be
   * drawn at all — recorded so it is not attempted again on every press.
   *
   * Drawn ahead of being needed, because they cannot be drawn on demand: `navigator.share`
   * needs the activation the tap carries and awaiting spends it, so whatever the tap sends has
   * to already exist. A card takes ~1.5s to render and a tap lasts a tenth of that, which is
   * why hanging this off the press — as it first did — meant the share sheet opened with no
   * picture in it every time.
   */
  private listCards = new Map<string, File | null>();
  /** Seeds still to draw, in the order they will be drawn. */
  private cardQueue: string[] = [];
  private drawingCard = false;

  // Adaptive resolution
  private fpsSamples: number[] = [];
  private hardwareScale = 1;
  /** Sharpest level we will render at — native device pixels, capped at 2x. */
  private sharpestScale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      // Snow is a huge flat expanse of near-white; without a stencil-free depth buffer and
      // antialiasing the terrain edges shimmer badly in motion.
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    // Babylon's hardware scaling level is a *divisor*: 1 renders at CSS resolution, 0.5 at
    // twice it, 2 at half. So rendering at native device pixels means 1/devicePixelRatio,
    // capped at 2x because a 3x display costs 9x the fill rate for a difference nobody can
    // see at arm's length.
    //
    // This was inverted, as `max(1, dpr / 2)`. On a 2.6x phone that rendered at 0.76x CSS
    // pixels and let the browser upscale — about 29% of native resolution, which is why it
    // looked soft and why the frame rate had so much headroom.
    const dpr = window.devicePixelRatio || 1;
    this.sharpestScale = 1 / Math.min(dpr, 2);
    this.hardwareScale = this.sharpestScale;
    this.engine.setHardwareScalingLevel(this.hardwareScale);

    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = true;

    setupSky(this.scene);

    this.camera = new ChaseCamera(this.scene, canvas);
    this.rider = new Rider(this.scene);
    this.spray = new SnowSpray(this.scene);
    this.input = new SteerInput(canvas);
    // Parented to the UI overlay so it sits above the canvas and inherits its safe areas.
    this.markers = new TouchMarkers(document.getElementById("ui") ?? document.body);

    this.hud = new Hud({
      onRideDaily: () => this.startRun(todaysSeed()),
      onRideSeed: (raw) => this.startRun(normaliseSeed(raw) || randomSeed()),
      onShuffle: () => this.hud.setSeedInput(randomSeed()),
      onRetry: () => this.startRun(this.seed),
      onContinue: () => this.continueRun(),
      // Nothing is awaited before shareRun runs, because `navigator.share` needs the user
      // activation this click carries and awaiting spends it on iOS. The card was drawn when
      // the end screen appeared, precisely so there is nothing left to wait for here.
      onShare: () => {
        const result = this.lastResult;
        if (!result) return;
        void shareRun(result, this.shareCard).then((outcome) => {
          const message = shareMessage(outcome);
          if (message) this.hud.flashShare(message);
        });
      },
      // Opening the list is what starts the cards; the press only jumps the queue. The other
      // way round does not work — see `queueListCards`.
      onScoresShown: (seeds) => this.queueListCards(seeds),
      onPrepareShareSeed: (seed) => this.prepareListCard(seed),
      onShareSeed: (seed) => {
        const result = this.listResult(seed);
        if (!result) return;
        const card = this.listCards.get(seed) ?? null;
        void shareRun(result, card).then((outcome) => {
          if (shareMessage(outcome)) this.hud.flashScoreShare(seed);
        });
      },
      onBackToMenu: () => this.showMenu(),
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onRestart: () => this.startRun(this.seed),
    });

    this.buildWorld(this.seed);

    // Debug handle for the browser smoke tests, so they can inspect the live scene and force
    // states (a crash, for instance) that are impractical to reach by simulated touch alone.
    // Opt-in only: dev builds, or ?debug=1 on a deployed build.
    if (import.meta.env.DEV || new URLSearchParams(location.search).has("debug")) {
      (window as unknown as { __game?: unknown }).__game = this;
    }

    // A phone call or app switch must not quietly burn through a run in the background.
    // This is also the only pause a player gets if they simply put the phone down.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
    });
    // The last chance to keep a run that is about to disappear. `pagehide` rather than
    // `beforeunload`: mobile browsers routinely discard a backgrounded tab without ever
    // firing the latter, and this is exactly the case where a score would be lost.
    window.addEventListener("pagehide", () => this.bankScore());
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" && e.key !== "p" && e.key !== "P") return;
      if (this.state === "playing") this.pause();
      else if (this.state === "paused") this.resume();
    });

    window.addEventListener("resize", () => this.engine.resize());
    // iOS fires orientationchange before the new viewport size is readable
    window.addEventListener("orientationchange", () => {
      window.setTimeout(() => this.engine.resize(), 220);
    });
  }

  async init(): Promise<void> {
    await initPhysics(this.scene);
    // Force shader compilation and the first frame before showing the menu, so pressing
    // "Ride" never lands on a hitch
    this.terrain.prime(0);
    this.scene.render();

    this.hud.hideLoading();
    this.showMenu();

    // Guarded, because an unguarded throw in here is the worst failure the game has: Babylon
    // keeps calling the loop, so it throws again every frame, and the player is left looking
    // at a frozen picture with nothing to tell them what happened or what to do. Banking the
    // run first means a crash costs the picture, not the score.
    this.engine.runRenderLoop(() => {
      try {
        this.frame();
      } catch (err) {
        this.engine.stopRenderLoop();
        console.error("render loop stopped", err);
        // In its own guard: whatever broke the frame may well break this too, and the panel
        // is what the player is waiting for.
        try {
          this.bankScore();
        } catch {
          /* the score is lost, which is the lesser of the two failures here */
        }
        this.hud.showBroken(err);
      }
    });
  }

  /** Tear down and rebuild everything that depends on the seed. */
  private buildWorld(seed: string): void {
    this.terrain?.dispose();
    this.obstacleRenderer?.dispose();
    this.rampRenderer?.dispose();
    this.wipeout?.stop();
    this.backdrop?.dispose();

    const numeric = hashString(seed);
    this.seedHash = numeric;
    this.field = new TerrainField(numeric);
    this.terrain = new TerrainRenderer(this.scene, this.field);
    this.obstacles = new ObstacleField(numeric, this.field.params, this.field);
    this.obstacleRenderer = new ObstacleRenderer(this.scene, this.obstacles);
    this.rampRenderer = new RampRenderer(this.scene, this.field.params, numeric, this.field);
    this.controller = new RiderController(this.field);
    this.wipeout = new Wipeout(this.scene, this.field);
    // Rebuilt per seed: the trail is baked in world space against a specific height field
    this.tracks?.dispose();
    this.tracks = new SnowTracks(this.scene, this.field);
    this.backdrop = createBackdrop(this.scene, numeric);

    this.terrain.prime(0);
    this.obstacleRenderer.update(0);
    this.rampRenderer.update(0, 0);
    this.camera.reset(this.controller);
    this.rider.sync(this.controller, this.field.heightAt(0, 0), 1 / 60);
  }

  /**
   * Record whatever the run has earned so far.
   *
   * A run used to reach the leaderboard from exactly two places: the crash and the
   * out-of-bounds timer. Every other way of leaving one — pausing and changing seed, pausing
   * and restarting, switching apps and never coming back, closing the tab — threw the score
   * away silently, which is the worst possible outcome for the best run of someone's day.
   *
   * Safe to call as often as you like: `recordBest` only ever replaces a lower score, so
   * banking early can never cost anything, and quitting can never beat riding on.
   */
  private bankScore(): void {
    if (this.state !== "playing" && this.state !== "paused" && this.state !== "crashing") return;
    if (recordBest(this.seed, this.score.value, this.controller.distance, this.controller.topSpeed)) {
      // The card for this seed now shows a score that has been beaten. Dropped rather than
      // redrawn, so the next visit to the list draws it from the record that replaced it.
      this.listCards.delete(this.seed);
    }
  }

  /**
   * A card's worth of detail from a stored best.
   *
   * Less than a finished run has: no top speed, because the leaderboard has never kept one and
   * inventing a plausible number would be a lie on a picture people send each other. The card
   * shows when the score was set in its place, which the row does know.
   */
  private listResult(seed: string): CardResult | null {
    const record = readRecord(seed);
    if (!record) return null;
    return {
      score: record.score,
      distance: record.distance,
      topSpeed: record.topSpeed,
      seed,
      strap: "My best on this run",
      url: shareUrl(seed),
    };
  }

  /**
   * How many scores-list cards to hold at once.
   *
   * Each is a 1080-square PNG, a couple of hundred KB, so the whole list is not worth keeping:
   * the list can hold two hundred rows and nobody shares from the bottom of it. Comfortably
   * more than fits on a screen, which is what decides whether the one being reached for is
   * already drawn.
   */
  private static readonly MAX_LIST_CARDS = 24;

  /**
   * Draw cards for the seeds on the scores list, in order, starting now.
   *
   * Called when the list opens rather than when a row is pressed. That is the whole fix: a
   * person takes a second or two to find the row they want, a card takes about that long to
   * render, and a press takes a tenth of a second. Drawing on the press meant the file was
   * never ready in time and every share from this list went out as text with no picture.
   *
   * One at a time. Rendering thirty cards at once would tie up the main thread on a phone for
   * as long as it takes to do them all, and the first row is the one most likely to be wanted.
   */
  private queueListCards(seeds: string[]): void {
    for (const seed of seeds.slice(0, Game.MAX_LIST_CARDS)) {
      if (!this.listCards.has(seed) && !this.cardQueue.includes(seed)) this.cardQueue.push(seed);
    }
    this.drawNextCard();
  }

  /** Bring one seed to the front of the queue — the press before a share. */
  private prepareListCard(seed: string): void {
    if (this.listCards.has(seed)) return;
    this.cardQueue = [seed, ...this.cardQueue.filter((s) => s !== seed)];
    this.drawNextCard();
  }

  private drawNextCard(): void {
    if (this.drawingCard) return;

    // Skips are resolved here rather than at enqueue time, since a card can arrive, or a seed
    // can lose its record, between being queued and being reached.
    let seed: string | undefined;
    let result: CardResult | null = null;
    while ((seed = this.cardQueue.shift()) !== undefined) {
      if (this.listCards.has(seed)) continue;
      result = this.listResult(seed);
      if (result) break;
    }
    if (seed === undefined || !result) return;

    this.drawingCard = true;
    const drawing = seed;
    void prepareShareCard(result).then((file) => {
      // Oldest out first: the map keeps insertion order, and the oldest entry is the row
      // furthest from the top of a list that is already sorted by how recent it is.
      if (this.listCards.size >= Game.MAX_LIST_CARDS) {
        const oldest = this.listCards.keys().next().value;
        if (oldest !== undefined) this.listCards.delete(oldest);
      }
      this.listCards.set(drawing, file);
      this.drawingCard = false;
      this.drawNextCard();
    });
  }

  private showMenu(): void {
    this.bankScore();
    this.state = "menu";
    this.wipeout.stop();
    this.spray.stop();
    this.rider.setEnabled(true);
    this.hud.showStart(this.seed, readBest(this.seed));
  }

  private startRun(seed: string): void {
    // Restarting from the pause panel abandons a live run, so it banks first
    this.bankScore();
    this.bestAtStart = readBest(seed);

    if (seed !== this.seed) {
      this.seed = seed;
      this.buildWorld(seed);
      syncUrl(seed);
    } else {
      this.controller.reset();
      this.wipeout.stop();
      this.terrain.prime(0);
      this.obstacleRenderer.update(0);
      this.rampRenderer.update(0, 0);
      this.camera.reset(this.controller);
    }

    // Back to the top with the rider, or the first frame of a new run claims every ramp
    // between where the last one ended and the start line.
    this.lastRampZ = this.controller.z;
    this.tracks.clear();
    this.score.reset();
    this.input.reset();
    this.oobTimer = 0;
    this.crashTimer = 0;
    this.rider.setEnabled(true);
    this.state = "playing";
    this.hud.showPlaying();

    void this.requestImmersive();
  }

  /**
   * Fullscreen, where the browser allows it. Failure is fine.
   *
   * Deliberately does *not* lock the orientation. It used to lock to portrait-primary, which
   * Android honours while fullscreen and iOS ignores — so the game was pinned to portrait on
   * exactly one of the two platforms, and turning the phone did nothing. Both orientations
   * play, so which one to hold is the player's business, not the game's.
   */
  private async requestImmersive(): Promise<void> {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      }
    } catch {
      // Desktop browsers and iOS Safari both refuse this; the game plays regardless
    }
  }

  private frame(): void {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.25);
    this.adaptResolution();

    // Drawn from the contacts the steering itself is using, so a finger that has stopped
    // registering has no ring under it — which is the only way to see that from the outside.
    this.markers.update(this.input.contacts);

    switch (this.state) {
      case "playing":
        this.updatePlaying(dt);
        break;
      case "crashing":
        this.updateCrashing(dt);
        break;
      case "paused":
        // Deliberately nothing: the scene still renders below, so the panel sits over a
        // frozen frame of the run rather than a blank screen or a world that drifts on.
        break;

      case "menu":
      case "ended":
        // Keep the world alive behind the panels so the menu isn't a frozen screenshot
        this.camera.update(this.controller, this.field, dt);
        break;
    }

    // Follow the camera in all three axes. Pinning it to world y=0 leaves the range hanging
    // in the sky once the player has descended a few hundred metres.
    const cam = this.camera.camera.position;
    this.backdrop.position.set(cam.x, cam.y, cam.z);
    this.scene.render();
  }

  private updatePlaying(dt: number): void {
    const c = this.controller;
    const wasAt = this.lastRampZ;
    c.update(dt, this.input.value);
    this.lastRampZ = c.z;

    // Paid over the ground actually covered since the last frame, not per frame: a per-frame
    // award would be worth twice as much at 120fps as at 60, and this leaderboard is shared.
    // A ramp is worth a burst of multiplier as well as the speed, because the speed alone was
    // overshooting the bonus ceiling and buying almost nothing.
    const earned = applyRamps(c, this.field, this.seedHash, wasAt);
    if (earned.boost > 0) this.score.awardBoost();

    this.terrain.update(c.z);
    this.obstacleRenderer.update(c.z);
    this.rampRenderer.update(c.z, dt);

    const groundY = this.field.heightAt(c.renderX, c.renderZ);
    this.rider.sync(c, groundY, dt);
    this.camera.update(c, this.field, dt);

    // Spray is a readout of the carve mechanic, so it has to be legible: a steady rooster
    // tail just from moving, growing sharply with how hard the rider is turning.
    const speedT = clamp01(c.speed / 30);
    const carveT = clamp01(Math.abs(c.steer)) * speedT;
    const sprayAmount = c.airborne ? 0 : 0.3 * speedT + 0.85 * Math.pow(carveT, 1.2);
    this.spray.update(c.renderX, groundY + 0.1, c.renderZ, c.renderHeading, sprayAmount, c.steer);
    this.tracks.update(c.renderX, c.renderZ, c.renderHeading, c.steer, c.airborne);

    if (c.lastLandingImpact > 6) {
      this.spray.burst(c.renderX, groundY + 0.15, c.renderZ);
      c.lastLandingImpact = 0;
    }

    this.score.update(c.distance, c.speed, dt);
    this.hud.updateHud(
      c.speed,
      c.distance,
      this.score.value,
      this.engine.getFps(),
      this.score.multiplierAt(c.speed),
      this.score.boost,
    );

    // Obstacles
    // Physics position, not the interpolated render one, so collisions stay deterministic
    const hit = this.obstacles.hitTest(c.x, c.z, c.y, c.heading, c.halfWidth, c.halfLength);
    if (hit) {
      this.beginCrash(hit.x, hit.z);
      return;
    }

    // Off course. The banks already push back; this is the backstop for a player who
    // insists on climbing out anyway.
    const off = lateralFraction(this.field.params, c.x, c.z);
    if (off > OUT_OF_BOUNDS_FRACTION) {
      this.oobTimer += dt;
      this.hud.setOutOfBounds(true, 1 - this.oobTimer / OUT_OF_BOUNDS_GRACE);
      if (this.oobTimer >= OUT_OF_BOUNDS_GRACE) this.endRun("outOfBounds");
    } else if (this.oobTimer > 0) {
      this.oobTimer = 0;
      this.hud.setOutOfBounds(false, 1);
    }
  }

  private pause(): void {
    if (this.state !== "playing") return;
    this.state = "paused";
    // Clears held keys and the mouse. Fingers are kept on purpose: a thumb still on the glass
    // when the panel opened is still asking for that turn when play resumes, and clearing it
    // used to strand it entirely — a motionless thumb sends no events to restore itself with.
    this.input.reset();
    this.spray.stop();
    // Banked here rather than only where the pause leads, because this is also what a phone
    // call or an app switch does — and that run may never be resumed at all.
    this.bankScore();
    this.hud.showPaused(this.controller.distance, this.score.value);
  }

  private resume(): void {
    if (this.state !== "paused") return;
    this.hud.hidePaused();
    this.hud.showPlaying();
    this.input.reset();
    this.state = "playing";
  }

  private beginCrash(hitX: number, hitZ: number): void {
    this.state = "crashing";
    this.crashTimer = 0;
    this.endReason = "crash";
    this.spray.burst(this.controller.x, this.controller.y + 0.2, this.controller.z);
    this.spray.stop();
    this.hud.setOutOfBounds(false, 1);
    this.wipeout.start(this.controller, hitX, hitZ);
  }

  /**
   * Pick the run back up from where it ended, at the price of the day.
   *
   * Only reachable on a daily course. Almost every attempt at one is over inside a kilometre,
   * which means almost nobody ever sees the part of the mountain this game is actually about —
   * the fall line past 3km, tipped over and quick. This is how they get to look at it.
   *
   * What it costs is recorded before anything else moves: from here on nothing on this course
   * is written to the leaderboard, including the score already earned. A continued run and a
   * clean one are not the same achievement and must not share a column.
   *
   * The rider is put back on the racing line rather than exactly where they fell. Where they
   * fell is, by definition, either inside a tree or off the course, and dropping them back into
   * it would end the run again within the second.
   */
  private continueRun(): void {
    if (this.state !== "ended") return;
    if (!isDaily(this.seed) || hasContinued(this.seed)) return;

    markContinued(this.seed);

    const z = this.controller.z;
    this.wipeout.stop();
    this.controller.resumeAt(gateX(this.field.params, z), z);
    this.rider.setEnabled(true);

    this.terrain.prime(this.controller.z);
    this.obstacleRenderer.update(this.controller.z);
    this.rampRenderer.update(this.controller.z, this.controller.z);
    this.camera.reset(this.controller);

    // The ramp between here and wherever the crash left `lastRampZ` is not a ramp this run rode
    this.lastRampZ = this.controller.z;
    this.input.reset();
    this.oobTimer = 0;
    this.crashTimer = 0;
    this.state = "playing";
    this.hud.showPlaying();
  }

  private updateCrashing(dt: number): void {
    this.crashTimer += dt;

    // Havok owns the rider now; the visual just follows the rigid body
    const transform = this.wipeout.update();
    if (transform) {
      this.rider.root.position.copyFrom(transform.position);
      this.rider.root.rotationQuaternion = transform.rotation.clone();

      // The shadow is not parented to the rider — it lies on the snow with its own
      // orientation — so it has to be driven here too. Without this it stayed where the
      // crash began while the rider tumbled off down the hill.
      const p = transform.position;
      const [gx, gz] = this.field.gradientAt(p.x, p.z);
      const yaw = transform.rotation.toEulerAngles().y;
      this.rider.placeShadow(
        p.x,
        p.y,
        p.z,
        this.field.heightAt(p.x, p.z),
        gx,
        gz,
        Math.sin(yaw),
        Math.cos(yaw),
      );
    }

    const f = this.wipeout.focus;
    this.camera.watchCrash(f.x, f.y, f.z, dt);

    if (this.crashTimer >= CRASH_DURATION) this.endRun("crash");
  }

  private endRun(reason: "crash" | "outOfBounds"): void {
    if (this.state === "ended") return;
    this.endReason = reason;
    this.state = "ended";
    this.spray.stop();
    this.hud.setOutOfBounds(false, 1);

    const score = this.score.value;
    recordBest(this.seed, score, this.controller.distance, this.controller.topSpeed);

    // Nothing on a continued day is recorded, so nothing on it can be a personal best.
    //
    // This was missed the first time and it mattered: the end screen announced a new personal
    // best over a score the game had just refused to save, and put that claim on the card as
    // well — so a continued run could be sent to somebody as a clean one. That is precisely the
    // comparison the continue exists to protect.
    //
    // It covers every run on the day, not only the continued one. Once the day is spent, a
    // fresh attempt on that course is not recorded either, and would have made the same claim.
    const spent = hasContinued(this.seed);
    // Compared against the best as it stood when this run *began*, not against what is in
    // storage now: banking mid-run means the run's own score may already be in there, and
    // asking storage would then deny the run the record it just set.
    const isRecord = !spent && score > this.bestAtStart;

    const best = readBest(this.seed);
    const result: CardResult = {
      score,
      distance: this.controller.distance,
      topSpeed: this.controller.topSpeed,
      seed: this.seed,
      // The card is the one thing here that travels to other people, so a continued run has to
      // say so on its face. Everything else about the picture is identical, which is the point:
      // it can still be shared, it just cannot be passed off.
      strap: spent
        ? "Continued run — doesn't count"
        : isRecord
          ? "New personal best!"
          : `Best on this run: ${best.toLocaleString()}`,
      url: shareUrl(this.seed),
    };
    this.lastResult = result;

    this.hud.showEnd({
      reason: this.endReason,
      score,
      distance: this.controller.distance,
      topSpeed: this.controller.topSpeed,
      seed: this.seed,
      best,
      isRecord,
      // Only a daily run, and only while the day is still worth something. A custom course can
      // simply be ridden again from the top, so a continue there would be a button that saves
      // nothing; and once the day is spent there is nothing left to warn anybody about.
      canContinue: isDaily(this.seed) && !spent,
      spent,
    });

    // Drawn now, not when the button is pressed. `navigator.share` needs the activation from
    // that press, and awaiting a canvas render inside the handler spends it on iOS — the one
    // platform where a share sheet is the whole point.
    this.shareCard = null;
    void prepareShareCard(result).then((card) => {
      // A newer run may have ended while this was drawing; only the current card is any use.
      if (this.lastResult === result) {
        this.shareCard = card;
        this.hud.setShareLabel(card != null || navigator.share != null);
      }
    });
  }

  /**
   * Nudge the render resolution to hold a playable frame rate.
   *
   * Phones vary enormously and thermal throttling means a device that was fine for a minute
   * may not be after five. Adjusting resolution is far less noticeable than dropped frames.
   */
  private adaptResolution(): void {
    const fps = this.engine.getFps();
    if (!Number.isFinite(fps) || fps <= 0) return;

    this.fpsSamples.push(fps);
    if (this.fpsSamples.length < 90) return;

    const mean = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    this.fpsSamples.length = 0;

    // Start sharp and only give up resolution when the device cannot keep up, recovering
    // when it can. The dead band between the two thresholds stops it oscillating.
    let next = this.hardwareScale;
    if (mean < 50) {
      next = Math.min(WORST_SCALE, this.hardwareScale + 0.15);
    } else if (mean > 57 && this.hardwareScale > this.sharpestScale) {
      next = Math.max(this.sharpestScale, this.hardwareScale - 0.08);
    }

    if (next !== this.hardwareScale) {
      this.hardwareScale = next;
      this.engine.setHardwareScalingLevel(next);
    }
  }
}

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
if (!canvas) throw new Error("missing #game canvas");

const game = new Game(canvas);
void game.init().catch((err: unknown) => {
  console.error("failed to start", err);
  const loading = document.getElementById("loading");
  if (loading) {
    loading.innerHTML =
      '<div class="panel"><h2>Could not start</h2>' +
      '<p class="tagline">This game needs WebGL. Try a different browser.</p></div>';
  }
});
