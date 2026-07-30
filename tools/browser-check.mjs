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
const restart = async () => {
  await page.evaluate(() => window.__game.startRun(window.__game.seed));
  await page.waitForTimeout(250);
};
// Held with a touch, not `page.mouse`. This context emulates a phone, and Chromium suppresses
// the compatibility mouse events there — `page.mouse.down()` produces a pointerdown and no
// mousedown at all, so a mouse-driven measurement here silently measures nothing. The mouse
// path is covered separately at the end, in a desktop context where it actually exists.
const touchAt = (fraction, phase) =>
  page.evaluate(
    ([f, p]) => {
      const canvas = document.querySelector("#game");
      const r = canvas.getBoundingClientRect();
      const mk = () => [
        new Touch({
          identifier: 700,
          target: canvas,
          clientX: r.left + r.width * f,
          clientY: r.top + r.height * 0.7,
        }),
      ];
      const touches = p === "end" ? [] : mk();
      canvas.dispatchEvent(
        new TouchEvent(p === "end" ? "touchend" : "touchstart", {
          touches,
          targetTouches: touches,
          changedTouches: mk(),
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [fraction, phase],
  );

const headingAfterHold = async (fraction, ms) => {
  await restart();
  const before = await page.evaluate(() => window.__game.controller.heading);
  await touchAt(fraction, "start");
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => window.__game.controller.heading);
  const state = await page.evaluate(() => window.__game.state);
  await touchAt(fraction, "end");
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

// --- The very first touch of the page must leave nothing behind ----------------------------
// Driven through the browser's own input pipeline rather than synthesised, because the fault
// this guards lived in the *ordering* of real events: the browser fires pointerdown before
// touchstart, so a page that also listened to Pointer Events picked the finger up before it
// knew touch events were coming, and skipped it on release once it did. That left a contact
// stuck for the life of the page, holding a turn the player had let go of. Only a real tap
// reproduces it; a dispatched event does not.
await restart();
const firstTouch = await page.evaluate(() => ({ before: window.__game.input.touchCount }));
await page.touchscreen.tap(120, 700);
await page.waitForTimeout(150);
const afterTap = await page.evaluate(() => ({
  contacts: window.__game.input.touchCount,
  steer: window.__game.input.value,
  rings: [...document.querySelectorAll(".touch-dot")].filter((d) => d.style.display !== "none")
    .length,
}));
if (firstTouch.before !== 0) fail(`started with ${firstTouch.before} contacts already`);
else if (afterTap.contacts !== 0)
  fail(`a tap left ${afterTap.contacts} contact(s) behind, steering ${afterTap.steer.toFixed(2)}`);
else if (afterTap.rings !== 0) fail(`a tap left ${afterTap.rings} ring(s) on screen`);
else console.log(`✓ the first real tap leaves no contact and no ring behind`);

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

// --- A finger still on the glass must survive a reset --------------------------------------
// input.reset() runs on startRun, pause and resume, and it deliberately keeps the fingers. A
// thumb already down and not moving sends no events, so clearing the list stranded it: no ring
// and no turn, right when a run begins. Keeping it is also the honest answer for a control
// that maps position to turn — the finger really is there.
await restart();
const stranded = await page.evaluate(`(() => {
  ${touchScript}
  const g = window.__game;
  send("touchstart", [0.97], [0.97]);
  const held = steer();
  g.pause();
  const paused = steer(); // the finger is still down, so it is still steering
  g.resume();
  send("touchmove", [0.97], [0.97]); // same finger, never lifted
  const afterResume = steer();
  send("touchend", [], [0.97]);
  return { held, paused, afterResume, after: steer() };
})()`);
if (!(stranded.held > 0.8)) fail(`finger down gave ${stranded.held.toFixed(2)}`);
else if (!(stranded.paused > 0.8))
  fail(`a finger held across a pause was dropped: steer ${stranded.paused.toFixed(2)}`);
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

  // What the rider collides with, against how wide the mesh actually is down where the rider
  // passes. Foliage above head height is passed under rather than through, so a collider is
  // only fair if the tree is really there in that band — the bare dead fir carried the same
  // 0.7m collider as the broad firs while being a 0.22m trunk, and crashed people against
  // empty snow. Measured off the built mesh, since the unit test reads the same table the
  // mesh is generated from and would not notice the two drifting apart.
  const RIDER_HEIGHT = 1.8;
  const colliders = [];
  for (const v of Object.keys(declared.tree)) {
    const mesh = g.scene.meshes.find((m) => m.name === `tree${v}`);
    if (!mesh) continue;
    const pos = mesh.getVerticesData("position");
    let widest = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] > RIDER_HEIGHT) continue;
      widest = Math.max(widest, Math.hypot(pos[i], pos[i + 2]));
    }
    // Recovered at scale 1 from any obstacle of this variant
    let hit = null;
    for (let i = 2; i < 400 && hit === null; i++) {
      for (const o of g.obstacles.slice(i)) {
        if (o.kind === 0 && String(o.variant) === v) {
          hit = o.hitRadius / o.scale;
          break;
        }
      }
    }
    colliders.push({ variant: v, hit, widest: +widest.toFixed(2) });
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
  return { trees: [...seen.tree].sort(), rocks: [...seen.rock].sort(), mismatches, colliders };
});
if (variants.trees.length < 5 || variants.rocks.length < 5)
  fail(
    `not all shapes in use: ${variants.trees.length} tree, ${variants.rocks.length} rock variants`,
  );
