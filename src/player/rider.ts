/**
 * The snowboarder, built entirely from Babylon primitives.
 *
 * No glTF, no textures, no external assets at all. That is a deliberate trade: a low-poly
 * cartoon rider is exactly the art direction we want, and building it in code means there is
 * nothing to 404, nothing to wait on, and the whole game is one JS bundle. The parts are
 * merged into a single mesh per material so the rider costs a handful of draw calls.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { clamp, clamp01, expDamp, lerp } from "../core/math";
import type { RiderController } from "./controller";
import type { WorldOrigin } from "../world/origin";

/** Bright, saturated, cartoon. Nothing muddy. */
const PALETTE = {
  jacket: new Color3(0.96, 0.26, 0.42), // hot pink-red
  trousers: new Color3(0.16, 0.42, 0.78), // deep blue
  skin: new Color3(0.99, 0.79, 0.62),
  beanie: new Color3(0.02, 0.84, 0.63), // mint
  board: new Color3(1.0, 0.82, 0.4), // sunny yellow
  boardEdge: new Color3(0.13, 0.24, 0.36),
  goggles: new Color3(0.1, 0.16, 0.24),
};

/**
 * The blob shadow's shape, in metres. Longer than it is wide, because what casts it is a
 * board rather than a ball.
 */
const SHADOW_LENGTH = 1.05;
const SHADOW_WIDTH = 0.62;
/**
 * Radii of the alpha falloff rings, as fractions of the edge, with the alpha at each.
 *
 * Most of the blob is solid and only the outer fifth fades. A gentler ramp than this looks
 * correct in isolation and disappears in play: seen at a shallow angle against bright snow,
 * a shadow that is mostly gradient reads as nothing at all.
 */
const SHADOW_RINGS: [radius: number, alpha: number][] = [
  [0.0, 1],
  [0.62, 1],
  [0.84, 0.6],
  [1.0, 0],
];
const SHADOW_SEGMENTS = 32;

/**
 * How the blob answers height off the snow.
 *
 * A shadow spreads and weakens as its occluder lifts away from the surface, and that spread is
 * most of what tells a player how high they are — the rider itself barely moves on screen,
 * because the camera follows it.
 *
 * The numbers are sized against the air the game actually produces, which is the part that was
 * wrong before: measured across seeds, a typical launch is about 0.25m and a good one peaks
 * near 2.4m. Fading out over 7m, as it did, meant the shadow hardly changed for the whole of
 * any real jump. Full spread and near-full fade now land at 4m, so an ordinary jump uses most
 * of the range, and the cap keeps a wipeout that flings the rider high from painting a
 * dinner plate on the snow.
 *
 * Strength on the ground is light on purpose for a separate reason: the sun here is high and
 * snow bounces a great deal of light back, so a strong shadow reads as a decal stuck under the
 * rider. It only has to say "the board is on the snow, and here".
 */
const SHADOW_ALPHA = 0.2;
const SHADOW_MIN_ALPHA = 0.04;
const SHADOW_FADE_HEIGHT = 4;
const SHADOW_SPREAD_PER_M = 0.3;
const SHADOW_MAX_SPREAD = 2.2;

// Scratch values for the shadow's orientation, reused every frame rather than reallocated
const SHADOW_UP = new Vector3();
const SHADOW_FWD = new Vector3();
const SHADOW_RIGHT = new Vector3();
const SHADOW_BASIS = new Matrix();

/**
 * A soft-edged elliptical blob, lying in the XZ plane with its long axis along +z.
 *
 * Built by hand rather than with CreateDisc for the alpha falloff: a disc of flat colour has a
 * hard rim, and a hard rim on a solid tint does not read as a shadow at all — it reads as a
 * sticker on the snow. The alpha is carried in vertex colours so it stays one draw call, and
 * the material's own alpha still scales the whole thing for the airborne fade.
 */
