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
 *
 * **Fingers are read from `TouchEvent.touches`, never remembered.** That is the important
 * design decision here, and it was arrived at the hard way. Keeping our own map of live
 * pointers meant the map could drift from what was actually on the glass, and it could only
 * ever be corrected by an event belonging to a *specific* pointer — so a thumb held still,
 * which produces no events at all, could be dropped and never recovered. The browser cancels
 * pointers for reasons the page never learns about, and a quick tap alongside a held thumb was
 * enough to trigger it.
 *
 * `touches` carries every contact on the surface on every touch event, so each one re-states
 * the whole truth. The tapping thumb's own events are what bring the held thumb back. Nothing
 * is held between events, so there is nothing left to fall out of step.
 *
 * Pointer Events cannot do this — a PointerEvent describes one pointer and says nothing about
 * the others — so they are kept only for the mouse, where the problem does not arise.
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

/**
 * How far out full lock is reached, as a fraction of half-width.
 *
 * Deliberately short of the screen edge. Steering that only reaches its limit at the very edge
 * teaches players to hold their thumbs there, and the outermost strip of a phone screen is
 * where the operating system watches for its own gestures — Android's back swipe lives exactly
 * there. A system gesture cancels the page's contacts, and a cancelled contact is one the
 * browser stops reporting at all, which no amount of page-side code can see through.
 *
 * Saturating at 85% means a hard turn never needs the edge, so the input stops competing with
 * the OS for the same pixels. It also makes full lock easier to hold, which is worth having on
 * its own.
 */
const FULL_LOCK_AT = 0.85;

/** A point of contact, in client coordinates. Only `x` steers; `y` is for drawing it. */
export interface Contact {
  x: number;
  y: number;
}

