/**
 * A ring drawn under every contact the steering is actually using.
 *
 * The value of this is entirely in *where the positions come from*. They are not read back
 * from the DOM or from touch events — they are the same list the steer was just calculated
 * from. So a finger the game has lost track of has no ring under it, and the player can see
 * that happening rather than having to infer it from the rider not turning.
 *
 * That distinction is the whole reason this exists: a touch that stopped registering was
 * invisible, and three rounds of fixing it were guided by guesswork about which event went
 * missing. A ring that vanishes under a thumb still on the glass says so immediately.
 *
 * Rings are pooled and moved with `transform`, which the compositor handles without laying
 * anything out, so this costs nothing per frame even while it updates every frame.
 */

import type { Contact } from "../input/steer";

export class TouchMarkers {
  private readonly host: HTMLElement;
  private readonly pool: HTMLElement[] = [];
  private shown = 0;

  constructor(parent: HTMLElement) {
    const host = document.createElement("div");
    host.className = "touch-markers";
    parent.appendChild(host);
    this.host = host;
  }

  /** Point the rings at the current contacts. Safe to call every frame. */
  update(contacts: readonly Contact[]): void {
    while (this.pool.length < contacts.length) {
      const dot = document.createElement("div");
      dot.className = "touch-dot";
      this.host.appendChild(dot);
      this.pool.push(dot);
    }

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]!;
      const dot = this.pool[i]!;
      dot.style.transform = `translate(${c.x}px, ${c.y}px) translate(-50%, -50%)`;
      if (i >= this.shown) dot.style.display = "block";
    }
    for (let i = contacts.length; i < this.shown; i++) {
      this.pool[i]!.style.display = "none";
    }
    this.shown = contacts.length;
  }

  /** Clear every ring — used when a run ends, so none is left stranded on the end screen. */
  clear(): void {
    this.update([]);
  }

  dispose(): void {
    this.host.remove();
  }
}