function makeShadowMesh(scene: Scene): Mesh {
  const mesh = new Mesh("riderShadow", scene);
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  // Centre vertex, then one ring of vertices per falloff step
  for (const [r, a] of SHADOW_RINGS) {
    const count = r === 0 ? 1 : SHADOW_SEGMENTS;
    for (let i = 0; i < count; i++) {
      const theta = (i / SHADOW_SEGMENTS) * Math.PI * 2;
      positions.push(Math.cos(theta) * r * SHADOW_WIDTH, 0, Math.sin(theta) * r * SHADOW_LENGTH);
      normals.push(0, 1, 0);
      colors.push(1, 1, 1, a); // white; the tint comes from the material's emissive
    }
  }

  // Fan from the centre to the first ring, then a strip between each pair of rings
  for (let i = 0; i < SHADOW_SEGMENTS; i++) {
    const next = (i + 1) % SHADOW_SEGMENTS;
    indices.push(0, 1 + next, 1 + i);
  }
  for (let ring = 1; ring < SHADOW_RINGS.length - 1; ring++) {
    const inner = 1 + (ring - 1) * SHADOW_SEGMENTS;
    const outer = inner + SHADOW_SEGMENTS;
    for (let i = 0; i < SHADOW_SEGMENTS; i++) {
      const next = (i + 1) % SHADOW_SEGMENTS;
      indices.push(inner + i, inner + next, outer + i);
      indices.push(outer + i, inner + next, outer + next);
    }
  }

  const vd = new VertexData();
  vd.positions = positions;
  vd.colors = colors;
  vd.normals = normals;
  vd.indices = indices;
  vd.applyToMesh(mesh);
  mesh.hasVertexAlpha = true;
  return mesh;
}

/** Where the rider is jointed, in metres above the board's own origin. */
const FOOT_Y = 0.09;
const HIP_Y = 0.59;
const LEG_LENGTH = HIP_Y - FOOT_Y;

/**
 * How far the upper body leans into a turn, in radians at full lock.
 *
 * On top of the whole-body lean, not instead of it. A snowboarder angulates: the board is on
 * edge, and the shoulders and head stay closer to upright over it rather than tipping with it.
 * Separating the two is what makes a hard carve read as effort rather than as the whole figure
 * being rotated, which is what it looked like when one node carried everything.
 */
const UPPER_LEAN = 0.3;
/** A little counter-yaw as well, so the shoulders open toward the inside of the turn. */
const UPPER_TWIST = 0.16;

/**
 * How much of leg length the knees can absorb, and what drives them.
 *
 * The trigger is vertical acceleration rather than any explicit landing event: the ground
 * pushing up through the board is exactly what a rider's knees answer, so the same term covers
 * rolling through a compression and taking a landing, which differ only in size. A landing
 * from a real jump spikes an order of magnitude above an undulation, hence the generous
 * scale and the clamp.
 */
const KNEE_TRAVEL = 0.42;
const KNEE_ACCEL_SCALE = 220;
/** Knees soak up fast and recover slowly, like legs rather than springs. */
const KNEE_RELEASE = 0.06;

function makeMaterial(scene: Scene, name: string, colour: Color3, emissive = 0.22): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = colour;
  // A touch of emissive keeps the cartoon colours vivid in shadow instead of going grey
  mat.emissiveColor = colour.scale(emissive);
  mat.specularColor = new Color3(0.18, 0.18, 0.2);
  mat.specularPower = 48;
  return mat;
}

export class Rider {
  /** Root node: positioned at the rider's feet, yawed to the heading. */
  readonly root: TransformNode;
  /** Child that carries lean and terrain pitch, so the root stays a clean transform. */
  private readonly body: TransformNode;
  /** Pivots at the feet: shortening this bends the knees. */
  private readonly legs: TransformNode;
  /** Everything above the waist, riding on top of the legs. */
  private readonly hips: TransformNode;
  private readonly shadow: Mesh;
  private readonly materials: StandardMaterial[] = [];
  private readonly parts: Mesh[] = [];

  private lean = 0;
  private pitch = 0;
  private roll = 0;
  private crouch = 0;
  private upperLean = 0;
  /** Knee bend from the ground, held separately so it can spike and decay on its own. */
  private absorb = 0;
  private prevVy = 0;

