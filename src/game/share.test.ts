import { afterEach, describe, expect, it, vi } from "vitest";

import { shareMessage, shareRun } from "./share";
import type { CardResult } from "./sharecard";

const RESULT: CardResult = {
  score: 5152,
  distance: 4139.7,
  topSpeed: 34.2,
  seed: "powder-chute-42",
  strap: "New personal best!",
  url: "https://example.test/?seed=powder-chute-42",
};

const card = () => new File([new Uint8Array([1, 2, 3])], "run.png", { type: "image/png" });

/** Stand in for whatever this browser's navigator can do. */
function withNavigator(nav: Record<string, unknown>): void {
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sharing a run", () => {
  it("hands the card and the link to the share sheet", () => {
    const share = vi.fn().mockResolvedValue(undefined);
    withNavigator({ share, canShare: () => true });

    return shareRun(RESULT, card()).then((outcome) => {
      expect(outcome).toBe("shared");
      const sent = share.mock.calls[0]![0] as { files: File[]; text: string; url: string };
      expect(sent.files, "the picture is the point").toHaveLength(1);
      expect(sent.files[0]!.type).toBe("image/png");
      expect(sent.url, "and the link goes with it").toBe(RESULT.url);
      // A challenge, not a second copy of the card. The run's numbers are all on the picture,
      // and repeating them only pushes the link far enough down to be truncated.
      expect(sent.text).not.toMatch(/\d/);
      expect(sent.text).toMatch(/beat/i);
    });
  });

  it("puts the numbers back in the message when the picture cannot go", async () => {
    // The stats live on the card. Where there is no card they have nowhere else to be, and a
    // bare "think you can beat that?" with no run attached is just a link nobody opens.
    const share = vi.fn().mockResolvedValue(undefined);
    withNavigator({ share });

    await shareRun(RESULT, null);
    const sent = share.mock.calls[0]![0] as { text: string };
    expect(sent.text).toContain("5,152");
    expect(sent.text).toContain("powder-chute-42");
  });

  it("falls back to text and a link where files are refused", async () => {
    // Desktop Chrome: navigator.share exists and rejects anything with files attached.
    const share = vi.fn(async (data: { files?: unknown[] }) => {
      if (data.files) throw new TypeError("cannot share files");
    });
    withNavigator({ share, canShare: () => true });

    expect(await shareRun(RESULT, card())).toBe("shared-link");
    expect(share).toHaveBeenCalledTimes(2);
    expect((share.mock.calls[1]![0] as { files?: unknown }).files).toBeUndefined();
  });

  it("shares text and a link when there is no card to send", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    withNavigator({ share });

    expect(await shareRun(RESULT, null)).toBe("shared-link");
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("treats a dismissed share sheet as nothing having happened", async () => {
    // Backing out is the single most common outcome of opening a share sheet, and it must not
    // be reported as a failure or quietly fall through to writing the clipboard instead.
    const abort = new Error("dismissed");
    abort.name = "AbortError";
    const share = vi.fn().mockRejectedValue(abort);
    const writeText = vi.fn().mockResolvedValue(undefined);
    withNavigator({ share, canShare: () => true, clipboard: { writeText } });

    expect(await shareRun(RESULT, card())).toBe("cancelled");
    expect(share, "no second attempt behind the player's back").toHaveBeenCalledTimes(1);
    expect(writeText, "and nothing written to the clipboard either").not.toHaveBeenCalled();
  });

  it("copies the link where there is no share sheet at all", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withNavigator({ clipboard: { writeText } });

    expect(await shareRun(RESULT, null)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(RESULT.url);
  });

  it("still offers the link when the clipboard is blocked too", async () => {
    // A browser with neither: the link is put in a prompt to be copied by hand rather than
    // the button doing nothing at all.
    withNavigator({});
    expect(await shareRun(RESULT, null)).toBe("link-ready");
  });
});

describe("what the button says afterwards", () => {
  it("confirms the ways that worked", () => {
    expect(shareMessage("shared")).toBe("Shared!");
    expect(shareMessage("shared-link")).toBe("Shared!");
    expect(shareMessage("copied")).toBe("Link copied!");
    expect(shareMessage("link-ready")).toBe("Link ready");
  });

  it("says nothing when the player backed out", () => {
    // Confirming a share that did not happen is worse than silence.
    expect(shareMessage("cancelled")).toBeNull();
  });
});
