/**
 * Steering input — the game's only control.
 *
 * Finger position across the screen maps directly to turn amount: far right is a hard right
 * turn, slightly right of centre is a gentle one. This is absolute positional steering, not a
 * virtual stick, so the player can pick a turn radius instantly without dragging to find it.
 *
 * Every touch counts, and the steer is the *average* of their offsets from centre. This
 * exists because of how people actually hold the phone: one thumb for left, one for right,
 * putting the next thumb down before lifting the last. Tracking a single pointer and ignoring
 * the rest — which this used to do, to reject stray palms — meant that second thumb did
 * nothing at all until the first was released, so a deliberate input was silently dropped
 * exactly during the handover.
 *
 * Averaging also makes the handover continuous rather than a jump: as the new thumb comes
 * down on the far side, the demand passes through neutral instead of snapping across.
 */

import { clamp } from "../core/math";

/**
 * Fraction of half-width around the centre that reads as "straight".
 *
 * Without this, holding a straight line on a phone means hitting a single pixel column, which
 * is impossible in motion. 7% is wide enough to hold and narrow enough that gentle turns are
 * still reachable.
 */
const DEAD_ZONE = 0.07;

export class SteerInput {
  /** Raw target in [-1, 1]. Negative is left. Smoothing happens in the rider controller. */
  private target = 0;
  /** Every touch currently down, by pointer id, holding its latest client x. */
  private readonly pointers = new Map<number, number>();
  private keyLeft = false;
  private keyRight = false;
  private detachers: (() => void)[] = [];

  constructor(private readonly element: HTMLElement) {
    this.attach();
  }

  /** Current steer demand in [-1, 1]. */
  get value(): number {
    if (this.keyLeft !== this.keyRight) return this.keyLeft ? -1 : 1;
    return this.target;
  }

  /** True while the player is actively touching the screen (used for the tutorial hint). */
  get isEngaged(): boolean {
    return this.pointers.size > 0 || this.keyLeft || this.keyRight;
  }

  /** Number of touches currently being averaged. Exposed for tests and the browser check. */
  get touchCount(): number {
    return this.pointers.size;
  }

  reset(): void {
    this.target = 0;
    this.pointers.clear();
    this.keyLeft = false;
    this.keyRight = false;
  }

  /**
   * Recompute the steer demand from every touch that is currently down.
   *
   * The dead zone is applied once, to the average, rather than per touch. Applying it per
   * touch and then averaging would let two fingers either side of centre average to zero
   * *after* both had already been rescaled to full lock, which reads as a much coarser
   * control than it looks.
   */
  private recompute(): void {
    if (this.pointers.size === 0) {
      // Straighten up on release. The controller damps this, so it isn't a snap.
      this.target = 0;
      return;
    }

    const rect = this.element.getBoundingClientRect();
    if (rect.width <= 0) return;

    let sum = 0;
    for (const clientX of this.pointers.values()) {
      // -1 at the left edge, +1 at the right edge, 0 at centre
      sum += ((clientX - rect.left) / rect.width) * 2 - 1;
    }
    const raw = sum / this.pointers.size;

    // Rescale outside the dead zone so full lock is still reachable at the screen edge
    const sign = Math.sign(raw);
    const mag = Math.abs(raw);
    this.target = mag <= DEAD_ZONE ? 0 : sign * clamp((mag - DEAD_ZONE) / (1 - DEAD_ZONE), 0, 1);
  }

  private attach(): void {
    const el = this.element;

    // Pointer capture keeps a finger steering after it slides off the canvas, but it is not
    // worth the input if it fails: setPointerCapture throws InvalidPointerId when the browser
    // no longer considers the pointer active, which can happen if it is released between the
    // event being queued and this handler running. Capturing *after* the steer is recorded,
    // and swallowing the throw, means the worst case is losing the capture rather than losing
    // the turn.
    const capture = (id: number, on: boolean) => {
      try {
        if (on) el.setPointerCapture?.(id);
        else el.releasePointerCapture?.(id);
      } catch {
        /* pointer already gone; nothing to capture or release */
      }
    };

    const onDown = (e: PointerEvent) => {
      this.pointers.set(e.pointerId, e.clientX);
      this.recompute();
      capture(e.pointerId, true);
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      // Only touches that are actually down; a mouse moving across the canvas is not a steer
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, e.clientX);
      this.recompute();
      e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      // Falls back to whatever fingers remain, so lifting one of two hands the control to the
      // other rather than straightening up
      this.recompute();
      capture(e.pointerId, false);
      e.preventDefault();
    };

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowLeft":
        case "a":
        case "A":
          this.keyLeft = down;
          break;
        case "ArrowRight":
        case "d":
        case "D":
          this.keyRight = down;
          break;
        default:
          return;
      }
      e.preventDefault();
    };

    const keyDown = onKey(true);
    const keyUp = onKey(false);

    // Non-passive so preventDefault actually suppresses scroll / pull-to-refresh
    const opts: AddEventListenerOptions = { passive: false };
    el.addEventListener("pointerdown", onDown, opts);
    el.addEventListener("pointermove", onMove, opts);
    el.addEventListener("pointerup", onUp, opts);
    el.addEventListener("pointercancel", onUp, opts);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    // Losing focus mid-turn would otherwise leave the rider locked into a carve
    const onBlur = () => this.reset();
    window.addEventListener("blur", onBlur);

    this.detachers.push(
      () => el.removeEventListener("pointerdown", onDown, opts),
      () => el.removeEventListener("pointermove", onMove, opts),
      () => el.removeEventListener("pointerup", onUp, opts),
      () => el.removeEventListener("pointercancel", onUp, opts),
      () => window.removeEventListener("keydown", keyDown),
      () => window.removeEventListener("keyup", keyUp),
      () => window.removeEventListener("blur", onBlur),
    );
  }

  dispose(): void {
    for (const detach of this.detachers) detach();
    this.detachers = [];
  }
}
