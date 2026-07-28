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
const SLOPE_ACCEL_SCALE = 1.75;
/** Constant board-on-snow friction, m/s². */
const FRICTION = 0.6;
/** Quadratic air resistance. Tuned with the above for a ~120 km/h top speed in real play. */
const AIR_DRAG = 0.0050;

/** Speed lost to carving, at full lock, as a fraction of current speed per second. */
const CARVE_DRAG = 0.33;
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

/**
 * How much more than gravity the terrain must demand before the rider leaves the ground.
 *
 * A real snowboarder absorbs rollers with their legs rather than launching off every crest,
 * and without modelling that the rider spends most of a fast run in the air — where there is
 * no edge to carve with and no control.
 */
const LAUNCH_TOLERANCE = 1.05;

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

  // State one physics step back, used only to interpolate what gets drawn
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private prevHeading = 0;

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

    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevHeading = this.heading;
  }

  /** Advance the simulation. `frameDt` is real elapsed seconds; stepping is fixed internally. */
  update(frameDt: number, steerDemand: number): void {
    this.accumulator += Math.min(frameDt, MAX_FRAME_TIME);
    while (this.accumulator >= FIXED_DT) {
      // Remember the state we are stepping *from*, so rendering can interpolate between the
      // two most recent physics steps rather than snapping to whichever one it happens to
      // land on. Without this the rider visibly jitters: at 60fps against a 120Hz step the
      // frame boundaries drift, so some frames consume no steps and others consume three,
      // and the rider stutters by tens of centimetres frame to frame.
      this.prevX = this.x;
      this.prevY = this.y;
      this.prevZ = this.z;
      this.prevHeading = this.heading;

      this.step(FIXED_DT, steerDemand);
      this.accumulator -= FIXED_DT;
    }
  }

  /**
   * How far past the latest physics step the current frame is, 0..1.
   *
   * Purely a rendering concern. Collision and scoring always use the exact stepped state, so
   * interpolation can never feed back into the simulation and cannot affect determinism.
   */
  private get alpha(): number {
    return clamp01(this.accumulator / FIXED_DT);
  }

  /** Smoothed position for drawing. */
  get renderX(): number {
    return lerp(this.prevX, this.x, this.alpha);
  }

  get renderY(): number {
    return lerp(this.prevY, this.y, this.alpha);
  }

  get renderZ(): number {
    return lerp(this.prevZ, this.z, this.alpha);
  }

  /** Smoothed heading for drawing, taking the short way round the circle. */
  get renderHeading(): number {
    return this.prevHeading + angleDelta(this.prevHeading, this.heading) * this.alpha;
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
        // Impact is the vertical speed *in excess of what following the surface demands*.
        // Measuring raw vy instead makes every landing look violent: on a 0.32 fall line at
        // speed the surface itself drops ~10 m/s, so even a perfectly smooth touchdown
        // scored as a heavy impact and paid a penalty for it.
        const impact = Math.max(0, -this.vy - -surfaceVy);
        this.lastLandingImpact = impact;

        // Split the landing velocity about the surface normal. The normal component is
        // absorbed by the snow; the tangential component carries on as speed. Throwing all
        // of it away — the previous behaviour — meant every roller scrubbed the run down,
        // and with the rider airborne a fifth of the time that quietly capped the top speed
        // of the whole game no matter how the drag and slope were tuned.
        const nLen = Math.hypot(ngx, 1, ngz);
        const nx = -ngx / nLen;
        const ny = 1 / nLen;
        const nz = -ngz / nLen;

        const vx = fx * this.speed;
        const vz = fz * this.speed;
        const vn = vx * nx + this.vy * ny + vz * nz;

        // Horizontal part of the tangential velocity, to stay in the same units as `speed`
        const carried = Math.hypot(vx - vn * nx, vz - vn * nz);
        this.speed =
          impact > CLEAN_LANDING
            ? Math.max(0, carried - (impact - CLEAN_LANDING) * LANDING_PENALTY)
            : carried;

        this.y = groundY;
        this.vy = surfaceVy;
        this.airborne = false;
      }
    } else {
      const demandedAccel = (surfaceVy - this.lastSurfaceVy) / dt;
      if (demandedAccel < -GRAVITY * LAUNCH_TOLERANCE) {
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
    // The falloff is gentle on purpose. Cornering radius is speed / turn-rate, so cutting
    // authority hard at speed sets a minimum radius — and once the top speed went to 120km/h
    // that minimum grew past the tightest curves the racing line actually contains, making
    // parts of some seeds physically impossible to follow.
    const highSpeed = lerp(1, 0.82, clamp01((this.speed - 16) / 24));
    return spinUp * highSpeed;
  }

  /** Visual bank angle, in radians. Leans harder the faster you carve. */
  get leanAngle(): number {
    return this.steer * 0.62 * clamp01(this.speed / 15);
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
