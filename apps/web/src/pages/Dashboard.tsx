// Page: /dashboard. The signed-in person's artifacts and the ones shared with them: a filter row
// (All / Mine / Shared, the owner's category, sort, list or grid), search (kept in ?q=, the category
// in ?category=), and the artifact quota.
import {
  ArrowsDownUpIcon,
  ChartLineUpIcon,
  FolderSimpleIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlugIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  type ArtifactList,
  type ArtifactSummary,
  type CategoryCount,
  categoryKey,
} from "@plinth/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import "../components/account/account.css";
import "../components/account/dashboard.css";
import {
  ArtifactCard,
  ArtifactCardSkeleton,
  ArtifactListHeader,
  ArtifactRow,
  ArtifactRowSkeleton,
  initialsOf,
} from "../components/account/ArtifactRow.tsx";
import { CopyField } from "../components/account/CopyField.tsx";
import { mcpUrl, quotaText } from "../components/account/format.ts";
import {
  useDebouncedValue,
  useDocumentTitle,
  useSignInRedirect,
  useSignOut,
} from "../components/account/hooks.tsx";
import { CONNECT_AGENT_HREF } from "../components/account/nav.ts";
import { RenameCategoryDialog } from "../components/account/RenameCategoryDialog.tsx";
import { AppShell } from "../components/layout/AppShell.tsx";
import {
  Button,
  ButtonLink,
  EmptyState,
  IconButton,
  Menu,
  SegmentedControl,
  Spinner,
  Tooltip,
} from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: ArtifactSummary[]; categories: CategoryCount[]; query: string };

type Filter = "all" | "mine" | "shared";
type Sort = "updated" | "created" | "title";
/** The category filter: null shows every category, "" the owner's artifacts with none. */
export type CategoryFilter = string | null;
export type DashboardView = "list" | "grid";

export const VIEW_STORAGE_KEY = "plinth-dashboard-view";

const SORT_LABEL: Record<Sort, string> = {
  updated: "Updated",
  created: "Created",
  title: "Title",
};

