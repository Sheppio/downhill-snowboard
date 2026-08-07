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
import { OUT_OF_BOUNDS_FRACTION, gateX, lateralFraction, slopeAt } from "./world/course";
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
import { CardCache } from "./game/cardcache";
import { strapFor, type CardResult } from "./game/sharecard";
import { Hud } from "./ui/hud";
import { outcomeOf, scoreDisplay, type ScoreDisplay } from "./game/outcome";
import { WorldOrigin } from "./world/origin";

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
  /**
   * The frame the world is drawn in.
   *
   * Created once and shared by every renderer, and deliberately not rebuilt per seed: it is a
   * property of where the camera is, not of which mountain is under it. See `world/origin.ts`
   * for why the drawing frame is not the world frame.
   */
  private readonly origin = new WorldOrigin();

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
  /**
   * Whether today's course has been continued, so nothing on it will be recorded.
   *
   * Cached at the start of a run rather than asked per frame: `hasContinued` parses a list out
   * of localStorage, and the score's colour is decided sixty times a second.
   */
  private spentDay = false;
  /**
   * Whether *this* run was continued, as opposed to started from the top.
   *
   * Separate from `spentDay`, and the distinction is the whole of `scoreDisplay`. A continued
   * run cannot be recorded from the moment it resumes, so it greys immediately. A fresh run on
   * the same spent day is a clean attempt and is drawn as one until it climbs past the best.
   */
  private continuedThisRun = false;
  /**
   * Whether storage has kept this run's score.
   *
   * Not a second opinion about whether it *should* have — it is `recordBest`'s own answer, kept
   * so the end screen can report what happened rather than work it out again. Working it out
   * again is how a continued run came to announce a personal best over a score that had just
   * been refused.
   */
  private runWasSaved = false;
  private oobTimer = 0;
  private crashTimer = 0;
  private endReason: "crash" | "outOfBounds" = "crash";
  /** The finished run the end screen is showing, and the card drawn from it. */
  private lastResult: CardResult | null = null;
  private shareCard: File | null = null;
  /**
   * Cards for the scores list, drawn before anybody asks for them.
   *
   * The queueing, the skipping and the eviction live in `game/cardcache.ts`, along with why any
   * of it is necessary. What stays here is the two things it needs from the game: what a card
   * for a seed would say, and how to draw one.
   */
  private readonly cards = new CardCache({
    resultFor: (seed) => this.listResult(seed),
    draw: (result) => prepareShareCard(result),
  });

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

    this.camera = new ChaseCamera(this.scene, canvas, this.origin);
    this.rider = new Rider(this.scene, this.origin);
    this.spray = new SnowSpray(this.scene, this.origin);
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
      onScoresShown: (seeds) => this.cards.queueAll(seeds),
      onPrepareShareSeed: (seed) => this.cards.prioritise(seed),
      onShareSeed: (seed) => {
        const result = this.listResult(seed);
        if (!result) return;
        const card = this.cards.get(seed);
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
    this.terrain = new TerrainRenderer(this.scene, this.field, this.origin);
    this.obstacles = new ObstacleField(numeric, this.field.params, this.field);
    this.obstacleRenderer = new ObstacleRenderer(this.scene, this.obstacles, this.origin);
    this.rampRenderer = new RampRenderer(
      this.scene,
      this.field.params,
      numeric,
      this.field,
      this.origin,
    );
    this.controller = new RiderController(this.field);
    this.wipeout = new Wipeout(this.scene, this.field, this.origin);
    // Rebuilt per seed: the trail is baked in world space against a specific height field
    this.tracks?.dispose();
    this.tracks = new SnowTracks(this.scene, this.field, this.origin);
    this.backdrop = createBackdrop(this.scene, numeric);

    this.origin.reset(0, this.field.heightAt(0, 0), 0);
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
  /**
   * Put whatever the run has earned so far into storage, and remember whether it went in.
   *
   * The remembering is what the end screen's claim is built from. A run can be banked more than
   * once — walking away banks it, and then crashing banks it again — and the second call is
   * comparing the run against a best that may already be its own, so only the first can return
   * true. Accumulating means a run that took the record while the tab was hidden is still a
   * record when it finally ends.
   */
  private bankScore(): void {
    if (this.state !== "playing" && this.state !== "paused" && this.state !== "crashing") return;
    if (recordBest(this.seed, this.score.value, this.controller.distance, this.controller.topSpeed)) {
      this.runWasSaved = true;
      // The card for this seed now shows a score that has been beaten. Dropped rather than
      // redrawn, so the next visit to the list draws it from the record that replaced it.
      this.cards.invalidate(this.seed);
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
    // Set here rather than per frame: the course cannot change mid-run, and this covers every
    // way in — the daily button, a typed code, a scores row, Retry, and a continue.
    this.hud.setSlopeCode(seed);

    if (seed !== this.seed) {
      this.seed = seed;
      this.buildWorld(seed);
      syncUrl(seed);
    } else {
      this.controller.reset();
      this.wipeout.stop();
      this.origin.reset(0, this.field.heightAt(0, 0), 0);
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
    // A fresh run on a continued day counts normally, and normally is how it is drawn — right
    // up to the point it passes the best already stored. See `scoreDisplay`.
    this.spentDay = hasContinued(seed);
    this.continuedThisRun = false;
    this.runWasSaved = false;
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

    // Before anything is placed for this frame. Every renderer below reads the origin, so
    // moving it afterwards would leave the frame half-drawn in each of two frames.
    this.origin.follow(c.renderX, c.renderY, c.renderZ);

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
    this.hud.updateHud({
      speedMs: c.speed,
      topSpeedMs: c.topSpeed,
      distance: c.distance,
      // The fall line where the rider is, which is what the slope indicator is about — not the
      // ground's local tilt, which rolls with every undulation and would jitter constantly.
      gradient: slopeAt(c.distance),
      score: this.score.value,
      best: this.bestAtStart,
      fps: this.engine.getFps(),
      multiplier: this.score.multiplierAt(c.speed),
      boost: this.score.boost,
      display: this.scoreDisplay(),
    });

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
    // Daily runs only, and that is the whole gate. It used to refuse a course that had already
    // been continued, which was correct while a continue was a once-a-day thing and became a
    // dead button the moment it was not: the end screen offered it every time, because the
    // offer is drawn from `isDaily` alone, and pressing it did nothing. Second press of a run,
    // and every press on any later run that day.
    //
    // Two gates for one rule is what did it. There is one now, and the offer and the action
    // read the same thing.
    if (!isDaily(this.seed)) return;

    // Idempotent, so continuing again on an already-spent day costs nothing further
    markContinued(this.seed);
    this.spentDay = true;
    // The score keeps counting from here — the riding is real and worth seeing a number for —
    // but it greys from the first frame, because none of it is going to be kept.
    this.continuedThisRun = true;
    // The run so far may well have taken the record, and it keeps it — that part was ridden
    // clean and is already in storage. But from here nothing more can be saved, so as far as
    // *this* run's standing goes the slate starts empty again. Without this the continued run
    // inherits the earlier record and announces a personal best over a score that has just been
    // refused, which is the exact fault this was pulled apart to make impossible.
    this.runWasSaved = false;

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

  /** How the score should be drawn this frame. See `game/outcome.ts` for the rule. */
  private scoreDisplay(): ScoreDisplay {
    return scoreDisplay({
      score: this.score.value,
      bestBefore: this.bestAtStart,
      spent: this.spentDay,
      continued: this.continuedThisRun,
    });
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
      // The tumble is simulated in the drawing frame, so the body's position goes straight
      // onto the rider's node — but the height field and the shadow both speak absolute
      // metres, and putting a drawing-frame position into either asks about a point on a
      // different part of the mountain.
      const p = transform.position;
      const wx = p.x + this.origin.x;
      const wy = p.y + this.origin.y;
      const wz = p.z + this.origin.z;
      const [gx, gz] = this.field.gradientAt(wx, wz);
      const yaw = transform.rotation.toEulerAngles().y;
      this.rider.placeShadow(
        wx,
        wy,
        wz,
        this.field.heightAt(wx, wz),
        gx,
        gz,
        Math.sin(yaw),
        Math.cos(yaw),
      );
    }

    const f = this.wipeout.focus;
    this.camera.watchCrash(f.x + this.origin.x, f.y + this.origin.y, f.z + this.origin.z, dt);

    if (this.crashTimer >= CRASH_DURATION) this.endRun("crash");
  }

  private endRun(reason: "crash" | "outOfBounds"): void {
    if (this.state === "ended") return;

    // Banked *before* the state moves to "ended", and that order is load-bearing: `bankScore`
    // only acts on a run that is still playing, paused or crashing, so ending first makes it a
    // no-op and the run is never recorded at all. Through the same path as every other bank, so
    // `runWasSaved` accumulates and the end screen has one thing to read rather than a rule to
    // re-derive.
    const score = this.score.value;
    this.bankScore();

    this.endReason = reason;
    this.state = "ended";
    this.spray.stop();
    this.hud.setOutOfBounds(false, 1);

    // What became of the run, taken from what storage did with it. There is no second opinion
    // here any more: a continued run cannot come out as a record, because the only way to be a
    // record is to have been kept, and `recordBest` refuses a spent day outright.
    const outcome = outcomeOf({
      score,
      best: readBest(this.seed),
      saved: this.runWasSaved,
      spent: this.spentDay,
    });

    const result: CardResult = {
      score,
      distance: this.controller.distance,
      topSpeed: this.controller.topSpeed,
      seed: this.seed,
      // The card is the one thing here that travels to other people, so a continued run has to
      // say so on its face. Everything else about the picture is identical, which is the point:
      // it can still be shared, it just cannot be passed off.
      strap: strapFor(outcome),
      url: shareUrl(this.seed),
    };
    this.lastResult = result;

    this.hud.showEnd({
      reason: this.endReason,
      distance: this.controller.distance,
      topSpeed: this.controller.topSpeed,
      seed: this.seed,
      outcome,
      // Every time, on any daily run. The first press is what costs the day; after that there
      // is nothing left to spend, so there is no reason to stop offering it — the point of the
      // feature is seeing the mountain, and one continue rarely gets anybody to the bottom.
      // A custom course still never offers it: it can simply be ridden again from the top.
      canContinue: isDaily(this.seed),
    });

    // Drawn now, not when the button is pressed. `navigator.share` needs the activation from
    // that press, and awaiting a canvas render inside the handler spends it on iOS — the one
    // platform where a share sheet is the whole point.
    //
    // A run that beat nothing offers the standing best instead, so it is that card that has to
    // exist by the time the icon is pressed. Same reasoning, different score.
    if (outcome.kind !== "record" && outcome.best > 0) this.cards.prioritise(this.seed);
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
