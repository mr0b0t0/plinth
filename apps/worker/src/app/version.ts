// The release version of this Worker: the npm CLI's version, which `pnpm release` sets and which
// the Docker image shares (docs/releasing.md). Reported by the MCP server and its server card.
import { MIN_UPLOAD_CLI_VERSION } from "@plinth/shared";
import { version } from "../../../../packages/cli/package.json";

export const PLINTH_VERSION: string = version;

/** A plain release version x.y.z at or above `min`. */
export function isReleaseAtLeast(version: string, min: string): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(min);
  if (!v || !m) return false;
  for (let i = 1; i <= 3; i++) {
    const a = Number(v[i]);
    const b = Number(m[i]);
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Whether text the server sends may tell agents to run the CLI's client commands (`plinth
 * publish`, `plinth login`): only from the release that ships them on npm, so an unreleased build
 * never points at commands `npx @mr0b0t0/plinth` does not have yet.
 */
export function cliPublishReleased(version: string = PLINTH_VERSION): boolean {
  return isReleaseAtLeast(version, MIN_UPLOAD_CLI_VERSION);
}

/** ", or run npx @mr0b0t0/plinth publish <dir>" on releases that ship it; "" before. */
export function orRunCliPublish(version: string = PLINTH_VERSION): string {
  return cliPublishReleased(version) ? ", or run npx @mr0b0t0/plinth publish <dir>" : "";
}
