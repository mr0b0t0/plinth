// Page: /dashboard. The signed-in person's artifacts and the ones shared with them: a filter row
// (All / Mine / Shared, a category, sort, list or grid), search (kept in ?q=, the category in
// ?category=), and the artifact quota. A category is the owner's own on their artifacts and the
// person's own on artifacts shared with them (issue #42). With category sharing on, the owner shares
// a category from here, reviews what waits in a shared one (?review=<share id>), and the Shared tab
// links the collections other people shared with them. "New" (NewMenu.tsx) starts a blank document
// or sheet that opens in edit mode, or imports a spreadsheet as a sheet.
import {
  ArrowsDownUpIcon,
  FolderSimpleIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlugIcon,
  ShareNetworkIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  type ArtifactList,
  type ArtifactSummary,
  type CategoryCount,
  type CategoryShareSummary,
  categoryKey,
  type PortalSummary,
  route,
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
  shownCategory,
} from "../components/account/ArtifactRow.tsx";
import { CategoryReviewDialog } from "../components/account/CategoryReviewDialog.tsx";
import { CopyField } from "../components/account/CopyField.tsx";
import { mcpUrl, quotaText } from "../components/account/format.ts";
import {
  useDebouncedValue,
  useDocumentTitle,
  useSignInRedirect,
  useSignOut,
} from "../components/account/hooks.tsx";
import { MyCategoryDialog } from "../components/account/MyCategoryDialog.tsx";
import { NewMenu, newHint } from "../components/account/NewMenu.tsx";
import { Note } from "../components/account/Note.tsx";
import { CONNECT_AGENT_HREF } from "../components/account/nav.ts";
import { RenameCategoryDialog } from "../components/account/RenameCategoryDialog.tsx";
import { ShareCategoryDialog } from "../components/account/ShareCategoryDialog.tsx";
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
import { Link, useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      items: ArtifactSummary[];
      categories: CategoryCount[];
      /** The person's own categories for artifacts shared with them (issue #42). */
      myCategories: CategoryCount[];
      query: string;
    };

/** "design_system": the design systems the person can build with (shown when there is one). */
type Filter = "all" | "mine" | "shared" | "design_system";
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
 * The artifacts a category filter keeps, matched as the Worker matches names (ignoring case,
 * spaces, "-" and "_"): the person's own artifacts by their category, and artifacts shared with
 * them by the person's own category for them. "" keeps the ones with none: the person's own
 * artifacts, or under Shared (`shared`), the shared ones they have not filed.
 */
export function filterByCategory(
  items: ArtifactSummary[],
  category: CategoryFilter,
  shared = false,
): ArtifactSummary[] {
  if (category === null) return items;
  const key = categoryKey(category);
  return items.filter((a) => {
    const name = shownCategory(a);
    if (category === "") return name === null && (a.role === "owner") !== shared;
    return name !== null && categoryKey(name) === key;
  });
}

