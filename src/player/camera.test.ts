import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import { ChaseCamera } from "./camera";
import { RiderController } from "./controller";
import { TerrainField } from "../world/terrain";
import { hashString } from "../core/rng";

/**
 * A camera on a headless engine, at a given screen shape.
 *
 * NullEngine renders nothing but answers `getRenderWidth`/`getRenderHeight`, which is all the
 * camera reads — the aspect ratio is the only thing about the screen it cares about, and it is
 * exactly what differs between portrait and landscape.
 */
function rig(renderWidth: number, renderHeight: number) {
  const engine = new NullEngine({
    renderWidth,
    renderHeight,
    textureSize: 4,
    deterministicLockstep: false,
    lockstepMaxSteps: 1,
  });
  const scene = new Scene(engine);
  const field = new TerrainField(hashString("alpine"));
  const rider = new RiderController(field);
  const camera = new ChaseCamera(scene, null as unknown as HTMLCanvasElement);

  // Get the rider moving, then leave it alone: the render transform it exposes is frozen from
  // here on, so anything that moves afterwards is the camera's own doing and nothing else's.
  for (let i = 0; i < 600; i++) rider.update(1 / 60, 0);

  /** Run the camera until it has settled, so damping is not still in flight. */
  const settle = (dt = 1 / 60) => {
    for (let i = 0; i < 400; i++) camera.update(rider, field, dt);
  };
  // `camera.lookAt`, not Babylon's `getTarget()`. The latter is rebuilt from the view matrix
  // and stays at the origin until something renders, so an earlier version of this file
  // compared zero against zero and passed against a camera that was visibly wrong.
  const frame = (dt: number) => {
    camera.update(rider, field, dt);
    return camera.lookAt.y;
  };
  return { camera, rider, field, settle, frame };
}

const PORTRAIT = [390, 844] as const;
const LANDSCAPE = [844, 390] as const;

describe("the framing does not depend on how long the last frame took", () => {
  // The bug this exists for: a small vertical shimmer, in landscape only. `wanted` — the FOV
  // the camera would like — was damped from `camera.fov`, which had already been clipped to
  // the landscape cap. So `wanted` came out as the cap plus a sliver whose size depended on
  // `dt`, the ratio between the two wobbled from frame to frame, and the look target rode up
  // and down with the frame rate. Portrait never clips, so the ratio was exactly 1 and none of
  // it showed.
  for (const [name, [w, h]] of [
    ["portrait", PORTRAIT],
    ["landscape", LANDSCAPE],
  ] as const) {
    it(`holds the same look target across a frame-rate wobble, in ${name}`, () => {
      const { settle, frame } = rig(w, h);
      settle();

      // Everything about the world is frozen, so a steady frame must change nothing at all
      const steady = frame(1 / 60);
      expect(frame(1 / 60)).toBeCloseTo(steady, 9);

      // A frame that took twice as long must not move the picture either. Sub-millimetre,
      // because what is being chased here is about a pixel on a phone.
      expect(Math.abs(frame(1 / 30) - steady), `${name} moved with the frame time`).toBeLessThan(
        0.001,
      );
      expect(Math.abs(frame(1 / 90) - steady), `${name} moved with the frame time`).toBeLessThan(
        0.001,
      );
    });
  }
});

describe("the landscape view", () => {
  it("is narrower vertically than portrait, and reaches the cap", () => {
    const port = rig(...PORTRAIT);
    const land = rig(...LANDSCAPE);
    port.settle();
    land.settle();

    const horizontal = (fov: number, aspect: number) => 2 * Math.atan(Math.tan(fov / 2) * aspect);
    expect(land.camera.camera.fov).toBeLessThan(port.camera.camera.fov);
    // 80°, the cap the camera exists to hold: a phone on its side would otherwise show 105°
    expect(horizontal(land.camera.camera.fov, 844 / 390)).toBeCloseTo(1.4, 2);
    expect(horizontal(port.camera.camera.fov, 390 / 844)).toBeLessThan(1.4);
  });

  it("keeps the rider in the same place in the frame as portrait", () => {
    // The reason the look target is aimed lower at all. The rider sits a fixed *angle* below
    // the camera axis, so shrinking the vertical view pushes it down the frame and, left
    // alone, into the bottom edge next to the distance readout.
    const port = rig(...PORTRAIT);
    const land = rig(...LANDSCAPE);
    port.settle();
    land.settle();

    /** Where the rider falls between the centre of the frame (0) and the bottom edge (1). */
    const downFrame = (r: ReturnType<typeof rig>) => {
      const cam = r.camera.camera;
      const p = cam.position;
      const t = r.camera.lookAt;
      const c = r.rider;
      const ry = r.field.heightAt(c.renderX, c.renderZ) + 0.9; // mid-torso
      const pitch = (x: number, y: number, z: number) => Math.atan2(y, Math.hypot(x, z));
      const below =
        pitch(t.x - p.x, t.y - p.y, t.z - p.z) - pitch(c.renderX - p.x, ry - p.y, c.renderZ - p.z);
      return Math.tan(below) / Math.tan(cam.fov / 2);
    };

    // Measured at 0.015 apart. The bound is 0.06 — tight enough that the uncorrected camera,
    // which put the rider 0.29 lower in landscape, cannot slip under it.
    expect(
      Math.abs(downFrame(land) - downFrame(port)),
      "landscape frames the rider differently",
    ).toBeLessThan(0.06);
  });
});
