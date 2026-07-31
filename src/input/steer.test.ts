import { beforeEach, describe, expect, it } from "vitest";

import { SteerInput } from "./steer";

/**
 * A stand-in for the canvas.
 *
 * The suite runs in node, and this needs nothing from a DOM beyond a width and the ability to
 * hand back the listeners that were registered — far less than pulling in jsdom for it.
 */
const WIDTH = 400;

class FakeElement {
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();

  getBoundingClientRect() {
    return { left: 0, width: WIDTH, top: 0, height: 800, right: WIDTH, bottom: 800 };
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {
    /* the tests build a fresh element each time */
  }

  /** Every touch is treated as having started on the canvas unless a test says otherwise. */
  contains(node: unknown): boolean {
    return node === this || node === undefined || node === null;
  }

  /** A pointer event. `pointerType` decides whether it is treated as a mouse or a duplicate. */
  emit(type: string, clientX: number, pointerType = "mouse"): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ clientX, clientY: 400, pointerType, target: this, preventDefault() {} });
    }
  }

  /** How many times a handler called preventDefault on the last event dispatched. */
  prevented = 0;

  /**
   * A touch event.
   *
   * `xs` is every finger on the glass *after* whatever just happened, which is exactly what
   * TouchEvent.touches means — an ended touch is simply absent from the list.
   *
   * `cancelable` defaults to true, as a real touch is. A browser sets it false when a scroll
   * is already under way, and that case is what this fake exists to be able to reproduce.
   */
  touch(type: string, xs: number[], cancelable = true): void {
    const touches = xs.map((clientX) => ({ clientX, target: this }));
    this.prevented = 0;
    for (const fn of this.listeners.get(type) ?? []) {
      fn({
        touches,
        cancelable,
        preventDefault: () => {
          this.prevented++;
        },
      });
    }
  }
}

/**
 * SteerInput also binds keyboard and blur handlers to `window`, which node has no notion of.
 * The touch behaviour under test does not need them to do anything — only to be bindable.
 */
const keyListeners = new Map<string, ((e: unknown) => void)[]>();
beforeEach(() => {
  keyListeners.clear();
  (globalThis as { window?: unknown }).window = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = keyListeners.get(type) ?? [];
      list.push(fn);
      keyListeners.set(type, list);
    },
    removeEventListener() {},
  };
});

let el: FakeElement;
let steer: SteerInput;

/** Screen positions, as fractions of the width. 0.5 is dead centre. */
const at = (fraction: number) => fraction * WIDTH;

beforeEach(() => {
  el = new FakeElement();
  steer = new SteerInput(el as unknown as HTMLElement);
});

describe("steering follows how far right the finger is", () => {
  it("reads centre as straight and the edges as full lock", () => {
    el.touch("touchstart", [at(0.5)]);
    expect(steer.value).toBe(0);

    el.touch("touchmove", [at(1)]);
    expect(steer.value).toBeCloseTo(1, 5);

    el.touch("touchmove", [at(0)]);
    expect(steer.value).toBeCloseTo(-1, 5);
  });

  it("reaches full lock before the screen edge", () => {
    // The outermost strip of a phone screen belongs to the operating system's own gestures —
    // Android's back swipe lives there — and a system gesture cancels the page's contacts.
    // Full lock arriving early means a hard turn never asks the player to hold that strip.
    el.touch("touchstart", [at(0.93)]);
    expect(steer.value, "hard right without touching the edge").toBeCloseTo(1, 5);

    el.touch("touchmove", [at(0.07)]);
    expect(steer.value, "hard left without touching the edge").toBeCloseTo(-1, 5);

    // Still proportional well inside that, so the fine control is not lost to the saturation
    el.touch("touchmove", [at(0.7)]);
    const mid = steer.value;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.95);
  });

  it("turns more gently the closer to centre the finger is", () => {
    el.touch("touchstart", [at(0.65)]);
    const gentle = steer.value;
    el.touch("touchmove", [at(0.9)]);
    const hard = steer.value;

    expect(gentle).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(gentle);
  });

  it("still works from a mouse, which sends no touch events at all", () => {
    el.emit("pointerdown", at(0.9));
    expect(steer.value).toBeGreaterThan(0.5);
    el.emit("pointerup", at(0.9));
    expect(steer.value).toBe(0);
  });

  it("ignores a mouse moving with no button held", () => {
    el.emit("pointermove", at(1));
    expect(steer.value).toBe(0);
    expect(steer.isEngaged).toBe(false);
  });

  it("never lets a touch-flavoured pointer become a contact", () => {
    // The browser fires pointerdown before touchstart and pointerup before touchend, so a
    // check that could change state between the two let the first touch of a page in and then
    // skipped it on the way out — leaving a contact stuck for the life of the page. Testing
    // pointerType gives the same answer both times, so the pair cannot come apart.
    el.emit("pointerdown", at(0.95), "touch");
    el.touch("touchstart", [at(0.95)]);
    expect(steer.touchCount, "the finger is one contact, not two").toBe(1);

    el.emit("pointerup", at(0.95), "touch");
    el.touch("touchend", []);
    expect(steer.touchCount, "nothing may survive the release").toBe(0);
    expect(steer.value).toBe(0);
  });
});

