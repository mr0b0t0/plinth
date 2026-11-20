// The files that pin the GitHub Action (mr0b0t0/plinth/publish@v<version>) or the CLI
// (@mr0b0t0/plinth@<version>) for publishing from CI (docs/ci.md). `pnpm release` moves every pin
// to the version it releases, so the Settings page and the docs always name a tag that exists:
// the release tag is the Action's version, and there is no moving tag.

export const CI_PINNED = [
  "packages/shared/src/ci.ts",
  "docs/ci.md",
  "publish/README.md",
  "README.md",
];

/** A release version, as `pnpm release` takes it: 0.6.0, or a prerelease such as 0.6.0-rc.1. */
export const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

/** A whole release version (scripts/release.mjs checks its argument with it). */
export const VERSION_RE = new RegExp(`^${VERSION}$`);

/** ACTION_REF in packages/shared/src/ci.ts: the Action at one release tag, prereleases included. */
export const ACTION_REF_RE = new RegExp(`^mr0b0t0/plinth/publish@v${VERSION}$`);

const ACTION_PIN = new RegExp(`(mr0b0t0/plinth/publish@v)${VERSION}`, "g");
const CLI_PIN = new RegExp(`(@mr0b0t0/plinth@)${VERSION}`, "g");

/** `text` with every CI pin set to `version`. */
export function withCiPins(text, version) {
  return text.replace(ACTION_PIN, `$1${version}`).replace(CLI_PIN, `$1${version}`);
}

/** Every pinned version in `text` (Action and CLI pins alike). */
export function ciPinsIn(text) {
  const found = [];
  for (const re of [ACTION_PIN, CLI_PIN]) {
    for (const m of text.matchAll(re)) found.push(m[0].slice(m[1].length));
  }
  return found;
}
