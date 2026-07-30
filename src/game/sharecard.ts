/**
 * The end-of-run result, drawn as a picture worth sending someone.
 *
 * A challenge link on its own is a URL in a chat window: it says nothing about the run, and
 * nobody taps it. A card carries the score, so the message is a boast and the link comes along
 * with it — which is the only reason anyone opens a seed they were sent.
 *
 * Drawn on a canvas rather than assembled from the DOM. Screenshotting the live end screen
 * would mean either `html2canvas` (a large dependency that re-implements CSS layout, badly) or
 * a real screenshot API browsers do not give pages. Canvas is a few hundred lines of drawing
 * and, more usefully, is *deterministic* — the card looks the same on every device instead of
 * inheriting whatever the phone did with the layout.
 *
 * **The seed has to be on the card as text**, not just inside the link. Chat apps strip and
 * re-wrap URLs, previews get cropped, and screenshots of screenshots are forwarded. The seed
 * printed on the image is what survives all of that.
 */

import { hashString, makeRng } from "../core/rng";
import { isDaily, seedLabel } from "./seed";

/**
 * Square, and 1080 on a side.
 *
 * Chat apps show a square or near-square thumbnail and crop anything taller, so a tall card
 * would be cropped exactly through the score. 1080 is the width every messaging app encodes
 * to anyway — going larger only costs upload time.
 */
export const CARD_SIZE = 1080;

export interface RunResult {
  score: number;
  /** Metres. */
  distance: number;
  /** Metres per second, as the controller keeps it. */
  topSpeed: number;
  seed: string;
  /** Best on this seed, for the line under the score when the run did not beat it. */
  best: number;
  isRecord: boolean;
  /** A link that drops the recipient straight onto this course. */
  url: string;
}

/**
 * The parts of a 2D context this uses.
 *
 * Declared structurally rather than taking `CanvasRenderingContext2D`, so the layout can be
 * tested against a recording double in node — where there is no canvas at all. Everything here
 * exists on the real thing with the same signature.
 */
export interface CardContext {
  fillStyle: string | CanvasGradient;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, from: number, to: number): void;
  fill(): void;
  stroke(): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
}

/** The game's palette, as in style.css. The card has to look like the thing it came from. */
const SKY = "#4fc3f7";
const SKY_HIGH = "#8fdcff";
const INK = "#0b3954";
const INK_SOFT = "#2a6f97";
const SNOW = "#ffffff";
const SUN = "#ffd166";
const TREE = "#1f7a5a";
const TREE_DARK = "#15614a";

/**
 * The same stack the page uses, so the card matches the game on the device that drew it.
 *
 * No web font is loaded and none should be: a card that waits on a network font would either
 * block the share or silently fall back anyway, and the share happens on a user gesture that
 * browsers will not hold open.
 */
const FACE = `"Baloo 2", "Nunito", "Trebuchet MS", system-ui, -apple-system, sans-serif`;
const font = (size: number, weight = 700) => `${weight} ${size}px ${FACE}`;

/** Metres per second to the km/h the HUD and the end screen both show. */
export function toKmh(speed: number): number {
  return Math.round(speed * 3.6);
}

/**
 * How the seed is named on the card.
 *
 * The end screen says "Today" for a daily, which is right there and useless here: by the time
 * anyone reads the card, "today" is a different mountain. The date it encodes is the thing
 * that stays true.
 */
export function cardSeedLabel(seed: string): string {
  return isDaily(seed) ? seedLabel(seed) : seed;
}

/** Shrink a label until it fits the width it has been given. */
function fitText(ctx: CardContext, text: string, max: number, size: number, weight = 700): number {
  let px = size;
  ctx.font = font(px, weight);
  while (px > 12 && ctx.measureText(text).width > max) {
    px -= 2;
    ctx.font = font(px, weight);
  }
  return px;
}

