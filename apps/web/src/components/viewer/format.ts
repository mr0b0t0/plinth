// Small formatting helpers for the viewer and admin pages.

/** "13 Nov 2026, 14:05" in the reader's locale; the raw value when it does not parse. */
export function formatDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
