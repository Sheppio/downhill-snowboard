/**
 * Getting a run out of the game and into a conversation.
 *
 * Three routes, in descending order of how much of the run survives the trip:
 *
 *  1. **The card, through the system share sheet.** WhatsApp, Messages, anything installed.
 *     The picture carries the score and the seed, and the link rides along with it.
 *  2. **Text and a link**, where the browser can share but not files. Desktop Safari, mostly.
 *  3. **The link on the clipboard**, which is what this used to do and is still the honest
 *     answer on a desktop browser with no share sheet at all.
 *
 * The card is rendered when the end screen appears rather than when the button is pressed, and
 * that is not a performance nicety. `navigator.share` requires transient user activation, and
 * awaiting anything before calling it spends that activation on iOS — a share prepared inside
 * the click handler is refused with `NotAllowedError` on exactly the platform this feature is
 * most for. Prepared in advance, the handler calls `share()` before it awaits anything.
 */

import { copyLink } from "./seed";
import { renderShareCard, shareText, type RunResult } from "./sharecard";

export type ShareOutcome =
  /** Handed to the system share sheet, with the card. */
  | "shared"
  /** Shared as text and a link — the browser would not take the file. */
  | "shared-link"
  /** No share sheet; the link is on the clipboard. */
  | "copied"
  /** No share sheet and no clipboard; the link was offered in a prompt. */
  | "link-ready"
  /** The player backed out of the share sheet. Not a failure, and not worth a message. */
  | "cancelled";

/** A file name someone might actually recognise in their downloads. */
function fileName(r: RunResult): string {
  const seed = r.seed.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "run";
  return `downhill-${seed}-${r.score}.png`;
}

/**
 * Draw the card and wrap it as a file, ready for a later share.
 *
 * Null whenever the browser cannot render or cannot take files — the caller then simply shares
 * text and a link, which every path below still handles.
 */
export async function prepareShareCard(r: RunResult): Promise<File | null> {
  const blob = await renderShareCard(r);
  if (!blob) return null;
  try {
    const file = new File([blob], fileName(r), { type: "image/png" });
    // Asked before use rather than assumed: Chrome on desktop has `share` but refuses files,
    // and calling it anyway rejects and loses the activation with nothing to fall back on.
    return navigator.canShare?.({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}

/**
 * Share a finished run.
 *
 * `card` is whatever `prepareShareCard` produced. Nothing is awaited before `share()` is
 * called, so the caller's user gesture is still valid when it runs — see the note above.
 */
export async function shareRun(r: RunResult, card: File | null): Promise<ShareOutcome> {
  const text = shareText(r);

  if (card && navigator.share) {
    try {
      await navigator.share({ files: [card], text, url: r.url });
      return "shared";
    } catch (e) {
      if (isAbort(e)) return "cancelled";
      // Fall through: a share sheet that refused the file may still take the link
    }
  }

  if (navigator.share) {
    try {
      await navigator.share({ title: "Downhill", text, url: r.url });
      return "shared-link";
    } catch (e) {
      if (isAbort(e)) return "cancelled";
    }
  }

  return (await copyLink(r.url)) ? "copied" : "link-ready";
}

/** The share sheet being dismissed arrives as an exception, and is not an error. */
function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** What to say on the button afterwards. Nothing at all when the player just backed out. */
export function shareMessage(outcome: ShareOutcome): string | null {
  switch (outcome) {
    case "shared":
    case "shared-link":
      return "Shared!";
    case "copied":
      return "Link copied!";
    case "link-ready":
      return "Link ready";
    case "cancelled":
      return null;
  }
}
