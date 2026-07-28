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

// Havok must actually move the body, not leave it frozen
const tumble = await page.evaluate(async () => {
  const g = window.__game;
  const start = g.wipeout.focus.clone();
  await new Promise((r) => setTimeout(r, 900));
  const now = g.wipeout.focus;
  return {
    moved: Math.hypot(now.x - start.x, now.y - start.y, now.z - start.z),
    physicsBodies: g.scene.getPhysicsEngine()?.getBodies?.().length ?? -1,
  };
});
await shot("05-wipeout");
if (tumble.moved < 1) fail(`crash body barely moved (${tumble.moved.toFixed(2)}m) — is Havok stepping?`);
else console.log(`✓ Havok tumble: body travelled ${tumble.moved.toFixed(1)}m`);

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
