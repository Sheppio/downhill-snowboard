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

    // Where the gulley is heading, as a yaw angle
    const ahead = rider.z + COURSE_LOOK;
    const courseYaw = Math.atan2(centreX(params, ahead) - rider.x, COURSE_LOOK);

    // Blend rider heading with course direction, taking the short way round the circle
    const blended = rider.heading + wrapAngle(courseYaw - rider.heading) * COURSE_LEAD;
    this.yaw = this.initialised ? dampAngle(this.yaw, blended, YAW_SMOOTHING, dt) : blended;

    const speedT = clamp01(rider.speed / 30);
    const distance = lerp(BASE_DISTANCE, BASE_DISTANCE + 2.2, speedT);
    const height = lerp(BASE_HEIGHT, BASE_HEIGHT + 0.7, speedT);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);

    // Sit behind the rider along the blended yaw
    const wantX = rider.x - sin * distance;
    const wantZ = rider.z - cos * distance;
    // Ride above the terrain, not the rider — stops the camera clipping into a bank behind
    const groundBehind = field.heightAt(wantX, wantZ);
    const wantY = Math.max(rider.y, groundBehind) + height;

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

    this.target.set(
      rider.x + sin * LOOK_AHEAD,
      rider.y + LOOK_HEIGHT,
      rider.z + cos * LOOK_AHEAD,
    );
    this.camera.setTarget(this.target);

    // Widening the FOV with speed is the cheapest possible sense of rush
    this.camera.fov = lerp(this.camera.fov, lerp(BASE_FOV, FOV_AT_SPEED, speedT), 1 - Math.pow(0.02, dt));
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
    this.camera.fov = expDamp(this.camera.fov, BASE_FOV, 0.02, dt);
  }
}
