/**
 * The crash.
 *
 * This is where Havok earns its place in the project. Everything up to the moment of impact
 * is hand-integrated arcade motion — deliberately, because it is predictable, cheap and
 * exactly reproducible for a given seed. But a wipeout wants the opposite qualities: it
 * should be chaotic, never the same twice in feel, and physically convincing. So at the
 * moment of impact the rider stops being a controller and becomes an actual rigid body that
 * Havok throws down the mountain.
 *
 * The ground it tumbles against is built once, on impact, from the terrain around the crash
 * site. Keeping a physics collider under the rider for the whole run would mean rebuilding a
 * mesh shape every time the player moved — expensive, and pointless when it is only ever
 * needed for the last two seconds of a run.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import "@babylonjs/core/Physics/physicsEngineComponent"; // adds Scene.enablePhysics

import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";

import type { TerrainField } from "../world/terrain";
import type { RiderController } from "./controller";

/** Radius of the terrain patch built as a collider at the crash site, in metres. */
const PATCH_RADIUS = 26;
/** Grid resolution of that patch. 16 is plenty for a body sliding across it. */
const PATCH_SUBDIV = 16;

/**
 * Boot the Havok WASM module and attach it to the scene.
 *
 * The `locateFile` hook is what makes this work under Vite: the wasm is imported with `?url`
 * so the bundler fingerprints and serves it, and Havok is told where to fetch it from rather
 * than guessing a path relative to the bundle.
 */
export async function initPhysics(scene: Scene): Promise<HavokPlugin> {
  const havok = await HavokPhysics({ locateFile: () => havokWasmUrl });
  const plugin = new HavokPlugin(true, havok);
  scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
  return plugin;
}

export class Wipeout {
  private patch: Mesh | null = null;
  private patchBody: PhysicsAggregate | null = null;
  private proxy: Mesh | null = null;
  private proxyBody: PhysicsAggregate | null = null;

  /** Where the crash happened, for the camera to watch. */
  readonly focus = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly field: TerrainField,
  ) {}

  get active(): boolean {
    return this.proxyBody !== null;
  }

  /**
   * Hand the rider over to the physics engine.
   *
   * `impactX`/`impactZ` is the obstacle that was hit — the body is kicked away from it, so
   * clipping a tree on the left throws you right, which reads as a real collision rather
   * than a scripted animation.
   */
  start(rider: RiderController, impactX: number, impactZ: number): void {
    this.buildGroundPatch(rider.x, rider.z);

    const proxy = new Mesh("crashProxy", this.scene);
    const vd = VertexData.CreateBox({ width: 0.7, height: 1.5, depth: 1.7 });
    vd.applyToMesh(proxy);
    proxy.isVisible = false;
    proxy.position.set(rider.x, rider.y + 0.75, rider.z);
    proxy.rotationQuaternion = Quaternion.RotationYawPitchRoll(rider.heading, 0, 0);
    this.proxy = proxy;

    const body = new PhysicsAggregate(
      proxy,
      PhysicsShapeType.BOX,
      { mass: 72, restitution: 0.28, friction: 0.42 },
      this.scene,
    );

    // Carry the rider's actual momentum into the tumble — a crash at 30 m/s must look
    // dramatically different from one at 8 m/s
    const fx = Math.sin(rider.heading);
    const fz = Math.cos(rider.heading);
    const speed = rider.speed;

    // Deflect away from whatever was hit
    let awayX = rider.x - impactX;
    let awayZ = rider.z - impactZ;
    const len = Math.hypot(awayX, awayZ) || 1;
    awayX /= len;
    awayZ /= len;

    body.body.setLinearVelocity(
      new Vector3(
        fx * speed * 0.55 + awayX * speed * 0.35,
        Math.max(2.5, speed * 0.28),
        fz * speed * 0.55 + awayZ * speed * 0.35,
      ),
    );
    // Tumble rate scales with impact speed
    body.body.setAngularVelocity(
      new Vector3(
        (Math.random() - 0.5) * speed * 0.5,
        (Math.random() - 0.5) * speed * 0.3,
        (Math.random() - 0.5) * speed * 0.5,
      ),
    );

    this.proxyBody = body;
    this.focus.copyFrom(proxy.position);
  }

  /** Current body transform, for the visual rider to follow. Call once per frame. */
  update(): { position: Vector3; rotation: Quaternion } | null {
    if (!this.proxy) return null;
    this.focus.copyFrom(this.proxy.position);
    return {
      position: this.proxy.position,
      rotation: this.proxy.rotationQuaternion ?? Quaternion.Identity(),
    };
  }

  /**
   * A patch of real terrain geometry for the body to tumble across.
   *
   * Built here rather than kept alive during the run: a mesh collider that followed the
   * player would have to be regenerated and re-cooked constantly, for something only the
   * final seconds of a run ever touch.
   */
  private buildGroundPatch(cx: number, cz: number): void {
    const positions: number[] = [];
    const indices: number[] = [];
    const step = (PATCH_RADIUS * 2) / PATCH_SUBDIV;
    const x0 = cx - PATCH_RADIUS;
    const z0 = cz - PATCH_RADIUS;

    for (let j = 0; j <= PATCH_SUBDIV; j++) {
      for (let i = 0; i <= PATCH_SUBDIV; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        positions.push(x, this.field.heightAt(x, z), z);
      }
    }

    const stride = PATCH_SUBDIV + 1;
    for (let j = 0; j < PATCH_SUBDIV; j++) {
      for (let i = 0; i < PATCH_SUBDIV; i++) {
        const a = j * stride + i;
        indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }

    const mesh = new Mesh("crashGround", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = [];
    VertexData.ComputeNormals(positions, indices, vd.normals);
    vd.applyToMesh(mesh);
    mesh.isVisible = false; // the rendered terrain is already there; this is collision only

    this.patch = mesh;
    this.patchBody = new PhysicsAggregate(
      mesh,
      PhysicsShapeType.MESH,
      { mass: 0, friction: 0.6, restitution: 0.1 },
      this.scene,
    );
  }

  stop(): void {
    this.proxyBody?.dispose();
    this.patchBody?.dispose();
    this.proxy?.dispose();
    this.patch?.dispose();
    this.proxyBody = null;
    this.patchBody = null;
    this.proxy = null;
    this.patch = null;
  }
}
