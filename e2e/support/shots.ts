// Review screenshots. Off by default; set PLINTH_E2E_SHOTS=<dir> to write each spec's shots to
// <dir>/<group>/. Tests never depend on them.
import { mkdirSync } from "node:fs";
import path from "node:path";

/** The directory for a spec's screenshots, created on first use, or null when shots are off. */
export function shotsDir(group: string): string | null {
  const root = process.env.PLINTH_E2E_SHOTS;
  if (!root) return null;
  const dir = path.join(root, group);
  mkdirSync(dir, { recursive: true });
  return dir;
}