function readView(): DashboardView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function saveView(v: DashboardView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

/** The dashboard's address for a search and a category filter (`?category=` alone: no category). */
export function dashboardHref(query: string, category: CategoryFilter): string {
  const params: string[] = [];
  if (query) params.push(`q=${encodeURIComponent(query)}`);
  if (category !== null) params.push(`category=${encodeURIComponent(category)}`);
  return params.length ? `${APP_ROUTES.dashboard}?${params.join("&")}` : APP_ROUTES.dashboard;
}

/**
 * The artifacts a category filter keeps: the person's own, in that category (matched as the Worker
 * matches names: ignoring case, spaces, "-" and "_") or, for "", with none. Shared artifacts never
 * carry a category, so a filter leaves them out.
 */
export function filterByCategory(
  items: ArtifactSummary[],
  category: CategoryFilter,
): ArtifactSummary[] {
  if (category === null) return items;
  const key = categoryKey(category);
  return items.filter(
    (a) =>
      a.role === "owner" &&
      (category === ""
        ? a.category === null
        : a.category !== null && categoryKey(a.category) === key),
  );
}

/**
 * The list after the owner renamed, merged or removed `from` (stored: the Worker's name, or null),
 * applied at once so the page shows the result (and keeps its controls) before the reload lands.
 */
export function applyCategoryRename(
  list: { items: ArtifactSummary[]; categories: CategoryCount[] },
  from: CategoryCount,
  stored: string | null,
): { items: ArtifactSummary[]; categories: CategoryCount[] } {
  const key = categoryKey(from.name);
  const items = list.items.map((a) =>
    a.role === "owner" && a.category !== null && categoryKey(a.category) === key
      ? { ...a, category: stored }
      : a,
  );
  const rest = list.categories.filter((c) => categoryKey(c.name) !== key);
  if (stored === null) return { items, categories: rest };
  const into = rest.find((c) => c.name === stored);
  const categories = into
    ? rest.map((c) => (c === into ? { ...c, count: c.count + from.count } : c))
    : [...rest, { name: stored, count: from.count }];
  // Most-used first, as the Worker lists them.
  categories.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { items, categories };
}

export function sortArtifacts(items: ArtifactSummary[], sort: Sort): ArtifactSummary[] {
  const out = [...items];
  if (sort === "title") out.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === "created") out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  else out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

export default function Dashboard() {
  useDocumentTitle("Artifacts");
  const { pending, redirect } = useSignInRedirect();
  const { me, config, refresh } = useSession();
  const signOut = useSignOut();
  const { search } = useLocation();
  const searchId = useId();
  const [query, setQuery] = useState(() => search.get("q") ?? "");
  const settled = useDebouncedValue(query.trim(), 250);
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState<CategoryFilter>(() => search.get("category"));
  const [renaming, setRenaming] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  /** A removed category takes its Rename button with it: focus goes to the category menu. */
  const [focusCategoryMenu, setFocusCategoryMenu] = useState(false);
  const [sort, setSort] = useState<Sort>("updated");
  const [view, setView] = useState<DashboardView>(readView);

  const chooseView = (v: DashboardView) => {
    setView(v);
    saveView(v);
  };

  // The quota count may have changed since the session loaded (publishes, deletes).
  useEffect(() => {
    if (!pending) refresh().catch(() => undefined);
  }, [pending, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch (Try again)
  useEffect(() => {
    if (pending) return;
    const ctrl = new AbortController();
    setBusy(true);
    const path = settled ? `${API.artifacts}?query=${encodeURIComponent(settled)}` : API.artifacts;
    api<ArtifactList>(path, { signal: ctrl.signal })
      .then((res) => {
        setList({
          status: "ready",
          items: res.items,
          categories: res.categories ?? [],
          query: settled,
        });
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setList({
          status: "error",
          message:
            e instanceof ApiRequestError
              ? e.message
              : "Could not reach Plinth. Check your connection and try again.",
        });
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [settled, pending, reload]);

  useEffect(() => {
    if (!focusCategoryMenu) return;
    setFocusCategoryMenu(false);
    barRef.current?.querySelector<HTMLButtonElement>(".pl-dash-bar__category > button")?.focus();
  }, [focusCategoryMenu]);

  // Keep the search and the category in the address bar (replace, so typing does not fill the
  // history).
  useEffect(() => {
    if (pending) return;
    const want = dashboardHref(settled, category);
    if (window.location.pathname + window.location.search !== want) {
      window.history.replaceState(null, "", want);
    }
  }, [settled, category, pending]);

  const items = list.status === "ready" ? list.items : [];
  const categories = list.status === "ready" ? list.categories : [];
  const hasShared = items.some((a) => a.role !== "owner");
  // Shared artifacts carry no category, so the category filter is off (and its menu hidden) there.
  const byCategory = filter !== "shared" && category !== null;
  const shown = useMemo(() => {
    const picked =
      filter === "mine"
        ? items.filter((a) => a.role === "owner")
        : filter === "shared"
          ? items.filter((a) => a.role !== "owner")
          : items;
    return sortArtifacts(filterByCategory(picked, byCategory ? category : null), sort);
  }, [items, filter, sort, category, byCategory]);
  // The listed category a name filter points at (none for an unknown ?category=).
  const selected =
    category && byCategory
      ? (categories.find((c) => categoryKey(c.name) === categoryKey(category)) ?? null)
      : null;

  if (redirect) return redirect;

  const searching = list.status === "ready" && list.query !== "";
  const nothingYet = list.status === "ready" && !searching && items.length === 0;
  const you = me ? initialsOf(me.name || me.email) : undefined;

  const searchField = (
    <search className="pl-dash-search">
      <label htmlFor={searchId} className="visually-hidden">
        Search artifacts
      </label>
      <MagnifyingGlassIcon size={16} aria-hidden="true" className="pl-dash-search__icon" />
      <input
        id={searchId}
        className="pl-control pl-dash-search__input"
        type="search"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="pl-dash-search__status" role="status">
        {busy && list.status === "ready" ? (
          <Spinner size={14} label="Searching" />
        ) : searching ? (
          <span className="visually-hidden">
            {`${items.length} ${items.length === 1 ? "match" : "matches"}`}
          </span>
        ) : null}
      </span>
    </search>
  );

  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "mine", label: "Mine" },
    ...(hasShared || filter === "shared" ? [{ value: "shared" as const, label: "Shared" }] : []),
  ];

  const emptyFilter =
    list.status === "ready" && items.length > 0 && shown.length === 0
      ? byCategory
        ? category === ""
          ? searching
            ? "None of your artifacts without a category match."
            : "Every artifact you own has a category."
          : searching
            ? `Nothing in ${selected?.name ?? category} matches.`
            : `Nothing in ${selected?.name ?? category} yet.`
        : filter === "mine"
          ? searching
            ? "None of your artifacts match."
            : "You have not published anything yet."
          : "Nothing has been shared with you."
      : null;

  const categoryLabel =
    category === null || !byCategory
      ? "All"
      : category === ""
        ? "No category"
        : (selected?.name ?? category);
  const showCategoryMenu = filter !== "shared" && (categories.length > 0 || category !== null);
  const byName = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  const categoryMenu = showCategoryMenu && (
    <>
      <Menu
        label={`Category: ${categoryLabel}`}
        variant="ghost"
        icon={FolderSimpleIcon}
        className="pl-dash-bar__category"
        triggerContent={
          <span className="pl-dash-bar__category-label">{`Category: ${categoryLabel}`}</span>
        }
        items={[
          {
            label: "All categories",
            checked: category === null,
            onSelect: () => setCategory(null),
          },
          ...byName.map((c) => ({
            label: `${c.name} (${c.count})`,
            checked: selected?.name === c.name,
            onSelect: () => setCategory(c.name),
          })),
          { type: "separator" as const },
          { label: "No category", checked: category === "", onSelect: () => setCategory("") },
        ]}
      />
      {selected && (
        <Tooltip content="Rename category">
          <IconButton
            icon={PencilSimpleIcon}
            label="Rename category"
            onClick={() => setRenaming(true)}
          />
        </Tooltip>
      )}
    </>
  );

  return (
    <AppShell onSignOut={signOut} title="Artifacts" actions={nothingYet ? undefined : searchField}>
      {!nothingYet && list.status !== "error" && (
        <div className="pl-dash-bar" ref={barRef}>
          <SegmentedControl<Filter>
            label="Show"
            options={filters}
            value={filter}
            onChange={setFilter}
            className="pl-dash-bar__filters"
          />
          {categoryMenu}
          <span className="pl-dash-bar__spacer" />
          <ButtonLink to={APP_ROUTES.stats} variant="ghost" icon={ChartLineUpIcon}>
            Stats
          </ButtonLink>
          <Menu
            label={`Sort by ${SORT_LABEL[sort].toLowerCase()}`}
            variant="ghost"
            icon={ArrowsDownUpIcon}
            align="end"
            className="pl-dash-bar__sort"
            triggerContent={<span className="pl-dash-bar__sort-label">{SORT_LABEL[sort]}</span>}
            items={(Object.keys(SORT_LABEL) as Sort[]).map((s) => ({
              label: SORT_LABEL[s],
              checked: s === sort,
              onSelect: () => setSort(s),
            }))}
          />
          <fieldset className="pl-dash-bar__views">
            <legend className="visually-hidden">View</legend>
            <Tooltip content="Grid">
              <IconButton
                icon={SquaresFourIcon}
                label="Grid view"
                aria-pressed={view === "grid"}
                onClick={() => chooseView("grid")}
              />
            </Tooltip>
            <Tooltip content="List">
              <IconButton
                icon={ListBulletsIcon}
                label="List view"
                aria-pressed={view === "list"}
                onClick={() => chooseView("list")}
              />
            </Tooltip>
          </fieldset>
        </div>
      )}

      {pending || list.status === "loading" ? (
        <div aria-busy="true" className="pl-dash">
          <span className="visually-hidden">Loading artifacts</span>
          {view === "grid" ? (
            <ul className="pl-dash__grid">
              <ArtifactCardSkeleton />
              <ArtifactCardSkeleton />
              <ArtifactCardSkeleton />
              <ArtifactCardSkeleton />
            </ul>
          ) : (
            <div className="pl-dash__list">
              <ArtifactListHeader />
              <ul className="pl-dash__rows">
                <ArtifactRowSkeleton />
                <ArtifactRowSkeleton />
                <ArtifactRowSkeleton />
              </ul>
            </div>
          )}
        </div>
      ) : list.status === "error" ? (
        <EmptyState
          art={null}
          title="Could not load your artifacts"
          description={list.message}
          action={
            <Button variant="primary" onClick={() => setReload((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      ) : nothingYet ? (
        <EmptyState
          size="lg"
          title="Nothing on display yet"
          description={
            <div className="pl-acct-empty">
              <p>
                Connect an agent, then ask it to publish something. Whatever it publishes stands
                here, and you decide who can see it.
              </p>
              <CopyField
                label="MCP server URL"
                value={mcpUrl(config?.app_origin)}
                copyLabel="Copy MCP server URL"
                copiedMessage="MCP server URL copied"
              />
            </div>
          }
          action={
            <ButtonLink to={CONNECT_AGENT_HREF} variant="primary" icon={PlugIcon}>
              Connect an agent
            </ButtonLink>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          art={null}
          title={`Nothing matches “${list.query}”`}
          description="Try another word from the title."
          action={<Button onClick={() => setQuery("")}>Clear search</Button>}
        />
      ) : (
        <section className="pl-dash" aria-label="Artifacts" aria-busy={busy || undefined}>
          {emptyFilter ? (
            <p className="pl-dash__empty">{emptyFilter}</p>
          ) : view === "grid" ? (
            <ul className="pl-dash__grid">
              {shown.map((a) => (
                <ArtifactCard key={a.id} artifact={a} now={now} you={you} />
              ))}
            </ul>
          ) : (
            <div className="pl-dash__list">
              <ArtifactListHeader />
              <ul className="pl-dash__rows">
                {shown.map((a) => (
                  <ArtifactRow key={a.id} artifact={a} now={now} you={you} />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {me && list.status === "ready" && (
        <p className="pl-dash__quota">{quotaText(me.artifact_count, me.artifact_limit)}</p>
      )}

      {renaming && selected && (
        <RenameCategoryDialog
          category={selected}
          categories={categories}
          onClose={() => setRenaming(false)}
          onDone={(stored) => {
            const from = selected;
            setRenaming(false);
            setList((l) =>
              l.status === "ready" ? { ...l, ...applyCategoryRename(l, from, stored) } : l,
            );
            if (stored === null) {
              // Show where those artifacts went; the menu stays, and takes the focus.
              setCategory("");
              setFocusCategoryMenu(true);
            } else {
              // The Rename button stays (the category still exists under its new name), so the
              // dialog hands the focus back to it.
              setCategory(stored);
            }
            setReload((n) => n + 1);
          }}
        />
      )}
    </AppShell>
  );
}
