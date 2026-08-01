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

/**
 * The rider's collision shape: a capsule lying along the board, in metres.
 *
 * Both figures come from the rider mesh's own silhouette, measured in its local frame with the
 * rig flattened. This used to be a single 0.6m circle, which was wrong in both directions at
 * once — nearly 2.7× too wide across the direction of travel, and 0.2m short at each tip.
 * Sideways is the axis you dodge on, so what players saw was crashing into trees they had
 * visibly passed.
 *
 * Across, the mesh reaches 0.240m one way and 0.225m the other, and the difference is entirely
 * the goggles sticking out past the face. 0.225 takes the body's own half-width and lets the
 * goggles overhang it: they are a 15mm detail on the front of a helmet, and nobody reads a
 * near miss as a hit because a strap clipped a trunk. The board is narrower still, 0.16m —
 * which is why "how wide is a snowboard" is the wrong question to size this from.
 *
 * Taken at rest, deliberately: at full lean the rider's head swings the better part of a metre
 * out over the snow, and a hitbox that grew every time you turned hard would be unreadable —
 * and it leans to the *inside* of the turn, away from whatever is being dodged. What threads a
 * gap is the board and the legs, and this is their width.
 *
 * They live here rather than next to the game loop so the collision tests can import the same
 * numbers the game plays with, instead of restating them and drifting.
 */
export const RIDER_HALF_WIDTH = 0.225;
export const RIDER_HALF_LENGTH = 0.81;

// --- Tuning ------------------------------------------------------------------------------
// These are the numbers that decide whether the game feels good. CARVE_DRAG is the most
// important one: it sets the price of a tight turn.

/** Arcade exaggeration on gravity-along-slope. 1.0 would be physically honest but sluggish. */
const SLOPE_ACCEL_SCALE = 1.75;
/** Constant board-on-snow friction, m/s². */
const FRICTION = 0.6;
/**
 * Quadratic air resistance. Tuned with the above for a ~112 km/h top speed on the opening
 * gradient, rising to about 164 km/h deep in a run as the fall line tips toward 45°.
 */
const AIR_DRAG = 0.0050;

// --- The speed the mountain builds to ----------------------------------------------------
// Terminal speed is where gravity along the slope balances air drag, so it is reached within a
// few hundred metres and then never changes for a given gradient. That is why a long run used
// to feel the same at 7km as at 1.5km: the rider was already going as fast as they ever would.
//
// There used to be a `dragScaleAt` here that eased the drag with distance to raise that
// ceiling, and it carried the note "it is the rider getting faster, not the mountain getting
// steeper: the height field is untouched". The height field is no longer untouched — the fall
// line now steepens from 0.40 toward 1.0 (see course.ts), which raises the ceiling for real,
// since terminal speed goes as sqrt(gradient).
//
// Running both was doubling up, and measurement said the fake lever was the worse one: over 57
// seeds ridden with the pilot it bought only +1.6% mean speed on the racing line while adding
// +10% to the *peak*, and the peaks are what cost seeds. Retiring it moved the worst daily seed
// from 2518m back to 2986m on its own. What it was for is now done by the mountain.

/** Speed lost to carving, at full lock, as a fraction of current speed per second. */
const CARVE_DRAG = 0.33;
/** Exponent on |steer|. Above 1 makes tight turns disproportionately expensive. */
const CARVE_EXPONENT = 1.5;

/** Yaw rate at full lock with full authority, rad/s. */
export const MAX_TURN_RATE = 2.1;
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

/**
 * How much of the maximum turn rate is available at a given speed.
 *
 * Near-zero at a standstill (no edge to bite), and eased back at very high speed so top-end
 * riding feels committed rather than darty.
 *
 * The falloff is gentle on purpose. Cornering radius is speed / turn-rate, so cutting
 * authority hard at speed sets a minimum radius — and once the top speed went to 120km/h that
 * minimum grew past the tightest curves the racing line actually contains, making parts of
 * some seeds physically impossible to follow.
 *
 * Exported because it is half of the budget the course is tuned against: `course.test.ts`
 * checks that the racing line never demands more turn rate than this leaves available.
 */
export function turnAuthorityAt(speed: number): number {
  const spinUp = smoothstep(0, 5, speed);
  const highSpeed = lerp(1, 0.82, clamp01((speed - 16) / 24));
  return spinUp * highSpeed;
}

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

  /** The rider's own collision capsule, so whatever tests against it need not restate it. */
  readonly halfWidth = RIDER_HALF_WIDTH;
  readonly halfLength = RIDER_HALF_LENGTH;

  /**
   * A kick from something the rider rode over — at present, a speed ramp.
   *
   * Applied here rather than by writing `speed` and `vy` from outside, because leaving the
   * ground is not one field: `airborne` has to be set with the velocity or the next step
   * treats the rider as still carving on snow it has already left.
   *
   * Speed is not capped. Terminal speed is where drag balances gravity, and drag is quadratic,
   * so an over-speed rider is pulled back to it within a second or two on its own — which is
   * exactly the shape a boost should have: a burst that fades, not a new ceiling.
   */
  boost(speedGain: number, lift: number): void {
    this.speed += speedGain;
    if (this.speed > this.topSpeed) this.topSpeed = this.speed;
    if (lift > 0) {
      this.vy += lift;
      this.airborne = true;
    }
  }

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
      // What the *ground* demands, with the heading held fixed across the difference.
      //
      // The obvious form — how much `surfaceVy` changed since last step — silently includes
      // the rider's own turning, because `grad · forward` moves when `forward` does. On a
      // smooth plane of gradient s, turning at θ̇ contributes `speed·s·sinθ·θ̇`, which at
      // 33 m/s on a 0.6 gradient is 9.5 m/s²: a rider carving on flawlessly smooth snow was
      // being thrown into the air by the act of turning, and the harder the mountain tipped
      // the worse it got. Differencing the gradient alone leaves only the curvature of the
      // terrain along the path actually travelled, which is the thing that really does
      // launch you.
      const demandedAccel = (this.speed * ((ngx - gx) * fx + (ngz - gz) * fz)) / dt;
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

  private turnAuthority(): number {
    return turnAuthorityAt(this.speed);
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
