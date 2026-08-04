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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "./.screenshots";

/**
 * The challenge lines the card can be sent with, restated because this file drives the *built*
 * game and cannot import the source. `sharecard.test.ts` holds the real list to the same rules;
 * what this adds is that the line actually reaching `navigator.share` is one of them, rather
 * than something assembled on the way out. If the list changes, this fails until it is updated,
 * which is the intended amount of friction for user-facing copy.
 */
const CHALLENGES = [
  "Think you can beat that?",
  "Your turn. Try not to hit a tree.",
  "Go on then, beat it.",
  "Reckon you can top that?",
  "Same mountain, same trees. Show me.",
  "Bet you can't beat it.",
  "Your move. I'll wait.",
  "Beat that and I'll believe you.",
  "Let's see you do better.",
  "Come and have a go, if you think you're fast enough.",
];
const BASE = process.env.GAME_URL ?? "http://127.0.0.1:4173/";
mkdirSync(OUT, { recursive: true });

/**
 * Where Chromium is, if it is somewhere Playwright would not look.
 *
 * The dev container ships a browser at a fixed path and no Playwright download; CI installs
 * one the normal way and Playwright finds it itself. Naming the container's path
 * unconditionally worked in exactly one of those places, which is how this check came to be
 * something only ever run by hand.
 */
const chromiumPath =
  process.env.CHROMIUM_PATH ??
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));

const browser = await chromium.launch({
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
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

// --- Sharing the run -------------------------------------------------------------------------
// The card only exists as pixels, so this is the only place it can be checked at all: the unit
// tests drive a recording context and can prove what the card *says*, never that a canvas came
// back with anything on it. Here the real PNG is produced, handed to a stubbed share sheet,
// decoded again and inspected — and saved next to the screenshots to be looked at.
//
// The stub goes in before the run ends, because the card is drawn then rather than on the
// click. That ordering is the point: `navigator.share` needs the click's user activation, and
// awaiting a render inside the handler spends it on iOS.
{
  await page.evaluate(() => {
    window.__shared = null;
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data) => {
        const file = data.files?.[0];
        const keep = (dataUrl) => {
          window.__shared = {
            text: data.text ?? null,
            url: data.url ?? null,
            name: file?.name ?? null,
            type: file?.type ?? null,
            size: file?.size ?? 0,
            dataUrl,
          };
        };
        if (!file) {
          keep(null);
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            keep(reader.result);
            resolve();
          };
          reader.readAsDataURL(file);
        });
      },
    });
  });

  await page.evaluate(() => window.__game.startRun("powder-chute-42"));
  await page.waitForTimeout(1500);
  const ended = await page.evaluate(() => {
    // Forced over a thousand so the score carries a thousands separator. This check rides for
    // a second and a half and earns about seventeen points, and "17" has no comma — which is
    // exactly why the comma colliding with the strap below it survived every previous run of
    // this check and shipped. A real card is far more often four digits than two.
    window.__game.score.total = 4410;
    window.__game.endRun("crash");
    return { score: window.__game.score.value, dist: window.__game.controller.distance };
  });
  await page.waitForSelector("#end:not([hidden])", { timeout: 10000 });

  // Wait for the card itself, not for the button to be renamed.
  //
  // The label was the obvious signal and is the wrong one: it is set when the render promise
  // resolves, and the *previous* run's promise lands about 700ms late — after this block has
  // installed the stub. `navigator.share` is then defined, so that stale promise renames the
  // button while `shareCard` is still null, and the click that follows shares a link. That
  // made this check pass or fail depending on when a promise from a different run happened to
  // settle. Drawing 1080² really does take the better part of a second here.
  await page.waitForFunction(() => window.__game.shareCard != null, { timeout: 15000 });
  const label = await page.textContent("#btn-share");

  await page.click("#btn-share");
  await page.waitForFunction(() => window.__shared != null, { timeout: 10000 });
  const shared = await page.evaluate(() => window.__shared);

  // Decode the PNG the share sheet was handed, and look at it
  const card = shared.dataUrl
    ? await page.evaluate(async (dataUrl) => {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error("the shared PNG would not decode"));
          img.src = dataUrl;
        });
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        const px = c.getContext("2d").getImageData(0, 0, img.width, img.height).data;
        const at = (x, y) => {
          const i = (y * img.width + x) * 4;
          return [px[i], px[i + 1], px[i + 2]];
        };
        const colours = new Set();
        let sun = 0;
        for (let y = 4; y < img.height; y += 12) {
          for (let x = 4; x < img.width; x += 12) {
            const [r, g, b] = at(x, y);
            colours.add(`${r >> 3},${g >> 3},${b >> 3}`);
            // #ffd166, the colour the score is drawn in — proof the text landed, not just a
            // background. Loose enough for the PNG round trip, tight enough to mean it.
            if (Math.abs(r - 255) < 12 && Math.abs(g - 209) < 12 && Math.abs(b - 102) < 12) sun++;
          }
        }
        // Nothing on the card may touch anything else on it.
        //
        // Rows of the upper half are classed as ink or sky by comparing against the sky at that
        // row's left edge — the background is a vertical gradient, so the far left of a row is
        // exactly what that row's empty space looks like. Contiguous ink rows are one block,
        // and what matters is the space between blocks.
        //
        // This exists because a grouped score hangs a comma below its digits, and "4,410" put
        // that comma two pixels from the strap under it while leaving thirty-seven pixels of
        // slack below the strap. Two pixels reads as a collision on a phone. It only appears
        // above a thousand points, which is why the layout looked fine everywhere it had been
        // looked at — so the score planted for this check is deliberately over a thousand.
        const rowBands = [];
        {
          let cur = null;
          for (let y = Math.round(img.height * 0.1); y < img.height * 0.42; y++) {
            const sky = at(4, y);
            let n = 0;
            for (let x = 0; x < img.width; x++) {
              const p = at(x, y);
              if (Math.abs(p[0] - sky[0]) + Math.abs(p[1] - sky[1]) + Math.abs(p[2] - sky[2]) > 40) n++;
            }
            if (n > 3) cur = cur ? ((cur.bottom = y), cur) : { top: y, bottom: y };
            else if (cur) {
              rowBands.push(cur);
              cur = null;
            }
          }
          if (cur) rowBands.push(cur);
        }

        // The build stamp, top right. Ink at 40% over the sky lands near (90,155,186) where
        // bare sky is about (143,220,255), so "noticeably darker than sky" finds the glyphs
        // without needing to read them. Sampled every 2px because the text is 24px tall and a
        // coarse grid walks straight between the strokes.
        let stamp = 0;
        for (let y = Math.round(img.height * 0.015); y < img.height * 0.05; y += 2) {
          for (let x = Math.round(img.width * 0.68); x < img.width * 0.98; x += 2) {
            const [r, g, b] = at(x, y);
            if (r < 120 && g < 190 && b < 230) stamp++;
          }
        }

        return { width: img.width, height: img.height, colours: colours.size, sun, stamp, rowBands };
      }, shared.dataUrl)
    : null;

  if (shared.dataUrl) {
    writeFileSync(`${OUT}/08-share-card.png`, Buffer.from(shared.dataUrl.split(",")[1], "base64"));
  }

  const problems = [];
  if (label !== "Share result") problems.push(`the button still says "${label}"`);
  if (shared.type !== "image/png") problems.push(`shared a ${shared.type ?? "nothing"}, not a PNG`);
  if (!shared.url?.includes("powder-chute-42"))
    problems.push(`the link does not name the seed: ${shared.url}`);
  // A challenge and nothing else. The run is on the picture beside it, and restating it only
  // makes the message long enough to be truncated — taking the link, which is at the end.
  // One of the written challenges — there are ten, picked at random, so the same person
  // getting these does not read the same sentence every time. Checked against the list rather
  // than for a keyword, which would pass for any sentence containing the word.
  if (!CHALLENGES.includes(shared.text ?? ""))
    problems.push(`the message is not one of the challenges: "${shared.text}"`);
  if (/\d/.test(shared.text ?? ""))
    problems.push(`the message repeats what is already on the card: "${shared.text}"`);
  if (!card) problems.push("no image was attached at all");
  else {
    if (card.width !== 1080 || card.height !== 1080)
      problems.push(`the card is ${card.width}x${card.height}, not 1080 square`);
    // A card that failed to draw is a flat fill, or a gradient and nothing else
    if (card.colours < 12) problems.push(`the card is nearly blank — ${card.colours} colours`);
    if (card.sun < 20) problems.push(`the score is not on the card — ${card.sun} pixels of it`);
    // Present, and still a watermark. Both ends matter: the whole point of putting the build on
    // the card is that it survives to whoever is looking at it, and the whole point of it being
    // faint is that it does not compete with the score.
    if (card.stamp < 30)
      problems.push(`the build stamp is not on the card — ${card.stamp} pixels of it`);
    if (card.stamp > 4000)
      problems.push(`the build stamp dominates the corner — ${card.stamp} pixels of it`);
    // Score, strap, rule — three separate things, and they have to stay separate
    if (card.rowBands.length < 3)
      problems.push(`the top of the card ran together into ${card.rowBands.length} block(s)`);
    else {
      const gap = card.rowBands[1].top - card.rowBands[0].bottom;
      if (gap < 12)
        problems.push(
          `the strap is ${gap}px under the score — a grouped score's comma collides with it`,
        );
    }
  }

  if (problems.length) fail(`sharing a run — ${problems.join("; ")}`);
  else
    console.log(
      `✓ shared a ${(shared.size / 1024).toFixed(0)}KB PNG card as "${shared.name}" for a ` +
        `${ended.score}-point run: ${card.width}px square, ${card.colours} colours, ` +
        `${card.stamp}px of build stamp in the corner, sent with ` +
        `"${shared.text}" and a link to the seed`,
    );

  await page.click("#btn-menu");
}

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
  for (const [kind, v] of [
    ...Object.keys(declared.tree).map((v) => ["tree", v]),
    ...Object.keys(declared.rock).map((v) => ["rock", v]),
  ]) {
    const mesh = g.scene.meshes.find((m) => m.name === `${kind}${v}`);
    if (!mesh) continue;
    const pos = mesh.getVerticesData("position");
    let widest = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] > RIDER_HEIGHT) continue;
      widest = Math.max(widest, Math.hypot(pos[i], pos[i + 2]));
    }
    // Recovered at scale 1 from any obstacle of this variant
    const wantKind = kind === "tree" ? 0 : 1;
    let hit = null;
    for (let i = 2; i < 400 && hit === null; i++) {
      for (const o of g.obstacles.slice(i)) {
        if (o.kind === wantKind && String(o.variant) === v) {
          hit = +(o.hitRadius / o.scale).toFixed(2);
          break;
        }
      }
    }
    colliders.push({ variant: `${kind}${v}`, hit, widest: +widest.toFixed(2) });
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
          .map((c) => `${c.variant}: hits at ${c.hit}m, only ${c.widest}m wide`)
          .join("; "),
    );
  else
    console.log(
      `✓ 5 tree and 5 rock shapes, every collider matching its mesh and inside its silhouette ` +
        `(${variants.colliders.map((c) => `${c.variant} ${c.hit}/${c.widest}`).join("  ")})`,
    );
}

