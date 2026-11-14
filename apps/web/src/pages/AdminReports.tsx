// Page: /admin/reports. Instance admins review abuse reports: take an artifact down, or dismiss the
// report. Everyone else gets "not found", like the API.
import { ProhibitIcon, XIcon } from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  type Paged,
  type ReportInfo,
  type ReportState,
  route,
} from "@plinth/shared";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell.tsx";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Row,
  SkeletonText,
  Stack,
  Tabs,
  useToast,
} from "../components/ui/index.ts";
import { formatDate } from "../components/viewer/format.ts";
import "../components/viewer/admin.css";
import { ApiRequestError, api } from "../lib/api.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";
import NotFound from "./NotFound.tsx";

const TABS: { id: ReportState; label: string; empty: string }[] = [
  { id: "open", label: "Open", empty: "No open reports. New reports appear here." },
  { id: "actioned", label: "Taken down", empty: "No artifacts have been taken down." },
  { id: "dismissed", label: "Dismissed", empty: "No reports have been dismissed." },
];

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; items: ReportInfo[] };

export default function AdminReports() {
  const { me, loading } = useSession();
  const [tab, setTab] = useState<ReportState>("open");

  useEffect(() => {
    document.title = "Reports · Plinth";
  }, []);

  const signOut = async () => {
    try {
      await api(API.logout, { method: "POST" });
    } finally {
      window.location.assign(APP_ROUTES.home);
    }
  };

  if (loading) return null;
  if (!me?.is_admin) return <NotFound />;

  return (
    <AppShell
      onSignOut={signOut}
      extraNav={[{ label: "Reports", to: APP_ROUTES.adminReports }]}
      title="Reports"
    >
      <p className="pl-reports__lead">
        Artifacts people reported on this instance. Taking one down stops its link from opening it,
        for everyone, at once.
      </p>
      <Tabs
        label="Report state"
        value={tab}
        onChange={(id) => setTab(id as ReportState)}
        tabs={TABS.map((t) => ({
          id: t.id,
          label: t.label,
          content: <ReportList state={t.id} empty={t.empty} />,
        }))}
      />
    </AppShell>
  );
}

function ReportList({ state, empty }: { state: ReportState; empty: string }) {
  const toast = useToast();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [confirm, setConfirm] = useState<ReportInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      api<Paged<ReportInfo>>(`${API.adminReports}?state=${state}`, { signal })
        .then((r) => setList({ kind: "ok", items: r.items }))
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setList({
            kind: "error",
            message: e instanceof Error ? e.message : "Could not load reports.",
          });
        });
    },
    [state],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setList({ kind: "loading" });
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const decide = async (report: ReportInfo, next: "actioned" | "dismissed") => {
    setBusy(report.id);
    try {
      await api<ReportInfo>(route(API.adminReport, { id: report.id }), {
        method: "POST",
        body: { state: next },
      });
      setList((l) =>
        l.kind === "ok"
          ? {
              kind: "ok",
              // Taking an artifact down closes its other open reports too.
              items: l.items.filter((r) =>
                next === "actioned" ? r.artifact_id !== report.artifact_id : r.id !== report.id,
              ),
            }
          : l,
      );
      toast.success(next === "actioned" ? "Artifact taken down" : "Report dismissed");
      setConfirm(null);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "conflict") {
        toast.error("Already decided", e.message);
        setConfirm(null);
        load();
      } else if (e instanceof ApiRequestError && e.status === 404) {
        // No longer an admin (ADMIN_EMAIL changed).
        navigate(APP_ROUTES.dashboard, { replace: true });
      } else {
        toast.error("Could not save the decision", e instanceof Error ? e.message : undefined);
      }
    } finally {
      setBusy(null);
    }
  };

  if (list.kind === "loading") {
    return (
      <div aria-busy="true" className="pl-reports">
        <SkeletonText lines={5} />
      </div>
    );
  }
  if (list.kind === "error") {
    return (
      <EmptyState
        title="Reports could not be loaded"
        description={list.message}
        action={<Button onClick={() => load()}>Try again</Button>}
      />
    );
  }
  if (list.items.length === 0) return <EmptyState title="Nothing here" description={empty} />;

  return (
    <>
      <Stack as="ul" gap={2} className="pl-reports">
        {list.items.map((r) => (
          <Card as="li" key={r.id} padding="md" className="pl-report">
            <Stack gap={2}>
              <Row justify="between" align="baseline" gap={3}>
                <h2 className="pl-report__title">
                  <Link to={route(APP_ROUTES.artifact, { slug: r.artifact_slug })}>
                    {r.artifact_title}
                  </Link>
                </h2>
                {r.state !== "open" && (
                  <Badge tone={r.state === "actioned" ? "danger" : "neutral"}>
                    {r.state === "actioned" ? "Taken down" : "Dismissed"}
                  </Badge>
                )}
              </Row>
              <p className="pl-report__meta">
                Reported by {r.reporter_email ?? "an anonymous visitor"} on{" "}
                <time dateTime={r.created_at}>{formatDate(r.created_at)}</time>
                <span aria-hidden="true"> · </span>
                <span className="type-mono">{r.artifact_slug}</span>
              </p>
              <blockquote className="pl-report__reason">
                <span className="visually-hidden">Reason: </span>
                {r.reason}
              </blockquote>
              {r.state === "open" && (
                <Row gap={2}>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={ProhibitIcon}
                    onClick={() => setConfirm(r)}
                    disabled={busy !== null}
                  >
                    Take down
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={XIcon}
                    loading={busy === r.id && confirm === null}
                    onClick={() => decide(r, "dismissed")}
                    disabled={busy !== null && busy !== r.id}
                  >
                    Dismiss
                  </Button>
                </Row>
              )}
            </Stack>
          </Card>
        ))}
      </Stack>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && decide(confirm, "actioned")}
        danger
        loading={busy !== null && confirm !== null && busy === confirm.id}
        title={confirm ? `Take down “${confirm.artifact_title}”?` : "Take down"}
        description="Its link stops opening it at once, for everyone, and its other open reports close with it. There is no way to undo a takedown from this page."
        confirmLabel="Take down artifact"
      />
    </>
  );
}
