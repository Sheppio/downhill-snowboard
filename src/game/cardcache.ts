/**
 * Share cards, drawn before anybody asks for them.
 *
 * The whole reason this exists as machinery rather than a function call: `navigator.share` needs
 * the user activation the tap carries, and awaiting anything inside the handler spends it on
 * iOS — the one platform where a share sheet is the point. So whatever a tap sends has to
 * already be a `File` sitting in memory. A card takes about a second and a half to render at
 * 1080 square; a tap lasts a tenth of that. Hanging the render off the press, which is where
 * this started, meant every share from the scores list went out as text with no picture.
 *
 * What buys the time is the list *opening*. A person takes a second or two to find the row they
 * want, which is about one card, so the queue is started then and the press only ever reorders
 * it.
 *
 * Both collaborators are injected rather than imported. Drawing a card needs a canvas and a
 * record needs storage, and neither exists under the unit runner — but the parts worth testing
 * are the queueing, the skipping and the eviction, none of which care what a card actually is.
 */

import type { CardResult } from "./sharecard";

/**
 * How many cards to hold at once.
 *
 * Each is a 1080-square PNG, a couple of hundred KB, so the whole list is not worth keeping: it
 * can hold two hundred rows and nobody shares from the bottom of one. Comfortably more than fits
 * on a screen, which is what decides whether the card being reached for is already drawn.
 */
export const MAX_CARDS = 24;

export interface CardCacheDeps {
  /** What a card for this seed would say, or null if the seed has no record to draw. */
  resultFor(seed: string): CardResult | null;
  /** Render one. Resolves null if it could not be drawn at all. */
  draw(result: CardResult): Promise<File | null>;
}

export class CardCache {
  /**
   * Cards by seed. A stored `null` is a seed whose card could not be drawn — remembered so it
   * is not attempted again on every press.
   */
  private readonly cards = new Map<string, File | null>();
  /** Seeds still to draw, in the order they will be drawn. */
  private queue: string[] = [];
  private drawing = false;

  constructor(private readonly deps: CardCacheDeps) {}

  /** The card for a seed, or null if there is not one — drawn, undrawable, or not reached yet. */
  get(seed: string): File | null {
    return this.cards.get(seed) ?? null;
  }

  /** How many cards are held. Exposed for the checks, which wait on one arriving. */
  get size(): number {
    return this.cards.size;
  }

  /**
   * Draw cards for these seeds, in this order, starting now.
   *
   * One at a time: rendering thirty at once would tie up a phone's main thread for as long as it
   * takes to do them all, and the first row is the one most likely to be wanted.
   */
  queueAll(seeds: readonly string[]): void {
    for (const seed of seeds.slice(0, MAX_CARDS)) {
      if (!this.cards.has(seed) && !this.queue.includes(seed)) this.queue.push(seed);
    }
    this.drawNext();
  }

  /** Bring one seed to the front — the press before a share. */
  prioritise(seed: string): void {
    if (this.cards.has(seed)) return;
    this.queue = [seed, ...this.queue.filter((s) => s !== seed)];
    this.drawNext();
  }

  /**
   * Forget a seed's card, because the score it shows has been beaten.
   *
   * Dropped rather than redrawn: the next visit to the list draws it from the record that
   * replaced it, and nobody is waiting for it in the meantime.
   */
  invalidate(seed: string): void {
    this.cards.delete(seed);
  }

  private drawNext(): void {
    if (this.drawing) return;

    // Skips are resolved here rather than at enqueue time, since a card can arrive, or a seed
    // can lose its record, between being queued and being reached.
    let seed: string | undefined;
    let result: CardResult | null = null;
    while ((seed = this.queue.shift()) !== undefined) {
      if (this.cards.has(seed)) continue;
      result = this.deps.resultFor(seed);
      if (result) break;
    }
    if (seed === undefined || !result) return;

    this.drawing = true;
    const drawing = seed;
    void this.deps.draw(result).then((file) => {
      // Oldest out first: the map keeps insertion order, and the oldest entry is the row
      // furthest from the top of a list already sorted by how recent it is.
      if (this.cards.size >= MAX_CARDS) {
        const oldest = this.cards.keys().next().value;
        if (oldest !== undefined) this.cards.delete(oldest);
      }
      this.cards.set(drawing, file);
      this.drawing = false;
      this.drawNext();
    });
  }
}
