// Page: Editor (/a/:slug/edit). Owner and editors only. Loads the artifact and any draft this tab
// kept, then the workspace (Monaco and the live preview), which is a separate lazy chunk so nothing
// of Monaco loads for people who cannot edit or whose screen is too narrow.
import { ArrowLeftIcon, ClockCounterClockwiseIcon, EyeIcon } from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  type ArtifactDetail,
  isLiveType,
  type LiveDraftInfo,
  liveRules,
  route,
  sourceOf,
} from "@plinth/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { type EditorInitial, initialState } from "../components/editor/initial.ts";
import {
  EDITOR_MIN_WIDTH,
  EDITOR_WIDE_QUERY,
  useMediaQuery,
} from "../components/editor/useMediaQuery.ts";
import { AppShell } from "../components/layout/AppShell.tsx";
import { ButtonLink, EmptyState, Row, SkeletonText, Spinner } from "../components/ui/index.ts";
import { ApiRequestError, api, liveInfo } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";
import "../components/editor/editor-page.css";

const EditorWorkspace = lazy(() => import("../components/editor/EditorWorkspace.tsx"));

type Load =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "not_found" }
  | { kind: "forbidden"; artifact: ArtifactDetail | null }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      artifact: ArtifactDetail;
      initial: EditorInitial;
      /** A doc's unsaved page edits (#36), when people left some. */
      pageEdits: LiveDraftInfo | null;
    };

const canEdit = (a: ArtifactDetail) => (a.role === "owner" || a.role === "editor") && !a.taken_down;

async function load(slug: string): Promise<Load> {
  try {
    const artifact = await api<ArtifactDetail>(route(API.artifact, { ref: slug }));
    if (!canEdit(artifact)) return { kind: "forbidden", artifact };
    const initial = await initialState(artifact, async (n) => {
      const old = await api<ArtifactDetail>(route(API.version, { ref: artifact.id, n }));
      return sourceOf(old).text;
    });
    return { kind: "ready", artifact, initial, pageEdits: await pageEdits(artifact) };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      if (e.status === 401) return { kind: "signed_out" };
      if (e.status === 404) return { kind: "not_found" };
      if (e.status === 403) return { kind: "forbidden", artifact: null };
    }
    return { kind: "error", message: e instanceof Error ? e.message : "Something went wrong." };
  }
}

/**
 * A doc's unsaved page edits, or null (none, a type without on-page editing, or on-page editing
 * is off here).
 */
async function pageEdits(artifact: ArtifactDetail): Promise<LiveDraftInfo | null> {
  if (!isLiveType(sourceOf(artifact).def)) return null;
  try {
    const info = await liveInfo(artifact.id);
    return info.draft?.dirty ? info.draft : null;
  } catch {
    return null;
  }
}

function titleFor(state: Load): string {
  switch (state.kind) {
    case "ready":
      return `Edit ${state.artifact.title} · Plinth`;
    case "signed_out":
      return "Sign in to edit · Plinth";
    case "not_found":
      return "Artifact not found · Plinth";
    case "forbidden":
      return "You can't edit this · Plinth";
    default:
      return "Editor · Plinth";
  }
}