/** Chunky cartoon lettering: ink outline behind a solid fill, exactly as the HUD does it. */
function outlined(
  ctx: CardContext,
  text: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  weight = 900,
): void {
  ctx.font = font(size, weight);
  ctx.lineJoin = "round";
  ctx.lineWidth = size * 0.11;
  ctx.strokeStyle = INK;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** One conifer, of the kind the mountain is full of. */
function tree(ctx: CardContext, x: number, base: number, height: number): void {
  const w = height * 0.42;
  // Up to where the lowest tier starts, or the trunk floats clear of its own foliage with a
  // band of snow showing between the two — which is exactly how the first card drew them.
  const LOWEST_TIER = 0.32;
  ctx.fillStyle = "#6b4b3a";
  ctx.fillRect(x - height * 0.05, base - height * LOWEST_TIER, height * 0.1, height * LOWEST_TIER);
  for (let tier = 0; tier < 3; tier++) {
    const top = base - height * (LOWEST_TIER + tier * 0.24);
    const spread = (w / 2) * (1 - tier * 0.22);
    ctx.fillStyle = tier === 1 ? TREE_DARK : TREE;
    ctx.beginPath();
    ctx.moveTo(x, top - height * 0.3);
    ctx.lineTo(x + spread, top);
    ctx.lineTo(x - spread, top);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Draw the whole card.
 *
 * Split from the canvas plumbing below so the layout can be exercised without one, and kept
 * pure: given the same result it draws the same card, on any device.
 */
export function drawShareCard(ctx: CardContext, r: RunResult, size = CARD_SIZE): void {
  const mid = size / 2;
  /**
   * Where the scenery starts and the words stop.
   *
   * A hard split, because the first version let the treeline run through the seed and the
   * stat labels. Text over decoration is unreadable at thumbnail size, which is the size this
   * is actually seen at — everything above this line is words on flat sky, everything below
   * is picture, and the footer sits on clean snow.
   */
  const SCENERY = size * 0.7;

  // --- Sky
  const sky = ctx.createLinearGradient(0, 0, 0, size);
  sky.addColorStop(0, SKY_HIGH);
  sky.addColorStop(1, SKY);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, size, size);

  // --- The mountain: a far bank, a treeline standing on it, and snow closing over the front
  const rng = makeRng(hashString(r.seed));
  ctx.fillStyle = "#cfeeff";
  ctx.beginPath();
  ctx.moveTo(0, SCENERY + size * 0.05);
  ctx.lineTo(size * 0.26, SCENERY - size * 0.02);
  ctx.lineTo(size * 0.55, SCENERY + size * 0.04);
  ctx.lineTo(size * 0.8, SCENERY - size * 0.03);
  ctx.lineTo(size, SCENERY + size * 0.03);
  ctx.lineTo(size, size);
  ctx.lineTo(0, size);
  ctx.closePath();
  ctx.fill();

  // Seeded, so the same course always decorates its own card the same way
  for (let i = 0; i < 9; i++) {
    tree(
      ctx,
      rng.range(size * 0.04, size * 0.96),
      SCENERY + rng.range(size * 0.11, size * 0.16),
      rng.range(size * 0.08, size * 0.13),
    );
  }

  ctx.fillStyle = SNOW;
  ctx.beginPath();
  ctx.moveTo(0, size * 0.87);
  ctx.lineTo(size * 0.33, size * 0.845);
  ctx.lineTo(size * 0.68, size * 0.88);
  ctx.lineTo(size, size * 0.85);
  ctx.lineTo(size, size);
  ctx.lineTo(0, size);
  ctx.closePath();
  ctx.fill();

  // --- Title
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  outlined(ctx, "DOWNHILL", mid, size * 0.075, size * 0.05, SNOW, 900);

  // --- The number the game is about
  outlined(ctx, r.score.toLocaleString(), mid, size * 0.225, size * 0.17, SUN, 900);

  const strap = r.isRecord ? "New personal best!" : `Best on this seed: ${r.best.toLocaleString()}`;
  ctx.fillStyle = INK;
  ctx.font = font(size * 0.038, 800);
  ctx.fillText(strap, mid, size * 0.325);

  // A dashed rule, as on the end screen. Drawn as ticks rather than with a line dash, which
  // would be one more method the recording context in the tests has to pretend to have.
  ctx.fillStyle = "rgba(11, 57, 84, 0.22)";
  for (let x = size * 0.1; x < size * 0.9; x += size * 0.035) {
    ctx.fillRect(x, size * 0.377, size * 0.02, size * 0.006);
  }

  // --- Distance and speed, side by side
  const stat = (label: string, value: string, x: number) => {
    const px = fitText(ctx, value, size * 0.4, size * 0.06, 900);
    outlined(ctx, value, x, size * 0.445, px, SNOW, 900);
    ctx.fillStyle = INK_SOFT;
    ctx.font = font(size * 0.026, 800);
    ctx.fillText(label, x, size * 0.5);
  };
  stat("DISTANCE", `${Math.floor(r.distance).toLocaleString()}m`, size * 0.28);
  stat("TOP SPEED", `${toKmh(r.topSpeed)}km/h`, size * 0.72);

  // --- The seed, full width: it is the whole reason this is worth sending
  const label = cardSeedLabel(r.seed);
  ctx.fillStyle = INK_SOFT;
  ctx.font = font(size * 0.026, 800);
  ctx.fillText(isDaily(r.seed) ? "DAILY SEED" : "SEED", mid, size * 0.575);
  const seedPx = fitText(ctx, label, size * 0.86, size * 0.072, 900);
  outlined(ctx, label, mid, size * 0.635, seedPx, SUN, 900);

  // --- Where to go to ride it, on the clean snow at the foot of the card
  ctx.fillStyle = INK;
  ctx.font = font(size * 0.031, 800);
  ctx.fillText("Same mountain, same trees. Beat it:", mid, size * 0.925);
  const urlPx = fitText(ctx, r.url, size * 0.9, size * 0.03, 700);
  ctx.font = font(urlPx, 700);
  ctx.fillStyle = INK_SOFT;
  ctx.fillText(r.url, mid, size * 0.968);
}

/**
 * The message that travels with the card.
 *
 * Kept short and with the seed in words, because this is what a chat app shows when it decides
 * not to render the image — and because a forwarded message often arrives with the picture
 * stripped and only this left.
 */
export function shareText(r: RunResult): string {
  const where = isDaily(r.seed)
    ? `today's Downhill run (${cardSeedLabel(r.seed)})`
    : `Downhill seed "${r.seed}"`;
  return (
    `${r.score.toLocaleString()} on ${where} — ` +
    `${Math.floor(r.distance).toLocaleString()}m at up to ${toKmh(r.topSpeed)}km/h. ` +
    `Same mountain, same trees. Beat it:`
  );
}

/**
 * Render the card to a PNG.
 *
 * Returns null rather than throwing if the browser has no usable 2D canvas — sharing is a
 * nicety and must never be able to take the end screen down with it.
 */
export async function renderShareCard(r: RunResult): Promise<Blob | null> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = CARD_SIZE;
    canvas.height = CARD_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    drawShareCard(ctx as unknown as CardContext, r);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/png"),
    );
  } catch {
    return null;
  }
}