// --- The rider's collider has to be the shape of the rider ---------------------------------
// The other half of the same fault. The obstacle colliders above were only one side of "you
// crashed into empty snow": the rider itself was a 0.6m circle, against a mesh under a quarter
// of a metre across and 0.81m long. Sideways is the axis you dodge on, so the error a player
// felt was nearly three times too much collider exactly where it hurt.
//
// Measured off the built mesh, like the obstacle silhouettes, because the unit tests read the
// same constants the game does and cannot see the two drifting apart from the model.
const shape = await page.evaluate(() => {
  const g = window.__game;
  const root = g.scene.getTransformNodeByName("rider");
  // Flatten the rig: this is a measurement of the shape, not of a moment's lean and pitch
  root.rotation.set(0, 0, 0);
  root.position.set(0, 0, 0);
  for (const child of root.getChildren()) child.rotation?.set(0, 0, 0);

  // Each side separately across the board, because the rider is not symmetric about its own
  // axis — the goggles reach past the face on one side only, and the collider is deliberately
  // sized to the body rather than to them.
  let left = 0;
  let right = 0;
  let along = 0;
  for (const m of root.getChildMeshes()) {
    if (m.name.includes("shadow")) continue; // a mark on the snow, not part of the rider
    m.computeWorldMatrix(true);
    m.refreshBoundingInfo();
    const b = m.getBoundingInfo().boundingBox;
    left = Math.max(left, -b.minimumWorld.x);
    right = Math.max(right, b.maximumWorld.x);
    along = Math.max(along, Math.abs(b.minimumWorld.z), Math.abs(b.maximumWorld.z));
  }
  const across = Math.max(left, right);
  const narrower = Math.min(left, right);

  // Where the game's own collision actually starts, found by bisection against a real tree.
  // The rider's dimensions come off the controller, so this is the collider the game plays
  // with rather than one the check supplied to itself.
  const c = g.controller;
  let tree = null;
  for (let i = 3; i < 80 && !tree; i++) {
    for (const o of g.obstacles.slice(i)) if (o.kind === 0) { tree = o; break; }
  }
  const hits = (dx, dz, heading) =>
    g.obstacles.hitTest(
      tree.x + dx, tree.z + dz, tree.y, heading, c.halfWidth, c.halfLength,
    ) === tree;
  const edge = (dir, heading) => {
    let hit = 0, miss = 8;
    for (let i = 0; i < 40; i++) {
      const mid = (hit + miss) / 2;
      if (hits(dir[0] * mid, dir[1] * mid, heading)) hit = mid;
      else miss = mid;
    }
    return miss;
  };
  const RIGHT = [1, 0];
  const AHEAD = [0, 1];
  return {
    mesh: {
      across: +across.toFixed(3),
      narrower: +narrower.toFixed(3),
      along: +along.toFixed(3),
    },
    used: { across: c.halfWidth, along: c.halfLength },
    side: +edge(RIGHT, 0).toFixed(3),
    nose: +edge(AHEAD, 0).toFixed(3),
    turnedSide: +edge(RIGHT, Math.PI / 2).toFixed(3),
    turnedNose: +edge(AHEAD, Math.PI / 2).toFixed(3),
  };
});
{
  const problems = [];
  // The constants have to describe the model, not a shape it used to be. Across, the collider
  // is allowed to sit anywhere between the rider's two sides: it is sized to the body, and the
  // goggles are permitted to overhang it by the centimetre and a half they stick out. What it
  // must never do is claim room outside the silhouette altogether — that is the whole fault.
  const SLACK = 0.02; // rounding, and the difference between a bounding box and a curve
  if (
    shape.used.across > shape.mesh.across + SLACK ||
    shape.used.across < shape.mesh.narrower - SLACK
  )
    problems.push(
      `collides ${shape.used.across}m across a rider that reaches ${shape.mesh.narrower}m one ` +
        `way and ${shape.mesh.across}m the other`,
    );
  if (Math.abs(shape.used.along - shape.mesh.along) > 0.06)
    problems.push(`collides ${shape.used.along}m along a rider ${shape.mesh.along}m long`);

  // The reach itself is the obstacle's radius plus the rider's, and the obstacle's cancels in
  // the difference — so this compares the collider's own proportions against the mesh's,
  // without needing to know the tree or the forgiveness.
  const shapeOfCollider = shape.nose - shape.side;
  const shapeOfMesh = shape.mesh.along - shape.mesh.across;
  if (Math.abs(shapeOfCollider - shapeOfMesh) > 0.08)
    problems.push(
      `collider is ${shapeOfCollider.toFixed(2)}m longer than it is wide, the rider ` +
        `${shapeOfMesh.toFixed(2)}m`,
    );

  // And it has to turn with the board, or "long" and "wide" mean nothing
  if (Math.abs(shape.turnedSide - shape.nose) > 0.03 ||
      Math.abs(shape.turnedNose - shape.side) > 0.03)
    problems.push(
      `turned across the hill the collider still reaches ${shape.turnedSide.toFixed(2)}m ` +
        `sideways and ${shape.turnedNose.toFixed(2)}m ahead, unchanged from ` +
        `${shape.side.toFixed(2)}/${shape.nose.toFixed(2)}`,
    );

  if (problems.length) fail(`the rider's collider is not the rider's shape — ${problems.join("; ")}`);
  else
    console.log(
      `✓ rider collides as a board: ${shape.used.across}m across a body reaching ` +
        `${shape.mesh.narrower}–${shape.mesh.across}m, ${shape.used.along}m along a ` +
        `${shape.mesh.along}m one, stopping at ${shape.side}m beside a tree and ${shape.nose}m ` +
        `ahead of one, and swapping the two when turned across the hill`,
    );
}