  constructor(
    scene: Scene,
    private readonly origin: WorldOrigin,
  ) {
    this.root = new TransformNode("rider", scene);
    this.body = new TransformNode("riderBody", scene);
    this.body.parent = this.root;

    const boardMat = makeMaterial(scene, "boardMat", PALETTE.board);
    const edgeMat = makeMaterial(scene, "edgeMat", PALETTE.boardEdge, 0.1);
    const jacketMat = makeMaterial(scene, "jacketMat", PALETTE.jacket);
    const trouserMat = makeMaterial(scene, "trouserMat", PALETTE.trousers);
    const skinMat = makeMaterial(scene, "skinMat", PALETTE.skin);
    const beanieMat = makeMaterial(scene, "beanieMat", PALETTE.beanie);
    const gogglesMat = makeMaterial(scene, "gogglesMat", PALETTE.goggles, 0.06);
    this.materials.push(boardMat, edgeMat, jacketMat, trouserMat, skinMat, beanieMat, gogglesMat);

    // --- Board. Rounded by scaling a cylinder rather than lofting a real outline.
    const board = CreateCylinder("board", { height: 1.62, diameter: 1, tessellation: 12 }, scene);
    board.rotation.z = Math.PI / 2; // lie flat, long axis along x...
    board.bakeCurrentTransformIntoVertices();
    board.rotation.y = Math.PI / 2; // ...then along z, the direction of travel
    board.bakeCurrentTransformIntoVertices();
    board.scaling = new Vector3(0.32, 0.075, 1); // narrow and thin
    board.bakeCurrentTransformIntoVertices();
    board.position.y = 0.06;
    board.material = boardMat;

    const stripe = CreateCylinder("stripe", { height: 1.5, diameter: 1, tessellation: 12 }, scene);
    stripe.rotation.z = Math.PI / 2;
    stripe.bakeCurrentTransformIntoVertices();
    stripe.rotation.y = Math.PI / 2;
    stripe.bakeCurrentTransformIntoVertices();
    stripe.scaling = new Vector3(0.12, 0.09, 1);
    stripe.bakeCurrentTransformIntoVertices();
    stripe.position.y = 0.06;
    stripe.material = edgeMat;

    // --- Legs: side-on stance, so the rider faces across the board like a real snowboarder
    const legBack = CreateBox("legBack", { width: 0.19, height: 0.5, depth: 0.22 }, scene);
    legBack.position.set(-0.13, 0.34, -0.26);
    legBack.material = trouserMat;

    const legFront = CreateBox("legFront", { width: 0.19, height: 0.5, depth: 0.22 }, scene);
    legFront.position.set(0.13, 0.34, 0.26);
    legFront.material = trouserMat;

    // --- Torso, slightly rotated so the shoulders open down the hill
    const torso = CreateBox("torso", { width: 0.34, height: 0.52, depth: 0.46 }, scene);
    torso.position.set(0, 0.83, 0);
    torso.rotation.y = 0.18;
    torso.material = jacketMat;

    // --- Arms, out for balance. This silhouette is what reads as "snowboarder" at distance.
    const armL = CreateBox("armL", { width: 0.13, height: 0.13, depth: 0.5 }, scene);
    armL.position.set(-0.04, 1.0, 0.44);
    armL.rotation.x = -0.35;
    armL.material = jacketMat;

    const armR = CreateBox("armR", { width: 0.13, height: 0.13, depth: 0.5 }, scene);
    armR.position.set(0.04, 0.95, -0.44);
    armR.rotation.x = 0.5;
    armR.material = jacketMat;

    const gloveL = CreateSphere("gloveL", { diameter: 0.17, segments: 6 }, scene);
    gloveL.position.set(-0.04, 1.08, 0.68);
    gloveL.material = trouserMat;

    const gloveR = CreateSphere("gloveR", { diameter: 0.17, segments: 6 }, scene);
    gloveR.position.set(0.04, 0.83, -0.66);
    gloveR.material = trouserMat;

    // --- Head
    const head = CreateSphere("head", { diameter: 0.36, segments: 8 }, scene);
    head.position.set(0, 1.26, 0.04);
    head.material = skinMat;

    const beanie = CreateSphere("beanie", { diameter: 0.38, segments: 8, slice: 0.58 }, scene);
    beanie.position.set(0, 1.28, 0.04);
    beanie.material = beanieMat;

    const bobble = CreateSphere("bobble", { diameter: 0.14, segments: 6 }, scene);
    bobble.position.set(0, 1.47, 0.04);
    bobble.material = beanieMat;

    const goggles = CreateBox("goggles", { width: 0.3, height: 0.11, depth: 0.28 }, scene);
    goggles.position.set(0.06, 1.29, 0.06);
    goggles.rotation.y = 0.25;
    goggles.material = gogglesMat;

    this.parts.push(
      board, stripe, legBack, legFront, torso, armL, armR,
      gloveL, gloveR, head, beanie, bobble, goggles,
    );

    // The rider is jointed in two places, which is all a boxy cartoon needs.
    //
    //  - `legs` pivots at the feet, so shortening it bends the knees without lifting the
    //    board off the snow. The board is not a child of it, for the same reason.
    //  - `hips` carries everything above the waist and rides on top of the legs, so it drops
    //    as they compress and can lean independently of the board.
    const legs = new TransformNode("riderLegs", scene);
    legs.parent = this.body;
    legs.position.y = FOOT_Y;

    const hips = new TransformNode("riderHips", scene);
    hips.parent = this.body;
    hips.position.y = HIP_Y;

    const lower = new Set<Mesh>([legBack, legFront]);
    const upper = new Set<Mesh>([torso, armL, armR, gloveL, gloveR, head, beanie, bobble, goggles]);

    for (const part of this.parts) {
      // Faceted shading is the whole cartoon look; smooth normals would read as plastic
      part.convertToFlatShadedMesh();
      if (lower.has(part)) {
        part.parent = legs;
        part.position.y -= FOOT_Y;
      } else if (upper.has(part)) {
        part.parent = hips;
        part.position.y -= HIP_Y;
      } else {
        part.parent = this.body; // board and stripe stay flat on the snow
      }
      part.isPickable = false;
    }

    this.legs = legs;
    this.hips = hips;

    // --- Blob shadow.
    // A real-time shadow map for one small character costs an extra render pass every frame
    // on a phone, for something the cartoon style does not miss. A soft blob does the job of
    // grounding the rider for almost nothing.
    const shadow = makeShadowMesh(scene);
    const shadowMat = new StandardMaterial("shadowMat", scene);
    shadowMat.diffuseColor = new Color3(0, 0, 0);
    // Blue rather than grey, matching the blue the terrain uses for its own shading. A
    // neutral dark shadow reads as a dirty smudge against bright snow.
    shadowMat.emissiveColor = new Color3(0.36, 0.55, 0.78);
    shadowMat.alpha = 0.34;
    shadowMat.disableLighting = true;
    shadowMat.backFaceCulling = false;
    // The blob is deliberately near-coplanar with the snow it sits on, so the small lift in
    // sync() is not enough on its own to stop it z-fighting at distance.
    shadowMat.zOffset = -6;
    shadow.material = shadowMat;
    shadow.isPickable = false;
    shadow.alphaIndex = 6; // after the terrain and the board tracks, before the spray
    this.materials.push(shadowMat);
    this.shadow = shadow;
    this.shadow.rotationQuaternion = Quaternion.Identity();
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
    this.shadow.setEnabled(on);
  }

