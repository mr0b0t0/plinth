// Page: /open/:id?next=<path>. Where direct content links without a viewer cookie used to land.
// Artifacts now render only inside the app's frame (see DECISIONS.md), so this forwards to the
// artifact page, keeping a version or a page inside the artifact.
import { Redirect, useLocation } from "../lib/router.tsx";

export function openTarget(id: string, next: string | null): string {
  const base = `/a/${encodeURIComponent(id)}`;
  if (!next || next === "/" || !next.startsWith("/") || next.startsWith("//")) return base;
  const version = /^\/__plinth\/v\/(\d{1,9})\/?$/.exec(next);
  if (version) return `${base}/v/${version[1]}`;
  return `${base}?path=${encodeURIComponent(next)}`;
}

export default function Open({ params }: { params: Record<string, string> }) {
  const { search } = useLocation();
  return <Redirect to={openTarget(params.id ?? "", search.get("next"))} />;
}
