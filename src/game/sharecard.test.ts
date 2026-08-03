import { describe, expect, it } from "vitest";

import {
  cardSeedLabel,
  cardVersion,
  challengeText,
  CHALLENGES,
  drawShareCard,
  CARD_SIZE,
  runSummaryText,
  toKmh,
  type CardContext,
  type CardResult,
} from "./sharecard";

/**
 * A 2D context that records what was drawn instead of drawing it.
 *
 * The suite runs in node, which has no canvas. What matters about this card is not how the
 * pixels land but *what it says* — the score, the seed and the link are the whole reason it
 * exists — and every one of those arrives as a `fillText`. Pixels are checked in the browser
 * check, which draws the real thing and saves it to look at.
 */
class RecordingContext implements CardContext {
  fillStyle: string | CanvasGradient = "";
  strokeStyle = "";
  lineWidth = 0;
  lineJoin: CanvasLineJoin = "round";
  font = "";
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";
  globalAlpha = 1;

  /** Every string drawn, in order, with the size, colour and alignment it was drawn with. */
  readonly texts: {
    text: string;
    size: number;
    x: number;
    y: number;
    fill: string;
    align: CanvasTextAlign;
  }[] = [];
  /** Calls that put geometry on the card, for the "it drew a scene at all" checks. */
  shapes = 0;

  /**
   * The pixel size out of a CSS font string.
   *
   * Specifically not "the first number in it" — the weight comes first, so `900 81px ...`
   * reads as 900 and every measurement comes out eleven times too big. That mistake made this
   * fake report the title as wider than the card and the shrink-to-fit as doing nothing.
   */
  private get size(): number {
    return Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? "0");
  }

  save(): void {}
  restore(): void {}
  fillRect(): void {
    this.shapes++;
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({
      text,
      size: this.size,
      x,
      y,
      // A gradient is only ever the sky, never text, so flattening it to "" here loses nothing
      fill: typeof this.fillStyle === "string" ? this.fillStyle : "",
      align: this.textAlign,
    });
  }
  strokeText(): void {
    // The outline pass of the same string; recording it would double every entry
  }
  measureText(text: string): { width: number } {
    return { width: text.length * this.size * 0.55 };
  }
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {
    this.shapes++;
  }
  arc(): void {
    this.shapes++;
  }
  fill(): void {}
  stroke(): void {}
  createLinearGradient(): CanvasGradient {
    return { addColorStop() {} } as unknown as CanvasGradient;
  }

  /** Everything written on the card, joined, for "does it mention X" checks. */
  said(): string {
    return this.texts.map((t) => t.text).join(" | ");
  }
}

const RESULT: CardResult = {
  score: 5152,
  distance: 4139.7,
  topSpeed: 34.2,
  seed: "powder-chute-42",
  strap: "New personal best!",
  url: "https://example.test/?seed=powder-chute-42",
};

function draw(overrides: Partial<CardResult> = {}): RecordingContext {
  const ctx = new RecordingContext();
  drawShareCard(ctx, { ...RESULT, ...overrides });
  return ctx;
}

describe("what the card says", () => {
  it("carries the numbers from the run", () => {
    const said = draw().said();
    expect(said, "the score, grouped as the game shows it").toContain("5,152");
    expect(said, "distance, floored to whole metres").toContain("4,139m");
    expect(said, "top speed in km/h, as on the end screen").toContain("123km/h");
  });

  it("names the seed in full, because that is what it is for", () => {
    // The link can be stripped, cropped out of a preview, or lost to a screenshot of a
    // screenshot. The seed printed on the picture survives all of it.
    expect(draw().said()).toContain("powder-chute-42");
  });

  it("gives a daily run its date rather than the word the end screen uses", () => {
    // The end screen says "Today", which is true where it is shown and false everywhere this
    // card is going to end up.
    const said = draw({ seed: "daily-2026-01-15" }).said();
    expect(said).not.toContain("Today");
    expect(said, "the raw seed is machine-shaped and not for reading").not.toContain(
      "daily-2026-01-15",
    );
    expect(said).toMatch(/\b2026\b/);
    expect(said).toMatch(/jan/i);
  });

  it("carries a link back to the same course", () => {
    expect(draw().said()).toContain("https://example.test/?seed=powder-chute-42");
  });

  it("prints whatever line the caller gave it", () => {
    // The caller knows what this share is; the card does not, and should not guess. A run that
    // just beat your best says one thing, a row on the scores list says another.
    expect(draw().said()).toContain("New personal best!");
    expect(draw({ strap: "My best on this seed" }).said()).toContain("My best on this seed");
  });

  it("draws a scene, not just words on nothing", () => {
    expect(draw().shapes).toBeGreaterThan(20);
  });
});

