/**
 * The rider — arcade motion over the terrain height field.
 *
 * This is the heart of the game, so it is deliberately *not* a rigid body. The rider samples
 * `TerrainField.heightAt` directly, which is exact and cheap and cannot catch on a chunk seam
 * or tunnel through a fast-moving slope. Havok is still doing real work elsewhere: obstacle
 * contacts, and the dynamic-body tumble on a wipeout.
 *
 * Everything the design promises falls out of two terms:
 *
 *  - **Slope acceleration** projects gravity onto the direction the rider is pointing. Point
 *    down the fall line and you accelerate; traverse across it and you don't; ride up a bank
 *    and you actively slow. That single term is why the gulley walls work without any
 *    boundary-collision code.
 *
 *  - **Carve drag** scales as |steer|^1.5, so a full-lock turn sheds dramatically more speed
 *    than a gentle lean. That is the core risk/reward the player is playing against.
 */

import { clamp, clamp01, expDamp, smoothstep, angleDelta, lerp } from "../core/math";
import type { TerrainField } from "../world/terrain";

/** Physics runs at a fixed step so behaviour never depends on frame rate. */
const FIXED_DT = 1 / 120;
/** Never simulate more than this much time in one frame, or a tab-out becomes a teleport. */
const MAX_FRAME_TIME = 0.25;

const GRAVITY = 9.81;

// --- Tuning ------------------------------------------------------------------------------
// These are the numbers that decide whether the game feels good. CARVE_DRAG is the most
// important one: it sets the price of a tight turn.

/** Arcade exaggeration on gravity-along-slope. 1.0 would be physically honest but sluggish. */
const SLOPE_ACCEL_SCALE = 1.6;
/** Constant board-on-snow friction, m/s². */
const FRICTION = 0.6;
/** Quadratic air resistance. Tuned with the above for a ~30 m/s (108 km/h) terminal speed. */
const AIR_DRAG = 0.004;

/** Speed lost to carving, at full lock, as a fraction of current speed per second. */
const CARVE_DRAG = 0.45;
/** Exponent on |steer|. Above 1 makes tight turns disproportionately expensive. */
const CARVE_EXPONENT = 1.5;

/** Yaw rate at full lock with full authority, rad/s. */
const MAX_TURN_RATE = 2.1;
/** Steering is much weaker in the air — you can rotate, but there is no edge to carve on. */
const AIR_TURN_FACTOR = 0.35;

/** How fast the steer demand is followed. Fraction of error remaining after one second. */
const STEER_SMOOTHING = 0.0001;

/**
 * At low speed the board is pulled around toward the fall line. This is what makes a stall
 * recoverable: without it, a rider who scrubs all their speed while pointing across the
 * mountain would sit there forever with no input that could save them.
 */
const FALL_LINE_PULL = 1.6;
const FALL_LINE_PULL_FADE = 11;

/** Speed lost per m/s of downward impact on landing. */
const LANDING_PENALTY = 0.22;
/** Below this impact speed a landing is clean — no penalty, no spray. */
const CLEAN_LANDING = 4;

const START_SPEED = 7;

export interface RiderSnapshot {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  vy: number;
  airborne: boolean;
  /** Smoothed steer, [-1, 1]. Drives the visual lean and the carve drag. */
  steer: number;
  /** Terrain gradient under the rider, for orienting the board to the slope. */
  gradX: number;
  gradZ: number;
}

export class RiderController {
  x = 0;
  y = 0;
  z = 0;
  heading = 0; // 0 = pointing straight down the mountain (+z)
  speed = START_SPEED;
  vy = 0;
  airborne = false;
  steer = 0;

  gradX = 0;
  gradZ = 0;

  /** Peak speed reached this run, for the end-of-run summary. */
  topSpeed = 0;
  /** Downward speed of the most recent landing, consumed by the effects layer. */
  lastLandingImpact = 0;

  private accumulator = 0;
  /** Previous step's surface-following vertical velocity, for the launch curvature test. */
  private lastSurfaceVy = 0;

  constructor(private readonly field: TerrainField) {
    this.reset();
  }

  reset(): void {
    this.x = 0;
    this.z = 0;
    this.heading = 0;
    this.speed = START_SPEED;
    this.vy = 0;
    this.airborne = false;
    this.steer = 0;
    this.topSpeed = 0;
    this.lastLandingImpact = 0;
    this.accumulator = 0;
    this.y = this.field.heightAt(0, 0);
    const [gx, gz] = this.field.gradientAt(0, 0);
    this.gradX = gx;
    this.gradZ = gz;
    this.lastSurfaceVy = this.speed * gz; // heading is 0, so forward is +z
  }

  /** Advance the simulation. `frameDt` is real elapsed seconds; stepping is fixed internally. */
  update(frameDt: number, steerDemand: number): void {
    this.accumulator += Math.min(frameDt, MAX_FRAME_TIME);
    while (this.accumulator >= FIXED_DT) {
      this.step(FIXED_DT, steerDemand);
      this.accumulator -= FIXED_DT;
    }
  }

