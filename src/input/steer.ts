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
 * the others — so fingers are handled here and the mouse is handled by plain mouse events.
 *
 * **Not Pointer Events for the mouse either**, which is the subtler half. Pointer Events also
 * fire for touch, so both APIs described the same finger, and the guard that stopped it being
 * counted twice could only be set once a touch event had been seen. The browser fires
 * `pointerdown` before `touchstart` and `pointerup` before `touchend`, so the very first touch
 * of a page was added while the guard was off and skipped on removal once it was on — leaving
 * a contact stuck for the life of the page, holding a turn nobody was asking for. Mouse events
 * do not fire for touch (the compatibility ones are suppressed by `preventDefault` below), so
 * the two inputs cannot describe the same contact and no guard is needed at all.
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
  /** The mouse, while its button is held. There is only ever one, so nothing can drift. */
  private mouse: Contact | null = null;
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
   * Clear held input. Called on every startRun, pause and resume.
   *
   * The fingers are deliberately *kept*. `touchPts` is the last authoritative statement of what
   * is on the glass and there is nothing better to replace it with — clearing it stranded any
   * thumb that was already down and not moving, because only an event can restore the list and
   * a motionless thumb sends none. That was a finger with no ring under it and no effect on
   * the rider, right at the start of a run, which is when a player is most likely to already
   * have a thumb planted.
   *
   * Keeping them is also simply correct for a control that maps position to turn: if the
   * finger really is there, it really is asking for that turn.
   */
  reset(): void {
    this.mouse = null;
    this.keyLeft = false;
    this.keyRight = false;
    this.recompute();
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
    if (this.mouse) this.live.push(this.mouse);

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

    /**
     * Is this contact pressing a UI control rather than steering?
     *
     * Only buttons and inputs take touches at all — the overlay itself is `pointer-events:
     * none` — so anything else landed on the canvas and is a steer.
     *
     * The visibility test is the part that matters. `Touch.target` is where the contact
     * *started* and never changes, so a thumb that came down on "Ride" and stayed down was
     * excluded for its whole life, long after the menu it landed on had gone: no ring, no
     * turn, right at the start of a run. Once the control is off screen the contact is just a
     * finger on the canvas, and it counts.
     */
    const pressingAControl = (target: EventTarget | null): boolean => {
      const node = target as Element | null;
      if (!node?.closest) return false;
      // Duck-typed rather than `instanceof HTMLElement`, which does not exist off the browser
      // and would make this unreachable from the unit tests.
      const control = node.closest("button, input") as { offsetParent?: unknown } | null;
      return control != null && control.offsetParent !== null;
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
        if (pressingAControl(t.target)) continue;
        this.touchPts.push({ x: t.clientX, y: t.clientY });
      }
      this.recompute();
      e.preventDefault();
    };

    /**
     * Fingers are handled by the touch listeners, so a touch-flavoured pointer is a duplicate.
     *
     * Stateless, and that is the whole point. This used to consult a flag that only became
     * true once a touch event had been seen — and because the browser fires `pointerdown`
     * before `touchstart`, the very first touch of a page was let *in* while the flag was off
     * and skipped on the way *out* once it was on. The contact stuck for the life of the page,
     * holding a turn the player had released. A test on the event's own `pointerType` gives
     * the same answer for a down and its matching up, always, so the pair cannot come apart.
     *
     * Mouse events would sidestep the question, but they are not available: Babylon calls
     * preventDefault on pointerdown, which suppresses the compatibility mouse events entirely,
     * so `mousedown` never arrives on the canvas.
     */
    const isFinger = (e: PointerEvent) => e.pointerType === "touch";

    const onPointerDown = (e: PointerEvent) => {
      if (isFinger(e) || pressingAControl(e.target)) return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.recompute();
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isFinger(e) || !this.mouse) return; // hovering with no button held is not a steer
      this.mouse = { x: e.clientX, y: e.clientY };
      this.recompute();
      e.preventDefault();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (isFinger(e) || !this.mouse) return;
      this.mouse = null;
      this.recompute();
    };

    /**
     * True when a keystroke belongs to a text field rather than to the game.
     *
     * Without this, typing a seed was impossible: `a` and `d` steer, the handler is on `window`
     * so a keystroke in the seed box reaches it, and it called preventDefault — which cancels
     * the character before it is inserted. Arrow keys lost the caret the same way.
     *
     * It only showed up on iPhones because of how the two mobile keyboards work. iOS dispatches
     * a real keydown carrying the actual key, so preventDefault suppresses the character.
     * Android's inserts text through composition and beforeinput, sending keydown with a
     * keyCode of 229 and a key of "Unidentified", so nothing here ever matched and nothing was
     * cancelled. Desktop browsers behave like iOS, so it was broken there too and simply
     * unreported.
     */
    const typingInAField = (target: EventTarget | null): boolean => {
      const node = target as (Element & { isContentEditable?: boolean }) | null;
      const tag = node?.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || node?.isContentEditable === true;
    };

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      // Neither steers nor swallows the keystroke: the field gets it, whole.
      if (typingInAField(e.target)) return;

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

    el.addEventListener("pointerdown", onPointerDown, opts);
    el.addEventListener("pointermove", onPointerMove, opts);
    el.addEventListener("pointerup", onPointerUp, opts);
    el.addEventListener("pointercancel", onPointerUp, opts);
    // A mouse released outside the window would otherwise leave the button stuck down.
    window.addEventListener("pointerup", onPointerUp, opts);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    // Losing focus mid-turn would otherwise leave the rider locked into a carve
    const onBlur = () => this.reset();
    window.addEventListener("blur", onBlur);

    this.detachers.push(
      () => el.removeEventListener("pointerdown", onPointerDown, opts),
      () => el.removeEventListener("pointermove", onPointerMove, opts),
      () => el.removeEventListener("pointerup", onPointerUp, opts),
      () => el.removeEventListener("pointercancel", onPointerUp, opts),
      () => window.removeEventListener("pointerup", onPointerUp, opts),
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
