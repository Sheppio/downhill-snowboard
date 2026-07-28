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
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";

import { clamp, clamp01, expDamp, lerp } from "../core/math";
import type { RiderController } from "./controller";

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
  private readonly shadow: Mesh;
  private readonly materials: StandardMaterial[] = [];
  private readonly parts: Mesh[] = [];

  private lean = 0;
  private pitch = 0;
  private roll = 0;
  private crouch = 0;

  constructor(scene: Scene) {
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

    for (const part of this.parts) {
      // Faceted shading is the whole cartoon look; smooth normals would read as plastic
      part.convertToFlatShadedMesh();
      part.parent = this.body;
      part.isPickable = false;
    }

    // --- Blob shadow.
    // A real-time shadow map for one small character costs an extra render pass every frame
    // on a phone, for something the cartoon style does not miss. A soft disc does the job of
    // grounding the rider for almost nothing.
    const shadow = CreateDisc("riderShadow", { radius: 0.85, tessellation: 16 }, scene);
    shadow.rotation.x = Math.PI / 2;
    shadow.bakeCurrentTransformIntoVertices();
    const shadowMat = new StandardMaterial("shadowMat", scene);
    shadowMat.diffuseColor = new Color3(0, 0, 0);
    shadowMat.emissiveColor = new Color3(0.16, 0.28, 0.42);
    shadowMat.alpha = 0.3;
    shadowMat.disableLighting = true;
    shadowMat.backFaceCulling = false;
    shadow.material = shadowMat;
    shadow.isPickable = false;
    this.materials.push(shadowMat);
    this.shadow = shadow;
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
    this.root.position.set(rider.x, rider.y, rider.z);
    this.root.rotation.y = rider.heading; // mesh forward is +z, matching heading 0 = downhill

    // Lean into the carve
    this.lean = expDamp(this.lean, rider.leanAngle, 0.0005, dt);

    // Match the board to the slope: pitch along travel, roll across it.
    // Both are negated against the raw gradient — rotation.x positive drops the nose, and the
    // slope along travel is negative going downhill, so the sign has to flip for the rider to
    // point down the hill rather than rear up out of it.
    const fx = Math.sin(rider.heading);
    const fz = Math.cos(rider.heading);
    const alongSlope = rider.gradX * fx + rider.gradZ * fz;
    const crossSlope = rider.gradX * fz - rider.gradZ * fx;

    const targetPitch = rider.airborne ? -0.12 : -Math.atan(alongSlope);
    // Only partly align to the cross-slope: a real snowboarder stays much closer to upright
    // than the surface does, and full alignment on a bank looks like a falling-over doll.
    const targetRoll = rider.airborne ? 0 : Math.atan(crossSlope) * 0.5;
    this.pitch = expDamp(this.pitch, targetPitch, 0.002, dt);
    this.roll = expDamp(this.roll, targetRoll, 0.002, dt);

    // Crouch low at speed and through hard turns — sells effort without any animation data
    const targetCrouch = clamp01(rider.speed / 30) * 0.16 + Math.abs(rider.steer) * 0.1;
    this.crouch = expDamp(this.crouch, rider.airborne ? 0.02 : targetCrouch, 0.002, dt);

    // Negative lean so the rider tilts *into* the turn. Rotation about +Z carries the head
    // toward -x, so a right-hand carve needs a negative angle; getting this backwards makes
    // the rider lean away from every corner like they are about to fall over outward.
    // Clamped because lean and slope roll stack, and together they can otherwise lay the
    // rider flat against the snow on a banked turn.
    const totalRoll = clamp(this.roll - this.lean, -0.7, 0.7);
    this.body.rotation.set(this.pitch, 0, totalRoll);
    this.body.position.y = -this.crouch;
    this.body.scaling.y = 1 - this.crouch * 0.5;

    // Shadow stays flat on the ground and fades as the rider gets air
    this.shadow.position.set(rider.x, groundY + 0.06, rider.z);
    const height = Math.max(0, rider.y - groundY);
    const shrink = 1 / (1 + height * 0.16);
    this.shadow.scaling.set(shrink, 1, shrink);
    const mat = this.shadow.material as StandardMaterial;
    mat.alpha = lerp(0.32, 0.05, clamp01(height / 7));
  }

  /** Tumble the visual rider while the wipeout physics body drives the root. */
  spin(dt: number): void {
    this.body.rotate(Vector3.Right(), dt * 6.5, Space.LOCAL);
  }

  dispose(): void {
    for (const part of this.parts) part.dispose();
    for (const mat of this.materials) mat.dispose();
    this.shadow.dispose();
    this.body.dispose();
    this.root.dispose();
  }
}