// --- Speed ramps: drawn, and paying what they promise ---------------------------------------
// The unit tests prove the arithmetic of the payout. What only a real run can show is that a
// ramp is actually built into the scene, sits where the rider will meet it, and pays through
// the live game loop rather than through a function the tests call themselves.
{
  await page.evaluate(() => window.__game.startRun("alpine"));
  await page.waitForTimeout(500);

  const found = await page.evaluate(() => {
    const g = window.__game;
    const meshes = g.scene.meshes.filter((m) => m.name.startsWith("ramp") && m.isEnabled());
    if (!meshes.length) return null;
    const m = meshes[0];
    m.refreshBoundingInfo();
    const b = m.getBoundingInfo().boundingBox;
    const mat = m.material;
    return {
      count: meshes.length,
      drawable: m.getTotalIndices() > 0 && m.isReady(),
      width: +(b.maximumWorld.x - b.minimumWorld.x).toFixed(2),
      length: +(b.maximumWorld.z - b.minimumWorld.z).toFixed(2),
      x: b.centerWorld.x,
      z: b.minimumWorld.z,
      scroll: mat?.emissiveTexture?.vOffset ?? null,
    };
  });

  if (!found) fail("no ramp was built into the scene");
  else {
    // The chevrons have to move, or they are a painted stripe rather than an invitation
    await page.waitForTimeout(400);
    const scrolled = await page.evaluate(() => {
      const m = window.__game.scene.meshes.find((x) => x.name.startsWith("ramp"));
      return m.material.emissiveTexture.vOffset;
    });

    // Put the rider on the line just short of the ramp and let the real loop ride it through,
    // recording what the game actually handed the controller.
    const paid = await page.evaluate(
      ([x, z]) => {
        const g = window.__game;
        const c = g.controller;
        c.x = x;
        c.z = z - 1.5;
        c.y = g.field.heightAt(c.x, c.z);
        c.heading = 0;
        let boost = 0;
        let lift = 0;
        const real = c.boost.bind(c);
        c.boost = (b, l) => {
          boost += b;
          lift += l;
          real(b, l);
        };

        // What the player sees while it happens. The multiplier is the readout the whole
        // reward is expressed through, so a ramp that pays into the score without moving this
        // is a ramp nobody can tell they took.
        const readMult = () => {
          const el = document.getElementById("hud-mult");
          return el.hidden ? 1 : Number(el.textContent.replace("×", "")) || 1;
        };
        let multBefore = readMult();
        let multPeak = multBefore;
        let barSeen = false;
        const watching = setInterval(() => {
          multPeak = Math.max(multPeak, readMult());
          if (!document.getElementById("hud-boost").hidden) barSeen = true;
        }, 16);

        return new Promise((resolve) =>
          setTimeout(() => {
            c.boost = real;
            clearInterval(watching);
            resolve({ boost, lift, multBefore, multPeak, barSeen });
          }, 700),
        );
      },
      [found.x, found.z],
    );

    const problems = [];
    if (!found.drawable) problems.push("the ramp mesh has nothing to draw");
    if (!(found.length > 3.5 && found.length < 4.5))
      problems.push(`the ramp is ${found.length}m long, not the 4m it should be`);
    // The bounding box runs a little wide of 2m because the ribbon curves with the racing line
    if (!(found.width > 1.8 && found.width < 2.8))
      problems.push(`the ramp is ${found.width}m wide, not the 2m it should be`);
    if (scrolled === found.scroll)
      problems.push(`the chevrons are not moving (vOffset stuck at ${scrolled})`);
    // 20 km/h for the length of it, and this rider covered all of it
    if (!(paid.boost * 3.6 > 17 && paid.boost * 3.6 < 21))
      problems.push(`riding it paid ${(paid.boost * 3.6).toFixed(1)} km/h, not 20`);
    if (!(paid.lift > 0)) problems.push("the lip gave no kick at all");
    // The reward has to be visible, not just banked. Asserted as the *jump* rather than an
    // absolute: the rider is still winding up this early in a run, so the speed half of the
    // multiplier is near 1 and an absolute threshold would be measuring the wrong thing. The
    // ramp bonus is 0.6, and before it existed a ramp moved this by 0.08.
    if (!(paid.multPeak - paid.multBefore > 0.4))
      problems.push(
        `the multiplier went x${paid.multBefore} → x${paid.multPeak} — the ramp pays into the ` +
          `score without showing it`,
      );
    if (!paid.barSeen) problems.push("the boost bar never appeared");

    if (problems.length) fail(`speed ramps — ${problems.join("; ")}`);
    else
      console.log(
        `✓ speed ramps: ${found.count} drawn, ${found.length}×${found.width}m with the ` +
          `chevrons scrolling, and riding one paid ${(paid.boost * 3.6).toFixed(1)}km/h ` +
          `plus a ${paid.lift.toFixed(1)}m/s kick, taking the multiplier ×${paid.multBefore} ` +
          `→ ×${paid.multPeak} with the bar draining`,
      );
  }
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
  await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

  // Which course generation this build stamps its scores with, learned from a record it writes
  // itself rather than written down here. The stamp moves whenever a change makes old scores
  // incomparable, and a literal would silently turn the row below into one more thing to drop
  // — the check would still pass, having stopped testing what it was written for.
  await page.evaluate(() => {
    localStorage.clear();
    window.__game.startRun("stamp-probe");
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__game.endRun("crash"));
  await page.waitForSelector("#end:not([hidden])", { timeout: 10000 });
  const currentGen = await page.evaluate(
    () => JSON.parse(localStorage.getItem("downhill.scores.v1") ?? "[]")[0]?.gen ?? null,
  );
  await page.click("#btn-menu");
  if (currentGen == null) fail("no score was recorded to read the course generation from");

  await page.evaluate((gen) => {
    localStorage.clear();
    localStorage.setItem("downhill.best.old-favourite", "4321");
    localStorage.setItem(
      "downhill.scores.v1",
      JSON.stringify([
        // Written before distances were kept, but on the course as it stands: still listed,
        // with a dash where the metres go rather than a zero or a blank.
        { seed: "before-distances", score: 4321, at: Date.now() - 9e7, gen },
        // Set on an earlier mountain. Not comparable with anything set now, so it should be
        // gone from the list *and* from storage — an unstamped record is generation 1.
        { seed: "old-mountain", score: 99999, at: Date.now() - 9e7 },
      ]),
    );
  }, currentGen);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

  // Re-stub `canShare` now, before anything opens the scores list. The reload above threw away
  // the stub installed for the end-screen share, and the list starts drawing its cards the
  // moment it opens — so a stub installed later than that arrives after `prepareShareCard` has
  // already asked, been told the browser will not take files, and cached a null for every row.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  });

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

  // --- Every row can be shared, not just the run you have only just finished
  // Checked on row 2, a best set by a real run earlier in this check: its card has to be the
  // same card the end screen sent, which means the top speed has to have survived in storage.
  // Row 3 is the other half — a planted record from before those were kept, which has to show
  // dashes rather than "undefined" or a zero.
  {
    await page.evaluate(() => {
      window.__shared = null;
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: (data) => {
          const file = data.files?.[0];
          window.__shared = {
            text: data.text ?? null,
            url: data.url ?? null,
            type: file?.type ?? null,
            size: file?.size ?? 0,
          };
          return Promise.resolve();
        },
      });
    });

    // Opening the list starts the cards; a tap sends whichever one is asked for. The card is
    // never drawn *by* the tap — `navigator.share` needs the tap's own activation and awaiting
    // a render spends it, so anything the tap sends has to already exist.
    //
    // This used to press the button, wait up to fifteen seconds for the card, and only then
    // click. That passed against a build where sharing from this list never attached a picture
    // at all, because no person waits fifteen seconds between pressing a button and releasing
    // it: a card takes ~1.5s to render and a tap lasts a tenth of that. So the click below
    // gets no preparation of its own — no `pointerdown` first, nothing waited for after the
    // list is ready — and if the picture is not already in hand, it is not going out.
    const shareButton = await page.$("#scores-list li:nth-child(2) .score-share");
    if (!shareButton) fail("no share button on the scores rows");
    else {
      const seed2 = await page.evaluate(
        () => document.querySelector("#scores-list li:nth-child(2) .score-share").dataset.shareSeed,
      );
      // Waited on because opening the list is what starts it — an earlier, separate action from
      // the tap under test. This is the window a person spends finding the row they want.
      const ready = await page
        .waitForFunction((seed) => window.__game.listCards?.get(seed) != null, seed2, {
          timeout: 30000,
        })
        .then(() => true)
        .catch(() => false);
      await shareButton.click();
      await page.waitForFunction(() => window.__shared != null, { timeout: 10000 });
      const sent = await page.evaluate(() => window.__shared);
      const tick = await page.textContent("#scores-list li:nth-child(2) .score-share");
      if (!ready) fail("the scores list never drew a card for row 2, however long it was given");

      // What the two rows can actually put on a card, straight out of storage
      const kept = await page.evaluate(() => {
        const rows = JSON.parse(localStorage.getItem("downhill.scores.v1") ?? "[]");
        const of = (seed) => rows.find((r) => r.seed === seed) ?? null;
        return { run: of("powder-chute-42"), old: of("before-distances") };
      });

      const problems = [];
      if (!ready) problems.push("opening the list never drew a card for the row");
      // The regression this whole section exists for: a share from this list that carries no
      // picture. It is not a degraded share, it is the wrong one — the text is a bare challenge
      // precisely because everything about the run is supposed to be on the image beside it, so
      // without the image the message says nothing at all.
      if (sent.type !== "image/png")
        problems.push(`no card was attached — shared a ${sent.type ?? "nothing"}`);
      if (!(sent.size > 10_000)) problems.push(`the card is only ${sent.size} bytes`);
      if (!sent.url?.includes("powder-chute-42"))
        problems.push(`the link does not name the row's seed: ${sent.url}`);
      if (/\d/.test(sent.text ?? "")) problems.push(`the message restates the card: "${sent.text}"`);
      if (tick !== "✓") problems.push(`the row gave no confirmation, it still says "${tick}"`);
      // The card from a row can only match the card from the end screen if the run's top speed
      // was kept. Nothing else in the game stores or shows it, so nothing else would notice.
      if (!(kept.run?.topSpeed > 0))
        problems.push(`the run's top speed was not kept: ${JSON.stringify(kept.run)}`);
      if (!(kept.run?.distance > 0))
        problems.push(`the run's distance was not kept: ${JSON.stringify(kept.run)}`);
      if (kept.old?.topSpeed !== undefined)
        problems.push(`a best from before top speeds were kept invented one: ${kept.old.topSpeed}`);

      if (problems.length) fail(`sharing a scores row — ${problems.join("; ")}`);
      else
        console.log(
          `✓ every scores row shares its own seed: a ${(sent.size / 1024).toFixed(0)}KB card for ` +
            `"powder-chute-42", carrying the ${Math.round(kept.run.topSpeed * 3.6)}km/h and ` +
            `${kept.run.distance}m the run stored — the same card the end screen sends`,
        );
    }
  }

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

  // 1. Paused, then "Change code". The score is read while the run is frozen, so the
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

