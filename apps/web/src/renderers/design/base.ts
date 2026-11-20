// Where a design's boards come from: the board loader's URL and the directory a board's relative
// URLs resolve against. Pure, from the shell's own location and the version its payload names.
//
// The shell is the artifact root (`/`), a version path (`/__plinth/v/<n>/`) or, in the staging
// path fallback, the same under `/__content/<id>`. At the root the content host serves whatever
// version is current at that moment, and a board mounts late and again after it scrolls back, so
// its base is always the shown version's own path, `/__plinth/v/<n>/`: a v1 board never loads the
// files of a v2 published while it was open. The content host puts the number in the payload; a
// shell without a valid one mounts no board. A design has no source editor, so it never renders in
// the editor's preview loader.
import { BOARD_LOADER_FILE } from "@plinth/shared";

const FALLBACK_RE = /^(\/__content\/[a-z0-9]{20})(?:\/|$)/;
/** The content host's version paths take at most nine digits (content/serve.ts). */
const MAX_VERSION = 999_999_999;

export interface ShellLocation {
  href: string;
}

/** The artifact root's path prefix: "" on its own subdomain, "/__content/<id>" in the fallback. */
export function contentBase(pathname: string): string {
  return FALLBACK_RE.exec(pathname)?.[1] ?? "";
}

/** A version number the content host can serve: a positive integer of at most nine digits. */
export function isVersionNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_VERSION;
}

/**
 * The URL a board's relative URLs resolve against (its <base href>): the shown version's own path,
 * `/__plinth/v/<version>/` under the artifact root. Null for anything but a valid version number,
 * never the root, which would follow the current version.
 */
export function boardBaseUrl(loc: ShellLocation, version: unknown): string | null {
  if (!isVersionNumber(version)) return null;
  const url = new URL(loc.href);
  return `${url.origin}${contentBase(url.pathname)}/__plinth/v/${version}/`;
}

/** The board loader every board frame opens: a fixed Plinth page on the artifact's origin. */
export function boardLoaderUrl(loc: ShellLocation): string {
  const url = new URL(loc.href);
  return `${url.origin}${contentBase(url.pathname)}/__plinth/frames/design/${BOARD_LOADER_FILE}`;
}
