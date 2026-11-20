// Page: /a/:slug/history. Every version of an artifact: who made it, the note, when, the size.
// View any version, compare two, and (owner and editors) restore one as the next version.
import {
  ArrowCounterClockwiseIcon,
  ArrowsLeftRightIcon,
  DotsThreeIcon,
  EyeIcon,
} from "@phosphor-icons/react";
import { typeDef, type VersionInfo } from "@plinth/shared";
import { useState } from "react";
import {
  AccessProblem,
  ArtifactCrumbTitle,
  AuthorLabel,
  HistoryShell,
  useDocumentTitle,
  VersionDate,
} from "../components/history/common.tsx";
import { restoreVersion, useArtifact, useVersions } from "../components/history/data.ts";
import {
  artifactPath,
  comparePath,
  formatBytes,
  restoreWording,
  versionPath,
} from "../components/history/format.ts";
import {
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  ConfirmDialog,
  Menu,
  type MenuEntry,
  SkeletonText,
  useToast,
} from "../components/ui/index.ts";
import { ApiRequestError } from "../lib/api.ts";
import { navigate } from "../lib/router.tsx";

export default function History({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const artifact = useArtifact(slug);
  const versions = useVersions(slug);
  const toast = useToast();
  const [selected, setSelected] = useState<number[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const title = artifact.data?.title;
  useDocumentTitle(title ? `History of ${title}` : "History");

  const error = artifact.error ?? versions.error;
  if (error) {
    return (
      <HistoryShell>
        <div className="hx-problem">
          <AccessProblem error={error} slug={slug} what="history" />
        </div>
      </HistoryShell>
    );
  }

  const a = artifact.data;
  const items = versions.data?.items;
  const current = a?.current_version ?? items?.[0]?.number ?? 0;
  const canRestore = a?.role === "owner" || a?.role === "editor";
  const def = a ? typeDef(a.type) : null;
  const wording = (n: number) => restoreWording(def, n, current);

  const toggle = (n: number, on: boolean) =>
    setSelected((s) =>
      on ? [...s.filter((x) => x !== n), n].slice(-2) : s.filter((x) => x !== n),
    );

  const refresh = () => {
    artifact.reload();
    versions.reload();
  };

  const confirmRestore = async () => {
    if (restoreTarget === null) return;
    const n = restoreTarget;
    setRestoring(true);
    try {
      const result = await restoreVersion(slug, n, current);
      const w = wording(n);
      toast.success(w.done, w.doneDetail(result.version));
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) {
        toast.error(
          "Someone published meanwhile",
          "A newer version appeared while this page was open, so nothing was restored. The list is up to date now; check it and restore again if you still want to.",
        );
      } else {
        toast.error("Could not restore", e instanceof Error ? e.message : undefined);
      }
    } finally {
      setRestoring(false);
      setRestoreTarget(null);
      refresh();
    }
  };

  const [from, to] = [...selected].sort((x, y) => x - y);

  return (
    <HistoryShell
      title={title !== undefined ? <ArtifactCrumbTitle slug={slug} title={title} /> : undefined}
      trail="History"
      actions={
        <ButtonLink to={artifactPath(slug)} icon={EyeIcon}>
          Open
        </ButtonLink>
      }
    >
      <div className="hx-intro">
        {a && (
          <p className="hx-intro__meta">
            <span className="type-num">
              {a.version_count === 1 ? "1 version" : `${a.version_count} versions`}
            </span>
            <span aria-hidden="true" className="hx-dot">
              ·
            </span>
            <span className="type-num">v{a.current_version} is current</span>
          </p>
        )}
        <p className="hx-hint">
          Restoring publishes an old version&rsquo;s content as a new version. Nothing is ever
          overwritten. <span className="hx-hint__select">Tick two versions to compare them.</span>
        </p>
      </div>

      {!items ? (
        <ol className="hx-list" aria-busy="true" aria-label="Versions">
          {[0, 1, 2].map((i) => (
            <li key={i} className="hx-row hx-row--skeleton">
              <SkeletonText lines={2} />
            </li>
          ))}
        </ol>
      ) : (
        <ol className="hx-list" aria-label="Versions">
          {items.map((v) => (
            <VersionRow
              key={v.number}
              slug={slug}
              v={v}
              current={current}
              checked={selected.includes(v.number)}
              onCheck={(on) => toggle(v.number, on)}
              canRestore={canRestore}
              restoreLabel={wording(v.number).action}
              onRestore={() => setRestoreTarget(v.number)}
            />
          ))}
        </ol>
      )}

      {selected.length > 0 && (
        <section className="hx-selbar" aria-label="Compare selected versions">
          <p className="hx-selbar__text" aria-live="polite">
            {from !== undefined && to !== undefined ? (
              <>
                <span className="type-num">v{from}</span> and{" "}
                <span className="type-num">v{to}</span> selected
              </>
            ) : (
              <>
                <span className="type-num">v{selected[0]}</span> selected. Tick one more to compare.
              </>
            )}
          </p>
          <div className="hx-actions">
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
              Clear
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={ArrowsLeftRightIcon}
              disabled={from === undefined || to === undefined}
              onClick={() => from && to && navigate(comparePath(slug, from, to))}
            >
              Compare selected
            </Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={restoreTarget !== null}
        onClose={() => !restoring && setRestoreTarget(null)}
        onConfirm={confirmRestore}
        loading={restoring}
        title={restoreTarget === null ? "" : wording(restoreTarget).title}
        description={restoreTarget === null ? "" : wording(restoreTarget).description}
        confirmLabel={restoreTarget === null ? "" : wording(restoreTarget).action}
      />
    </HistoryShell>
  );
}

function VersionRow({
  slug,
  v,
  current,
  checked,
  onCheck,
  canRestore,
  restoreLabel,
  onRestore,
}: {
  slug: string;
  v: VersionInfo;
  current: number;
  checked: boolean;
  onCheck: (on: boolean) => void;
  canRestore: boolean;
  restoreLabel: string;
  onRestore: () => void;
}) {
  const isCurrent = v.number === current;
  const actions: MenuEntry[] = [
    {
      label: "Compare with previous",
      icon: ArrowsLeftRightIcon,
      href: comparePath(slug, v.number - 1, v.number),
      disabled: v.number <= 1,
    },
    {
      label: "Compare with current",
      icon: ArrowsLeftRightIcon,
      href: comparePath(slug, v.number, current),
      disabled: isCurrent,
    },
  ];
  if (canRestore && !isCurrent) {
    actions.push(
      { type: "separator" },
      { label: restoreLabel, icon: ArrowCounterClockwiseIcon, onSelect: onRestore },
    );
  }
  return (
    <li className={`hx-row${checked ? " hx-row--selected" : ""}`} data-version={v.number}>
      <Checkbox
        className="hx-row__check"
        checked={checked}
        onChange={(e) => onCheck(e.currentTarget.checked)}
        label={<span className="visually-hidden">Select v{v.number} to compare</span>}
      />
      <div className="hx-row__main">
        <div className="hx-row__head">
          <h2 className="hx-row__n">v{v.number}</h2>
          {isCurrent && <Badge tone="strong">Current</Badge>}
          {v.restored_from !== null && (
            <Badge icon={ArrowCounterClockwiseIcon}>Restored from v{v.restored_from}</Badge>
          )}
        </div>
        {/* A restore's automatic note repeats the badge; show only notes that add something. */}
        {v.note && v.note !== `Restored from v${v.restored_from}` ? (
          <p className="hx-row__note">{v.note}</p>
        ) : v.restored_from === null ? (
          <p className="hx-row__note hx-row__note--empty">No note</p>
        ) : null}
        <p className="hx-row__meta">
          <AuthorLabel author={v.author} />
          <span aria-hidden="true" className="hx-dot">
            ·
          </span>
          <VersionDate iso={v.created_at} />
          <span aria-hidden="true" className="hx-dot">
            ·
          </span>
          <span>{formatBytes(v.size_bytes)}</span>
        </p>
      </div>
      <div className="hx-row__actions">
        <ButtonLink
          to={versionPath(slug, v.number)}
          variant="ghost"
          size="sm"
          icon={EyeIcon}
          aria-label={`View v${v.number}`}
        >
          View
        </ButtonLink>
        <Menu
          label={`More actions for v${v.number}`}
          icon={DotsThreeIcon}
          iconOnly
          variant="ghost"
          size="sm"
          align="end"
          items={actions}
        />
      </div>
    </li>
  );
}
