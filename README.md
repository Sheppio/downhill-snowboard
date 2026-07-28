# Downhill

A 3D snowboarding game for mobile browsers. One control: **where your finger is across the
screen is how hard you turn.** Far right is a hard right; slightly right of centre is a gentle
one. Tighter turns bleed more speed, so every corner is a trade.

Built with [Babylon.js](https://www.babylonjs.com/) and [Havok](https://www.havok.com/).

## Playing

Hold a finger anywhere on the screen and slide it left or right. Let go to straighten up.
Arrow keys or `A`/`D` work on desktop.

Follow the gulley down the mountain, dodge the trees and rocks, and go as far as you can. Score
is the distance you cover, with a small multiplier for speed — so a fast clean line beats a
cautious one, but not by enough to make straight-lining into a tree a good idea.

The gulley walls are just steep snow, not invisible walls. Riding up one costs speed and
gravity brings you back down, so you can bank off them deliberately. Stay out of the course
for more than three seconds and the run ends.

## Seeds

Every course is generated from a seed, and **the same seed always builds exactly the same
mountain** — same terrain, same corners, same trees, on any device.

- **Today's Run** is a seed derived from the UTC date, so everyone in the world races the same
  course on the same day. No server involved.
- Type any seed you like, or hit the dice for a random one.
- The end screen gives you a link that drops someone straight onto the course you just rode.

## Running it

```bash
npm install
npm run dev        # then open the printed LAN address on your phone
```

```bash
npm test           # unit tests
npm run build      # production build into dist/
```

To check it in a real browser at a phone viewport, with screenshots:

```bash
npm run build
npx vite preview --port 4173 &
node tools/browser-check.mjs ./.screenshots
```

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via `.github/workflows/deploy.yml`.

**One manual step is required first:** in the repository's *Settings → Pages*, set **Source**
to **GitHub Actions**. The workflow cannot do this itself and the first deploy will fail
without it.

## How it fits together

```
src/
  core/       seeded RNG and noise — everything deterministic starts here
  world/      the gulley, the terrain height field, obstacles, sky
  player/     rider physics, the visual rider, camera, wipeout
  input/      touch and keyboard steering
  game/       scoring, seeds, sharing
  ui/         DOM overlay
```

Three decisions are worth knowing about before changing anything:

**Determinism comes from pure functions, not from a shared random stream.** `heightAt(x, z)` is
a pure function of the seed and coordinates, and each slice of obstacles derives its own
generator from `(seed, sliceIndex)`. Chunks are built in whatever order the player happens to
ride, so anything drawing from one long PRNG stream would give different worlds to two people
on the same seed. This is the property the whole shared-seed idea rests on.

**The rider is not a rigid body.** It samples the terrain height field directly and integrates
its own motion, which is exact, cheap, and cannot catch on a chunk seam or tunnel through fast
ground. Havok is used where it genuinely earns its keep: the wipeout, where the rider becomes a
real dynamic body carrying its own momentum and tumbles across terrain built at the crash site.

**Course boundaries are terrain, not collision.** The gulley walls are part of the height
field, so riding up one is riding uphill — the existing slope term bleeds speed and gravity
pulls you back. There is no boundary-collision code anywhere in the project.

## Tests

Two of them guard properties that would otherwise fail silently and be miserable to diagnose
from play alone:

- **The mountain must never flatten enough to stall the rider.** There is no way to push, so a
  counter-slope steep enough to stop someone ends the run with no recovery. The undulation
  amplitude is bounded by this, and the test measures it across many seeds.
- **Every course must be completable.** Obstacles are kept clear of a meandering racing line,
  and the test verifies it by *riding* every daily seed of the year with an autopilot and
  checking it survives 3km. A daily seed that generated a blocked corridor would be unwinnable
  for everyone racing that day.

`tools/browser-check.mjs` exists because the unit tests can all pass while the screen shows
nothing at all — during development, three separate rendering bugs did exactly that.
