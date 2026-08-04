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

Riding a speed ramp roughly doubles the multiplier for three seconds, so the racing line pays
for itself. See below.

Ground is paid for once. Hold full lock long enough and the board comes round past ninety
degrees and starts climbing back up the mountain; those metres then arrive a second time. The
score keeps a high-water mark rather than a last position, so re-covering them is worth
nothing — before that it was worth 11% extra for twenty seconds of circling, and it compounded.

The gulley walls are just steep snow, not invisible walls. Riding up one costs speed and
gravity brings you back down, so you can bank off them deliberately. Stay out of the course
for more than three seconds and the run ends.

## Difficulty

The mountain keeps getting harder as you descend. Six things escalate:

| | Opening | At 5km |
| --- | --- | --- |
| Obstacles per 12m | 3.2, reaching 10 by 1.3km | 15 |
| Clear channel around the racing line | 5.0m, closing to 3.1m by 1.3km | 2.8m |
| Gulley width | full | 82% |
| Weave in the racing line | ×1, reaching ×1.36 by 4.2km | ×1.36 |
| **Fall-line gradient** | **0.40 (22°) to 1.3km** | **0.66 (33°)** |
| Top speed while holding the line | 36 m/s | 44 m/s |

The gradient is the one that carries the rest. It holds at 0.40 through the opening, then
climbs to **1.0 — a metre down per metre along, a 45° face — by 10km**, and holds there. Speed
follows it: terminal speed is where gravity along the slope balances drag, so it goes as
√gradient, and the peak on the racing line rises from 148 km/h to 173 km/h.

That replaced a `dragScaleAt` that had been thinning the air with distance to fake the same
effect. Running both was doubling up, and the fake one was the worse of the two — measured over
57 seeds it bought 1.6% mean speed while adding 10% to the peak, and the peaks are what cost
seeds. Tipping the mountain does it honestly.

The reference pilot reaches 8km on 27 of 57 seeds, worst 3274m — so the 3km completability
guarantee holds with 274m to spare, which is exactly the margin it had before the mountain
tipped, on a course now 17% faster.

**With one caveat, found by widening that test from a sample to the whole year.** It used to
ride one daily seed in seven. Ridden on all 365, six a year never reach 3000m. That is not
caused by the mountain steepening — measured on both the old and new code formats it is six
either way, and the old format's worst was far worse, ending at 1477m. The cause is the
reference pilot: on every failing seed it dies 3–4m off the racing line, through a channel
about 3m wide, using **one percent of full lock**. A proportional controller following a curve
settles at an offset, so it stabilises wrong with all its authority unused. Widening the
channel, shortening the lookahead and adding the curvature feedforward it lacks were all tried
and all measured worse. The test now rides every day of the year and holds the line at "nothing
dies before 2400m, at most eight fall short" — visible in CI rather than hidden by sampling,
and not where this should be left.

A steep face cannot also snake hard, so past 4.2km the gulley trades weave for pitch and eases
back toward straight. That is geometry rather than a difficulty knob: holding full weave at
7.6km asked 2.01 rad/s of a rider who has 1.72, which is a line no input can hold. A steep
couloir runs straight.

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

Past 10km the course is stationary, the gradient having reached 45°. It is meant to be
survivable there, not endless: the reference pilot used to reach 8km on 52 of 53 daily seeds
and now manages it on 27 of 57.

## Speed ramps

Every 250m or so there is a **4m by 2m chevroned pad laid along the racing line**, red and
yellow. Ride the length of one and it pays **20 km/h**, a small kick off the lip, and a score
multiplier that roughly doubles for three seconds — normal riding reads about ×1.3, a ramp
takes it to ×2.0 and drains back down, with a bar under the score showing what is left.

The multiplier bonus is separate from the speed bonus on purpose. For a while a ramp was worth
almost nothing on the score: the speed bonus capped at 34 m/s while riders sit at 31, so a
ramp's 5.6 m/s overshot into a dead zone and moved the multiplier by 0.08 before stopping. The
ceiling is 42 m/s now, above anything a boosted rider reaches, so speed registers properly —
but making the *speed* curve steep enough to carry a ramp on its own would have turned a
distance game into a speed game. So the ramp pays for itself, and the speed curve keeps its own
job. Carrying the speed away from a ramp is worth something; crashing two metres past it is
not.

"Or so" is doing real work: **ramps only go on straights**, and a stretch that corners all the
way through gets none. That is not a nicety. A rider in the air keeps only 35% of their turn
authority, so a kicker in a corner does not reward the line, it takes the steering away exactly
where the line needs it — and the ramp is *on* the racing line, so good riding is what meets it.
Placing them anywhere, the reference pilot lost the line at 2012m on one daily seed against a
3000m guarantee. The threshold is the loosest one that keeps every seed completable, which
works out at one ramp every 315m on average.

