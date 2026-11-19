// Where a design's boards come from: the board loader's URL and the directory a board's relative
// URLs resolve against. Pure, from the shell's own location.
//
// The shell is the artifact root (`/`), a version path (`/__plinth/v/<n>/`) or, in the staging
// path fallback, the same under `/__content/<id>`. A board's files are the version's own, so its
// base is the shell's directory: `/__plinth/v/3/` boards load v3's images. In the editor preview the
// loader has already moved its URL to the artifact root; if it could not, its path still ends in
// `/__plinth/preview`, and the base is the root.
import { BOARD_LOADER_FILE } from "@plinth/shared";

const FALLBACK_RE = /^(\/__content\/[a-z0-9]{20})(?:\/|$)/;
const PREVIEW_SUFFIX = "/__plinth/preview";

export interface ShellLocation {
  href: string;
}

/** The artifact root's path prefix: "" on its own subdomain, "/__content/<id>" in the fallback. */
export function contentBase(pathname: string): string {
  return FALLBACK_RE.exec(pathname)?.[1] ?? "";
}

/** The URL a board's relative URLs resolve against (its <base href>). */
export function boardBaseUrl(loc: ShellLocation): string {
  const url = new URL(loc.href);
  if (url.pathname.endsWith(PREVIEW_SUFFIX)) {
    return `${url.origin}${contentBase(url.pathname)}/`;
  }
  return new URL(".", url).href;
}

/** The board loader every board frame opens: a fixed Plinth page on the artifact's origin. */
export function boardLoaderUrl(loc: ShellLocation): string {
  const url = new URL(loc.href);
  return `${url.origin}${contentBase(url.pathname)}/__plinth/frames/design/${BOARD_LOADER_FILE}`;
}