// --- Typing a seed ------------------------------------------------------------------------------
// `a` and `d` steer, from a handler on `window`, and it used to call preventDefault on every
// match — which cancelled the character before the field could take it. So "alpine" arrived as
// "lpine" and no seed containing an a or a d could be typed at all.
//
// Typed key by key rather than with `fill()`, which sets `value` directly and would sail past
// the bug entirely. This is also why the fault was reported from iPhones and not Android: iOS
// dispatches a real keydown carrying the key, so preventDefault suppresses the character, while
// Android inserts text through composition with keydown as "Unidentified". Chromium here behaves
// like iOS, which is what makes the reproduction possible at all.
{
  await page.goto(`${BASE}?seed=alpine&debug=1`, { waitUntil: "load" });
  await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

  const wanted = "avalanche-42"; // three a's and a d, all of which used to be swallowed
  await page.click("#seed-input");
  await page.evaluate(() => {
    const el = document.querySelector("#seed-input");
    el.value = "";
  });
  await page.keyboard.type(wanted, { delay: 12 });
  const typed = await page.inputValue("#seed-input");

  // And the keystrokes must not have steered while they were being typed
  const steered = await page.evaluate(() => ({
    steer: window.__game.input.value,
    engaged: window.__game.input.isEngaged,
  }));

  if (typed !== wanted) fail(`typed "${wanted}" into the seed box and got "${typed}"`);
  else if (steered.steer !== 0 || steered.engaged)
    fail(`typing a seed left the rider steering at ${steered.steer.toFixed(2)}`);
  else {
    // It must still ride the seed that was typed
    await page.click("#btn-ride");
    await page.waitForSelector("#hud:not([hidden])", { timeout: 10000 });
    const seed = await page.evaluate(() => window.__game.seed);
    if (seed !== wanted) fail(`typed "${wanted}" but rode "${seed}"`);
    else console.log(`✓ a seed can be typed in full ("${typed}") without steering the rider`);
  }
}

