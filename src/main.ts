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
import { OUT_OF_BOUNDS_FRACTION, lateralFraction } from "./world/course";
import { RiderController } from "./player/controller";
import { Rider } from "./player/rider";
import { ChaseCamera } from "./player/camera";
import { Wipeout, initPhysics } from "./player/wipeout";
import { SteerInput } from "./input/steer";
import { Score, readBest, writeBest } from "./game/score";
import {
  copyShareLink,
  initialSeed,
  normaliseSeed,
  randomSeed,
  syncUrl,
  todaysSeed,
} from "./game/seed";
import { Hud } from "./ui/hud";

/** Collision radius of the rider on the XZ plane. */
const RIDER_RADIUS = 0.6;

/** Seconds off course before the run is ended. */
const OUT_OF_BOUNDS_GRACE = 3;

/** How long the crash tumble plays before the score screen appears. */
const CRASH_DURATION = 2.4;

type GameState = "menu" | "playing" | "crashing" | "ended";

class Game {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly hud: Hud;
  private readonly input: SteerInput;
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
  private backdrop!: import("@babylonjs/core/Meshes/mesh").Mesh;

  private state: GameState = "menu";
  private seed = initialSeed();
  private oobTimer = 0;
  private crashTimer = 0;
  private endReason: "crash" | "outOfBounds" = "crash";

  // Adaptive resolution
  private fpsSamples: number[] = [];
  private hardwareScale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      // Snow is a huge flat expanse of near-white; without a stencil-free depth buffer and
      // antialiasing the terrain edges shimmer badly in motion.
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    // Start at device resolution but cap the pixel ratio — a 3x phone display costs 9x the
    // fill rate for a difference nobody can see at arm's length.
    this.hardwareScale = Math.max(1, window.devicePixelRatio / 2);
    this.engine.setHardwareScalingLevel(this.hardwareScale);

    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = true;

    setupSky(this.scene);

    this.camera = new ChaseCamera(this.scene, canvas);
    this.rider = new Rider(this.scene);
    this.spray = new SnowSpray(this.scene);
    this.input = new SteerInput(canvas);

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
    });

    this.buildWorld(this.seed);

    // Debug handle for the browser smoke tests, so they can inspect the live scene and force
    // states (a crash, for instance) that are impractical to reach by simulated touch alone.
    // Opt-in only: dev builds, or ?debug=1 on a deployed build.
    if (import.meta.env.DEV || new URLSearchParams(location.search).has("debug")) {
      (window as unknown as { __game?: unknown }).__game = this;
    }

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
    this.backdrop = createBackdrop(this.scene, numeric);

    this.terrain.prime(0);
    this.obstacleRenderer.update(0);
    this.camera.reset(this.controller);
    this.rider.sync(this.controller, this.field.heightAt(0, 0), 1 / 60);
  }

  private showMenu(): void {
    this.state = "menu";
    this.wipeout.stop();
    this.spray.stop();
    this.rider.setEnabled(true);
    this.hud.showStart(this.seed, readBest(this.seed));
  }

  private startRun(seed: string): void {
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

    this.score.reset();
    this.input.reset();
    this.oobTimer = 0;
    this.crashTimer = 0;
    this.rider.setEnabled(true);
    this.state = "playing";
    this.hud.showPlaying();

    void this.requestImmersive();
  }

  /** Fullscreen and landscape lock, where the browser allows it. Failure is fine. */
  private async requestImmersive(): Promise<void> {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      }
      const orientation = screen.orientation as
        | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
        | undefined;
      await orientation?.lock?.("portrait-primary");
    } catch {
      // Desktop browsers and iOS Safari both refuse parts of this; the game plays regardless
    }
  }

  private frame(): void {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.25);
    this.adaptResolution();

    switch (this.state) {
      case "playing":
        this.updatePlaying(dt);
        break;
      case "crashing":
        this.updateCrashing(dt);
        break;
      case "menu":
      case "ended":
        // Keep the world alive behind the panels so the menu isn't a frozen screenshot
        this.camera.update(this.controller, this.field, dt);
        break;
    }

    this.backdrop.position.set(this.camera.camera.position.x, 0, this.camera.camera.position.z);
    this.scene.render();
  }

  private updatePlaying(dt: number): void {
    const c = this.controller;
    c.update(dt, this.input.value);

    this.terrain.update(c.z);
    this.obstacleRenderer.update(c.z);

    const groundY = this.field.heightAt(c.x, c.z);
    this.rider.sync(c, groundY, dt);
    this.camera.update(c, this.field, dt);

    // Spray tracks how hard the board is being driven into the snow, so the carve mechanic
    // is visible and not just felt
    const sprayAmount = c.airborne
      ? 0
      : clamp01(Math.abs(c.steer) * (c.speed / 18)) * 0.9 + clamp01(c.speed / 40) * 0.1;
    this.spray.update(c.x, groundY + 0.1, c.z, c.heading, sprayAmount);

    if (c.lastLandingImpact > 6) {
      this.spray.burst(c.x, groundY + 0.15, c.z);
      c.lastLandingImpact = 0;
    }

    this.score.update(c.distance, c.speed);
    this.hud.updateHud(c.speed, c.distance, this.score.value);

    // Obstacles
    const hit = this.obstacles.hitTest(c.x, c.z, RIDER_RADIUS);
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
    const isRecord = writeBest(this.seed, score);

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

    let next = this.hardwareScale;
    if (mean < 48) next = Math.min(2.0, this.hardwareScale + 0.15);
    else if (mean > 58 && this.hardwareScale > 1) next = Math.max(1, this.hardwareScale - 0.1);

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