/** One list of names from two (counts summed by key, the first list's spelling kept). */
export function mergeCategories(
  a: readonly CategoryCount[],
  b: readonly CategoryCount[],
): CategoryCount[] {
  const out = a.map((c) => ({ ...c }));
  for (const c of b) {
    const same = out.find((x) => categoryKey(x.name) === categoryKey(c.name));
    if (same) same.count += c.count;
    else out.push({ name: c.name, count: c.count });
  }
  return out;
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
  const [sharing, setSharing] = useState(false);
  /** The share whose waiting artifacts are being reviewed (?review=<id> opens it). */
  const [reviewing, setReviewing] = useState<string | null>(() => search.get("review"));
  /** The shared artifact being filed under the person's own category. */
  const [filing, setFiling] = useState<ArtifactSummary | null>(null);
  const [shares, setShares] = useState<CategoryShareSummary[]>([]);
  const [portals, setPortals] = useState<PortalSummary[]>([]);
  const [shareReload, setShareReload] = useState(0);
  const categorySharing = config?.category_sharing === true;
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
          myCategories: res.my_categories ?? [],
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

  // The owner's shares (for the review banner and the Share button) and the collections shared with
  // them, only where the instance offers category sharing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shareReload` re-runs the fetch
  useEffect(() => {
    if (pending || !categorySharing) return;
    const ctrl = new AbortController();
    api<{ items: CategoryShareSummary[] }>(API.categoryShares, { signal: ctrl.signal })
      .then((r) => setShares(r.items))
      .catch(() => undefined);
    api<{ items: PortalSummary[] }>(API.portals, { signal: ctrl.signal })
      .then((r) => setPortals(r.items))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [pending, categorySharing, shareReload, reload]);

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
  const ownCategories = list.status === "ready" ? list.categories : [];
  const myCategories = list.status === "ready" ? list.myCategories : [];
  // The names the menu offers: the owner's under Mine, the person's own under Shared, both under All.
  const categories =
    filter === "shared"
      ? myCategories
      : filter === "mine" || myCategories.length === 0
        ? ownCategories
        : mergeCategories(ownCategories, myCategories);
  const hasShared = items.some((a) => a.role !== "owner");
  const hasDesignSystems = items.some((a) => a.type === "design_system");
  // Under Shared the filter and its menu are the person's own categories; with none, both are off.
  const byCategory = category !== null && (filter !== "shared" || myCategories.length > 0);
  const shown = useMemo(() => {
    const picked =
      filter === "mine"
        ? items.filter((a) => a.role === "owner")
        : filter === "shared"
          ? items.filter((a) => a.role !== "owner")
          : filter === "design_system"
            ? items.filter((a) => a.type === "design_system")
            : items;
    return sortArtifacts(
      filterByCategory(picked, byCategory ? category : null, filter === "shared"),
      sort,
    );
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
    ...(hasDesignSystems || filter === "design_system"
      ? [{ value: "design_system" as const, label: "Design systems" }]
      : []),
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
          : filter === "design_system"
            ? searching
              ? "No design systems match."
              : "No design systems yet."
            : "Nothing has been shared with you."
      : null;

  const categoryLabel =
    category === null || !byCategory
      ? "All"
      : category === ""
        ? "No category"
        : (selected?.name ?? category);
  const showCategoryMenu =
    filter === "shared" ? myCategories.length > 0 : categories.length > 0 || category !== null;
  // Renaming the selected name renames the owner's category, or under Shared (or when only the
  // person's own list has it) their own category for shared artifacts.
  const selectedOwn =
    selected !== null &&
    filter !== "shared" &&
    ownCategories.some((c) => categoryKey(c.name) === categoryKey(selected.name));
  const renamePersonal = selected !== null && !selectedOwn;
  const selectedShare =
    selectedOwn && selected
      ? (shares.find((s) => categoryKey(s.category) === categoryKey(selected.name)) ?? null)
      : null;
  const waiting = shares.filter((s) => s.counts.pending > 0);
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
      {selectedOwn && categorySharing && (
        <Tooltip content={selectedShare ? "Sharing" : "Share category"}>
          <IconButton
            icon={ShareNetworkIcon}
            label={selectedShare ? "Sharing" : "Share category"}
            aria-pressed={selectedShare ? true : undefined}
            onClick={() => setSharing(true)}
          />
        </Tooltip>
      )}
    </>
  );

  return (
    <AppShell
      onSignOut={signOut}
      title="Artifacts"
      actions={
        // With nothing yet, New stands in the empty state, beside Connect an agent.
        nothingYet ? undefined : (
          <>
            {searchField}
            {me && <NewMenu config={config} />}
          </>
        )
      }
    >
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

      {waiting.length > 0 && (
        <div className="pl-dash__notices">
          {waiting.map((s) => (
            <Note key={s.id} tone="warning">
              <span>
                {`${s.counts.pending} ${s.counts.pending === 1 ? "artifact waits" : "artifacts wait"} for your review before ${s.category}'s people can see ${s.counts.pending === 1 ? "it" : "them"}.`}
              </span>{" "}
              <Button size="sm" onClick={() => setReviewing(s.id)}>
                Review
              </Button>
            </Note>
          ))}
        </div>
      )}
      {filter === "shared" && portals.length > 0 && (
        <nav className="pl-dash__portals" aria-label="Collections shared with you">
          <span className="pl-dash__portals-label">Collections:</span>
          <ul>
            {portals.map((p) => (
              <li key={p.id}>
                <Link to={route(APP_ROUTES.portal, { id: p.id })}>{p.title}</Link>{" "}
                <span className="text-muted">({p.count})</span>
              </li>
            ))}
          </ul>
        </nav>
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
              {newHint(config) && <p>{newHint(config)}</p>}
              <CopyField
                label="MCP server URL"
                value={mcpUrl(config?.app_origin)}
                copyLabel="Copy MCP server URL"
                copiedMessage="MCP server URL copied"
              />
            </div>
          }
          action={
            <span className="pl-dash__empty-actions">
              <ButtonLink to={CONNECT_AGENT_HREF} variant="primary" icon={PlugIcon}>
                Connect an agent
              </ButtonLink>
              {me && <NewMenu config={config} variant="secondary" />}
            </span>
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
                <ArtifactCard key={a.id} artifact={a} now={now} you={you} onFile={setFiling} />
              ))}
            </ul>
          ) : (
            <div className="pl-dash__list">
              <ArtifactListHeader />
              <ul className="pl-dash__rows">
                {shown.map((a) => (
                  <ArtifactRow key={a.id} artifact={a} now={now} you={you} onFile={setFiling} />
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
          categories={renamePersonal ? myCategories : ownCategories}
          personal={renamePersonal}
          onClose={() => setRenaming(false)}
          onDone={(stored) => {
            const from = selected;
            setRenaming(false);
            if (!renamePersonal) {
              setList((l) =>
                l.status === "ready" ? { ...l, ...applyCategoryRename(l, from, stored) } : l,
              );
            }
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

      {sharing && selected && (
        <ShareCategoryDialog
          category={selected.name}
          shareId={selectedShare?.id ?? null}
          onClose={() => setSharing(false)}
          onDone={() => {
            setSharing(false);
            setShareReload((n) => n + 1);
            setReload((n) => n + 1);
          }}
        />
      )}

      {reviewing && (
        <CategoryReviewDialog
          shareId={reviewing}
          onClose={() => {
            setReviewing(null);
            // Leave ?review= behind, so a reload does not reopen it.
            window.history.replaceState(null, "", dashboardHref(settled, category));
          }}
          onDone={() => {
            setReviewing(null);
            window.history.replaceState(null, "", dashboardHref(settled, category));
            setShareReload((n) => n + 1);
            setReload((n) => n + 1);
          }}
        />
      )}

      {filing && (
        <MyCategoryDialog
          artifact={filing}
          names={mergeCategories(myCategories, ownCategories)}
          onClose={() => setFiling(null)}
          onDone={() => {
            setFiling(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </AppShell>
  );
}
