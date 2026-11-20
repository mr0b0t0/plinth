// Page: /a/:slug/settings. Owner only: title, category, a whiteboard's board settings, who can open
// it (visibility and password), people and their roles, the share link, and deletion.
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES, type ArtifactSummary, route, type SharingSettings } from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import "../components/account/account.css";
import { BoardSection } from "../components/account/BoardSection.tsx";
import { useDocumentTitle, useSignInRedirect, useSignOut } from "../components/account/hooks.tsx";
import { Note } from "../components/account/Note.tsx";
import {
  AccessSection,
  CategorySection,
  DeleteSection,
  PeopleSection,
  TitleSection,
} from "../components/account/SettingsSections.tsx";
import { AppShell } from "../components/layout/AppShell.tsx";
import {
  Button,
  ButtonLink,
  EmptyState,
  Skeleton,
  SkeletonText,
  VisibilityBadge,
} from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

type State =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "forbidden"; artifact: ArtifactSummary }
  | { status: "error"; message: string }
  | { status: "ready"; artifact: ArtifactSummary; sharing: SharingSettings };

export default function Settings({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const { pending, redirect } = useSignInRedirect();
  const { me, config } = useSession();
  const signOut = useSignOut();
  const [state, setState] = useState<State>({ status: "loading" });
  const [reload, setReload] = useState(0);

  useDocumentTitle(
    state.status === "ready" ? `Settings · ${state.artifact.title}` : "Artifact settings",
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch (Try again)
  useEffect(() => {
    if (pending) return;
    const ctrl = new AbortController();
    const load = async () => {
      // The artifact first (its role decides what to show), then its sharing settings.
      const artifact = await api<ArtifactSummary>(route(API.artifact, { ref: slug }), {
        signal: ctrl.signal,
      });
      if (artifact.role !== "owner") {
        setState({ status: "forbidden", artifact });
        return;
      }
      const sharing = await api<SharingSettings>(route(API.sharing, { ref: artifact.id }), {
        signal: ctrl.signal,
      });
      setState({ status: "ready", artifact, sharing });
    };
    load().catch((e: unknown) => {
      if (ctrl.signal.aborted) return;
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
        setState({ status: "not_found" });
      } else {
        setState({
          status: "error",
          message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
        });
      }
    });
    return () => ctrl.abort();
  }, [pending, slug, reload]);

  // A link to a section (the dashboard's "Move to category…" opens #settings-category): once the
  // settings have loaded, scroll to its heading (scroll-margin-top clears the sticky top bar) and
  // put the focus in its first field, so the shortcut lands where the person types.
  const scrolled = useRef(false);
  useEffect(() => {
    if (state.status !== "ready" || scrolled.current) return;
    scrolled.current = true;
    const id = window.location.hash.slice(1);
    const heading = id ? document.getElementById(id) : null;
    if (!heading) return;
    heading.scrollIntoView?.({ block: "start" });
    heading
      .closest("section")
      ?.querySelector<HTMLElement>("input, textarea, select")
      ?.focus({ preventScroll: true });
  }, [state.status]);

  const refreshSharing = useCallback(async () => {
    if (state.status !== "ready") return;
    const { artifact } = state;
    const [fresh, sharing] = await Promise.all([
      api<ArtifactSummary>(route(API.artifact, { ref: artifact.id })),
      api<SharingSettings>(route(API.sharing, { ref: artifact.id })),
    ]);
    setState({ status: "ready", artifact: fresh, sharing });
  }, [state]);

  if (redirect) return redirect;

  const artifactHref = (s: string) => route(APP_ROUTES.artifact, { slug: s });
  const known = state.status === "ready" ? state.artifact : null;
  const titled = known !== null;

  return (
    <AppShell
      onSignOut={signOut}
      crumbs={titled ? [{ label: "Artifacts", to: APP_ROUTES.dashboard }] : undefined}
      title={known ? <Link to={artifactHref(known.slug)}>{known.title}</Link> : undefined}
      trail="Settings"
      actions={
        state.status === "ready" ? (
          <ButtonLink to={artifactHref(state.artifact.slug)} icon={ArrowSquareOutIcon}>
            Open
          </ButtonLink>
        ) : undefined
      }
    >
      {pending || state.status === "loading" ? (
        <div aria-busy="true" className="pl-acct-settings">
          <span className="visually-hidden">Loading settings</span>
          <div className="pl-acct-settings__skeleton">
            <Skeleton width="8rem" height="0.75rem" />
          </div>
          <SkeletonText lines={4} />
        </div>
      ) : state.status === "not_found" ? (
        <EmptyState
          size="lg"
          headingLevel={1}
          title="Artifact not found"
          description="There is no artifact at this address that you can manage. It may have been deleted, or the link is mistyped."
          action={
            <ButtonLink to={APP_ROUTES.dashboard} variant="primary">
              Go to dashboard
            </ButtonLink>
          }
        />
      ) : state.status === "forbidden" ? (
        <EmptyState
          size="lg"
          headingLevel={1}
          title="Only the owner can change settings"
          description={`You can open “${state.artifact.title}”, but its visibility, people and deletion are up to its owner.`}
          action={
            <ButtonLink to={artifactHref(state.artifact.slug)} variant="primary">
              Open the artifact
            </ButtonLink>
          }
        />
      ) : state.status === "error" ? (
        <EmptyState
          art={null}
          headingLevel={1}
          title="Could not load the settings"
          description={state.message}
          action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}
        />
      ) : (
        <div className="pl-acct-settings">
          <p className="pl-acct-settings__meta">
            <VisibilityBadge visibility={state.artifact.visibility} />
            <span className="type-num text-muted">
              <span className="visually-hidden">Current version </span>v
              {state.artifact.current_version}
            </span>
          </p>
          {state.artifact.taken_down && (
            <Note tone="warning">
              This artifact was taken down after a report. Nobody else can open it.
            </Note>
          )}
          <TitleSection
            key={`title-${state.artifact.title}`}
            artifact={state.artifact}
            onRenamed={(title) =>
              setState((s) =>
                s.status === "ready" ? { ...s, artifact: { ...s.artifact, title } } : s,
              )
            }
          />
          {/* Not keyed on the category: a remount after Save would drop the focus. */}
          <CategorySection
            artifact={state.artifact}
            onSaved={(category) =>
              setState((s) =>
                s.status === "ready" ? { ...s, artifact: { ...s.artifact, category } } : s,
              )
            }
          />
          {state.artifact.type === "whiteboard" && (
            <BoardSection
              artifactId={state.artifact.id}
              onVersion={(version) =>
                setState((s) =>
                  s.status === "ready"
                    ? { ...s, artifact: { ...s.artifact, current_version: version } }
                    : s,
                )
              }
            />
          )}
          <AccessSection
            key={`access-${state.sharing.visibility}-${state.sharing.has_password}`}
            artifact={state.artifact}
            sharing={state.sharing}
            publicEnabled={config?.public_visibility_enabled === true}
            onSaved={refreshSharing}
          />
          <PeopleSection
            artifact={state.artifact}
            sharing={state.sharing}
            ownerEmail={me?.email ?? null}
            invitations={config?.invitation_emails !== false}
            onChange={(sharing) => setState((s) => (s.status === "ready" ? { ...s, sharing } : s))}
          />
          <DeleteSection artifact={state.artifact} />
        </div>
      )}
    </AppShell>
  );
}