// --- A date-shaped code has to be today's -------------------------------------------------------
// The daily run is only a competition while everybody meets the same mountain on the same day
// with the same warning. Typing a date in defeats both halves at once, so the box refuses one
// that is not today — and refusing has to mean the run does not start, not merely that a
// message appears next to a run that started anyway.
{
  await page.evaluate(() => window.__game.showMenu());
  await page.waitForSelector("#start:not([hidden])", { timeout: 10000 });

  const dayOffset = (days) => {
    const d = new Date(Date.now() + days * 86400_000);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  };

  const tryCode = async (code) => {
    await page.fill("#seed-input", code);
    await page.click("#btn-ride");
    await page.waitForTimeout(250);
    return page.evaluate(() => ({
      state: window.__game.state,
      seed: window.__game.seed,
      error: document.getElementById("seed-error")?.hidden
        ? null
        : document.getElementById("seed-error")?.textContent,
    }));
  };

  const problems = [];

  const tomorrow = await tryCode(dayOffset(1));
  if (tomorrow.state !== "menu")
    problems.push(`tomorrow's code started a run (state ${tomorrow.state})`);
  if (!tomorrow.error) problems.push("tomorrow's code was refused without saying why");
  else if (!/hasn't happened/i.test(tomorrow.error))
    problems.push(`odd refusal for tomorrow: "${tomorrow.error}"`);

  const yesterday = await tryCode(dayOffset(-1));
  if (yesterday.state !== "menu")
    problems.push(`yesterday's code started a run (state ${yesterday.state})`);
  if (!yesterday.error) problems.push("yesterday's code was refused without saying why");

  // ...and an ordinary code still rides, so this has not simply broken the box
  const ordinary = await tryCode("powder-chute-42");
  if (ordinary.state === "menu") problems.push("an ordinary code no longer starts a run");
  if (ordinary.seed !== "powder-chute-42") problems.push(`rode "${ordinary.seed}" instead`);

  if (problems.length) fail(`date-shaped codes — ${problems.join("; ")}`);
  else
    console.log(
      `✓ a date-shaped code must be today's: tomorrow refused ("${tomorrow.error}"), ` +
        `yesterday refused ("${yesterday.error}"), an ordinary code still rides`,
    );
}

// --- Landscape ---------------------------------------------------------------------------------
// The game used to call screen.orientation.lock("portrait-primary") on every run. Android
// honours that while fullscreen and iOS ignores it, so turning the phone did nothing on exactly
// one of the two platforms. The spy below is the direct guard against that coming back; the
// rest checks the orientation is actually playable now that it is reachable.
{
  const land = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const lp = await land.newPage();
  const errs = [];
  lp.on("pageerror", (e) => errs.push(e.message));
  await lp.addInitScript(() => {
    window.__lockCalls = [];
    try {
      const o = screen.orientation;
      if (o) o.lock = (which) => (window.__lockCalls.push(which), Promise.resolve());
    } catch {
      /* nothing to stub */
    }
  });
  await lp.goto(`${BASE}?seed=alpine&debug=1`, { waitUntil: "load" });
  await lp.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

  const menu = await lp.evaluate(() => {
    const r = document.querySelector("#start .panel").getBoundingClientRect();
    return { panel: Math.round(r.height), view: window.innerHeight };
  });

  await lp.click("#btn-ride");
  await lp.waitForSelector("#hud:not([hidden])", { timeout: 10000 });
  // Short enough that an unsteered rider is still on its feet. Measured after a crash the
  // framing is `watchCrash`'s, not the chase camera's, and means nothing here.
  await lp.waitForTimeout(700);
  await lp.screenshot({ path: `${OUT}/08-landscape.png` });

  const view = await lp.evaluate(() => {
    const g = window.__game;
    const cam = g.camera.camera;
    const e = g.engine;
    const ar = e.getRenderWidth() / e.getRenderHeight();
    const p = cam.position;
    const t = cam.getTarget();
    const c = g.controller;
    const ry = g.field.heightAt(c.renderX, c.renderZ) + 0.9; // mid-torso
    const pitch = (x, y, z) => Math.atan2(y, Math.hypot(x, z));
    const below = pitch(t.x - p.x, t.y - p.y, t.z - p.z) - pitch(c.renderX - p.x, ry - p.y, c.renderZ - p.z);
    const dist = document.querySelector(".stat-dist").getBoundingClientRect();

    // Does the framing move with the frame rate? Driven by calling the camera directly with
    // different frame times rather than by watching a real run, because this machine renders
    // at about five frames a second and could not see a shimmer if it tried. The camera is
    // deterministic, so two frame times against a frozen world is the whole question.
    //
    // What this catches: the FOV was damped from `camera.fov`, which landscape had already
    // clipped to the 80° cap, so the ratio the look angle is scaled by moved with `dt` and the
    // picture rode up and down about a quarter of a metre. Portrait never clips and never saw it.
    for (let i = 0; i < 30; i++) g.camera.update(g.controller, g.field, 1 / 60);
    const steady = g.camera.lookAt.y;
    g.camera.update(g.controller, g.field, 1 / 30);
    const slowFrame = g.camera.lookAt.y;
    g.camera.update(g.controller, g.field, 1 / 60);
    g.camera.update(g.controller, g.field, 1 / 200);
    const fastFrame = g.camera.lookAt.y;

    return {
      locks: window.__lockCalls,
      state: g.state,
      frameRateShift: Math.max(Math.abs(slowFrame - steady), Math.abs(fastFrame - steady)),
      horizFov: (2 * Math.atan(Math.tan(cam.fov / 2) * ar) * 180) / Math.PI,
      // 0 is the centre of the frame, 1 the bottom edge
      riderDownFrame: 0.5 + 0.5 * (Math.tan(below) / Math.tan(cam.fov / 2)),
      distClearOfCentre: dist.left > window.innerWidth * 0.6 || dist.right < window.innerWidth * 0.4,
      dist: Math.round(g.controller.distance),
    };
  });
  await land.close();

  if (view.locks.length)
    fail(`the orientation was locked to ${view.locks.join(", ")} — landscape is unreachable`);
  else if (view.state !== "playing")
    fail(`the run was ${view.state} when the framing was measured, so it measured nothing`);
  else if (!(view.dist > 0)) fail("the run did not advance in landscape");
  // Both bounded at both ends. A one-sided check let a nonsense camera through: mangling the
  // cap produced a -88° view with the rider 110% *above* the frame, and "not too wide, not too
  // low" was satisfied by both.
  else if (!(view.horizFov > 20 && view.horizFov < 84))
    fail(`landscape shows a ${view.horizFov.toFixed(0)}° view, against portrait's 31°`);
  // Was 0.4–0.92, which the uncapped-ratio bug sat inside at 0.92 exactly. Landscape is meant
  // to frame the rider where portrait does, and portrait puts it at 0.78.
  else if (!(view.riderDownFrame > 0.6 && view.riderDownFrame < 0.86))
    fail(`the rider sits ${(view.riderDownFrame * 100).toFixed(0)}% down the frame`);
  else if (!(view.frameRateShift < 0.002))
    fail(
      `the framing moves with the frame rate: ${(view.frameRateShift * 1000).toFixed(0)}mm ` +
        `between a 30fps frame and a 200fps one, which is the landscape shimmer`,
    );
  else if (!view.distClearOfCentre)
    fail("the distance readout sits over the rider, who is centred in landscape");
  else if (menu.panel > menu.view)
    fail(`the menu is ${menu.panel}px tall in a ${menu.view}px viewport, so it has to be scrolled`);
  else if (errs.length) fail(`landscape console errors: ${errs.join("; ")}`);
  else
    console.log(
      `✓ landscape plays: no orientation lock, ${view.horizFov.toFixed(0)}° wide, rider ` +
        `${(view.riderDownFrame * 100).toFixed(0)}% down the frame and steady across frame ` +
        `times (${(view.frameRateShift * 1000).toFixed(2)}mm), menu ${menu.panel}/${menu.view}px`,
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

// --- A crash says so, instead of freezing --------------------------------------------------
// Last, because it deliberately breaks the page. Anything that throws inside the render loop
// used to leave the player looking at a frozen mountain: Babylon keeps calling the loop, so it
// throws again every frame, and nothing on screen changes or explains itself. `scene.render` is
// made to throw here because it is the real thing the loop calls, rather than a test hook the
// game would have to carry.
{
  const dying = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const dp = await dying.newPage();
  await dp.goto(`${BASE}?seed=alpine&debug=1`, { waitUntil: "load" });
  await dp.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
  await dp.evaluate(() => window.__game.startRun("alpine"));
  await dp.waitForTimeout(900);

  const state = await dp.evaluate(() => {
    localStorage.clear();
    const g = window.__game;
    const earned = g.score.value;
    g.scene.render = () => {
      throw new Error("simulated render failure");
    };
    return { earned, seed: g.seed };
  });

  await dp.waitForSelector("#broken:not([hidden])", { timeout: 10000 }).catch(() => {});
  const after = await dp.evaluate(() => ({
    brokenShown: !document.querySelector("#broken").hidden,
    hudShown: !document.querySelector("#hud").hidden,
    detail: document.querySelector("#broken-detail").textContent,
    canReload: document.querySelector("#btn-reload") != null,
    stored: JSON.parse(localStorage.getItem("downhill.scores.v1") ?? "[]"),
  }));
  await dying.close();

  const problems = [];
  if (!after.brokenShown) problems.push("the game froze without saying anything");
  if (after.hudShown) problems.push("the HUD stayed up over a dead game");
  if (!after.canReload) problems.push("there is no way back except closing the tab");
  if (!/simulated render failure/.test(after.detail ?? ""))
    problems.push(`the panel does not say what happened: "${after.detail}"`);
  // A crash should cost the picture, not the run
  const kept = after.stored.find((r) => r.seed === state.seed);
  if (!(kept?.score > 0)) problems.push(`the run's ${state.earned} points were lost with it`);

  if (problems.length) fail(`a crash mid-run — ${problems.join("; ")}`);
  else
    console.log(
      `✓ a crash stops the game and says so, keeping the ${kept.score} points the run had earned`,
    );
}


// The mountain tips from 0.40 to a 45° face by 10km, and nothing had ever rendered that ground
// — every check above rides the first few hundred metres, where the gradient is still the
// opening one. What makes this worth a section rather than a unit test: the chase camera sits
// *behind* the rider, which on a steep face means uphill, and the ground behind rises to meet
// it. `heightAt` being right says nothing about whether the picture is still a rideable view
// down a mountain or the inside of a snowdrift.
{
  await page.evaluate(() => window.__game.startRun("alpine"));
  await page.waitForFunction(() => window.__game.state === "playing", { timeout: 15000 });

  const depths = [];
  for (const z of [500, 3000, 6000, 9500]) {
    const at = await page.evaluate((target) => {
      const g = window.__game;
      const c = g.controller;
      // Teleport rather than ride: 9.5km at 45 m/s is three and a half minutes of real time,
      // and the question here is about the geometry at a depth, not about getting there.
      c.z = target;
      // Drop into the gulley floor as well as down the mountain. The corridor snakes, so
      // holding x while moving z a kilometre leaves the rider partway up a bank and out of
      // bounds — the screenshots came back captioned RETURN TO COURSE, and the framing was
      // being measured from somewhere no run ever is. The floor is the lowest snow across the
      // corridor, which is inside it by construction.
      {
        // ...and into a gap in the trees, without leaving the gulley to find one.
        //
        // Both halves are needed and each broke the picture on its own. Dropping to the lowest
        // snow put the rider under a spruce and the chase camera inside its foliage — a solid
        // wall of green, twice. Hunting for the widest clearing instead walked out of the
        // corridor entirely and filed a screenshot captioned RETURN TO COURSE.
        //
        // So: stay on the floor, which is the flat band the banks rise from and therefore
        // everything within about a metre of the lowest point across the corridor, and pick
        // the roomiest spot *inside* it. The margin ladder matters because a trunk's collider
        // is 0.7m — that is what you crash into — while the canopy the camera flies through is
        // metres across, and deep in the run the trees are dense enough that a wide gap may
        // simply not exist.
        const clearAt = (x, z, margin) =>
          !g.obstacles.hitTest(x, z, g.field.heightAt(x, z), 0, margin, margin);

        let floorH = Infinity;
        for (let x = c.x - 70; x <= c.x + 70; x += 0.5)
          floorH = Math.min(floorH, g.field.heightAt(x, c.z));

        let bestX = c.x;
        for (const margin of [6, 4, 2.5, c.halfWidth]) {
          const spots = [];
          for (let x = c.x - 70; x <= c.x + 70; x += 0.5) {
            if (g.field.heightAt(x, c.z) > floorH + 1.2) continue; // off the floor, up a bank
            // Behind as well as at the rider — that is where the camera actually sits
            if (![0, -5, -10, -15].every((dz) => clearAt(x, c.z + dz, margin))) continue;
            spots.push(x);
          }
          if (spots.length) {
            bestX = spots[Math.floor(spots.length / 2)]; // middle of the widest run of gaps
            break;
          }
        }
        c.x = bestX;
      }
      c.y = g.field.heightAt(c.x, c.z);
      c.vy = 0;
      c.airborne = false;
      // The interpolation state has to move with it. What gets drawn is a lerp between the two
      // most recent physics steps, so teleporting `z` alone leaves `renderZ` smeared between
      // here and wherever the rider was, and every framing number below would describe a rider
      // that is not on the screen.
      c.prevX = c.x;
      c.prevY = c.y;
      c.prevZ = c.z;
      c.prevHeading = c.heading;
      c.accumulator = 0;
      g.terrain.prime(c.z);
      g.camera.reset(c); // snap rather than damp in from a kilometre away
      for (let i = 0; i < 120; i++) g.camera.update(c, g.field, 1 / 60);
      g.scene.render();

      const cam = g.camera.camera;
      const e = g.engine;
      const ar = e.getRenderWidth() / e.getRenderHeight();
      const p = cam.position;
      const t = cam.getTarget();
      const ry = g.field.heightAt(c.renderX, c.renderZ) + 0.9; // mid-torso
      const pitch = (x, y, z) => Math.atan2(y, Math.hypot(x, z));
      const below =
        pitch(t.x - p.x, t.y - p.y, t.z - p.z) -
        pitch(c.renderX - p.x, ry - p.y, c.renderZ - p.z);

      // The gradient the ground actually has here, straight off the rendered height field.
      //
      // Two corrections, both of which the naive version got wrong by more than the thing it
      // is trying to measure:
      //
      //  - Follow the *floor* of the gulley, taken as the lowest snow across the corridor at
      //    each z, rather than a fixed x. The centreline snakes, so a fixed x slides up onto a
      //    bank and back off it, and the bank is 9m tall — that read 0.42 at 3000m where the
      //    fall line is 0.52, and 0.84 at 6000m where it is 0.72. Bias in both directions,
      //    larger than the whole escalation being checked.
      //  - Regress over ±120m instead of differencing over 2m. The undulation is 4.5m over a
      //    ~48m wavelength, so a short baseline measures whichever roller the rider is sitting
      //    on: that read 0.48 at 500m and 0.34 at 3000m on ground that is flat 0.40 at both.
      const floorAt = (z) => {
        let lowest = Infinity;
        for (let x = c.x - 70; x <= c.x + 70; x += 1) {
          const h = g.field.heightAt(x, z);
          if (h < lowest) lowest = h;
        }
        return lowest;
      };

      // Least squares on height against z: gradient is -slope, undulation falls out as residual
      let sZ = 0, sH = 0, sZZ = 0, sZH = 0, n = 0;
      for (let dz = -120; dz <= 120; dz += 4) {
        const h = floorAt(c.z + dz);
        sZ += dz; sH += h; sZZ += dz * dz; sZH += dz * h; n++;
      }
      const gradient = -(n * sZH - sZ * sH) / (n * sZZ - sZ * sZ);

      // Is the camera above the snow it is flying over, or buried in it?
      const clearance = p.y - g.field.heightAt(p.x, p.z);

      // Take the speed off on the way out, so the run cannot ride away between here and the
      // shutter. The render loop keeps going after `evaluate` returns: at 45 m/s down a 45°
      // face the first version of this filed a picture of the rider cartwheeling through the
      // sky, half a bank from anywhere it had measured. Pausing instead is worse — the rider
      // mesh only follows the controller while playing, so a paused teleport photographs an
      // empty mountain with the rider left a kilometre uphill. Everything returned below was
      // measured above, at the real speed, before this line.
      c.speed = 0;

      return {
        z: target,
        gradient,
        clearance,
        riderDownFrame: 0.5 + 0.5 * (Math.tan(below) / Math.tan(cam.fov / 2)),
        // Terrain actually built here, rather than the rider hanging over a hole
        chunks: g.scene.meshes.filter((m) => m.name.startsWith("chunk") && m.isEnabled()).length,
        ar,
      };
    }, z);
    await shot(`09-deep-${z}m`);
    depths.push(at);
  }

  const problems = [];

  // What the fall line is supposed to be at each depth: flat 0.40 to 1300m, then straight to
  // 1.0 at 10km. Restated here as plain numbers rather than imported, deliberately — this check
  // runs against the built bundle and cannot see the source, so an independent statement of the
  // intended mountain is exactly what is wanted. If `slopeAt` is ever reshaped, these are meant
  // to be edited by hand, having first been looked at.
  const intended = { 500: 0.4, 3000: 0.52, 6000: 0.72, 9500: 0.97 };
  // Measured against the floor of the gulley this comes out on the nose at every depth, so the
  // tolerance is only absorbing the undulation residual left by the regression rather than any
  // systematic bias. Well inside the 0.6 the gradient travels over a run.
  const TOLERANCE = 0.05;

  for (const d of depths) {
    if (!(Math.abs(d.gradient - intended[d.z]) < TOLERANCE))
      problems.push(
        `at ${d.z}m the ground falls at ${d.gradient.toFixed(2)}, not the ${intended[d.z]} intended`,
      );
  }
  for (let i = 1; i < depths.length; i++) {
    if (!(depths[i].gradient > depths[i - 1].gradient + 0.05))
      problems.push(
        `the mountain stops steepening between ${depths[i - 1].z}m and ${depths[i].z}m ` +
          `(${depths[i - 1].gradient.toFixed(2)} then ${depths[i].gradient.toFixed(2)})`,
      );
  }

  for (const d of depths) {
    if (!(d.chunks > 0)) problems.push(`no terrain built at ${d.z}m`);
    // Bounded both ways: buried in the snow, or so far above it the run is a map view
    if (!(d.clearance > 0.5 && d.clearance < 40))
      problems.push(`the camera is ${d.clearance.toFixed(1)}m above the ground at ${d.z}m`);
    // The same window the landscape check holds portrait to. A steeper mountain must not
    // quietly push the rider out of frame, which is exactly what a camera clamped to the
    // ground behind it would do as that ground rises.
    if (!(d.riderDownFrame > 0.55 && d.riderDownFrame < 0.95))
      problems.push(
        `at ${d.z}m the rider sits ${(d.riderDownFrame * 100).toFixed(0)}% down the frame`,
      );
  }

  if (problems.length) fail(`the deep mountain — ${problems.join("; ")}`);
  else
    console.log(
      `✓ the mountain steepens and stays rideable: ` +
        depths
          .map(
            (d) =>
              `${d.z}m grad ${d.gradient.toFixed(2)} (rider ${(d.riderDownFrame * 100).toFixed(0)}% down, ` +
              `cam +${d.clearance.toFixed(1)}m)`,
          )
          .join(", "),
    );
}

// --- The daily continue ------------------------------------------------------------------------
// A daily run ends at the first mistake, so almost nobody ever reaches the part of the mountain
// the game is about. This buys the rest of the run for the price of the day's scoring — which
// only means anything if the price is actually charged, so that is what this checks.
{
  const dp = await ctx.newPage();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  await dp.addInitScript(() => localStorage.clear());
  await dp.goto(`${BASE}?debug=1`, { waitUntil: "load" });
  await dp.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

  await dp.evaluate((seed) => window.__game.startRun(seed), today);
  await dp.waitForFunction(() => window.__game.state === "playing", { timeout: 15000 });
  await dp.waitForTimeout(1200);

  const crashed = await dp.evaluate(() => {
    window.__game.score.total = 1500;
    window.__game.endRun("crash");
    return { z: window.__game.controller.z, score: window.__game.score.value };
  });
  await dp.waitForSelector("#end:not([hidden])", { timeout: 10000 });

  const offered = await dp.evaluate(() => ({
    shown: !document.getElementById("btn-continue").hidden,
    note: document.getElementById("continue-note").textContent,
    stored: JSON.parse(localStorage.getItem("downhill.scores.v1") ?? "[]"),
  }));

  // The first press on a code asks first. Spending the day cannot be undone, so the button that
  // does it is not allowed to do it on one tap.
  await dp.click("#btn-continue");
  await dp.waitForTimeout(300);
  // A panel nobody has looked at is a panel that fits until it doesn't — the tagline that pushed
  // the start screen past a 390px landscape viewport was found this way and not by any assertion.
  await dp.screenshot({ path: `${OUT}/11-confirm-continue.png` });
  const asked = await dp.evaluate(() => ({
    shown: !document.getElementById("confirm-continue").hidden,
    body: document.getElementById("confirm-continue-body").textContent,
    state: window.__game.state,
  }));

  // Backing out has to actually back out — the offer withdrawn, the day untouched. Only pressed
  // if there is something to back out of: with no confirmation at all this button is off-screen,
  // and clicking it would end the section on a locator timeout instead of on the rule that was
  // actually broken.
  if (asked.shown) await dp.click("#btn-cancel-continue");
  await dp.waitForTimeout(300);
  const cancelled = await dp.evaluate(() => ({
    shown: !document.getElementById("confirm-continue").hidden,
    state: window.__game.state,
    spent: (JSON.parse(localStorage.getItem("downhill.continued.v1") ?? "[]")).length > 0,
  }));

  // Ask again after backing out. Read rather than waited for: a gate that fires once and then
  // lets everything through leaves this panel closed, and that should be reported as the rule it
  // broke, not as a locator that timed out.
  await dp.click("#btn-continue");
  await dp.waitForTimeout(300);
  const reAsked = await dp.evaluate(() => !document.getElementById("confirm-continue").hidden);
  if (reAsked) await dp.click("#btn-confirm-continue");
  await dp.waitForFunction(() => window.__game.state === "playing", { timeout: 10000 });
  // Read the instant the run resumes. Whether the rider is on the snow is a question about
  // being *set down*, and a second later they may be over a roller with both feet in the air
  // like anybody else — which is how measuring it late turned a good resume into a failure.
  const atResume = await dp.evaluate(() => ({
    score: window.__game.score.value,
    z: window.__game.controller.z,
    onGround: !window.__game.controller.airborne,
    gap: Math.abs(
      window.__game.controller.y -
        window.__game.field.heightAt(window.__game.controller.x, window.__game.controller.z),
    ),
  }));
  await dp.waitForTimeout(1500);
  // The greyed score is the whole point of this and a number cannot show it
  await dp.screenshot({ path: `${OUT}/10-continued.png` });

  const after = await dp.evaluate(() => ({
    state: window.__game.state,
    z: window.__game.controller.z,
    score: window.__game.score.value,
    // It keeps counting — the riding is real — but greys, because none of it will be kept.

    greyed: document.getElementById("hud-score-block").classList.contains("is-unrecorded"),
    multShown: !document.getElementById("hud-mult").hidden,
    // ...while the distance carries on, because that part is still true
    shownDistance: Number(document.getElementById("hud-dist").textContent.replace(/\D/g, "")),
  }));

  // End it again, having earned more, and check the extra did not count. What was banked
  // *before* continuing is a clean run and keeps standing — the deal is that nothing further
  // counts, not that the run so far is confiscated.
  const banked = await dp.evaluate(() => {
    window.__game.endRun("crash");
    return {
      stored: JSON.parse(localStorage.getItem("downhill.scores.v1") ?? "[]"),
      continueShown: !document.getElementById("btn-continue").hidden,
      note: document.getElementById("continue-note").textContent,
      // What the screen claims about a score that was just refused, and what the card built
      // from it would carry to somebody else
      best: document.getElementById("end-best").textContent,
      strap: window.__game.lastResult?.strap ?? null,
      shown: window.__game.lastResult?.score ?? null,
    };
  });

  // Press it a second time, and check it *does* something.
  //
  // This is where the last version was wrong. It asserted the button came back on offer and
  // never pressed it again — and the offer was drawn from one condition while the action was
  // guarded by another, so the button was there and dead. Second press of a run, and every
  // press on any later run that day. Showing a control is not evidence it works.
  const before2 = await dp.evaluate(() => window.__game.controller.z);
  await dp.click("#btn-continue");
  await dp.waitForTimeout(600);
  const second = await dp.evaluate(() => ({
    state: window.__game.state,
    z: window.__game.controller.z,
    // ...and it does it without asking. The warning is about a cost, and on this press there is
    // no cost left to warn about; repeating it would be a dialog that means nothing.
    asked: !document.getElementById("confirm-continue").hidden,
  }));

  // ...and again on a *later* run that day, which is the other way it died
  await dp.evaluate((seed) => window.__game.startRun(seed), today);
  await dp.waitForFunction(() => window.__game.state === "playing", { timeout: 10000 });
  await dp.waitForTimeout(700);
  await dp.evaluate(() => window.__game.endRun("crash"));
  await dp.waitForSelector("#end:not([hidden])", { timeout: 10000 });
  await dp.click("#btn-continue");
  await dp.waitForTimeout(600);
  const laterRun = await dp.evaluate(() => ({
    state: window.__game.state,
    asked: !document.getElementById("confirm-continue").hidden,
    greyed: document.getElementById("hud-score-block").classList.contains("is-unrecorded"),
    // The target beside it does *not* grey. It is the number to beat either way, and dimming it
    // says the target has somehow moved. Read here rather than on the first continue, where the
    // score has just equalled the best and the target is hidden — nothing to compare.
    bestShown: !document.getElementById("hud-best").hidden,
    scoreColour: getComputedStyle(document.getElementById("hud-score")).color,
    bestColour: getComputedStyle(document.getElementById("hud-best")).color,
  }));
  await dp.evaluate(() => window.__game.endRun("crash"));
  await dp.waitForSelector("#end:not([hidden])", { timeout: 10000 });

  // A *fresh* run on a continued day is a clean attempt: it counts, and it is drawn as
  // counting, right up to the moment it climbs past the best already stored. Past that it keeps
  // climbing — the run is real — but greys, because nothing above that line will be saved.
  await dp.evaluate((seed) => window.__game.startRun(seed), today);
  await dp.waitForFunction(() => window.__game.state === "playing", { timeout: 10000 });
  await dp.waitForTimeout(800);
  const rerun = await dp.evaluate(() => ({
    score: window.__game.score.value,
    best: JSON.parse(localStorage.getItem("downhill.scores.v1") ?? "[]").find(
      (r) => r.seed === window.__game.seed,
    )?.score,
    greyed: document.getElementById("hud-score-block").classList.contains("is-unrecorded"),
  }));

  // Push it past the stored best and let it run on
  const above = await dp.evaluate(async () => {
    const g = window.__game;
    g.score.total = 3000;
    await new Promise((r) => setTimeout(r, 700));
    return {
      score: g.score.value,
      greyed: document.getElementById("hud-score-block").classList.contains("is-unrecorded"),
      multShown: !document.getElementById("hud-mult").hidden,
      // The multiplier legitimately hides below x1.02, and whether the rider is under that at
      // this instant is luck — it depends on how fast they happen to be going. Asserting it is
      // shown without asking what it *is* fails on a slow moment and says nothing about the
      // rule under test.
      multiplier: g.score.multiplierAt(g.controller.speed),
    };
  });
  // Let frames actually pass before asking whether the number moved. Read back-to-back with
  // `above` it was a coin toss — an evaluate round-trip is a couple of milliseconds and a frame
  // is sixteen, so an unchanged score meant "no frame ran", not "the score is frozen", which is
  // the thing under test. Also reported alongside the state: if the rider crashed in the
  // meantime the score stops for a reason that has nothing to do with the best.
  await dp.waitForTimeout(400);
  const climbed = await dp.evaluate(() => ({
    score: window.__game.score.value,
    state: window.__game.state,
  }));
  const stillClimbing = climbed.score;

  // ...and that an ordinary course never offers it at all
  await dp.evaluate(() => window.__game.startRun("powder-chute-42"));
  await dp.waitForFunction(() => window.__game.state === "playing", { timeout: 10000 });
  await dp.waitForTimeout(600);
  const custom = await dp.evaluate(() => {
    window.__game.endRun("crash");
    return { shown: !document.getElementById("btn-continue").hidden };
  });

  // The question is asked per code, not once per player. Every code has its own day to lose, so
  // being warned about Tuesday's is no reason to spend Wednesday's without being asked.
  //
  // Standing in for a second code by rewriting the record of which codes have been spent: a
  // genuinely different daily code only exists on a different day, and this asks the same
  // question — is the gate keyed on *this* seed, or on having ever continued anything? A
  // one-time flag passes every other assertion here and fails this one.
  await dp.evaluate(() => localStorage.setItem("downhill.continued.v1", '["20200101"]'));
  await dp.evaluate((seed) => window.__game.startRun(seed), today);
  await dp.waitForFunction(() => window.__game.state === "playing", { timeout: 10000 });
  await dp.waitForTimeout(600);
  await dp.evaluate(() => window.__game.endRun("crash"));
  await dp.waitForSelector("#end:not([hidden])", { timeout: 10000 });
  await dp.click("#btn-continue");
  await dp.waitForTimeout(400);
  const freshCode = await dp.evaluate(() => ({
    asked: !document.getElementById("confirm-continue").hidden,
    state: window.__game.state,
  }));

  const problems = [];
  if (!offered.shown) problems.push("a daily run did not offer the continue");
  // Looked up by seed rather than counted. The game opens on today's daily, and if the UTC day
  // happens to roll over mid-check the seed it opened on is not the seed being ridden — a count
  // then reads as a failure about scoring when it is really a failure about midnight.
  const cleanRun = offered.stored.find((r) => r.seed === today);
  if (!cleanRun) problems.push(`the clean run was not banked under "${today}"`);
  else if (cleanRun.score !== crashed.score)
    problems.push(`banked ${cleanRun.score} for the clean run, expected ${crashed.score}`);
  if (!/stop counting/i.test(offered.note ?? ""))
    problems.push(`the offer does not say what it costs: "${offered.note}"`);
  // The confirmation. Spending the day cannot be taken back, so the first press must ask, must
  // say what it costs, and cancelling must leave everything exactly as it was.
  if (!asked.shown) problems.push("the first continue on a code spent the day without asking");
  if (asked.state !== "ended")
    problems.push(`the confirmation was skipped — the game was ${asked.state} before answering`);
  if (!/stops? counting|no longer count|spends? your scoring/i.test(asked.body ?? ""))
    problems.push(`the confirmation does not say what it costs: "${asked.body}"`);
  if (cancelled.shown) problems.push("cancelling left the confirmation up");
  if (cancelled.state !== "ended")
    problems.push(`cancelling continued anyway — the game went ${cancelled.state}`);
  if (cancelled.spent) problems.push("cancelling still spent the day");
  if (!reAsked) problems.push("pressing continue again after cancelling did not ask — it just went");
  if (second.asked) problems.push("the second continue on the same code asked again");
  if (laterRun.asked) problems.push("a later run on a spent code asked to spend it again");
  if (!freshCode.asked)
    problems.push("a code that has not been continued was not asked about — the warning is once-ever");
  if (freshCode.state !== "ended")
    problems.push(`a fresh code continued without asking — the game went ${freshCode.state}`);

  if (after.state !== "playing") problems.push(`continuing left the game ${after.state}`);
  if (!(after.z >= crashed.z - 1)) problems.push(`continued at ${after.z}m, behind the crash at ${crashed.z}m`);
  if (!(after.score > atResume.score))
    problems.push(`the score stopped counting after continuing: ${atResume.score} to ${after.score}`);
  if (!(atResume.score >= crashed.score))
    problems.push(`the continue lost the score earned so far: ${crashed.score} to ${atResume.score}`);
  if (!after.greyed) problems.push("a continued run's score is drawn as one that will be kept");

  if (!(after.shownDistance > 0 && after.z > atResume.z))
    problems.push("the run did not continue at all — distance never moved");
  if (!atResume.onGround) problems.push("the rider resumed in mid-air");
  if (!(atResume.gap < 1.5))
    problems.push(`the rider resumed ${atResume.gap.toFixed(1)}m off the snow`);
  // The price. The clean 1500 stays; the 5000 earned after continuing does not.
  const daily = banked.stored.find((r) => r.seed === today);
  if (!daily) problems.push("the clean run before the continue was not recorded at all");
  else if (daily.score !== crashed.score)
    problems.push(`the continued run counted: banked ${daily.score}, expected ${crashed.score}`);
  if (!banked.continueShown)
    problems.push("the continue was not offered again — it is meant to be unlimited");
  if (!/carry on|no longer count/i.test(banked.note ?? ""))
    problems.push(`a spent day still threatens to charge for the continue: "${banked.note}"`);
  // The bug this section exists for now, found by playing rather than by any check here: the
  // end screen announced a new personal best over a score the game had just refused to save,
  // and put that claim on the card, so a continued run could be sent to somebody as a clean
  // one. A card is the only thing in this game that travels to other people; it must not be
  // able to lie about what it is.
  if (/personal best/i.test(banked.best ?? ""))
    problems.push(`a continued run claimed a record: "${banked.best}"`);
  if (!/continued/i.test(banked.best ?? ""))
    problems.push(`the end screen does not say the run was continued: "${banked.best}"`);
  if (!/no longer count/i.test(banked.note ?? ""))
    problems.push(`a spent day does not say so: "${banked.note}"`);
  if (!/continued/i.test(banked.strap ?? ""))
    problems.push(`the shared card does not say the run was continued: "${banked.strap}"`);
  // The card carries what the continued run actually reached — it is a real ride and worth
  // showing — and says on its face that it was continued, which is what stops it being passed
  // off as a clean one.
  if (!(banked.shown >= crashed.score))
    problems.push(`the card shows ${banked.shown}, less than the ${crashed.score} already earned`);
  if (custom.shown) problems.push("an ordinary course offered the continue");
  // Pressing it again has to work, not merely be offered
  if (second.state !== "playing")
    problems.push(`a second continue did nothing — still ${second.state}`);
  if (!(second.z >= before2 - 1))
    problems.push(`the second continue went backwards: ${before2}m to ${second.z}m`);
  if (laterRun.state !== "playing")
    problems.push(`continuing a later run on a spent day did nothing — still ${laterRun.state}`);
  if (!laterRun.greyed)
    problems.push("a later continued run's score is not greyed");
  if (!laterRun.bestShown)
    problems.push("the target vanished on a continued run that is nowhere near it");
  else if (laterRun.bestColour === laterRun.scoreColour)
    problems.push(`the target greyed with the score — both are ${laterRun.bestColour}`);
  // The re-run rules
  if (!(rerun.score > 0)) problems.push("a fresh run on a continued day did not score at all");
  if (!(rerun.score < rerun.best))
    problems.push(`the re-run passed the best (${rerun.best}) before this could be checked`);
  if (rerun.greyed)
    problems.push(`a re-run below the best (${rerun.score} of ${rerun.best}) was greyed anyway`);
  if (!above.greyed)
    problems.push(`a re-run past the best (${above.score} of ${rerun.best}) was not greyed`);
  if (!(stillClimbing > above.score))
    problems.push(
      `the re-run stopped counting past the best: ${above.score} to ${stillClimbing} ` +
        `(${climbed.state})`,
    );
  if (above.multiplier > 1.02 && !above.multShown)
    problems.push(
      `the multiplier (x${above.multiplier.toFixed(2)}) was hidden over a climbing score`,
    );

  if (problems.length) fail(`the daily continue — ${problems.join("; ")}`);
  else
    console.log(
      `✓ a daily run can be continued freely: resumed at ${after.z.toFixed(0)}m keeping ` +
        `${atResume.score} points and still counting to ${after.score}, greyed throughout; ` +
        `pressed again and again on a later run, both took; a re-run then counted normally at ` +
        `${rerun.score} and greyed once past the ${rerun.best} best while still climbing to ` +
        `${stillClimbing}; the continue stayed on offer; a custom code never offers it; and the ` +
        `first press on a code asked before spending it — cancelling changed nothing, later ` +
        `presses went straight through, and an un-continued code asked again`,
    );
  await dp.close();
}

// --- The readouts under the speed and the score -------------------------------------------------
// Three quiet lines: the run's fastest, how steep the ground is, and the score to beat. Each is
// only worth having if it is *right*, and each has a state where it should say nothing at all.
{
  const rp = await ctx.newPage();
  await rp.addInitScript(() =>
    localStorage.setItem(
      "downhill.scores.v1",
      JSON.stringify([
        { seed: "alpine", score: 9500, at: Date.now(), distance: 6000, topSpeed: 45, gen: 7 },
      ]),
    ),
  );
  await rp.goto(`${BASE}?debug=1&seed=alpine`, { waitUntil: "load" });
  await rp.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
  await rp.evaluate(() => window.__game.startRun("alpine"));
  await rp.waitForFunction(() => window.__game.state === "playing", { timeout: 15000 });

  const read = () =>
    rp.evaluate(() => {
      const el = (id) => document.getElementById(id);
      const wedge = el("hud-slope-fill");
      return {
        speed: Number(el("hud-speed").textContent),
        topHidden: el("hud-top-speed").hidden,
        topText: el("hud-top-speed").textContent,
        slope: Number(el("hud-slope-text").textContent.replace(/\D/g, "")),
        wedge: Number(/scaleY\(([\d.]+)\)/.exec(wedge.style.transform)?.[1] ?? "0"),
        bestHidden: el("hud-best").hidden,
        bestText: el("hud-best").textContent,
        score: Number(el("hud-score").textContent.replace(/\D/g, "")),
        gradient: window.__game.field ? null : null,
      };
    });

  // Straight out of the gate: still accelerating, so the top speed *is* the current speed and
  // saying so twice reads as a rendering fault.
  await rp.waitForTimeout(900);
  const early = await read();

  // Deep down, where the mountain has tipped over
  await rp.evaluate(() => {
    const g = window.__game;
    const c = g.controller;
    c.z = 6800;
    c.y = g.field.heightAt(c.x, c.z);
    c.prevX = c.x;
    c.prevY = c.y;
    c.prevZ = c.z;
    c.accumulator = 0;
    c.topSpeed = 48;
    g.terrain.prime(c.z);
    g.camera.reset(c);
  });
  await rp.waitForTimeout(800);
  const deep = await read();

  // ...and once the run is past the stored best there is no target left to show
  await rp.evaluate(() => {
    window.__game.score.total = 12000;
  });
  await rp.waitForTimeout(300);
  const beaten = await read();

  const problems = [];

  if (!early.topHidden)
    problems.push(`the top speed showed while still accelerating: "${early.topText}"`);
  if (deep.topHidden) problems.push("the run's top speed never appeared");
  else if (Number(deep.topText.replace(/\D/g, "")) !== Math.round(48 * 3.6))
    problems.push(`top speed reads "${deep.topText}", not the 48 m/s the run reached`);
  if (!(deep.speed < Number(deep.topText.replace(/\D/g, ""))))
    problems.push("the top speed is not above the current speed, so it says nothing");

  // The opening is a flat 22°, and the fall line only steepens from there
  if (!(early.slope >= 20 && early.slope <= 24))
    problems.push(`the opening reads ${early.slope}°, not the 22° it is`);
  if (!(deep.slope > early.slope + 8))
    problems.push(`the slope barely moved: ${early.slope}° to ${deep.slope}° at 6.8km`);
  // The wedge is the gradient drawn, so it has to grow with it rather than sit still
  if (!(deep.wedge > early.wedge + 0.15))
    problems.push(`the wedge did not steepen: ${early.wedge} to ${deep.wedge}`);
  if (!(deep.wedge <= 1)) problems.push(`the wedge overflowed its box at ${deep.wedge}`);

  if (early.bestHidden) problems.push("the score to beat was not shown");
  else if (!/9,500/.test(early.bestText))
    problems.push(`the target reads "${early.bestText}", not the stored 9,500`);
  if (!beaten.bestHidden)
    problems.push(`a run past the best still shows a target: "${beaten.bestText}"`);

  if (problems.length) fail(`the HUD readouts — ${problems.join("; ")}`);
  else
    console.log(
      `✓ speed, slope and target read true: quiet while accelerating, then ${deep.topText} over ` +
        `${deep.speed}km/h, ${early.slope}° at the top and ${deep.slope}° at 6.8km with the ` +
        `wedge ${early.wedge}→${deep.wedge}, "${early.bestText}" until the run passes it`,
    );
  await rp.close();
}

if (errors.length) process.exitCode = 1;

await browser.close();
console.log(process.exitCode ? "\nBROWSER CHECK FAILED" : "\nBROWSER CHECK PASSED");
