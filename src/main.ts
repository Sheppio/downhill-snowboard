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
import { createBackdrop, setupSky, SnowSpray } from "./world/scenery";
import { SnowTracks } from "./world/tracks";
import { OUT_OF_BOUNDS_FRACTION, lateralFraction } from "./world/course";
import { RiderController } from "./player/controller";
import { Rider } from "./player/rider";
import { ChaseCamera } from "./player/camera";
import { Wipeout, initPhysics } from "./player/wipeout";
import { SteerInput } from "./input/steer";
import { TouchMarkers } from "./ui/touchmarkers";
import { Score } from "./game/score";
import { readBest, recordBest } from "./game/leaderboard";
import {
  copyShareLink,
  initialSeed,
  normaliseSeed,
  randomSeed,
  syncUrl,
  todaysSeed,
} from "./game/seed";
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
      onShare: () => {
        void copyShareLink(this.seed).then((ok) =>
          this.hud.flashShare(ok ? "Link copied!" : "Link ready"),
        );
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

    this.engine.runRenderLoop(() => this.frame());
  }

  /** Tear down and rebuild everything that depends on the seed. */
  private buildWorld(seed: string): void {
    this.terrain?.dispose();
    this.obstacleRenderer?.dispose();
    this.wipeout?.stop();
    this.backdrop?.dispose();

    const numeric = hashString(seed);
    this.field = new TerrainField(numeric);
    this.terrain = new TerrainRenderer(this.scene, this.field);
    this.obstacles = new ObstacleField(numeric, this.field.params, this.field);
    this.obstacleRenderer = new ObstacleRenderer(this.scene, this.obstacles);
    this.controller = new RiderController(this.field);
    this.wipeout = new Wipeout(this.scene, this.field);
    // Rebuilt per seed: the trail is baked in world space against a specific height field
    this.tracks?.dispose();
    this.tracks = new SnowTracks(this.scene, this.field);
    this.backdrop = createBackdrop(this.scene, numeric);

    this.terrain.prime(0);
    this.obstacleRenderer.update(0);
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
    recordBest(this.seed, this.score.value, this.controller.distance);
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
      this.camera.reset(this.controller);
    }

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
    c.update(dt, this.input.value);

    this.terrain.update(c.z);
    this.obstacleRenderer.update(c.z);

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

    this.score.update(c.distance, c.speed);
    this.hud.updateHud(c.speed, c.distance, this.score.value, this.engine.getFps());

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
    // Compared against the best as it stood when this run *began*, not against what is in
    // storage now: banking mid-run means the run's own score may already be in there, and
    // asking storage would then deny the run the record it just set.
    const isRecord = score > this.bestAtStart;
    recordBest(this.seed, score, this.controller.distance);

    this.hud.showEnd({
      reason: this.endReason,
      score,
      distance: this.controller.distance,
      topSpeed: this.controller.topSpeed,
      seed: this.seed,
      best: readBest(this.seed),
      isRecord,
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
