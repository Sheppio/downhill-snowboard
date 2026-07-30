# Downhill

A 3D snowboarding game for mobile browsers. One control: **where your finger is across the
screen is how hard you turn.** Far right is a hard right; slightly right of centre is a gentle
one. Tighter turns bleed more speed, so every corner is a trade.

Built with [Babylon.js](https://www.babylonjs.com/) and [Havok](https://www.havok.com/).

## Playing

Hold a finger anywhere on the screen and slide it left or right. Let go to straighten up.
Arrow keys or `A`/`D` work on desktop.

Portrait or landscape, whichever you prefer — the game does not lock the orientation. Babylon's
`fov` is the *vertical* angle, so turning the phone would otherwise open the view from 31° wide
to 105°, which is a different game rather than the same one rotated; the camera caps the
horizontal view at 80° and aims lower to keep the rider in the same place in the frame.

Follow the gulley down the mountain, dodge the trees and rocks, and go as far as you can. Score
is the distance you cover, with a small multiplier for speed — so a fast clean line beats a
cautious one, but not by enough to make straight-lining into a tree a good idea.

The gulley walls are just steep snow, not invisible walls. Riding up one costs speed and
gravity brings you back down, so you can bank off them deliberately. Stay out of the course
for more than three seconds and the run ends.

## Difficulty

The mountain keeps getting harder until 5km, and then stops. Five things escalate:

| | Opening | At 5km |
| --- | --- | --- |
| Obstacles per 12m | 3.2, reaching 10 by 1.3km | 15 |
| Clear channel around the racing line | 5.0m, closing to 3.1m by 1.3km | 2.5m |
| Gulley width | full | 82% |
| Weave in the racing line | ×1, reaching ×1.36 by 4.2km | ×1.36 |
| Top speed while holding the line | 34.7 m/s | 36.5 m/s |

Nothing below 1300m changed when this was added, deliberately: that is the stretch nearly
every attempt covers, and per-seed bests already recorded should still describe the same
course.

The escalation is bounded by one hard rule — **the racing line must never demand more turn
rate than the rider can produce.** Following a line of curvature κ at speed v needs κ·v rad/s,
and past that the corner is not hard, it is impossible, identically for everyone on that seed.
The tightest corner across a year of daily seeds now asks 91% of full lock, against 82% before.
That is the ceiling, and it is why the weave stops at ×1.36 rather than going further.

Speed and the weave compete for the same budget, and speed wins ties: it makes the corners
*and* the trees harder, where the weave only bends the line. Narrowing the gulley is the one
lever that costs nothing against it — a tighter corridor does not bend the line at all.

Past 5km the course is stationary. It is meant to be survivable there, not endless: the
reference pilot used to reach 8km on 52 of 53 daily seeds and now manages it on 29.

## Seeds

Every course is generated from a seed, and **the same seed always builds exactly the same
mountain** — same terrain, same corners, same trees, on any device.

- **Today's Run** is a seed derived from the UTC date, so everyone in the world races the same
  course on the same day. No server involved.
- Type any seed you like, or hit the dice for a random one.
- The end screen gives you a link that drops someone straight onto the course you just rode.

## Your scores

**Your scores** on the start screen lists your best on every seed you have ridden, one row per
seed, with how far that run got and when you set it.

The list is ordered by *when the best was made*, newest at the top — not by score. Beating your
best on a seed lifts it back to the top, so the list reads as what you have been riding lately
rather than as a hall of fame frozen around one lucky run.

A custom seed appears exactly as you typed it, since that is the only way back to that course.
Daily runs are shown as their date and tagged as dailies, so a date is never mistaken for a
seed somebody chose.

**Tap any row to ride that seed again.** For past dailies this is the only route back — once
the date moves on, nothing else in the game can reach them.

A run counts however it ends. Crashing, going off course, pausing and changing seed, restarting
from the pause panel, switching apps and never coming back, closing the tab — all of them bank
whatever the run had earned. Banking early can never cost anything, because a score is only
ever replaced by a higher one.

Every score is stamped with which version of the course it was set on, and scores from an
older one are deleted the next time the game loads. A 9,000 set before the mountain kept
getting harder past 1300m is not the same achievement as a 9,000 set after it, and leaving the
two side by side makes the list meaningless. `COURSE_GENERATION` in `src/game/leaderboard.ts`
is the stamp — bump it in the same commit as any change that makes scores incomparable.

A generation rather than a cutoff date, deliberately: a date is only as good as the clock on
the phone, and a device running a few days slow would stamp every *new* score before the
cutoff and throw all of them away.

It lives in the browser's local storage, so it is per-device and per-browser: there is no
account and nothing is sent anywhere. Every row states when it was set, so a score with no
recorded time is not listed at all — that includes bests from before the list existed, which
were stored as a bare number with nowhere to keep a date. A record from before distances were
kept is still listed, with a dash where the metres go: the score and its date are what the row
is for, and both are still there.

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

## Versioning

The version in `package.json` is the human-readable half of the build stamp shown on the start
and end screens (`v0.2.0 · a1b2c3d`). The commit hash identifies a build exactly; the version
says what kind of change it was. Bump it in the same commit as the change it describes:

| Change | Bump | Example |
| --- | --- | --- |
| A bug fix — something was meant to work this way and didn't | **patch** | the run-in ramp putting the tightest corner at 119m |
| A change to how something works, or new behaviour | **minor** | steering from the average of every finger; the course continuing to get harder past 1300m |

Patch means "the same game, working properly". Minor means "if you had a feel for this, it has
changed" — which is the distinction worth having when someone comes back to a build after a
week and wants to know whether their muscle memory still applies.

**Do not bump for CI or test-only changes.** Workflow config, test timeouts, new tests, the
browser check — none of it reaches the built game, so moving the number for it only adds noise
to the one signal that is supposed to mean something changed on the phone. The commit hash
already identifies those builds exactly.

Nothing enforces this, so it is on whoever makes the change. The stamp gains a `-dirty` suffix
on an uncommitted tree, which is how you tell a phone is showing a local build.

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
