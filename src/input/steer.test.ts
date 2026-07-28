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

  emit(type: string, pointerId: number, clientX: number): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ pointerId, clientX, preventDefault() {} });
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
    el.emit("pointerdown", 1, at(0.5));
    expect(steer.value).toBe(0);

    el.emit("pointermove", 1, at(1));
    expect(steer.value).toBeCloseTo(1, 5);

    el.emit("pointermove", 1, at(0));
    expect(steer.value).toBeCloseTo(-1, 5);
  });

  it("turns more gently the closer to centre the finger is", () => {
    el.emit("pointerdown", 1, at(0.65));
    const gentle = steer.value;
    el.emit("pointermove", 1, at(0.9));
    const hard = steer.value;

    expect(gentle).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(gentle);
  });
});

describe("two-finger steering", () => {
  // The reported problem: players use one thumb per direction and put the next one down
  // before lifting the last. Tracking a single pointer meant that second thumb did nothing
  // until the first was released, so a deliberate input was silently dropped.
  it("recognises a second finger placed before the first is lifted", () => {
    el.emit("pointerdown", 1, at(0.75)); // right thumb, gentle right
    const oneFinger = steer.value;
    expect(oneFinger).toBeGreaterThan(0);

    el.emit("pointerdown", 2, at(0.1)); // left thumb goes down, first still held
    expect(steer.touchCount).toBe(2);
    expect(steer.value, "the second finger must move the steer").not.toBeCloseTo(oneFinger, 5);
  });

  it("averages the offsets rather than obeying whichever came first", () => {
    el.emit("pointerdown", 1, at(1)); // hard right
    el.emit("pointerdown", 2, at(0)); // hard left
    // Offsets of +1 and -1 average to 0 — dead centre
    expect(steer.value).toBe(0);
  });

  it("hands control to the remaining finger when one lifts", () => {
    el.emit("pointerdown", 1, at(1));
    el.emit("pointerdown", 2, at(0));
    expect(steer.value).toBe(0);

    el.emit("pointerup", 1, at(1)); // right thumb released, left still down
    expect(steer.touchCount).toBe(1);
    expect(steer.value).toBeCloseTo(-1, 5);
  });

  it("passes through neutral during a handover instead of snapping across", () => {
    // Hard right, then the left thumb lands before the right lifts. The demand should cross
    // zero on the way rather than jumping from +1 to -1 in one step.
    el.emit("pointerdown", 1, at(1));
    expect(steer.value).toBeCloseTo(1, 5);

    el.emit("pointerdown", 2, at(0));
    const during = steer.value;
    expect(Math.abs(during)).toBeLessThan(0.5);

    el.emit("pointerup", 1, at(1));
    expect(steer.value).toBeCloseTo(-1, 5);
  });

  it("straightens up only when the last finger goes", () => {
    el.emit("pointerdown", 1, at(0.9));
    el.emit("pointerdown", 2, at(0.8));
    expect(steer.isEngaged).toBe(true);

    el.emit("pointerup", 1, at(0.9));
    expect(steer.value).toBeGreaterThan(0);

    el.emit("pointerup", 2, at(0.8));
    expect(steer.value).toBe(0);
    expect(steer.isEngaged).toBe(false);
  });

  it("ignores a lift for a pointer it never saw", () => {
    el.emit("pointerdown", 1, at(0.9));
    const before = steer.value;
    el.emit("pointerup", 99, at(0));
    expect(steer.value).toBe(before);
    expect(steer.touchCount).toBe(1);
  });

  it("ignores movement from a pointer that is not down", () => {
    // A mouse crossing the canvas with no button held must not steer the rider.
    el.emit("pointermove", 7, at(1));
    expect(steer.value).toBe(0);
    expect(steer.isEngaged).toBe(false);
  });

  it("forgets every touch on reset", () => {
    el.emit("pointerdown", 1, at(1));
    el.emit("pointerdown", 2, at(0.9));
    steer.reset();
    expect(steer.value).toBe(0);
    expect(steer.touchCount).toBe(0);
    expect(steer.isEngaged).toBe(false);
  });
});