  /**
   * Sync the visual rider to the controller.
   *
   * Everything here is cosmetic and damped — the simulation never reads any of it back, so
   * lag in the visuals can never affect the physics.
   */
  sync(rider: RiderController, groundY: number, dt: number): void {
    // The wipeout hands this node a rotationQuaternion, and Babylon ignores `rotation`
    // entirely while one is set — without clearing it, the rider stays frozen in whatever
    // pose it crashed in for every subsequent run.
    if (this.root.rotationQuaternion) this.root.rotationQuaternion = null;

    // Interpolated position, not the raw stepped one — see RiderController.renderX
    this.root.position.set(
      rider.renderX - this.origin.x,
      rider.renderY - this.origin.y,
      rider.renderZ - this.origin.z,
    );
    this.root.rotation.y = rider.renderHeading; // mesh forward is +z; heading 0 = downhill

    // Lean into the carve
    this.lean = expDamp(this.lean, rider.leanAngle, 0.0005, dt);

    // Match the board to the slope: pitch along travel, roll across it.
    // Both are negated against the raw gradient — rotation.x positive drops the nose, and the
    // slope along travel is negative going downhill, so the sign has to flip for the rider to
    // point down the hill rather than rear up out of it.
    const fx = Math.sin(rider.renderHeading);
    const fz = Math.cos(rider.renderHeading);
    const alongSlope = rider.gradX * fx + rider.gradZ * fz;
    const crossSlope = rider.gradX * fz - rider.gradZ * fx;

    const targetPitch = rider.airborne ? -0.12 : -Math.atan(alongSlope);
    // Only partly align to the cross-slope: a real snowboarder stays much closer to upright
    // than the surface does, and full alignment on a bank looks like a falling-over doll.
    const targetRoll = rider.airborne ? 0 : Math.atan(crossSlope) * 0.5;
    this.pitch = expDamp(this.pitch, targetPitch, 0.002, dt);
    this.roll = expDamp(this.roll, targetRoll, 0.002, dt);

    // Crouch low at speed and through hard turns — sells effort without any animation data
    const targetCrouch = clamp01(rider.speed / 34) * 0.16 + Math.abs(rider.steer) * 0.1;
    this.crouch = expDamp(this.crouch, rider.airborne ? 0.02 : targetCrouch, 0.002, dt);

    // Knees answer vertical acceleration. Rolling into a compression and taking a landing are
    // the same event at different sizes, so one term covers both rather than needing a
    // landing to be announced. Only upward acceleration counts: being thrown *off* a crest
    // unweights the legs, it does not fold them.
    const vAccel = dt > 0 ? (rider.vy - this.prevVy) / dt : 0;
    this.prevVy = rider.vy;
    const demand = rider.airborne ? 0 : clamp01(vAccel / KNEE_ACCEL_SCALE);
    // Attack immediately, release slowly: legs soak up a hit at once and unfold afterwards.
    this.absorb = Math.max(demand, expDamp(this.absorb, 0, KNEE_RELEASE, dt));

    // Negative lean so the rider tilts *into* the turn. Rotation about +Z carries the head
    // toward -x, so a right-hand carve needs a negative angle; getting this backwards makes
    // the rider lean away from every corner like they are about to fall over outward.
    // Clamped because lean and slope roll stack, and together they can otherwise lay the
    // rider flat against the snow on a banked turn.
    const totalRoll = clamp(this.roll - this.lean, -0.7, 0.7);
    this.body.rotation.set(this.pitch, 0, totalRoll);

    // Knee bend. The legs shorten from the feet up, so the board stays welded to the snow and
    // the hips drop by exactly what the legs lose — which is what makes it read as absorbing
    // rather than as the whole rider being scaled down.
    const bend = clamp01(this.crouch + this.absorb);
    const legScale = 1 - bend * KNEE_TRAVEL;
    this.legs.scaling.y = legScale;
    this.hips.position.y = FOOT_Y + LEG_LENGTH * legScale;

    // Upper body angulates into the turn on top of the whole-body lean, and opens its
    // shoulders the same way. Negative for the same reason as `lean` above: rotation about +Z
    // carries the head toward -x, so a right-hand carve needs a negative angle.
    this.upperLean = expDamp(this.upperLean, rider.airborne ? 0 : rider.steer, 0.0007, dt);
    this.hips.rotation.set(0, this.upperLean * UPPER_TWIST, -this.upperLean * UPPER_LEAN);

    this.placeShadow(rider.renderX, rider.renderY, rider.renderZ, groundY, rider.gradX, rider.gradZ, fx, fz);
  }

