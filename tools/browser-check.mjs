/**
 * Browser smoke test.
 *
 * The unit suite covers the maths, but the maths can be perfectly correct while the screen
 * shows nothing at all — three separate rendering bugs during development looked fine to
 * every headless check and rendered an empty sky. So this drives the *built* game in a real
 * browser at a phone viewport, exercises each game state, and saves screenshots to look at.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node tools/browser-check.mjs [outputDir]
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "./.screenshots";
const BASE = process.env.GAME_URL ?? "http://127.0.0.1:4173/";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone-ish portrait
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(`${BASE}?seed=alpine&debug=1`, { waitUntil: "load" });
await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
console.log("✓ booted (Havok wasm loaded, first frame rendered)");
await shot("01-menu");

// --- The mountain must actually be on screen -----------------------------------------------
// Guards the class of bug where geometry streams and culls correctly but draws nothing.
const terrain = await page.evaluate(() => {
  const g = window.__game;
  const chunks = g.scene.meshes.filter((m) => m.name.startsWith("chunk") && m.isEnabled());
  const drawn = chunks.filter((m) => m.getTotalIndices() > 0 && m.isReady());
  return { live: chunks.length, drawn: drawn.length };
});
if (terrain.drawn < 5) fail(`only ${terrain.drawn} terrain chunks drawable`);
else console.log(`✓ terrain: ${terrain.drawn}/${terrain.live} chunks drawable`);

// --- Riding --------------------------------------------------------------------------------
await page.click("#btn-ride");
await page.waitForSelector("#hud:not([hidden])", { timeout: 10000 });
await page.waitForTimeout(1200);
await shot("02-riding");

const hud = async () => ({
  speed: Number(await page.textContent("#hud-speed")),
  dist: Number(await page.textContent("#hud-dist")),
  score: Number((await page.textContent("#hud-score")).replace(/,/g, "")),
});
const riding = await hud();
if (riding.speed <= 0 || riding.dist <= 0) fail(`HUD not advancing: ${JSON.stringify(riding)}`);
else console.log(`✓ riding: ${JSON.stringify(riding)}`);

// --- Steering: holding far right must turn harder than slightly right ----------------------
// Each measurement restarts the run first. Obstacles begin 20m in, and an unsteered rider
// now crashes within a few seconds, so measuring back-to-back would silently take the second
// reading after the run had already ended.
const box = await page.locator("#game").boundingBox();
const restart = async () => {
  await page.evaluate(() => window.__game.startRun(window.__game.seed));
  await page.waitForTimeout(250);
};
const headingAfterHold = async (fraction, ms) => {
  await restart();
  const before = await page.evaluate(() => window.__game.controller.heading);
  await page.mouse.move(box.x + box.width * fraction, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => window.__game.controller.heading);
  const state = await page.evaluate(() => window.__game.state);
  await page.mouse.up();
  await page.waitForTimeout(250);
  if (state !== "playing") fail(`run ended mid-measurement (state ${state})`);
  return after - before;
};

const gentle = await headingAfterHold(0.58, 700);
const hard = await headingAfterHold(0.97, 700);
await shot("03-carving");
console.log(`  turn from slight-right: ${gentle.toFixed(3)} rad, far-right: ${hard.toFixed(3)} rad`);
if (!(hard > gentle && gentle > 0)) fail("steering is not proportional to finger position");
else console.log("✓ steering scales with how far right the finger is");

// --- Multi-touch, driven by real TouchEvents ----------------------------------------------
// The unit tests drive a stand-in for the canvas, so they would still pass if the listeners
// were bound to the wrong element or the wrong event name. These dispatch genuine TouchEvents
// at a phone viewport, which is the only place that is actually checked.
//
// `touches` is the whole contact list on every event, so each helper states what is on the
// glass *after* whatever just happened — an ended touch is simply absent, exactly as the
// browser reports it.
const touchScript = `
  const canvas = document.querySelector("#game");
  const r = canvas.getBoundingClientRect();
  const mk = (f, id) => new Touch({
    identifier: id,
    target: canvas,
    clientX: r.left + r.width * f,
    clientY: r.top + r.height * 0.7,
  });
  // \`changed\` is only the contact this event is about, as a real browser reports it. Passing
  // the whole list there instead would let an implementation that reads changedTouches pass
  // these checks, which is precisely the mistake they exist to catch.
  const send = (type, fractions, changed) => {
    const touches = fractions.map((f, i) => mk(f, 500 + i));
    const changedTouches = (changed ?? fractions).map((f, i) => mk(f, 900 + i));
    canvas.dispatchEvent(new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches,
      bubbles: true, cancelable: true,
    }));
  };
  const steer = () => window.__game.input.value;
`;

await restart();
const handover = await page.evaluate(`(() => {
  ${touchScript}
  const right = (send("touchstart", [0.97], [0.97]), steer());     // right thumb, hard right
  const both = (send("touchstart", [0.97, 0.03], [0.03]), steer()); // left thumb down, right held
  const left = (send("touchend", [0.03], [0.97]), steer());        // right lifts, left still down
  const after = (send("touchend", [], [0.03]), steer());
  return { right, both, left, after };
})()`);
if (!(handover.right > 0.8)) fail(`one finger far right gave ${handover.right.toFixed(2)}`);
else if (Math.abs(handover.both) > 0.2)
  fail(`second finger ignored: steer stayed at ${handover.both.toFixed(2)} with both down`);
else if (!(handover.left < -0.8))
  fail(`handover failed: steer was ${handover.left.toFixed(2)} after the first finger lifted`);
else if (handover.after !== 0) fail(`steer did not straighten up: ${handover.after}`);
else
  console.log(
    `✓ two-finger handover: ${handover.right.toFixed(2)} → ${handover.both.toFixed(2)} → ` +
      `${handover.left.toFixed(2)} → ${handover.after}`,
  );

// --- The reported gesture: a held thumb while the other taps quickly -----------------------
// A thumb held still produces no events of its own, so anything that drops it from the game's
// idea of what is down used to be permanent — and the browser cancels contacts for reasons the
// page never learns about. Reading the whole contact list on every event is what lets the
// tapping thumb's own events carry the held one back.
await restart();
const tapping = await page.evaluate(`(() => {
  ${touchScript}
  send("touchstart", [0.03], [0.03]);      // left thumb, then held still throughout
  const held = steer();
  for (let i = 0; i < 4; i++) {
    send("touchstart", [0.03, 0.97], [0.97]); // right thumb taps
    send("touchend", [0.03], [0.97]);
  }
  send("touchcancel", [0.03], [0.97]);     // browser gives up on a contact mid-sequence
  const afterCancel = steer();
  send("touchstart", [0.03, 0.97], [0.97]); // next tap must re-state the held thumb
  send("touchend", [0.03], [0.97]);
  const recovered = steer();
  send("touchend", [], [0.03]);
  return { held, afterCancel, recovered, after: steer() };
})()`);
if (!(tapping.held < -0.8)) fail(`held thumb gave ${tapping.held.toFixed(2)}`);
else if (!(tapping.recovered < -0.8))
  fail(
    `held thumb lost after tapping: steer was ${tapping.recovered.toFixed(2)} ` +
      `(${tapping.afterCancel.toFixed(2)} right after the cancel)`,
  );
else if (tapping.after !== 0) fail(`steer did not straighten up: ${tapping.after}`);
else
  console.log(
    `✓ held thumb survives quick taps and a cancel (${tapping.held.toFixed(2)} → ` +
      `${tapping.recovered.toFixed(2)})`,
  );

// --- A finger still on the glass after a reset must not be stranded ------------------------
// input.reset() runs on startRun, pause and resume. It no longer tries to remember what is
// down; the next touch event says so.
await restart();
const stranded = await page.evaluate(`(() => {
  ${touchScript}
  const g = window.__game;
  send("touchstart", [0.97], [0.97]);
  const held = steer();
  g.pause();
  const paused = steer(); // reset() has dropped the steer, which is intended
  g.resume();
  send("touchmove", [0.97], [0.97]); // same finger, never lifted
  const afterResume = steer();
  send("touchend", [], [0.97]);
  return { held, paused, afterResume, after: steer() };
})()`);
if (!(stranded.held > 0.8)) fail(`finger down gave ${stranded.held.toFixed(2)}`);
else if (stranded.paused !== 0) fail(`pause did not drop the steer: ${stranded.paused}`);
else if (!(stranded.afterResume > 0.8))
  fail(`finger stranded by reset: steer was ${stranded.afterResume.toFixed(2)} after resume`);
else if (stranded.after !== 0) fail(`release after a reset was ignored: ${stranded.after}`);
else console.log(`✓ a finger held across a pause steers again on resume`);

// --- A ring under every contact the steering is using --------------------------------------
// The markers are drawn from the same contact list the steer is calculated from, not from the
// DOM, so a finger the game has lost has no ring. That is the whole point of them, and it only
// holds if they track that list exactly — hence checking the count and the positions rather
// than merely that something is on screen.
await restart();
const markers = await page.evaluate(`(async () => {
  ${touchScript}
  const dots = () => [...document.querySelectorAll(".touch-dot")]
    .filter((d) => d.style.display !== "none")
    .map((d) => {
      const m = /translate\\(([-0-9.]+)px, ([-0-9.]+)px\\)/.exec(d.style.transform);
      return m ? { x: +m[1], y: +m[2] } : null;
    })
    .filter(Boolean);

  // The rings are refreshed in the render loop, so each state needs a frame to appear
  const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  send("touchstart", [0.2, 0.8], [0.8]);
  await frame();
  const two = dots();
  send("touchend", [0.8], [0.2]);
  await frame();
  const one = dots();
  send("touchend", [], [0.8]);
  await frame();
  const none = dots();
  return { two, one, none, want: [0.2, 0.8].map((f) => r.left + r.width * f) };
})()`);
if (markers.two.length !== 2)
  fail(`expected a ring per contact, got ${markers.two.length} for two fingers`);
else if (markers.two.some((d, i) => Math.abs(d.x - markers.want[i]) > 1))
  fail(
    `rings are not on the contacts: ${JSON.stringify(markers.two.map((d) => Math.round(d.x)))} ` +
      `vs ${JSON.stringify(markers.want.map(Math.round))}`,
  );
else if (markers.one.length !== 1)
  fail(`ring did not clear when a finger lifted: ${markers.one.length} left`);
else if (markers.none.length !== 0)
  fail(`rings left on screen with nothing touching: ${markers.none.length}`);
else console.log(`✓ a ring under every contact, and none left behind`);

// --- The rider is jointed: upper body angulates, knees absorb -------------------------------
// Both are pure animation, so nothing else in the suite would notice them silently breaking.
await restart();
// Knees: ride a stretch and watch the legs work over the terrain. Collision is stubbed out
// for it — an unsteered rider meets a tree within a couple of seconds, and the sample needs
// longer than that to cross enough ground to be worth measuring.
const knees = await page.evaluate(async () => {
  const g = window.__game;
  const legs = g.scene.transformNodes.find((n) => n.name === "riderLegs");
  if (!legs) return { found: false };
  const realHitTest = g.obstacles.hitTest.bind(g.obstacles);
  g.obstacles.hitTest = () => null;

  let minLeg = 9;
  let maxLeg = -9;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 16));
    minLeg = Math.min(minLeg, legs.scaling.y);
    maxLeg = Math.max(maxLeg, legs.scaling.y);
  }
  g.obstacles.hitTest = realHitTest;
  return { found: true, minLeg, maxLeg };
});

await restart();
const joints = await page.evaluate(`(async () => {
  ${touchScript}
  const g = window.__game;
  const hips = g.scene.transformNodes.find((n) => n.name === "riderHips");
  if (!hips) return { found: false };

  // Upper body: hold a hard right and read the extra lean over the whole-body roll
  send("touchstart", [0.97], [0.97]);
  await new Promise((res) => setTimeout(res, 800));
  const right = { steer: g.controller.steer, roll: hips.rotation.z, yaw: hips.rotation.y };
  send("touchend", [], [0.97]);

  return { found: true, right };
})()`);
if (!knees.found || !joints.found) fail("rider has no leg or hip joint");
else if (knees.maxLeg - knees.minLeg < 0.05)
  fail(
    `knees barely move over terrain: leg scale ${knees.minLeg.toFixed(2)}–${knees.maxLeg.toFixed(2)}`,
  );
else if (knees.minLeg < 0.5)
  fail(`knees fold too far: leg scale down to ${knees.minLeg.toFixed(2)}`);
else if (!(joints.right.steer > 0.5))
  fail(`carve did not register: steer ${joints.right.steer.toFixed(2)}`);
else if (!(joints.right.roll < -0.1))
  // Negative roll carries the head toward +x, which is *into* a right-hand turn
  fail(`upper body does not lean into the turn: roll ${joints.right.roll.toFixed(3)}`);
else
  console.log(
    `✓ rider is jointed (knees ${knees.minLeg.toFixed(2)}–${knees.maxLeg.toFixed(2)} of leg, ` +
      `upper body ${((joints.right.roll * 180) / Math.PI).toFixed(0)}° into a hard carve)`,
  );

// --- Pause -----------------------------------------------------------------------------------
await restart();
await page.click("#btn-pause");
await page.waitForSelector("#paused:not([hidden])", { timeout: 5000 });
const frozen = await page.evaluate(() => ({ z: window.__game.controller.z, state: window.__game.state }));
await page.waitForTimeout(1200);
const stillFrozen = await page.evaluate(() => window.__game.controller.z);
await shot("04-paused");
if (frozen.state !== "paused") fail(`pause did not change state (got ${frozen.state})`);
else if (Math.abs(stillFrozen - frozen.z) > 0.01) fail(`world advanced ${(stillFrozen - frozen.z).toFixed(2)}m while paused`);
else console.log("✓ pause freezes the run");

await page.click("#btn-resume");
await page.waitForSelector("#paused", { state: "hidden", timeout: 5000 });
await page.waitForTimeout(600);
const moved = (await page.evaluate(() => window.__game.controller.z)) - stillFrozen;
if (moved < 1) fail(`resume did not restart the run (moved ${moved.toFixed(2)}m)`);
else console.log(`✓ resume continues the run (+${moved.toFixed(1)}m)`);

// The pause button sits on top of the canvas, which is the steering surface. Pressing it
// must not also register as a steer, or the rider would lurch every time you paused.
const steerAfterPause = await page.evaluate(() => window.__game.controller.steer);
if (Math.abs(steerAfterPause) > 0.35) fail(`pause button leaked a steer of ${steerAfterPause.toFixed(2)}`);
else console.log("✓ pausing does not steal a steer input");

// --- Wipeout: put the rider into the next obstacle and watch Havok take over ----------------
await restart();
const crashInfo = await page.evaluate(() => {
  const g = window.__game;
  const c = g.controller;
  const next = g.obstacles.range(c.z + 25, c.z + 140)[0];
  if (!next) return null;
  // Teleport onto it: reaching a specific tree by simulated touch is not practical
  c.x = next.x;
  c.z = next.z - 1.5;
  c.y = g.field.heightAt(c.x, c.z);
  c.heading = 0;
  c.speed = 26;
  return { kind: next.kind, x: next.x, z: next.z };
});
if (!crashInfo) fail("no obstacle found ahead to crash into");

await page.waitForFunction(() => window.__game.state === "crashing", null, { timeout: 8000 })
  .then(() => console.log("✓ collision detected, wipeout started"))
  .catch(() => fail("rider did not crash into the obstacle"));

// Havok must actually move the body, not leave it frozen — and the shadow must go with it.
// The shadow is not parented to the rider, so during a wipeout it is only in the right place
// if something is explicitly driving it; it used to stay where the crash began while the
// rider tumbled away, leaving a blob sitting on empty snow.
const tumble = await page.evaluate(async () => {
  const g = window.__game;
  const shadowMesh = g.scene.meshes.find((m) => m.name === "riderShadow");
  const start = g.wipeout.focus.clone();
  let worstLag = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 30));
    const f = g.wipeout.focus;
    const lag = Math.hypot(shadowMesh.position.x - f.x, shadowMesh.position.z - f.z);
    if (lag > worstLag) worstLag = lag;
  }
  const now = g.wipeout.focus;
  return {
    moved: Math.hypot(now.x - start.x, now.y - start.y, now.z - start.z),
    worstLag,
    physicsBodies: g.scene.getPhysicsEngine()?.getBodies?.().length ?? -1,
  };
});
await shot("05-wipeout");
if (tumble.moved < 1) fail(`crash body barely moved (${tumble.moved.toFixed(2)}m) — is Havok stepping?`);
else console.log(`✓ Havok tumble: body travelled ${tumble.moved.toFixed(1)}m`);
if (tumble.worstLag > 1.5)
  fail(`shadow left behind during the wipeout: ${tumble.worstLag.toFixed(2)}m from the body`);
else console.log(`✓ shadow follows the wipeout (worst lag ${tumble.worstLag.toFixed(2)}m)`);

// --- End screen ----------------------------------------------------------------------------
await page.waitForSelector("#end:not([hidden])", { timeout: 10000 });
await shot("06-end");
const end = {
  title: await page.textContent("#end-title"),
  score: await page.textContent("#end-score"),
  dist: await page.textContent("#end-dist"),
  top: await page.textContent("#end-top"),
  seed: await page.textContent("#end-seed"),
};
console.log("✓ end screen:", JSON.stringify(end));
if (end.title !== "WIPEOUT") fail(`expected WIPEOUT, got ${end.title}`);

// --- Snow spray must survive a crash --------------------------------------------------------
// Regression: a burst leaves Babylon's manualEmitCount at 0, which silently switches the
// system to manual mode forever, so all rate-based spray died after the first crash. Only
// visible on a *second* run, which is exactly what a single-run smoke test never reaches.
await restart();
await page.waitForTimeout(1500);
const spray = await page.evaluate(() => {
  const s = window.__game.spray.system;
  return { active: s.getActiveCount(), rate: s.emitRate, manual: s.manualEmitCount };
});
if (spray.active < 5) {
  fail(`no snow spray on a run after a crash: ${JSON.stringify(spray)}`);
} else {
  console.log(`✓ spray still emitting after a crash (${spray.active} particles)`);
}

// --- Board tracks -----------------------------------------------------------------------------
const tracks = await page.evaluate(() => {
  const g = window.__game;
  const m = g.scene.meshes.find((x) => x.name === "tracks");
  if (!m) return null;
  const pos = m.getVerticesData("position");
  const col = m.getVerticesData("color");
  let visible = 0;
  let onGround = 0;
  for (let i = 0; i < col.length / 4; i++) {
    if (col[i * 4 + 3] > 0.01) {
      visible++;
      // Each vertex should sit just above the terrain it was laid on, not float or sink
      const dy = pos[i * 3 + 1] - g.field.heightAt(pos[i * 3], pos[i * 3 + 2]);
      if (dy > 0 && dy < 0.3) onGround++;
    }
  }

  // Longest gap between consecutive samples where either end is drawn at all
  let longestSpan = 0;
  const samples = col.length / 4 / 2;
  for (let i = 0; i < samples - 1; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    const lit = col[a * 4 + 3] > 0.01 || col[b * 4 + 3] > 0.01;
    if (!lit) continue;
    const d = Math.hypot(pos[b * 3] - pos[a * 3], pos[b * 3 + 2] - pos[a * 3 + 2]);
    if (d > longestSpan) longestSpan = d;
  }
  return { visible, onGround, longestSpan };
});
if (!tracks || tracks.visible < 20) {
  fail(`board left no visible tracks: ${JSON.stringify(tracks)}`);
} else if (tracks.onGround < tracks.visible * 0.9) {
  fail(`tracks not sitting on the snow: ${tracks.onGround}/${tracks.visible} at ground level`);
} else if (tracks.longestSpan > 5) {
  // Samples are laid 0.7m apart, so any quad spanning metres is stray geometry. Unused ring
  // slots used to be parked at the world origin, which drew a wedge from the live trail all
  // the way back to the top of the course. The alpha-only check above could never see it:
  // the far end of that wedge is at alpha 0.
  fail(`stray track geometry: a quad spans ${tracks.longestSpan.toFixed(0)}m`);
} else {
  console.log(
    `✓ board tracks laid on the snow (${tracks.visible} live vertices, ` +
      `longest quad ${tracks.longestSpan.toFixed(2)}m)`,
  );
}

// --- The rider's shadow must lie on the snow, not in a horizontal plane through it ---------
// It is a flat blob about a metre across, and the fall line is 0.40, so a blob that ignores
// the slope has its uphill half buried in the hill and its downhill half floating. What you
// see of it is the intersection with the ground: a hard-edged semicircle rather than a shadow.
// Measured as the worst gap between any shadow vertex and the terrain directly beneath it.
const shadow = await page.evaluate(() => {
  const g = window.__game;
  const mesh = g.scene.meshes.find((m) => m.name === "riderShadow");
  if (!mesh) return { found: false };
  const verts = mesh.getVerticesData("position");
  mesh.computeWorldMatrix(true);
  const world = mesh.getWorldMatrix();
  let worst = 0;
  let extent = 0;
  for (let i = 0; i < verts.length; i += 3) {
    // Transform by hand rather than reaching for Vector3, which is not exposed on window
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    const m = world.m;
    const wx = x * m[0] + y * m[4] + z * m[8] + m[12];
    const wy = x * m[1] + y * m[5] + z * m[9] + m[13];
    const wz = x * m[2] + y * m[6] + z * m[10] + m[14];
    const gap = Math.abs(wy - g.field.heightAt(wx, wz));
    if (gap > worst) worst = gap;
    const r = Math.hypot(wx - mesh.position.x, wz - mesh.position.z);
    if (r > extent) extent = r;
  }
  return { found: true, worst, extent, verts: verts.length / 3 };
});
if (!shadow.found) fail("no rider shadow in the scene");
else if (shadow.worst > 0.2)
  fail(
    `shadow does not follow the slope: a vertex sits ${shadow.worst.toFixed(2)}m off the snow ` +
      `(blob extends ${shadow.extent.toFixed(2)}m)`,
  );
else
  console.log(
    `✓ shadow lies on the slope (worst gap ${shadow.worst.toFixed(3)}m across ` +
      `${shadow.extent.toFixed(2)}m of blob)`,
  );

// --- The shadow must read as height ---------------------------------------------------------
// Spread and fade are what tell the player how high they are, since the rider itself barely
// moves on screen with the camera following it. Sampled at heights a real jump reaches: a
// typical launch is ~0.25m and a good one peaks near 2.4m, and the curves used to be scaled
// for 7m, so the shadow hardly changed for the whole of any actual air.
await restart();
const height = await page.evaluate(() => {
  const g = window.__game;
  const mesh = g.scene.meshes.find((m) => m.name === "riderShadow");
  const c = g.controller;
  const ground = g.field.heightAt(c.x, c.z);
  const sample = (h) => {
    g.rider.placeShadow(c.x, ground + h, c.z, ground, 0, 0, 0, 1);
    return { spread: mesh.scaling.x, alpha: mesh.material.alpha };
  };
  return { ground: sample(0), low: sample(0.8), peak: sample(2.4), silly: sample(30) };
});
const grew = height.peak.spread / height.ground.spread;
const faded = height.peak.alpha / height.ground.alpha;
if (!(grew > 1.4))
  fail(`shadow barely spreads with height: x${grew.toFixed(2)} at a 2.4m jump`);
else if (!(faded < 0.75))
  fail(`shadow barely fades with height: ${(faded * 100).toFixed(0)}% alpha at a 2.4m jump`);
else if (height.silly.spread > 2.5)
  fail(`shadow is unbounded: x${height.silly.spread.toFixed(1)} at 30m up`);
else
  console.log(
    `✓ shadow reads as height (at a 2.4m jump: x${grew.toFixed(2)} wider, ` +
      `${(faded * 100).toFixed(0)}% as strong)`,
  );

// --- Five shapes of each, and every collider matching the shape it belongs to --------------
// The heights that decide what you can jump are written down by hand, one per variant, so
// they can silently drift from the geometry they are supposed to describe. This compares each
// declared height against the mesh actually built for it, and checks all five shapes are in
// use — a variant picker stuck on 0 would look like the old single-tree forest and pass
// everything else.
const variants = await page.evaluate(() => {
  const g = window.__game;
  const seen = { tree: new Set(), rock: new Set() };
  for (let i = 2; i < 400; i++) {
    for (const o of g.obstacles.slice(i)) {
      (o.kind === 0 ? seen.tree : seen.rock).add(o.variant);
    }
  }

  // Declared height at scale 1, recovered from any obstacle of that variant
  const declared = { tree: {}, rock: {} };
  for (let i = 2; i < 400; i++) {
    for (const o of g.obstacles.slice(i)) {
      const bag = o.kind === 0 ? declared.tree : declared.rock;
      bag[o.variant] = o.height / o.scale;
    }
  }

  const mismatches = [];
  for (const kind of ["tree", "rock"]) {
    for (const v of Object.keys(declared[kind])) {
      const mesh = g.scene.meshes.find((m) => m.name === `${kind}${v}`);
      if (!mesh) {
        mismatches.push(`${kind}${v}: no mesh`);
        continue;
      }
      mesh.refreshBoundingInfo();
      const top = mesh.getBoundingInfo().boundingBox.maximum.y;
      const want = declared[kind][v];
      if (Math.abs(top - want) > 0.1) {
        mismatches.push(`${kind}${v}: collider ${want.toFixed(2)}m vs mesh ${top.toFixed(2)}m`);
      }
    }
  }
  return { trees: [...seen.tree].sort(), rocks: [...seen.rock].sort(), mismatches };
});
if (variants.trees.length < 5 || variants.rocks.length < 5)
  fail(
    `not all shapes in use: ${variants.trees.length} tree, ${variants.rocks.length} rock variants`,
  );
else if (variants.mismatches.length)
  fail(`collider does not match the mesh — ${variants.mismatches.join("; ")}`);
else console.log(`✓ 5 tree and 5 rock shapes, every collider matching its mesh`);

// --- Retry, and the same seed must rebuild the same course ---------------------------------
const before = await page.evaluate(() => {
  const g = window.__game;
  return [0, 250, 900, 2400].map((z) => g.field.heightAt(3, z));
});
await page.click("#btn-retry");
await page.waitForSelector("#hud:not([hidden])", { timeout: 10000 });
const after = await page.evaluate(() => {
  const g = window.__game;
  return [0, 250, 900, 2400].map((z) => g.field.heightAt(3, z));
});
if (JSON.stringify(before) !== JSON.stringify(after)) fail("retry rebuilt a different mountain");
else console.log("✓ retry reproduces the identical course");

// The wipeout leaves a rotationQuaternion on the rider node, and Babylon ignores Euler
// `rotation` while one is set — so a missed reset leaves the rider permanently stuck in the
// pose it crashed in, on every run afterwards.
await page.waitForTimeout(500);
const pose = await page.evaluate(() => {
  const r = window.__game.rider.root;
  return { quat: r.rotationQuaternion !== null, yaw: r.rotation.y, heading: window.__game.controller.heading };
});
if (pose.quat || Math.abs(pose.yaw - pose.heading) > 0.01) {
  fail(`rider not reset after crash: ${JSON.stringify(pose)}`);
} else {
  console.log("✓ rider pose resets after a crash");
}

// --- A different seed must give a different course ------------------------------------------
await page.goto(`${BASE}?seed=totally-different&debug=1`, { waitUntil: "load" });
await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
const other = await page.evaluate(() => {
  const g = window.__game;
  return [0, 250, 900, 2400].map((z) => g.field.heightAt(3, z));
});
if (JSON.stringify(other) === JSON.stringify(after)) fail("different seeds produced the same course");
else console.log("✓ a different seed builds a different mountain");

console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join("\n")}` : "\n✓ no console errors");
if (errors.length) process.exitCode = 1;

await browser.close();
console.log(process.exitCode ? "\nBROWSER CHECK FAILED" : "\nBROWSER CHECK PASSED");
