// The admin Stats tiles: one figure per tile with a short caption. Instance totals only; nothing
// here names an artifact, owner or viewer.
import { type AdminStats, APP_ROUTES, CLIENT_TYPES, VISIBILITIES } from "@plinth/shared";
import type { ReactNode } from "react";
import { Link } from "../../lib/router.tsx";
import { formatBytes } from "../history/format.ts";
import { VISIBILITY_META } from "../ui/index.ts";
import "./admin.css";

const nf = new Intl.NumberFormat("en");

/** "1,234" (grouped, the reader's digits stay ASCII so tests and copy match). */
export const formatCount = (n: number) => nf.format(n);

const CLIENT_NAMES: Record<(typeof CLIENT_TYPES)[number], string> = {
  claude: "Claude",
  codex: "Codex",
  other: "other",
};

interface Tile {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
}

/** Join caption parts with a middle dot that screen readers skip. */
function parts(items: ReactNode[]): ReactNode {
  const shown = items.filter((x) => x !== null && x !== false && x !== "");
  return shown.map((x, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional caption parts
    <span key={i}>
      {i > 0 && <span aria-hidden="true"> · </span>}
      {i > 0 && <span className="visually-hidden">, </span>}
      {x}
    </span>
  ));
}

export function statTiles(s: AdminStats): Tile[] {
  const t = s.totals;
  const w = s.window;
  const byVisibility = VISIBILITIES.filter((v) => (t.artifacts_by_visibility[v] ?? 0) > 0).map(
    (v) =>
      `${formatCount(t.artifacts_by_visibility[v] ?? 0)} ${VISIBILITY_META[v].label.toLowerCase()}`,
  );
  return [
    {
      label: "People",
      value: formatCount(t.users),
      caption: `+${formatCount(w.new_users)} in period`,
    },
    {
      label: "Artifacts",
      value: formatCount(t.artifacts),
      caption: parts([
        ...byVisibility,
        t.artifacts_taken_down > 0 ? `${formatCount(t.artifacts_taken_down)} taken down` : null,
      ]),
    },
    {
      label: "Publishes",
      value: formatCount(w.publishes),
      caption: parts([
        `${formatCount(t.versions)} versions in all`,
        `${formatCount(t.agent_versions)} by agents`,
      ]),
    },
    { label: "Storage", value: formatBytes(t.storage_bytes) },
    {
      label: "Shared data",
      value: formatCount(t.data_docs),
      caption: `${formatBytes(t.data_bytes)} on ${formatCount(t.data_artifacts)} ${
        t.data_artifacts === 1 ? "page" : "pages"
      }`,
    },
    {
      label: "Agent connections",
      value: formatCount(t.connections),
      caption: parts([
        `${formatCount(w.connections_used)} used in period`,
        ...CLIENT_TYPES.map(
          (c) => `${CLIENT_NAMES[c]} ${formatCount(t.connections_by_client[c] ?? 0)}`,
        ),
      ]),
    },
    s.view_counts
      ? {
          label: "Opens",
          value: formatCount(w.views),
          caption: `${formatCount(t.views)} in all`,
        }
      : {
          label: "Opens",
          value: "Off",
          caption: "Turned off on this instance (VIEW_COUNTS)",
        },
    {
      label: "Open reports",
      value: formatCount(t.open_reports),
      caption: <Link to={APP_ROUTES.adminReports}>Review reports</Link>,
    },
  ];
}

export function StatGrid({ stats }: { stats: AdminStats }) {
  return (
    <dl className="pl-stat-grid">
      {statTiles(stats).map((tile) => (
        <div key={tile.label} className="pl-stat">
          <dt className="pl-stat__label">{tile.label}</dt>
          <dd className="pl-stat__value type-num">{tile.value}</dd>
          {tile.caption && <dd className="pl-stat__caption type-num">{tile.caption}</dd>}
        </div>
      ))}
    </dl>
  );
}
