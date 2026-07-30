/**
 * Chase camera.
 *
 * Hand-rolled rather than Babylon's `FollowCamera`, which recomputes its own position from a
 * target every frame and visibly jitters when the target is itself being damped.
 *
 * The one non-obvious decision: camera yaw blends between the rider's heading and the
 * direction the *course* runs a little way ahead. Following the rider alone means that every
 * time they carve hard the camera swings to stare at a bank, hiding the corner they are about
 * to enter. Leading with the course keeps the next turn on screen.
 */

import type { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { clamp01, dampAngle, expDamp, lerp, wrapAngle } from "../core/math";
import { centreX, type CourseParams } from "../world/course";
import type { RiderController } from "./controller";
import type { TerrainField } from "../world/terrain";

const BASE_DISTANCE = 9.5;
const BASE_HEIGHT = 3.9;
const LOOK_AHEAD = 11;
const LOOK_HEIGHT = 1.5;

/** How much of the camera's yaw comes from the course rather than the rider. */
const COURSE_LEAD = 0.42;
/** How far down the mountain to sample the course direction. */
const COURSE_LOOK = 42;

const BASE_FOV = 0.95;
const FOV_AT_SPEED = 1.16;

/**
 * Widest horizontal view we will present, radians (80°).
 *
 * Babylon's `fov` is the *vertical* angle, so the horizontal view is whatever the aspect ratio
 * makes of it. On a phone held upright that is a 30° slit, which is the view the whole game was
 * tuned against. Turned on its side the same vertical angle opens to 105° — three and a half
 * times as much warning of a tree coming, plus the smeared perspective a very wide angle gives.
 *
 * So the vertical angle is reduced in landscape until the horizontal view fits inside this cap.
 * Portrait never reaches it and is left exactly as it was.
 */
const MAX_HORIZONTAL_FOV = 1.4;

/**
 * The vertical FOV to actually use: the one asked for, or as much of it as keeps the horizontal
 * view inside MAX_HORIZONTAL_FOV at this aspect ratio.
 */
function fitToScreen(verticalFov: number, aspect: number): number {
  const widest = 2 * Math.atan(Math.tan(MAX_HORIZONTAL_FOV / 2) / Math.max(aspect, 0.01));
  return Math.min(verticalFov, widest);
}

/** Fractions of error remaining after one second. Lower = snappier. */
const YAW_SMOOTHING = 0.00002;
const POS_SMOOTHING = 0.0000005;

export class ChaseCamera {
  readonly camera: UniversalCamera;
  private yaw = 0;
  private readonly target = new Vector3();
  private initialised = false;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    const cam = new UniversalCamera("chase", new Vector3(0, 5, -10), scene);
    cam.fov = BASE_FOV;
    cam.minZ = 0.4;
    cam.maxZ = 1400; // must clear the horizon backdrop
    cam.inputs.clear(); // the game owns the camera entirely; no user control
    this.camera = cam;
    void canvas;
  }

  reset(rider: RiderController): void {
    this.yaw = rider.heading;
    this.initialised = false;
  }

  update(rider: RiderController, field: TerrainField, dt: number): void {
    const params: CourseParams = field.params;

    // Everything here reads the *interpolated* rider transform. Chasing the raw stepped
    // position re-introduces exactly the jitter the interpolation exists to remove.
    const rx = rider.renderX;
    const ry = rider.renderY;
    const rz = rider.renderZ;
    const rHeading = rider.renderHeading;

    // Where the gulley is heading, as a yaw angle
    const ahead = rz + COURSE_LOOK;
    const courseYaw = Math.atan2(centreX(params, ahead) - rx, COURSE_LOOK);

    // Blend rider heading with course direction, taking the short way round the circle
    const blended = rHeading + wrapAngle(courseYaw - rHeading) * COURSE_LEAD;
    this.yaw = this.initialised ? dampAngle(this.yaw, blended, YAW_SMOOTHING, dt) : blended;

    const speedT = clamp01(rider.speed / 34);
    const distance = lerp(BASE_DISTANCE, BASE_DISTANCE + 2.2, speedT);
    const height = lerp(BASE_HEIGHT, BASE_HEIGHT + 0.7, speedT);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);

    // Sit behind the rider along the blended yaw
    const wantX = rx - sin * distance;
    const wantZ = rz - cos * distance;
    // Ride above the terrain, not the rider — stops the camera clipping into a bank behind
    const groundBehind = field.heightAt(wantX, wantZ);
    const wantY = Math.max(ry, groundBehind) + height;

    if (!this.initialised) {
      this.camera.position.set(wantX, wantY, wantZ);
      this.initialised = true;
    } else {
      const p = this.camera.position;
      p.x = expDamp(p.x, wantX, POS_SMOOTHING, dt);
      p.z = expDamp(p.z, wantZ, POS_SMOOTHING, dt);
      // Vertical follows faster, or landings feel like the camera is on elastic
      p.y = expDamp(p.y, wantY, POS_SMOOTHING * 0.02, dt);
    }

    // Widening the FOV with speed is the cheapest possible sense of rush
    const wanted = lerp(this.camera.fov, lerp(BASE_FOV, FOV_AT_SPEED, speedT), 1 - Math.pow(0.02, dt));
    const fov = fitToScreen(wanted, this.aspect());
    this.camera.fov = fov;

    this.target.set(
      rx + sin * LOOK_AHEAD,
      this.lookHeight(rx, ry, rz, wanted, fov),
      rz + cos * LOOK_AHEAD,
    );
    this.camera.setTarget(this.target);
  }

  /**
   * Height to aim at, which is LOOK_HEIGHT unless the aspect cap has narrowed the view.
   *
   * LOOK_HEIGHT was tuned against a phone held upright, and it puts the rider about halfway
   * between the centre of the frame and the bottom of it. That placement is an *angle* below
   * the camera axis, so shortening the vertical view — which is exactly what capping the
   * horizontal one does — pushes the rider down the frame and, in landscape, into the bottom
   * edge alongside the distance readout.
   *
   * So the angle is scaled by however much of the view survived the cap, which aims lower and
   * brings the rider back to the same place in the frame. When nothing is capped the two FOVs
   * are equal, the scale is 1, and this returns `ry + LOOK_HEIGHT` exactly — portrait is
   * untouched, including as the FOV pulses with speed.
   */
  private lookHeight(rx: number, ry: number, rz: number, wanted: number, capped: number): number {
    const p = this.camera.position;
    const behind = Math.hypot(p.x - rx, p.z - rz);
    const run = behind + LOOK_AHEAD;
    if (run < 1e-3) return ry + LOOK_HEIGHT;

    const above = p.y - ry;
    const riderPitch = Math.atan2(above, Math.max(behind, 1e-3));
    const basePitch = Math.atan2(above - LOOK_HEIGHT, run);
    const axisPitch = riderPitch - (riderPitch - basePitch) * (capped / wanted);
    return p.y - Math.tan(axisPitch) * run;
  }

  /** Pull back and stop leading once the rider has crashed, so the tumble stays in frame. */
  watchCrash(x: number, y: number, z: number, dt: number): void {
    const p = this.camera.position;
    const wantX = x - Math.sin(this.yaw) * 11;
    const wantZ = z - Math.cos(this.yaw) * 11;
    p.x = expDamp(p.x, wantX, 0.0001, dt);
    p.z = expDamp(p.z, wantZ, 0.0001, dt);
    p.y = expDamp(p.y, y + 5, 0.0001, dt);
    this.target.set(x, y + 0.6, z);
    this.camera.setTarget(this.target);
    this.camera.fov = fitToScreen(expDamp(this.camera.fov, BASE_FOV, 0.02, dt), this.aspect());
  }

  /** Width over height of what is being rendered. */
  private aspect(): number {
    const engine = this.camera.getScene().getEngine();
    const h = engine.getRenderHeight();
    return h > 0 ? engine.getRenderWidth() / h : 1;
  }
}