export default function Editor({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const editPath = route(APP_ROUTES.editor, { slug });
  const viewPath = route(APP_ROUTES.artifact, { slug });
  const historyPath = route(APP_ROUTES.history, { slug });
  const { loading: sessionLoading, me, config } = useSession();
  const wide = useMediaQuery(EDITOR_WIDE_QUERY);
  const [state, setState] = useState<Load>({ kind: "loading" });
  // Once the workspace has mounted it stays mounted (hidden when the window gets narrow), so
  // resizing never throws away the editor's state.
  const [mounted, setMounted] = useState(false);
  const userId = me?.id ?? null;

  useEffect(() => {
    if (sessionLoading) return;
    if (!userId) {
      setState({ kind: "signed_out" });
      return;
    }
    let live = true;
    setState({ kind: "loading" });
    load(slug).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [slug, sessionLoading, userId]);

  useEffect(() => {
    document.title = titleFor(state);
  }, [state]);

  const ready = state.kind === "ready" && config;
  useEffect(() => {
    if (ready && wide) setMounted(true);
  }, [ready, wide]);

  if (state.kind === "ready" && config && (wide || mounted)) {
    return (
      <AppShell
        width="full"
        crumbs={wide ? [{ label: "Artifacts", to: APP_ROUTES.dashboard }] : undefined}
        title={wide ? <Link to={viewPath}>{state.artifact.title}</Link> : undefined}
        trail={wide ? "Edit" : undefined}
      >
        {state.pageEdits && (
          <p className="pl-editor-page__live" role="note">
            There are unsaved page edits based on v{state.pageEdits.base_version}. Saving here
            publishes a new version;{" "}
            {liveRules(state.artifact.type)?.merge === "review"
              ? "their edits are not merged with it: they review it beside theirs and keep one."
              : "their edits are merged onto it, or reviewed if they overlap."}
          </p>
        )}
        {!wide && (
          <NarrowMessage
            title={state.artifact.title}
            viewPath={viewPath}
            historyPath={historyPath}
          />
        )}
        <Suspense
          fallback={
            <div className="pl-editor-loading">
              <Spinner label="Loading the editor" />
            </div>
          }
        >
          <EditorWorkspace
            artifact={state.artifact}
            config={config}
            initial={state.initial}
            active={wide}
          />
        </Suspense>
      </AppShell>
    );
  }

  return (
    <AppShell>
      {state.kind === "loading" || (state.kind === "ready" && !config) ? (
        <div className="pl-editor-page__loading" aria-busy="true">
          <span className="visually-hidden" role="status">
            Loading the editor
          </span>
          <SkeletonText lines={3} />
        </div>
      ) : state.kind === "signed_out" ? (
        <EmptyState
          headingLevel={1}
          title="Sign in to edit"
          description="Only the owner and people with the editor role can change an artifact. Sign in to continue."
          action={
            <ButtonLink
              to={`${APP_ROUTES.login}?next=${encodeURIComponent(editPath)}`}
              variant="primary"
            >
              Sign in
            </ButtonLink>
          }
        />
      ) : state.kind === "not_found" ? (
        <EmptyState
          headingLevel={1}
          title="Artifact not found"
          description="Nothing stands at this address, or you do not have access to it. If someone shared it with you, ask them for a new link."
          action={
            <ButtonLink to={APP_ROUTES.dashboard} variant="primary">
              Go to dashboard
            </ButtonLink>
          }
        />
      ) : state.kind === "forbidden" ? (
        <EmptyState
          headingLevel={1}
          title="You can't edit this"
          description={
            state.artifact?.taken_down
              ? "This artifact was taken down and cannot be changed."
              : state.artifact
                ? `You can view “${state.artifact.title}”, but only its owner and people with the editor role can change it. Ask the owner for edit access.`
                : "Only the owner and people with the editor role can change this artifact."
          }
          action={
            <Row gap={3} justify="center">
              {state.artifact && !state.artifact.taken_down && (
                <ButtonLink to={viewPath} variant="primary" icon={EyeIcon}>
                  View artifact
                </ButtonLink>
              )}
              <ButtonLink to={APP_ROUTES.dashboard} variant="secondary">
                Go to dashboard
              </ButtonLink>
            </Row>
          }
        />
      ) : state.kind === "error" ? (
        <EmptyState
          headingLevel={1}
          title="The editor could not load"
          description={state.message}
          action={
            <ButtonLink to={viewPath} variant="secondary" icon={ArrowLeftIcon}>
              Back to the artifact
            </ButtonLink>
          }
        />
      ) : state.kind === "ready" ? (
        <NarrowMessage title={state.artifact.title} viewPath={viewPath} historyPath={historyPath} />
      ) : null}
    </AppShell>
  );
}

function NarrowMessage({
  title,
  viewPath,
  historyPath,
}: {
  title: string;
  viewPath: string;
  historyPath: string;
}) {
  return (
    <div className="pl-editor-narrow">
      <EmptyState
        headingLevel={1}
        title="The editor needs a wider screen"
        description={`Editing “${title}” needs a window at least ${EDITOR_MIN_WIDTH} pixels wide. On this screen you can still view the artifact and its version history.`}
        action={
          <Row gap={3} justify="center">
            <ButtonLink to={viewPath} variant="primary" icon={EyeIcon}>
              View artifact
            </ButtonLink>
            <ButtonLink to={historyPath} variant="secondary" icon={ClockCounterClockwiseIcon}>
              Version history
            </ButtonLink>
          </Row>
        }
      />
    </div>
  );
}