They are a reward for holding the line rather than something to dodge. The line is already the
hardest thing to hold and the only guaranteed-clear path down the mountain, so this gives the
skill the whole game is about something to buy.

A ramp is *defined* as a stretch of the racing line rather than as a position of its own. That
means it curves with the line, and it can never be generated where the obstacle field has put a
tree — the clear channel is 2.5m either side of the line at its narrowest, against a ramp
reaching 1m either side, so it fits inside the existing guarantee with room to spare. A tree
growing out of a speed pad would be the cruellest thing in the game, and it is impossible by
construction rather than by a check.

The payout is proportional to how much of the ramp was covered, so clipping the last half metre
is worth a sixth rather than nothing — an all-or-nothing edge is a cliff the player cannot see.
It is measured over ground covered rather than awarded per frame, so a 120fps phone does not
earn twice what a 60fps one does on a leaderboard everyone shares.

The kick is deliberately small — about 0.25m of air. Airborne riders keep only 35% of their
turn authority, so a generous ramp sitting on the racing line would be a trap rather than a
reward.

Ramps are not part of the height field, which is where this started. A ramp in `heightAt` would
be ridden and launched off by the existing physics for free and would render itself — but the
terrain is meshed at 2m per quad, so a ramp would be sampled by a couple of vertices and look
like nothing at all. It is its own terrain-hugging ribbon instead.

## What you collide with

The rider is a **capsule lying along the board** — 0.225m across the direction of travel and
0.81m along it, both taken from the mesh actually drawn. It was a 0.6m circle, which is not a
shape a snowboard has: nearly three times too wide sideways, which is the axis you dodge on,
and still short of the board's own tips. Crashing into a tree you had visibly passed was that,
and it is fixed.

Across, the mesh reaches 0.240m one way and 0.225m the other, all of the difference being the
goggles standing out past the face. The collider takes the body's half-width and lets the
goggles overhang it — nobody reads a near miss as a hit because a strap clipped a trunk. The
board is narrower still at 0.16m, which is why "how wide is a snowboard" is the wrong question
to size this from.

Obstacles keep a circle each, and a separate one from the circle that spaces them out. A tree's
placement radius is uniform, because changing it would move every tree in the game; what stops
you is per shape, measured from the mesh below rider height. The stripped dead fir is a 0.22m
trunk with its branches up over your head, so it collides like one.

Collision is generous by a tenth on top of all that, deliberately: a hit the player did not
believe in is worse than one they got away with, because the run ends on it.

The hitbox does not grow when you lean. At full lock the rider's head swings the better part of
a metre out over the snow, and a collider that tracked it would be unreadable — it also leans
*into* the turn, away from whatever is being dodged. What threads a gap is the board and the
legs.

## Slope codes

Every course is generated from a code, and **the same code always builds exactly the same
mountain** — same terrain, same corners, same trees, on any device.

The UI calls it a *slope code*. The source calls it a seed, because that is what it is; the
player is not the one who needs to know that.

- **Today's Run** is a code derived from the UTC date — `20260804` — so everyone in the world
  races the same course on the same day. No server involved.
- Type any code you like, or hit the dice for a random one.
- The end screen gives you a link that drops someone straight onto the course you just rode.

Daily codes were `daily-2026-08-03` until 4 August 2026 and a bare `YYYYMMDD` from then on.
Both are still read, so links already sent keep working; only the new one is written. It is a
cutover rather than a rename because the code *is* the course — it is hashed to build the
mountain — so rewriting old ones would move days that have already been played.

**A date-shaped code has to be today's.** Type tomorrow's and the run does not start; type last
Tuesday's and it does not either. Otherwise the daily stops being a competition: one player
practises the course a day early, another grinds a day everyone else has already finished. A
link carrying an old date falls back to today's run rather than dead-ending.

### Continuing a daily run

A daily run ends at the first mistake, so most attempts are over inside a kilometre and almost
nobody sees the mountain past 3km, where the fall line has tipped over and the speed is the
point. So a daily run can be **continued once**, from where it ended.

The first one costs the day; after that they are free, and there is no limit. One continue
rarely gets anybody to the bottom, and once the day is spent there is nothing left to charge
for.

**A continued run's score stops there and greys out**, and does not move again however far the
run goes. What was banked before continuing still stands, since that part was ridden clean;
everything after it is riding for its own sake.

Freezing the number rather than merely declining to save it is the point. A gold figure
climbing at sixty frames a second is the game's loudest claim that something is being earned,
and it was still making that claim over a score nothing was keeping — right up to the end
screen, and onto a card that could be sent to somebody as a clean run. The distance carries on
counting, because that part is still true.

**A fresh run on a continued day is different.** That is a clean attempt, so it counts, and it
is drawn as counting — gold and climbing, exactly as normal. It only greys once it passes the
best already stored, and then it carries on climbing. Grey means one thing everywhere: this
number is not being kept. Below the best there is nothing to say, since a run that cannot beat
the best would not have been recorded on any day.