  /**
   * Put the blob shadow on the snow beneath a world position.
   *
   * Separate from `sync` because the wipeout drives the rider from a Havok body and never
   * calls `sync` — which left the shadow parked wherever the crash began while the rider
   * tumbled away from it.
   *
   * `fx`/`fz` are the facing direction the blob's long axis lines up with.
   */
  placeShadow(
    x: number,
    y: number,
    z: number,
    groundY: number,
    gradX: number,
    gradZ: number,
    fx: number,
    fz: number,
  ): void {
    // It lies *on* the slope rather than in a horizontal plane, which is the whole difference
    // between a shadow and a grey semicircle. The fall line is 0.40, so across a blob a metre
    // wide the snow rises and falls about 0.2m; a horizontal disc lifted 0.06m therefore had
    // its uphill half buried in the hill and only its downhill half showing.
    this.shadow.position.set(x - this.origin.x, groundY + 0.05 - this.origin.y, z - this.origin.z);

    // Basis from the surface normal and the direction of travel: y to the normal, z along the
    // board, x across it. Built as axes rather than Euler angles so the blob cannot twist as
    // the heading passes through the poles.
    const nLen = Math.hypot(gradX, 1, gradZ);
    SHADOW_UP.set(-gradX / nLen, 1 / nLen, -gradZ / nLen);
    SHADOW_FWD.set(fx, 0, fz);
    Vector3.CrossToRef(SHADOW_UP, SHADOW_FWD, SHADOW_RIGHT);
    SHADOW_RIGHT.normalize();
    Vector3.CrossToRef(SHADOW_RIGHT, SHADOW_UP, SHADOW_FWD);
    Matrix.FromXYZAxesToRef(SHADOW_RIGHT, SHADOW_UP, SHADOW_FWD, SHADOW_BASIS);
    Quaternion.FromRotationMatrixToRef(SHADOW_BASIS, this.shadow.rotationQuaternion!);

    // Spreads and thins with height, the way a real shadow does as its occluder moves away
    // from the surface. It used to shrink instead, which is backwards, and both curves were
    // scaled for heights the game does not produce: fading out over 7m when a good jump peaks
    // near 2.4m meant the shadow barely changed for the whole of any actual air.
    const height = Math.max(0, y - groundY);
    const spread = Math.min(1 + height * SHADOW_SPREAD_PER_M, SHADOW_MAX_SPREAD);
    this.shadow.scaling.set(spread, 1, spread);
    const mat = this.shadow.material as StandardMaterial;
    mat.alpha = lerp(SHADOW_ALPHA, SHADOW_MIN_ALPHA, clamp01(height / SHADOW_FADE_HEIGHT));
  }

  dispose(): void {
    for (const part of this.parts) part.dispose();
    for (const mat of this.materials) mat.dispose();
    this.shadow.dispose();
    this.body.dispose();
    this.root.dispose();
  }
}
