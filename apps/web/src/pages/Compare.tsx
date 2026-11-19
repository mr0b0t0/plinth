// Page: /a/:slug/compare?from=&to=. Two versions of an artifact: a plain-language list of what
// changed (worked out in the browser by the shared describers, files included), then the two
// versions rendered side by side, one at a time at phone width. No source is shown: older links
// with view=source or view=rendered land here too.
import { ArrowsLeftRightIcon, ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import type { VersionInfo } from "@plinth/shared";
import { ChangeList } from "../components/history/ChangeList.tsx";
import {
  AccessProblem,
  ArtifactCrumbTitle,
  HistoryShell,
  useDocumentTitle,
} from "../components/history/common.tsx";
import { useArtifact, useVersion, useVersions } from "../components/history/data.ts";
import { comparePath, excerpt, historyPath, parseVersion } from "../components/history/format.ts";
import { RenderedCompare } from "../components/history/RenderedCompare.tsx";
import { useChanges } from "../components/history/useChanges.ts";
import { ButtonLink, IconButton, Select, Skeleton, Tooltip } from "../components/ui/index.ts";
import { navigate, useLocation } from "../lib/router.tsx";

const clamp = (n: number, max: number) => Math.min(Math.max(n, 1), Math.max(max, 1));

function versionOption(v: VersionInfo, current: number) {
  const note = excerpt(v.note, 40);
  const tag = v.number === current ? "current" : note;
  return { value: String(v.number), label: tag ? `v${v.number} · ${tag}` : `v${v.number}` };
}

export default function Compare({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const { search } = useLocation();
  const artifact = useArtifact(slug);
  const versions = useVersions(slug);

  const current = artifact.data?.current_version ?? 0;
  const askedTo = parseVersion(search.get("to"));
  const askedFrom = parseVersion(search.get("from"));
  const to = current ? clamp(askedTo ?? current, current) : null;
  const from = to !== null ? clamp(askedFrom ?? to - 1, current) : null;

  const oldVersion = useVersion(slug, from);
  const newVersion = useVersion(slug, to);
  const changes = useChanges(oldVersion.data, newVersion.data);

  const title = artifact.data?.title;
  useDocumentTitle(
    title && from && to ? `Compare v${from} and v${to} of ${title}` : "Compare versions",
  );

  const error = artifact.error ?? versions.error ?? oldVersion.error ?? newVersion.error;
  if (error) {
    return (
      <HistoryShell>
        <div className="hx-problem">
          <AccessProblem error={error} slug={slug} what="comparison" />
        </div>
      </HistoryShell>
    );
  }

  const go = (f: number, t: number) => navigate(comparePath(slug, f, t), { replace: true });

  const options = (versions.data?.items ?? []).map((v) => versionOption(v, current));
  const ready = from !== null && to !== null;

  return (
    <HistoryShell
      width="full"
      title={title !== undefined ? <ArtifactCrumbTitle slug={slug} title={title} /> : undefined}
      trail="Compare versions"
      actions={
        <ButtonLink to={historyPath(slug)} icon={ClockCounterClockwiseIcon}>
          History
        </ButtonLink>
      }
    >
      <div className="hx-compare">
        <div className="hx-pickers">
          {options.length > 0 && ready ? (
            <>
              <Select
                label="From"
                className="hx-pickers__select"
                value={String(from)}
                options={options}
                onChange={(e) => go(Number(e.currentTarget.value), to)}
              />
              <Tooltip content="Swap sides">
                <IconButton
                  icon={ArrowsLeftRightIcon}
                  label="Swap sides"
                  variant="secondary"
                  className="hx-pickers__swap"
                  onClick={() => go(to, from)}
                />
              </Tooltip>
              <Select
                label="To"
                className="hx-pickers__select"
                value={String(to)}
                options={options}
                onChange={(e) => go(from, Number(e.currentTarget.value))}
              />
            </>
          ) : (
            <Skeleton width="24rem" height="var(--control-md)" />
          )}
        </div>

        {ready && from === to && (
          <p className="hx-note type-small">Both sides show the same version. Pick another one.</p>
        )}

        {ready && (
          <div className="hx-compare__body">
            <ChangeList
              key={`${from}-${to}`}
              heading={`What changed from v${from} to v${to}`}
              changes={changes?.changes ?? null}
              files={changes?.files ?? null}
            />
            <RenderedCompare slug={slug} title={title ?? slug} from={from} to={to} />
          </div>
        )}
      </div>
    </HistoryShell>
  );
}