  private step(dt: number, steerDemand: number): void {
    const { field } = this;

    // 1. Follow the steer demand smoothly — responsive, but not twitchy on a phone
    this.steer = expDamp(this.steer, clamp(steerDemand, -1, 1), STEER_SMOOTHING, dt);

    // Forward direction. heading 0 → +z (downhill); +x is the rider's right.
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);

    const [gx, gz] = field.gradientAt(this.x, this.z);
    this.gradX = gx;
    this.gradZ = gz;

    // Positive when pointing uphill, negative when pointing down the fall line
    const slopeDot = gx * fx + gz * fz;

    // 2. Turn
    const authority = this.turnAuthority() * (this.airborne ? AIR_TURN_FACTOR : 1);
    this.heading += this.steer * MAX_TURN_RATE * authority * dt;

    // 3. Gravity pulls the board back toward the fall line when slow — the anti-stall term
    if (!this.airborne && this.speed < FALL_LINE_PULL_FADE) {
      const len = Math.hypot(gx, gz);
      if (len > 1e-5) {
        const fallAngle = Math.atan2(-gx, -gz);
        const pull = FALL_LINE_PULL * (1 - smoothstep(0, FALL_LINE_PULL_FADE, this.speed));
        this.heading += angleDelta(this.heading, fallAngle) * pull * dt;
      }
    }

    // 4. Speed
    if (!this.airborne) {
      // Gravity along the slope, projected onto where the board is pointing
      this.speed -= GRAVITY * SLOPE_ACCEL_SCALE * slopeDot * dt;
      // The carve tax: superlinear in steer, proportional to current speed
      const carve = CARVE_DRAG * Math.pow(Math.abs(this.steer), CARVE_EXPONENT);
      this.speed -= carve * this.speed * dt;
      this.speed -= FRICTION * dt;
    }
    this.speed -= AIR_DRAG * this.speed * this.speed * dt;
    if (this.speed < 0) this.speed = 0;
    if (this.speed > this.topSpeed) this.topSpeed = this.speed;

    // 5. Move across the ground plane
    this.x += fx * this.speed * dt;
    this.z += fz * this.speed * dt;

    // 6. Vertical.
    //
    // Launching off a roller is decided by a curvature test rather than by integrating a
    // ballistic path and seeing whether it clears the ground. The naive version cannot work:
    // clamping y to the surface every step destroys the tiny separation before it can ever
    // accumulate into a real gap, so the rider stays welded to the terrain forever.
    //
    // Instead, ask what vertical acceleration the surface is *demanding*. Staying glued to a
    // crest requires accelerating downward; once that demand exceeds gravity, the ground is
    // falling away faster than the rider can follow, and they leave it.
    const groundY = field.heightAt(this.x, this.z);
    const [ngx, ngz] = field.gradientAt(this.x, this.z);
    const surfaceVy = this.speed * (ngx * fx + ngz * fz);

    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= groundY) {
        const impact = Math.max(0, -this.vy);
        this.lastLandingImpact = impact;
        if (impact > CLEAN_LANDING) {
          this.speed = Math.max(0, this.speed - (impact - CLEAN_LANDING) * LANDING_PENALTY);
        }
        this.y = groundY;
        this.vy = surfaceVy;
        this.airborne = false;
      }
    } else {
      const demandedAccel = (surfaceVy - this.lastSurfaceVy) / dt;
      if (demandedAccel < -GRAVITY) {
        // The crest has outrun gravity — go ballistic from the velocity we already had
        this.airborne = true;
        this.vy = this.lastSurfaceVy - GRAVITY * dt;
        this.y += this.vy * dt;
        if (this.y <= groundY) {
          this.y = groundY;
          this.vy = surfaceVy;
          this.airborne = false;
        }
      } else {
        this.y = groundY;
        this.vy = surfaceVy;
      }
    }

    this.lastSurfaceVy = surfaceVy;
  }

  /**
   * How much of the maximum turn rate is available right now.
   *
   * Near-zero at a standstill (no edge to bite), and eased back at very high speed so top-end
   * riding feels committed rather than darty.
   */
  private turnAuthority(): number {
    const spinUp = smoothstep(0, 5, this.speed);
    const highSpeed = lerp(1, 0.62, clamp01((this.speed - 13) / 22));
    return spinUp * highSpeed;
  }

  /** Visual bank angle, in radians. Leans harder the faster you carve. */
  get leanAngle(): number {
    return this.steer * 0.62 * clamp01(this.speed / 13);
  }

  /** Distance down the mountain. Zig-zagging does not inflate it, which keeps seeds fair. */
  get distance(): number {
    return Math.max(0, this.z);
  }

  snapshot(): RiderSnapshot {
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      heading: this.heading,
      speed: this.speed,
      vy: this.vy,
      airborne: this.airborne,
      steer: this.steer,
      gradX: this.gradX,
      gradZ: this.gradZ,
    };
  }
}