else if (variants.mismatches.length)
  fail(`collider does not match the mesh — ${variants.mismatches.join("; ")}`);
else {
  const wider = variants.colliders.filter((c) => c.hit === null || c.hit > c.widest + 0.1);
  if (wider.length)
    fail(
      `collider claims room the tree does not occupy at rider height — ` +
        wider
          .map((c) => `tree${c.variant}: hits at ${c.hit}m, only ${c.widest}m wide`)
          .join("; "),
    );
  else
    console.log(
      `✓ 5 tree and 5 rock shapes, every collider matching its mesh and inside its silhouette ` +
        `(${variants.colliders.map((c) => `${c.hit}/${c.widest}`).join(" ")})`,
    );
}

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

// --- The local leaderboard -------------------------------------------------------------------
// The unit tests cover the store; this covers what they cannot — that runs which actually end
// put rows on the screen, in the right order, dated from the clock, and identified by the seed
// that was ridden. A custom seed has to appear exactly as it was typed: it is the only way back
// to that course. A best in the pre-timestamp format is planted to check it stays out, since
// there is no honest date to give it.
{
  await page.goto(`${BASE}?seed=alpine&debug=1`, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("downhill.best.old-favourite", "4321");
    localStorage.setItem(
      "downhill.scores.v1",
      JSON.stringify([
        // Written before distances were kept, but on the course as it stands: still listed,
        // with a dash where the metres go rather than a zero or a blank.
        { seed: "before-distances", score: 4321, at: Date.now() - 9e7, gen: 2 },
        // Set on the mountain as it was before it kept getting harder past 1300m. Not
        // comparable with anything set now, so it should be gone from the list *and* from
        // storage — an unstamped record is generation 1 by definition.
        { seed: "old-mountain", score: 99999, at: Date.now() - 9e7 },
      ]),
    );
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

  // A fixed date rather than today's, so the row is the same whenever this runs. The label
  // itself is formatted in the browser's locale ("15 Jan 2026" here, "Jan 15, 2026" in a
  // US one), so it is checked by its parts rather than as one string.
  const ride = async (seed) => {
    await page.evaluate((s) => window.__game.startRun(s), seed);
    await page.waitForTimeout(1500);
    // Ends the run wherever the rider has got to, rather than waiting on a tree
    await page.evaluate(() => window.__game.endRun("crash"));
    await page.waitForSelector("#end:not([hidden])", { timeout: 10000 });
    const ended = {
      score: (await page.textContent("#end-score")).replace(/\D/g, ""),
      dist: (await page.textContent("#end-dist")).replace(/\D/g, ""),
    };
    await page.click("#btn-menu");
    return ended;
  };
  const custom = await ride("powder-chute-42");
  await ride("daily-2026-01-15");

  await page.click("#btn-scores");
  await page.waitForSelector("#scores:not([hidden])", { timeout: 5000 });
  await shot("07-scores");

  const rows = await page.$$eval("#scores-list .score-row", (els) =>
    els.map((el) => ({
      seed: el.querySelector(".score-seed").textContent.trim(),
      score: el.querySelector(".score-value").textContent.replace(/,/g, ""),
      when: el.querySelector(".score-when").textContent.trim(),
      dist: el.querySelector(".score-dist").textContent.trim(),
    })),
  );
  const shown = rows.map((r) => `${r.seed} ${r.score}/${r.dist} (${r.when})`).join(" · ");

  if (rows.length !== 3) fail(`leaderboard shows ${rows.length} rows, expected 3 — ${shown}`);
  else if (!/\b15\b/.test(rows[0].seed) || !/jan/i.test(rows[0].seed) || !/2026/.test(rows[0].seed))
    fail(`daily row is labelled "${rows[0].seed}", expected the date it encodes (2026-01-15)`);
  else if (!rows[0].when.startsWith("Daily"))
    fail(`daily row is not tagged as one: "${rows[0].when}"`);
  else if (rows[1].seed !== "powder-chute-42")
    fail(`custom seed row does not name the seed: ${JSON.stringify(rows[1])}`);
  else if (rows[1].score !== custom.score)
    fail(`custom seed row scored ${rows[1].score}, the run ended on ${custom.score}`);
  else if (rows[1].when !== "just now")
    fail(`a run that just ended is dated "${rows[1].when}"`);
  else if (rows[1].dist.replace(/\D/g, "") !== custom.dist)
    fail(`custom row says ${rows[1].dist}, but that run ended at ${custom.dist}m`);
  else if (!/m$/.test(rows[1].dist)) fail(`distance is unitless: "${rows[1].dist}"`);
  else if (rows[2].dist !== "—")
    fail(`a record with no distance shows "${rows[2].dist}" instead of a dash`);
  else if (rows.some((r) => r.seed === "old-favourite"))
    fail(`a best with no recorded time was listed anyway: ${shown}`);
  else if (rows.some((r) => r.seed === "old-mountain"))
    fail(`a score from the earlier, easier course was listed anyway: ${shown}`);
  else if (
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("downhill.scores.v1") ?? "[]").some(
        (r) => r.seed === "old-mountain",
      ),
    )
  )
    fail("a score from the earlier course was hidden from the list but left on the device");
  else console.log(`✓ leaderboard, newest first: ${shown}`);

  // Every row rides its seed. Checked on the *daily* row, which is the only one that can tell
  // the difference: its label is a formatted date, so a row riding what it displays rather
  // than what it stored would start a course seeded "Jan 15, 2026". On a custom row the label
  // and the seed are the same string, and the check would pass either way.
  await page.click("#scores-list li:nth-child(1) .score-row");
  await page.waitForSelector("#hud:not([hidden])", { timeout: 10000 });
  await page.waitForTimeout(600);
  const started = await page.evaluate(() => ({
    seed: window.__game.seed,
    state: window.__game.state,
    dist: window.__game.controller.distance,
    scoresOpen: !document.querySelector("#scores").hidden,
  }));
  if (started.seed !== "daily-2026-01-15")
    fail(`riding a row started "${started.seed}", not the seed it stored`);
  else if (started.state !== "playing" || !(started.dist > 0))
    fail(`riding a row did not start a run: ${JSON.stringify(started)}`);
  else if (started.scoresOpen) fail("the leaderboard stayed up over the run");
  else console.log(`✓ a row rides its own seed (${started.seed}, ${started.dist.toFixed(0)}m in)`);
}