describe("a card made from a scores-list row", () => {
  const fromList = (over: Partial<CardResult> = {}) =>
    draw({ strap: "My best on this seed", ...over });

  it("is the same card, with the same two stats", () => {
    // The whole point of storing a top speed on the record: a best sent from the list should
    // be indistinguishable from one sent the moment the run ended.
    const said = fromList().said();
    expect(said).toContain("DISTANCE");
    expect(said).toContain("4,139m");
    expect(said).toContain("TOP SPEED");
    expect(said).toContain("123km/h");
    expect(said).toContain("powder-chute-42");
  });

  it("lays out identically to a card from a finished run", () => {
    // Same labels in the same places, so only the numbers and the strap can differ.
    const ended = draw().texts.map((t) => `${t.x},${t.y}`);
    const listed = fromList().texts.map((t) => `${t.x},${t.y}`);
    expect(listed).toEqual(ended);
  });

  it("shows a dash for what a best predating the record cannot say", () => {
    // Not "0m" or "0km/h", which describe a run that went nowhere at no speed — a different
    // claim entirely, and one that would be a lie on a picture people send each other.
    const said = fromList({ distance: undefined, topSpeed: undefined }).said();
    expect(said).toContain("DISTANCE");
    expect(said).toContain("TOP SPEED");
    expect(said).not.toContain("0m");
    expect(said).not.toContain("0km/h");
    expect(said.match(/—/g) ?? [], "one for each of the two it cannot answer").toHaveLength(2);
  });
});

describe("fitting what it is given", () => {
  it("shrinks a seed too long to fit rather than running off the card", () => {
    // Seeds are capped at 24 characters, and 24 of the widest ones do not fit at full size.
    const long = draw({ seed: "wwwwwwwwwwwwwwwwwwwwwwww" });
    const short = draw({ seed: "ab" });
    const sizeOf = (ctx: RecordingContext, text: string) =>
      ctx.texts.find((t) => t.text === text)?.size ?? 0;

    expect(sizeOf(long, "wwwwwwwwwwwwwwwwwwwwwwww")).toBeLessThan(sizeOf(short, "ab"));
    // ...and still readable rather than shrunk to nothing
    expect(sizeOf(long, "wwwwwwwwwwwwwwwwwwwwwwww")).toBeGreaterThan(20);
  });

  it("keeps every line inside the card", () => {
    const ctx = draw({ seed: "wwwwwwwwwwwwwwwwwwwwwwww" });
    for (const t of ctx.texts) {
      const width = t.text.length * t.size * 0.55;
      // `x` means different things per alignment, and reading it as a centre for everything is
      // how the build stamp — right-aligned against the edge — first showed up here as 111px
      // of overhang it does not have.
      const left = t.align === "right" ? t.x - width : t.x - width / 2;
      expect(left, `"${t.text}" runs off the left`).toBeGreaterThan(-1);
      expect(left + width, `"${t.text}" runs off the right`).toBeLessThan(1081);
    }
  });
});

describe("the build stamp in the corner", () => {
  /** The one text on the card drawn right-aligned — that alignment is how it is found. */
  const stamp = (ctx: RecordingContext) => ctx.texts.find((t) => t.align === "right");

  it("says which version drew the card, and nothing else", () => {
    // The card is the one part of this game that reaches people who are not looking at the
    // game, so the release it was set on is worth carrying. The commit is not: it goes out to
    // people with no repository to look it up in.
    const found = stamp(draw());
    expect(found, "nothing was drawn right-aligned, so there is no stamp").toBeDefined();
    expect(found!.text, `stamp read "${found!.text}"`).toMatch(/^v?\d+\.\d+\.\d+$/);
    expect(found!.text).toBe(cardVersion());
  });

  it("trims the commit off the build stamp rather than keeping its own version", () => {
    // The start screen shows `v0.24.2 · e3b7ba8`; this has to be the same number with the sha
    // taken off, not a second copy that can drift. Checked against the define the rest of the
    // game reads, so a card claiming a different release than the build it came from fails.
    expect(cardVersion()).not.toContain("·");
    expect(cardVersion()).not.toMatch(/dirty/);
    expect(__APP_VERSION__.startsWith(cardVersion())).toBe(true);
    expect(cardVersion().length).toBeGreaterThan(3);
  });

  it("puts it in the top right, clear of the title", () => {
    const found = stamp(draw())!;
    // Right-aligned at the right edge, so x is where the text *ends*
    expect(found.x, "not against the right edge").toBeGreaterThan(CARD_SIZE * 0.9);
    expect(found.x, "hanging off the card").toBeLessThanOrEqual(CARD_SIZE);
    // The title is centred at 7.5% down and 5% tall, so it occupies roughly 5%-10%. Anything
    // sharing that band either crowds it or gets clipped by a narrow crop.
    expect(found.y, "down in the title's band").toBeLessThan(CARD_SIZE * 0.048);
    expect(found.y, "off the top of the card").toBeGreaterThan(0);
  });

  it("keeps it subtle, and does not leave the card right-aligned", () => {
    const ctx = draw();
    const found = stamp(ctx)!;
    // Translucent: the alpha is what makes it a watermark rather than a headline. Full-strength
    // ink here would compete with the score, which is the number the card exists to show.
    const alpha = Number.parseFloat(/rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(found.fill)?.[1] ?? "1");
    expect(alpha, `stamp drawn at ${found.fill}`).toBeLessThan(0.6);
    expect(alpha, "so faint it may as well not be there").toBeGreaterThan(0.15);
    // Small: well under the stat labels, which are the smallest thing meant to be read
    expect(found.size).toBeLessThan(CARD_SIZE * 0.027);

    // Everything after it is centred, so the alignment change must not leak. Miss this and the
    // seed and the URL slide off the right-hand edge of the card.
    const after = ctx.texts.slice(ctx.texts.indexOf(found) + 1);
    expect(after.length, "the stamp was drawn last, so this proves nothing").toBeGreaterThan(3);
    expect(after.every((t) => t.align === "center")).toBe(true);
  });
});

