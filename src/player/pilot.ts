/**
 * A simple automatic rider.
 *
 * Its real job is testing. "Is this course completable?" cannot be answered by inspecting
 * geometry — the honest way to ask is to have something ride it and see whether it survives.
 * The suite uses this to check every daily seed of the year, which is the guarantee the whole
 * shared-seed competition depends on.
 *
 * It is intentionally unsophisticated: proportional steering toward a point on the racing
 * line a little way ahead. If a course cannot be held by a pilot this crude, a player on a
 * phone has no chance.
 */

import { angleDelta, clamp } from "../core/math";
import { gateX, type CourseParams } from "../world/course";

export interface PilotTarget {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export interface PilotOptions {
  /** Multiplier on the heading error. Higher is more aggressive and less stable. */
  gain?: number;
  /** Seconds of travel to look ahead. Longer is smoother but cuts corners more. */
  lookaheadTime?: number;
  minLookahead?: number;
  maxLookahead?: number;
}

/** Steer demand in [-1, 1] that aims the rider at the clear racing line ahead. */
export function pilotSteer(
  params: CourseParams,
  rider: PilotTarget,
  opts: PilotOptions = {},
): number {
  const {
    // A long lookahead cuts corners badly — at 1.3s it drifts over 5m off the line, which
    // is wider than the clear channel and makes the pilot crash on courses a player could
    // ride. These values keep it inside ~1.5m, which is a realistic competent rider.
    gain = 2.4,
    lookaheadTime = 0.8,
    minLookahead = 8,
    maxLookahead = 26,
  } = opts;

  const lookahead = clamp(rider.speed * lookaheadTime, minLookahead, maxLookahead);
  const targetX = gateX(params, rider.z + lookahead);
  const desired = Math.atan2(targetX - rider.x, lookahead);
  return clamp(angleDelta(rider.heading, desired) * gain, -1, 1);
}