describe("two-finger steering", () => {
  // Players use one thumb per direction and put the next down before lifting the last.
  it("recognises a second finger placed before the first is lifted", () => {
    el.touch("touchstart", [at(0.75)]);
    const oneFinger = steer.value;
    expect(oneFinger).toBeGreaterThan(0);

    el.touch("touchstart", [at(0.75), at(0.1)]);
    expect(steer.touchCount).toBe(2);
    expect(steer.value, "the second finger must move the steer").not.toBeCloseTo(oneFinger, 5);
  });

  it("averages the offsets rather than obeying whichever came first", () => {
    el.touch("touchstart", [at(1), at(0)]);
    // Offsets of +1 and -1 average to 0 — dead centre
    expect(steer.value).toBe(0);
  });

  it("hands control to the remaining finger when one lifts", () => {
    el.touch("touchstart", [at(1), at(0)]);
    expect(steer.value).toBe(0);

    // touchend carries what is *still* down, so the lifted finger is simply absent
    el.touch("touchend", [at(0)]);
    expect(steer.touchCount).toBe(1);
    expect(steer.value).toBeCloseTo(-1, 5);
  });

  it("passes through neutral during a handover instead of snapping across", () => {
    el.touch("touchstart", [at(1)]);
    expect(steer.value).toBeCloseTo(1, 5);

    el.touch("touchstart", [at(1), at(0)]);
    expect(Math.abs(steer.value)).toBeLessThan(0.5);

    el.touch("touchend", [at(0)]);
    expect(steer.value).toBeCloseTo(-1, 5);
  });

  it("straightens up only when the last finger goes", () => {
    el.touch("touchstart", [at(0.9), at(0.8)]);
    expect(steer.isEngaged).toBe(true);

    el.touch("touchend", [at(0.8)]);
    expect(steer.value).toBeGreaterThan(0);

    el.touch("touchend", []);
    expect(steer.value).toBe(0);
    expect(steer.isEngaged).toBe(false);
  });

  it("keeps steering a held thumb through a cancel while the other taps", () => {
    // The reported gesture: a thumb held on one side while the other taps quickly. The browser
    // cancels contacts for reasons the page never learns about, and a held thumb produces no
    // events of its own to be recovered from — so when this was a remembered map of pointers,
    // a cancel killed that thumb until it was lifted and put back down.
    //
    // Reading `touches` on every event makes the tapping thumb's own events carry the held one
    // back, which is why the recovery happens without the held thumb doing anything.
    el.touch("touchstart", [at(0.1)]); // left thumb, held still from here on
    expect(steer.value).toBeLessThan(-0.5);

    for (let tap = 0; tap < 3; tap++) {
      el.touch("touchstart", [at(0.1), at(0.9)]);
      el.touch("touchend", [at(0.1)]);
    }
    // The browser gives up on the held thumb. It is still on the glass, so it is still listed.
    el.touch("touchcancel", [at(0.1)]);

    el.touch("touchstart", [at(0.1), at(0.9)]);
    el.touch("touchend", [at(0.1)]);

    expect(steer.value, "the held thumb must still be steering").toBeLessThan(-0.5);
  });

  it("does not steer from a finger that came down on a HUD button", () => {
    // Touches carry every contact on the surface, including one pressing pause. `target` is
    // where the touch started, so this stays out of the average without losing a finger that
    // merely slid over the HUD.
    const button: { closest: () => unknown; offsetParent: unknown } = {
      closest: () => button,
      offsetParent: {}, // on screen
    };
    for (const fn of (el as unknown as { listeners: Map<string, ((e: unknown) => void)[]> })
      .listeners.get("touchstart") ?? []) {
      fn({
        touches: [
          { clientX: at(0.9), target: el },
          { clientX: at(0.02), target: button },
        ],
        preventDefault() {},
      });
    }
    // Only the canvas touch counts, so this is a hard right rather than an average of the two
    expect(steer.touchCount).toBe(1);
    expect(steer.value).toBeGreaterThan(0.5);
  });

  it("does not let a stale mouse pointer wipe out the fingers", () => {
    // The two paths used to write the steer independently, so whichever fired last won. A
    // pointer event arriving alongside real touches could overwrite a correct reading with
    // whatever the pointer map happened to hold — including nothing.
    el.touch("touchstart", [at(0.1)]);
    expect(steer.value).toBeLessThan(-0.5);

    // A mouse press and release alongside the finger. On release the pointer map is empty,
    // and the pointer path used to recompute from that alone — zeroing the steer even though
    // a finger was still on the glass.
    el.emit("pointerdown", at(0.9));
    el.emit("pointerup", at(0.9));
    expect(steer.value, "the finger on the glass must still be steering").toBeLessThan(-0.5);
  });

  it("keeps fingers that are still on the glass across a reset", () => {
    // reset() runs on every startRun, pause and resume. Clearing the contacts stranded a thumb
    // that was already down and not moving: only an event can restore the list, and a
    // motionless thumb sends none. No ring, no turn, right when a run begins.
    el.touch("touchstart", [at(0.95)]);
    const before = steer.value;
    expect(before).toBeGreaterThan(0.5);

    steer.reset();
    expect(steer.touchCount, "the finger is still on the glass").toBe(1);
    expect(steer.value).toBeCloseTo(before, 5);

    // Held input that has no way to announce itself still goes
    el.touch("touchend", []);
    expect(steer.value).toBe(0);
    expect(steer.isEngaged).toBe(false);
  });

  it("counts a finger that began on a control once that control is gone", () => {
    // Touch.target is where the contact started and never changes. A thumb that came down on
    // "Ride" and stayed down was excluded for its whole life, long after the menu had gone.
    const hiddenButton = { closest: () => hiddenButton, offsetParent: null };
    const visibleButton = { closest: () => visibleButton, offsetParent: {} };

    const send = (target: unknown) => {
      for (const fn of (el as unknown as { listeners: Map<string, ((e: unknown) => void)[]> })
        .listeners.get("touchstart") ?? []) {
        fn({ touches: [{ clientX: at(0.95), clientY: 400, target }], preventDefault() {} });
      }
    };

    send(visibleButton);
    expect(steer.touchCount, "pressing a button on screen is not a steer").toBe(0);

    send(hiddenButton);
    expect(steer.touchCount, "the menu has gone; this is just a finger now").toBe(1);
    expect(steer.value).toBeGreaterThan(0.5);
  });
});

