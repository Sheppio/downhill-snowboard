import { describe, expect, it } from "vitest";

import {
  cardSeedLabel,
  challengeText,
  drawShareCard,
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

  /** Every string drawn, in order, with the size it was drawn at. */
  readonly texts: { text: string; size: number; x: number; y: number }[] = [];
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
    this.texts.push({ text, size: this.size, x, y });
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

/** A fixed "now", so a card that shows an age draws the same one every run. */
const NOW = Date.UTC(2026, 6, 20, 9, 0, 0);

const RESULT: CardResult = {
  score: 5152,
  distance: 4139.7,
  topSpeed: 34.2,
  seed: "powder-chute-42",
  strap: "New personal best!",
  at: NOW,
  url: "https://example.test/?seed=powder-chute-42",
};

function draw(overrides: Partial<CardResult> = {}): RecordingContext {
  const ctx = new RecordingContext();
  drawShareCard(ctx, { ...RESULT, ...overrides }, undefined, NOW);
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
  // That row knows a score, how far it got and when — never a top speed, because the
  // leaderboard has never stored one.
  const fromList = (over: Partial<CardResult> = {}) =>
    draw({ topSpeed: undefined, strap: "My best on this seed", ...over });

  it("shows when the score was set where the top speed would go", () => {
    // Rather than a dash in the best half of the card. "3d ago" on a score says something.
    const said = fromList({ at: NOW - 3 * 86_400_000 }).said();
    expect(said).toContain("SET");
    expect(said).toContain("3d ago");
    expect(said).not.toContain("TOP SPEED");
    expect(said).not.toMatch(/km\/h/);
  });

  it("still shows the score, the distance and the seed", () => {
    const said = fromList().said();
    expect(said).toContain("5,152");
    expect(said).toContain("4,139m");
    expect(said).toContain("powder-chute-42");
  });

  it("shows a dash for a record kept before distances were", () => {
    // Not "0m", which reads as a run that went nowhere — a different claim entirely.
    const said = fromList({ distance: undefined }).said();
    expect(said).toContain("—");
    expect(said).not.toContain("0m");
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
      expect(t.x - width / 2, `"${t.text}" runs off the left`).toBeGreaterThan(-1);
      expect(t.x + width / 2, `"${t.text}" runs off the right`).toBeLessThan(1081);
    }
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
  it("is a challenge and nothing else", () => {
    // Everything about the run is already on the picture. Saying it again only makes the
    // message long enough for a chat app to truncate it — and what gets truncated is the end,
    // which is where the link lives.
    const text = challengeText();
    expect(text).not.toMatch(/\d/);
    expect(text.length).toBeLessThan(60);
    expect(text).toMatch(/beat/i);
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
    expect(challengeText()).not.toContain("https://");
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