Custom codes do not offer it. They can simply be ridden again.

## Sharing a run

**Share result** on the end screen hands the system share sheet a picture of the run — score,
distance, top speed, and the slope code — with the challenge link attached. The line that goes
with it is picked from ten, so the same people do not read the same sentence every time. On a phone that is
WhatsApp, Messages, or whatever else is installed.

**Every row of Your scores has its own ↗**, so a best from last week can be sent as easily as
the run you just finished — and it sends the same card. That is the only reason the leaderboard
stores a run's top speed at all: nothing displays it, the rows do not show it, and it has no
bearing on the score. It is kept so a share from the list is indistinguishable from a share the
moment the run ended.

A best set before those were kept shows a dash where the number would be. Not a zero, which
would describe a run that went nowhere at no speed — a different claim entirely, and not one to
put on a picture people send each other.

The card is drawn on a canvas rather than screenshotted from the end screen. A screenshot would
mean `html2canvas`, which is a large dependency that re-implements CSS layout badly; drawing it
means the card is *deterministic* and looks the same everywhere instead of inheriting whatever
that particular phone did with the layout. The trees on it are placed from the seed, so a
course always decorates its own card the same way.

**The seed is printed on the image, not only in the link.** Chat apps rewrite URLs, crop
previews, and forward screenshots of screenshots; the text on the picture is what survives all
of that. A daily run shows its date rather than the "Today" the end screen says, because by the
time anyone reads the card, today is a different mountain.

The message sent alongside the card is a challenge and nothing else — "Think you can beat
that?". Everything about the run is already in the picture, and repeating it in words only makes
the message long enough for a chat app to truncate, which costs the link at the end of it.

Three routes out, in descending order of how much survives:

| | When | Message |
| --- | --- | --- |
| The card, through the share sheet | Any phone, and desktop Safari | The challenge |
| Text and a link, no picture | A browser that shares but refuses files | The run's numbers, since nothing else is carrying them |
| The link on the clipboard | No share sheet at all | — |

The card is rendered when the end screen appears, not when the button is pressed. That is not a
performance nicety: `navigator.share` needs the user activation the press carries, and awaiting
anything before calling it spends that activation on iOS — the one platform this feature is
most for.

Drawing 1080² takes a few hundred milliseconds, so a press in the first moment of the end screen
finds no card yet and shares text and a link instead. That is the second row of the table doing
its job rather than a failure, and it is why that row still carries the numbers.

A scores row has no equivalent moment to render in — there is no telling which of them will be
tapped, and drawing all of them would be absurd. So the render starts on `pointerdown` and the
card is sent on the `click`, which buys it the length of a press. The same fallback covers a
press too quick for it.

## Your scores

**Your scores** on the start screen lists your best on every seed you have ridden, one row per
seed, with how far that run got and when you set it.

The list is ordered by *when the best was made*, newest at the top — not by score. Beating your
best on a seed lifts it back to the top, so the list reads as what you have been riding lately
rather than as a hall of fame frozen around one lucky run.

A custom seed appears exactly as you typed it, since that is the only way back to that course.
Daily runs are shown as their date and tagged as dailies, so a date is never mistaken for a
seed somebody chose.

**Tap any row to ride that seed again**, or its ↗ to share it. For past dailies the row is the
only route back — once the date moves on, nothing else in the game can reach them.

A run counts however it ends. Crashing, going off course, pausing and changing seed, restarting
from the pause panel, switching apps and never coming back, closing the tab — all of them bank
whatever the run had earned. Banking early can never cost anything, because a score is only
ever replaced by a higher one.

Every score is stamped with which version of the course it was set on, and scores from an
older one are deleted the next time the game loads. A 9,000 set before the mountain kept
getting harder past 1300m is not the same achievement as a 9,000 set after it, and leaving the
two side by side makes the list meaningless. `COURSE_GENERATION` in `src/game/leaderboard.ts`
is the stamp — bump it in the same commit as any change that makes scores incomparable. It has
moved five times: for the escalation past 1300m, for the rider gaining the shape of a board,
for speed ramps, for those ramps growing, and for the scoring multiplier being rebalanced
around them.

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
  world/      the gulley, the terrain height field, obstacles, speed ramps, sky
  player/     rider physics, the visual rider, camera, wipeout
  input/      touch and keyboard steering
  game/       scoring, seeds, the local leaderboard, the share card
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
nothing at all — during development, three separate rendering bugs did exactly that. **It runs
in CI**, between the unit tests and the deploy, and its screenshots are kept as an artifact for
seven days: when it fails, "the rider is 92% down the frame" is a number, and the picture is
what says whether that is wrong.

It earns its place. Running only by hand, it caught a ramp kicking at a twentieth of its
intended force, a camera drifting a quarter of a metre with the frame rate, and a share card
that rendered completely blank — each of them invisible to `npm test`, and each caught after it
had already shipped.
