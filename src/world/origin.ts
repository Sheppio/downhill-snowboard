/**
 * Where the world is drawn from.
 *
 * The simulation runs in absolute coordinates and always will: distance is the score, the
 * course is a function of z, and a rider 9km down the hill really is at z=9000. But that
 * number cannot also be the one handed to the GPU.
 *
 * A vertex shader computes `viewProjection * (world * position)` and the intermediate is a
 * float32. At 9.5km down this course the rider is about 11,300m from the origin — 9,500 along
 * and 6,100 below — and a float32 near 11,300 resolves to about 2mm. Every vertex is therefore
 * snapped to a 2mm lattice before the camera is subtracted from it, and the camera is subtracted
 * from it: two large, nearly equal numbers cancelling down to a few metres of view space, with
 * the rounding error surviving at full size. As the camera moves, each vertex lands on a
 * different lattice point, and edges crawl.
 *
 * That is the shimmer on the rocks: not two surfaces fighting over the depth buffer — pushing
 * them apart made it worse, which is the wrong direction for a depth fight — but every edge in
 * the scene jittering, showing up first where the contrast is highest, which is a white snow cap
 * against grey stone. Measured on one boulder over sixteen frames of camera drift: 20 flickering
 * pixels at the top of the mountain, 139 at 9.5km, and it grows with *both* z and y.
 *
 * So the drawing is done in a frame that stays near the rider. Every renderer subtracts this
 * offset when it writes a position, the camera subtracts it too, and the difference — which is
 * all the GPU ever sees — stays under a kilometre. At a kilometre a float32 resolves to about
 * 0.06mm, which is thirty times finer than the wobble that was showing.
 *
 * Nothing about the world moves. This is a change of coordinates for rendering only, and the
 * physics, the scoring, the course and every test go on speaking in absolute metres.
 */

/**
 * How far the rider may drift from the current origin before it is moved, in metres.
 *
 * Generous on purpose. Every metre of slack costs precision that is not in short supply — even
 * at the far end of this the numbers are tiny compared to what they replaced — while every
 * rebase costs a pass over the live chunks, the instance buffers and the trail. 512m at racing
 * speed is one rebase every ten seconds or so.
 */
const REBASE_DISTANCE = 512;

/**
 * Grid the origin snaps to. Rebases then land on round numbers and repeat exactly for a given
 * run, which keeps a rendering change out of the seeded-course guarantee and makes the whole
 * thing reproducible in a test.
 */
const ORIGIN_GRID = 256;

function snap(v: number): number {
  return Math.round(v / ORIGIN_GRID) * ORIGIN_GRID;
}

export class WorldOrigin {
  x = 0;
  y = 0;
  z = 0;

  /**
   * Bumped every time the offset moves.
   *
   * Renderers that cache world positions in a buffer — chunk transforms, instance matrices, the
   * trail — compare against the version they last wrote and rebuild when it has changed. A
   * renderer that forgets to do this does not fail quietly: its geometry is left in the old
   * frame and visibly slides away from everything else.
   */
  version = 0;

  /** Put the origin on the rider and start again. Called when a run starts or resumes. */
  reset(x: number, y: number, z: number): void {
    this.x = snap(x);
    this.y = snap(y);
    this.z = snap(z);
    this.version++;
  }

  /**
   * Move the origin if the rider has drawn too far from it. Returns true if it moved.
   *
   * Checked per axis rather than by true distance: y falls almost as fast as z advances once
   * the fall line steepens, and a rider who has dropped 600m has lost just as much precision as
   * one who has travelled 600m along.
   */
  follow(x: number, y: number, z: number): boolean {
    if (
      Math.abs(x - this.x) <= REBASE_DISTANCE &&
      Math.abs(y - this.y) <= REBASE_DISTANCE &&
      Math.abs(z - this.z) <= REBASE_DISTANCE
    ) {
      return false;
    }
    this.reset(x, y, z);
    return true;
  }
}

export { REBASE_DISTANCE, ORIGIN_GRID };
