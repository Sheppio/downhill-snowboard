import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * Build stamp shown in the UI, e.g. `v0.1.0 · c6ee40e`.
 *
 * Derived from git at build time rather than written down anywhere, so it cannot drift out
 * of date — the commit hash changes on every commit by definition. On a dirty working tree
 * it gains a `-dirty` suffix, which is what tells you a phone is showing a local build
 * rather than something that was actually committed.
 */
function buildVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  const git = (cmd: string): string | null => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null; // no git, or building from a source tarball
    }
  };

  // CI checks out shallow, but `rev-parse` still works; GITHUB_SHA is the belt-and-braces path
  const sha =
    git("git rev-parse --short=7 HEAD") ?? process.env.GITHUB_SHA?.slice(0, 7) ?? null;
  if (!sha) return `v${pkg.version}`;

  const dirty = git("git status --porcelain") ? "-dirty" : "";
  return `v${pkg.version} · ${sha}${dirty}`;
}

// `base` must match the GitHub Pages sub-path (https://<user>.github.io/downhill-snowboard/).
// Overridable so the same build can be deployed elsewhere: BASE_PATH=/ npm run build
export default defineConfig({
  base: process.env.BASE_PATH || "/downhill-snowboard/",
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
  },
  server: {
    host: true, // listen on the LAN so a phone can reach the dev server
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2048, // Babylon is large by nature; the warning is noise here
  },
});
