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

  /** A pointer event, for the mouse path. */
  emit(type: string, pointerId: number, clientX: number, buttons = 1): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ pointerId, clientX, buttons, pointerType: "mouse", preventDefault() {} });
    }
  }

  /**
   * A touch event.
   *
   * `xs` is every finger on the glass *after* whatever just happened, which is exactly what
   * TouchEvent.touches means — an ended touch is simply absent from the list.
   */
  touch(type: string, xs: number[]): void {
    const touches = xs.map((clientX) => ({ clientX, target: this }));
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ touches, preventDefault() {} });
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
    el.emit("pointerdown", 1, at(0.9));
    expect(steer.value).toBeGreaterThan(0.5);
    el.emit("pointerup", 1, at(0.9));
    expect(steer.value).toBe(0);
  });

  it("ignores a mouse moving with no button held", () => {
    el.emit("pointermove", 7, at(1), 0); // buttons: 0 — nothing pressed
    expect(steer.value).toBe(0);
    expect(steer.isEngaged).toBe(false);
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

  it("recovers a finger that was down when the run restarted", () => {
    // reset() runs on every startRun, pause and resume. It no longer tries to know what is on
    // the glass — the next touch event says so.
    el.touch("touchstart", [at(0.9)]);
    steer.reset();
    expect(steer.value).toBe(0);

    el.touch("touchmove", [at(0.9)]);
    expect(steer.value, "a finger still on the glass must steer again").toBeGreaterThan(0);
  });

  it("does not steer from a finger that came down on a HUD button", () => {
    // Touches carry every contact on the surface, including one pressing pause. `target` is
    // where the touch started, so this stays out of the average without losing a finger that
    // merely slid over the HUD.
    const button = { name: "pause" };
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
    el.emit("pointerdown", 99, at(0.9));
    el.emit("pointerup", 99, at(0.9));
    expect(steer.value, "the finger on the glass must still be steering").toBeLessThan(-0.5);
  });

  it("ignores touch-derived pointer events once touch events are seen", () => {
    // Both would otherwise count the same finger twice, and the pointer copy would outlive
    // the finger, because that path remembers contacts and the touch path does not.
    el.touch("touchstart", [at(0.9)]);
    const oneFinger = steer.value;

    for (const fn of (el as unknown as { listeners: Map<string, ((e: unknown) => void)[]> })
      .listeners.get("pointerdown") ?? []) {
      fn({ pointerId: 7, clientX: at(0.9), buttons: 1, pointerType: "touch", preventDefault() {} });
    }
    expect(steer.touchCount, "the same finger must not be counted twice").toBe(1);
    expect(steer.value).toBeCloseTo(oneFinger, 5);
  });

  it("forgets every touch on reset", () => {
    el.touch("touchstart", [at(1), at(0.9)]);
    steer.reset();
    expect(steer.value).toBe(0);
    expect(steer.touchCount).toBe(0);
    expect(steer.isEngaged).toBe(false);
  });
});