describe("the same seed always decorates its own card the same way", () => {
  it("draws identically for identical results", () => {
    // The card is generated, not photographed, so two people sharing the same run should be
    // sending the same picture.
    expect(draw().texts).toEqual(draw().texts);
    expect(draw().shapes).toBe(draw().shapes);
  });
});

describe("the message that travels with the card", () => {
  it("is a challenge and nothing else, whichever one comes up", () => {
    // Everything about the run is already on the picture. Saying it again only makes the
    // message long enough for a chat app to truncate it — and what gets truncated is the end,
    // which is where the link lives. Held against the whole list, not a sample of it: one line
    // that sneaks a number in would only surface for the players who happened to roll it.
    expect(CHALLENGES.length).toBeGreaterThanOrEqual(5);
    for (const text of CHALLENGES) {
      expect(text, `"${text}" carries a number the card already shows`).not.toMatch(/\d/);
      expect(text.length, `"${text}" is long enough to be truncated`).toBeLessThan(60);
      expect(text, `"${text}" is not a challenge`).toMatch(/[?.!]$/);
      expect(text).not.toContain("https://");
    }
    expect(new Set(CHALLENGES).size, "duplicates waste a variation").toBe(CHALLENGES.length);
  });

  it("actually varies, rather than dressing up one line", () => {
    // The point of a list is that the same person receiving these does not read the same
    // sentence every time. A picker that always lands on the first entry would pass every
    // check above and none of the intent.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(challengeText(i / 200));
    expect(seen.size).toBe(CHALLENGES.length);
  });

  it("picks by the roll it is handed, and survives a bad one", () => {
    expect(challengeText(0)).toBe(CHALLENGES[0]);
    // 1 is the exclusive end of Math.random()'s range, but a caller can still pass it, and
    // flooring it lands one past the end of the list
    expect(challengeText(1)).toBe(CHALLENGES[CHALLENGES.length - 1]);
    expect(CHALLENGES).toContain(challengeText(-5));
    expect(CHALLENGES).toContain(challengeText(Number.NaN));
  });
});

describe("the message for when there is no card", () => {
  it("puts the numbers in the words, since nothing else is carrying them", () => {
    const text = runSummaryText(RESULT);
    expect(text).toContain("5,152");
    expect(text).toContain("powder-chute-42");
    expect(text).toContain("4,139m");
    expect(text).toContain("123km/h");
  });

  it("calls the daily run what a reader would call it", () => {
    const text = runSummaryText({ ...RESULT, seed: "daily-2026-01-15" });
    expect(text).not.toContain("daily-2026-01-15");
    expect(text).toMatch(/2026/);
  });

  it("does not carry the URL itself — the share sheet adds it", () => {
    // Passed as `url` to navigator.share, which appends it. Including it here too gets it
    // pasted twice in WhatsApp.
    expect(runSummaryText(RESULT)).not.toContain("https://");
  });
});

describe("units", () => {
  it("converts to km/h the way the HUD does", () => {
    expect(toKmh(34.2)).toBe(123);
    expect(toKmh(0)).toBe(0);
  });

  it("labels seeds for a reader", () => {
    expect(cardSeedLabel("powder-chute-42")).toBe("powder-chute-42");
    expect(cardSeedLabel("daily-2026-01-15")).toMatch(/2026/);
  });
});