console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join("\n")}` : "\n✓ no console errors");
// --- A run you walk away from still counts ------------------------------------------------
// The score used to reach the leaderboard from exactly two places: the crash, and the
// out-of-bounds timer. Pausing and changing seed, restarting from the pause panel, switching
// apps and never coming back, or closing the tab all threw the run away without a word.
{
  const stored = (seed) =>
    page.evaluate((s) => {
      const raw = localStorage.getItem("downhill.scores.v1");
      const rows = raw ? JSON.parse(raw) : [];
      return rows.find((r) => r.seed === s) ?? null;
    }, seed);

  const rideFor = async (seed, ms) => {
    await page.evaluate((s) => window.__game.startRun(s), seed);
    await page.waitForTimeout(ms);
    return page.evaluate(() => ({
      score: window.__game.score.value,
      state: window.__game.state,
    }));
  };

  await page.evaluate(() => localStorage.clear());

  // 1. Paused, then "Change seed". The score is read while the run is frozen, so the
  // comparison is exact — read before pausing it climbs a little further before the click
  // lands, which is what an earlier version of this check tripped over.
  const quit = await rideFor("quit-from-pause", 1300);
  await page.click("#btn-pause");
  await page.waitForSelector("#paused:not([hidden])", { timeout: 5000 });
  const paused = await page.evaluate(() => window.__game.score.value);
  await page.click("#btn-quit");
  await page.waitForSelector("#start:not([hidden])", { timeout: 5000 });
  const afterQuit = await stored("quit-from-pause");

  // 2. The tab going away mid-run, with no pause at all. Nothing freezes here, so the run has
  // earned a little more by the time the value is read back — hence a floor, not an equality.
  const gone = await rideFor("tab-closed", 1300);
  const beforeHide = await page.evaluate(() => window.__game.score.value);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const afterHide = await stored("tab-closed");

  if (quit.state !== "playing" || !(quit.score > 0) || !(gone.score > 0))
    fail(`could not get a run going to test quitting: ${JSON.stringify(quit)}`);
  else if (afterQuit === null)
    fail(`pausing and changing seed threw the run away (scored ${quit.score})`);
  else if (afterQuit.score !== paused)
    fail(`quit banked ${afterQuit.score}, the paused run had earned ${paused}`);
  else if (afterHide === null)
    fail(`the tab going away threw the run away (scored ${gone.score})`);
  else if (afterHide.score < beforeHide)
    fail(`pagehide banked ${afterHide.score}, below the ${beforeHide} already earned`);
  else
    console.log(
      `✓ a walked-away run still counts (quit ${afterQuit.score}, tab closed ${afterHide.score})`,
    );
}

// --- The mouse, in a context where it actually exists --------------------------------------
// Everything above runs in an emulated phone, where Chromium suppresses compatibility mouse
// events entirely — so none of it can see the desktop path. This opens a plain desktop context
// to check the mouse still steers and, more importantly, that releasing it lets go: a button
// that sticks down is the desktop form of the phantom contact this build exists to remove.
{
  const desktop = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const dp = await desktop.newPage();
  await dp.goto(`${BASE}?seed=alpine&debug=1`, { waitUntil: "load" });
  await dp.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
  await dp.evaluate(() => window.__game.startRun(window.__game.seed));
  await dp.waitForTimeout(200);

  const b = await dp.locator("#game").boundingBox();
  await dp.mouse.move(b.x + b.width * 0.95, b.y + b.height * 0.7);
  await dp.mouse.down();
  await dp.waitForTimeout(120);
  const held = await dp.evaluate(() => window.__game.input.value);
  await dp.mouse.up();
  await dp.waitForTimeout(120);
  const released = await dp.evaluate(() => ({
    steer: window.__game.input.value,
    contacts: window.__game.input.touchCount,
  }));
  await desktop.close();

  if (!(held > 0.8)) fail(`mouse held right gave ${held.toFixed(2)}`);
  else if (released.steer !== 0 || released.contacts !== 0)
    fail(
      `mouse release left steer ${released.steer.toFixed(2)} and ` +
        `${released.contacts} contact(s)`,
    );
  else console.log(`✓ the mouse steers on desktop, and releasing it lets go`);
}

if (errors.length) process.exitCode = 1;

await browser.close();
console.log(process.exitCode ? "\nBROWSER CHECK FAILED" : "\nBROWSER CHECK PASSED");