describe("a touch the browser will not let us cancel", () => {
  /**
   * Chromium marks a touchstart non-cancelable when a scroll is already under way — the scores
   * list is the one thing in this game that scrolls. Calling preventDefault on such an event
   * does nothing at all except log an error, and the browser check fails the build on console
   * errors, so an unguarded call meant a deploy that could not go out.
   *
   * It is a no-op either way, which is what makes the guard safe. It is also why nothing else
   * in the suite would ever have noticed.
   */
  it("does not try to cancel it", () => {
    const el = new FakeElement();
    const steer = new SteerInput(el as unknown as HTMLElement);

    el.touch("touchstart", [WIDTH * 0.9], false);
    expect(el.prevented, "preventDefault on a non-cancelable event only logs an error").toBe(0);

    // ...and still steers, because the finger is on the glass whatever the browser says about
    // its own scrolling
    expect(steer.value).toBeGreaterThan(0.5);
    expect(steer.touchCount).toBe(1);
  });

  it("still cancels an ordinary one, or the page scrolls under the rider", () => {
    // The other half. Suppressing scroll and pull-to-refresh is the entire reason the touch
    // listeners are registered non-passive.
    const el = new FakeElement();
    new SteerInput(el as unknown as HTMLElement);

    el.touch("touchstart", [WIDTH * 0.9]);
    expect(el.prevented).toBeGreaterThan(0);
  });
});

describe("the keyboard", () => {
  /** Fires a key at the window handlers, and reports whether the keystroke was swallowed. */
  const press = (type: "keydown" | "keyup", key: string, target: unknown = null): boolean => {
    let prevented = false;
    const event = {
      key,
      target,
      preventDefault() {
        prevented = true;
      },
    };
    for (const fn of keyListeners.get(type) ?? []) fn(event);
    return prevented;
  };

  it("steers, and keeps the keystroke to itself", () => {
    expect(press("keydown", "a"), "the page must not also scroll or scrub").toBe(true);
    expect(steer.value).toBe(-1);
    expect(steer.isEngaged).toBe(true);

    press("keyup", "a");
    expect(steer.value).toBe(0);

    press("keydown", "ArrowRight");
    expect(steer.value).toBe(1);
    press("keyup", "ArrowRight");

    press("keydown", "D");
    expect(steer.value, "shift or caps lock still steers").toBe(1);
    press("keyup", "D");
  });

  it("leaves a keystroke aimed at a text field completely alone", () => {
    // Typing a seed was impossible on any keyboard that sends a real keydown. `a` and `d` steer,
    // this handler is on `window` so a keystroke in the seed box reaches it, and it called
    // preventDefault — cancelling the character before it could be inserted. Reported from
    // iPhones; Android escaped it only because its keyboard inserts text through composition and
    // sends keydown as "Unidentified", so nothing ever matched.
    for (const field of [
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      for (const key of ["a", "A", "d", "D", "ArrowLeft", "ArrowRight"]) {
        expect(
          press("keydown", key, field),
          `"${key}" was swallowed inside a ${field.tagName}, so it never reaches the field`,
        ).toBe(false);
        expect(steer.value, `"${key}" steered while typing in a ${field.tagName}`).toBe(0);
        expect(steer.isEngaged).toBe(false);
        press("keyup", key, field);
      }
    }
  });

  it("still steers when the key comes from the page itself", () => {
    // The guard has to key off what was focused, not merely the presence of a target: every
    // real keydown has one, and on the canvas that target is the element the game steers from.
    expect(press("keydown", "a", { tagName: "CANVAS" })).toBe(true);
    expect(steer.value).toBe(-1);
    press("keyup", "a", { tagName: "CANVAS" });
    expect(steer.value).toBe(0);
  });
});