export class SteerInput {
  /** Raw target in [-1, 1]. Negative is left. Smoothing happens in the rider controller. */
  private target = 0;
  /**
   * Mouse and pen only. Touches are never stored — see the note at the top of the file.
   * A mouse cannot be one of several contacts, so there is nothing here that can drift.
   */
  private readonly pointers = new Map<number, Contact>();
  /** Fingers as of the last touch event. Replaced wholesale each time, never edited. */
  private readonly touchPts: Contact[] = [];
  /**
   * The contacts the last calculation actually used.
   *
   * Exposed so the on-screen markers can be drawn from it. That they come from here and not
   * from the DOM is the point: a marker appears exactly where the steering believes a finger
   * is, so a contact the game has lost track of visibly is not there.
   */
  private readonly live: Contact[] = [];
  private keyLeft = false;
  private keyRight = false;
  private detachers: (() => void)[] = [];
  /** Set the first time a real touch event arrives — see `duplicatesATouch`. */
  private sawTouch = false;

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
    return this.touchCount > 0 || this.keyLeft || this.keyRight;
  }

  /** Number of contacts currently being averaged. Exposed for tests and the browser check. */
  get touchCount(): number {
    return this.live.length;
  }

  /** Where the game currently believes the player is touching. Drives the markers. */
  get contacts(): readonly Contact[] {
    return this.live;
  }

  /**
   * Drop the steer. Called on every startRun, pause and resume.
   *
   * It does not need to know what is on the glass, and deliberately does not try: the next
   * touch event carries the full contact list and puts the truth back. That is what stops a
   * finger held across a pause from being stranded, which used to need its own special case.
   */
  reset(): void {
    this.target = 0;
    this.pointers.clear();
    this.touchPts.length = 0;
    this.live.length = 0;
    this.keyLeft = false;
    this.keyRight = false;
  }

  /**
   * Set the steer demand from the x position of every contact on the glass.
   *
   * The dead zone is applied once, to the average, rather than per contact. Applying it per
   * contact and then averaging would let two fingers either side of centre average to zero
   * *after* both had already been rescaled to full lock, which reads as a much coarser
   * control than it looks.
   */
  private recompute(): void {
    // Both sources feed one calculation. They used to write the steer independently, so
    // whichever fired last won and a stale pointer map could overwrite a correct touch
    // reading with zero. Averaging is also unbothered if a finger somehow reaches both lists,
    // since the duplicate sits at the same position and cannot move the mean.
    this.live.length = 0;
    for (const p of this.touchPts) this.live.push(p);
    for (const p of this.pointers.values()) this.live.push(p);

    if (this.live.length === 0) {
      // Straighten up on release. The controller damps this, so it isn't a snap.
      this.target = 0;
      return;
    }

    const rect = this.element.getBoundingClientRect();
    if (rect.width <= 0) return;

    let sum = 0;
    for (const c of this.live) {
      // -1 at the left edge, +1 at the right edge, 0 at centre
      sum += ((c.x - rect.left) / rect.width) * 2 - 1;
    }
    const raw = sum / this.live.length;

    // Rescale between the dead zone and the full-lock point, so full lock arrives before the
    // edge rather than at it
    const sign = Math.sign(raw);
    const mag = Math.abs(raw);
    this.target =
      mag <= DEAD_ZONE ? 0 : sign * clamp((mag - DEAD_ZONE) / (FULL_LOCK_AT - DEAD_ZONE), 0, 1);
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

    /**
     * Every touch event, of every kind, does the same thing: read the whole contact list.
     *
     * touchend and touchcancel are no different from touchstart here — `touches` already
     * excludes whatever just ended, so there is nothing to remove and no bookkeeping to get
     * wrong. A cancel is not a special case either, which is the entire point: the browser
     * cancelling a contact used to be indistinguishable from a finger lifting.
     */
    const onTouch = (e: TouchEvent) => {
      this.touchPts.length = 0;
      for (let i = 0; i < e.touches.length; i++) {
        const t = e.touches[i];
        if (!t) continue;
        // A finger that came down on a HUD button is pressing the button, not steering.
        // `target` is where the touch *started*, so sliding off the canvas keeps steering.
        const target = t.target as Node | null;
        if (target && el.contains && !el.contains(target)) continue;
        this.touchPts.push({ x: t.clientX, y: t.clientY });
      }
      // Seeing one touch event is proof this browser reports fingers that way, which is a far
      // better test than asking whether `ontouchstart` exists — that is a famously unreliable
      // signal, and getting it wrong here means both paths steering at once.
      this.sawTouch = true;
      this.recompute();
      e.preventDefault();
    };

    /**
     * Touch-derived pointer events, once we know this browser sends real touch events too.
     *
     * Handling both would count every finger twice. It would also be worse than double
     * counting, because the pointer path remembers contacts and the touch path does not, so a
     * stale pointer could outlive the finger it describes.
     */
    const duplicatesATouch = (e: PointerEvent) => this.sawTouch && e.pointerType === "touch";

    const onDown = (e: PointerEvent) => {
      if (duplicatesATouch(e)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.recompute();
      capture(e.pointerId, true);
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (duplicatesATouch(e)) return;
      // `buttons` is non-zero only while something is actually pressed, so a mouse moving
      // across the canvas with no button held does not steer.
      if (!this.pointers.has(e.pointerId) && e.buttons === 0) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.recompute();
      e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (duplicatesATouch(e)) return;
      if (!this.pointers.delete(e.pointerId)) return;
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

    const touchEvents = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
    for (const type of touchEvents) {
      el.addEventListener(type, onTouch as EventListener, opts);
      this.detachers.push(() => el.removeEventListener(type, onTouch as EventListener, opts));
    }

    el.addEventListener("pointerdown", onDown, opts);
    el.addEventListener("pointermove", onMove, opts);
    el.addEventListener("pointerup", onUp, opts);
    el.addEventListener("pointercancel", onUp, opts);
    // A mouse released outside the window would otherwise leave the button stuck down.
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("pointercancel", onUp, opts);
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
      () => window.removeEventListener("pointerup", onUp, opts),
      () => window.removeEventListener("pointercancel", onUp, opts),
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
