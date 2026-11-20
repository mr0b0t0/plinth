// Formatting for version lists: sizes, relative and full dates, note excerpts, compare links.
import { APP_ROUTES, type ArtifactTypeDef, route } from "@plinth/shared";

/** "820 B", "12.4 KB", "3.1 MB" (decimal units, like file managers). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[u]}`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago"; older than a year: "12 Mar 2025". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 45 * 60) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 22 * 3600) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 6 * 86400) return rtf.format(Math.round(s / 86400), "day");
  if (abs < 30 * 86400) return rtf.format(Math.round(s / (7 * 86400)), "week");
  if (abs < 365 * 86400) return rtf.format(Math.round(s / (30 * 86400)), "month");
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(t);
}

/** Full local timestamp for tooltips: "13 November 2026 at 14:05". */
export function fullTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short" }).format(t);
}

/** First line of a note, cut at a word boundary to at most `max` characters. */
export function excerpt(text: string | null | undefined, max = 60): string {
  const line = (text ?? "").trim().split(/\r?\n/)[0] ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  // Already at a word boundary when the next character is a space.
  const space = line[max - 1] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export const artifactPath = (slug: string) => route(APP_ROUTES.artifact, { slug });
export const historyPath = (slug: string) => route(APP_ROUTES.history, { slug });

/** Permanent link to one version; the current version links to the bare artifact URL. */
export function versionPath(slug: string, n: number, current?: number): string {
  return n === current ? artifactPath(slug) : route(APP_ROUTES.artifactVersion, { slug, n });
}

export function comparePath(
  slug: string,
  from: number,
  to: number,
  view?: "source" | "rendered",
): string {
  const q = new URLSearchParams({ from: String(from), to: String(to) });
  if (view && view !== "source") q.set("view", view);
  return `${route(APP_ROUTES.compare, { slug })}?${q}`;
}

/** What the history says about restoring version `n`. */
export interface RestoreWording {
  /** The menu item and the confirm button. */
  action: string;
  title: string;
  description: string;
  /** The toast once it is done. */
  done: string;
  doneDetail: (version: number) => string;
}

/**
 * Restoring version `n` while `current` is the current version. On a type whose versions hold only
 * settings (registry `versions: "settings"`, a whiteboard), a restore brings back the settings
 * alone, and says in one line that what people made on the page stays as it is.
 */
export function restoreWording(
  def: Pick<ArtifactTypeDef, "label" | "versions"> | null,
  n: number,
  current: number,
): RestoreWording {
  if (def?.versions === "settings") {
    const what = def.label.toLowerCase();
    return {
      action: "Restore settings",
      title: `Restore v${n}'s settings?`,
      description: `This publishes v${n}'s settings as v${current + 1}. What is on the ${what} stays as it is.`,
      done: `Restored v${n}'s settings`,
      doneDetail: (v) => `Its settings are now the current version, v${v}.`,
    };
  }
  return {
    action: `Restore v${n}`,
    title: `Restore v${n}?`,
    description: `This publishes v${n}'s content as v${current + 1}. Nothing is lost: v${current} and every other version stay in the history.`,
    done: `Restored v${n}`,
    doneDetail: (v) => `Its content is now the current version, v${v}.`,
  };
}

/** Parse a version number from a query value; null when absent or not a positive integer. */
export function parseVersion(v: string | null | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 ? n : null;
}
