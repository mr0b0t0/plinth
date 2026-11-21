// App shell for signed-in pages: a 224px sidebar (logo, primary nav, the person's agents, the
// account menu), a 44px top bar per page (breadcrumb title on the left, page actions on the
// right), a skip link, and the <main id="main"> landmark. It reads the session through
// useSession() only. Below 48rem the sidebar becomes a slide-over opened from the top bar.
import {
  ChartBarIcon,
  FileIcon,
  FlagIcon,
  ListIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  PlusIcon,
  SignOutIcon,
  SunIcon,
  UserCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES } from "@plinth/shared";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { agentInitials, useAgents } from "../../lib/agents.ts";
import { Link, useLocation } from "../../lib/router.tsx";
import { setSessionMe, useSession } from "../../lib/session.ts";
import { THEME_NAMES, useThemePreference } from "../../lib/theme.ts";
import { useSignOut } from "../account/hooks.tsx";
import { CONNECT_AGENT_HREF } from "../account/nav.ts";
import { ProfileNameDialog } from "../account/ProfileNameDialog.tsx";
import { useMediaQuery } from "../editor/useMediaQuery.ts";
import { LogoMark } from "../Logo.tsx";
import { focusElement, getFocusable } from "../ui/focus.ts";
import {
  ButtonLink,
  type Icon,
  IconButton,
  IconProvider,
  Menu,
  type MenuEntry,
  Toaster,
} from "../ui/index.ts";
import "./shell.css";

export interface NavItem {
  label: string;
  to: string;
  icon?: Icon;
}

/** One step of the top-bar breadcrumb before the page title. */
export interface Crumb {
  label: ReactNode;
  /** Links the step; plain text without it. */
  to?: string;
}

const PRIMARY_NAV: NavItem[] = [
  { label: "Artifacts", to: APP_ROUTES.dashboard, icon: FileIcon },
  { label: "Connections", to: APP_ROUTES.connections, icon: PlugIcon },
];
const ADMIN_NAV: NavItem[] = [
  { label: "Stats", to: APP_ROUTES.adminStats, icon: ChartBarIcon },
  { label: "Reports", to: APP_ROUTES.adminReports, icon: FlagIcon },
];

/** Below this width the sidebar is a slide-over. Keep in step with shell.css. */
export const SIDEBAR_COMPACT_QUERY = "(max-width: 47.99rem)";

export interface AppShellProps {
  children: ReactNode;
  /** Called by "Sign out" in the user menu. Defaults to signing out and going to /login. */
  onSignOut?: () => void;
  /** Extra user-menu entries, shown above the theme choices. */
  userMenuItems?: MenuEntry[];
  /** Extra sidebar links after the primary ones (admins get Stats and Reports automatically). */
  extraNav?: NavItem[];
  /**
   * content (default): children sit in the page column with the page padding.
   * full: children get the whole area below the top bar (editor, compare).
   */
  width?: "content" | "full";
  /** Breadcrumb steps before the title, e.g. [{ label: "Artifacts", to: "/dashboard" }]. */
  crumbs?: Crumb[];
  /**
   * The page title, rendered as the page's h1 in the top bar. Without it the bar names the
   * current section in plain text and the page brings its own h1 (e.g. a PageHeader).
   */
  title?: ReactNode;
  /** A last, plain step after the title ("History", "Settings"). */
  trail?: ReactNode;
  /** Page actions on the right of the top bar. */
  actions?: ReactNode;
}

export function SkipLink() {
  return (
    <a className="pl-skip-link" href="#main">
      Skip to content
    </a>
  );
}

function isActive(pathname: string, to: string) {
  if (to === APP_ROUTES.dashboard) {
    // Artifact pages (/a/...) live under Artifacts.
    return pathname === to || pathname.startsWith("/a/");
  }
  return pathname === to || pathname.startsWith(`${to}/`);
}

function initials(email: string, name?: string | null) {
  const source = (name ?? "").trim() || email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : source.slice(0, 2);
  return letters.toUpperCase();
}

export function AppShell({
  children,
  onSignOut,
  userMenuItems = [],
  extraNav = [],
  width = "content",
  crumbs,
  title,
  trail,
  actions,
}: AppShellProps) {
  const { pathname } = useLocation();
  const { me, loading } = useSession();
  // The Connections page publishes its own list (see publishAgents); elsewhere the sidebar loads it.
  const agents = useAgents(me?.id, pathname !== APP_ROUTES.connections);
  const [preference, setPreference] = useThemePreference();
  const compact = useMediaQuery(SIDEBAR_COMPACT_QUERY);
  const [navOpen, setNavOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const sidebarId = useId();
  const agentsHeadingId = useId();
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mainColumnRef = useRef<HTMLDivElement>(null);

  const nav: NavItem[] = me ? [...PRIMARY_NAV] : [];
  if (me?.is_admin) nav.push(...ADMIN_NAV);
  for (const item of extraNav) {
    if (me && !nav.some((n) => n.to === item.to)) nav.push(item);
  }
  const section = nav.find((n) => isActive(pathname, n.to));

  const defaultSignOut = useSignOut();
  const signOut = onSignOut ?? defaultSignOut;

  const menuItems: MenuEntry[] = [
    ...userMenuItems,
    ...(userMenuItems.length > 0 ? [{ type: "separator" as const }] : []),
    {
      label: "Your name…",
      icon: UserCircleIcon,
      onSelect: () => {
        // On a phone the menu sits in the slide-over: close it so the dialog is the only layer.
        setNavOpen(false);
        setNameOpen(true);
      },
    },
    { type: "separator" as const },
    {
      label: `${THEME_NAMES.light} (light)`,
      icon: SunIcon,
      checked: preference === "light",
      onSelect: () => setPreference("light"),
    },
    {
      label: `${THEME_NAMES.dark} (dark)`,
      icon: MoonIcon,
      checked: preference === "dark",
      onSelect: () => setPreference("dark"),
    },
    {
      label: "Follow system theme",
      icon: MonitorIcon,
      checked: preference === "system",
      onSelect: () => setPreference("system"),
    },
    { type: "separator" as const },
    { label: "Sign out", icon: SignOutIcon, onSelect: () => void signOut() },
  ];

  // ---------- the slide-over on small screens ----------
  const overlay = compact && navOpen;

  // Close it when the page changes or the screen grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  // While open: the rest of the page is inert, focus moves in, and comes back on close.
  useEffect(() => {
    if (!overlay) return;
    const column = mainColumnRef.current;
    const skip = document.querySelector<HTMLElement>(".pl-skip-link");
    column?.setAttribute("inert", "");
    skip?.setAttribute("inert", "");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = sidebarRef.current;
    if (panel) focusElement(getFocusable(panel)[0] ?? panel);
    return () => {
      column?.removeAttribute("inert");
      skip?.removeAttribute("inert");
      document.body.style.overflow = overflow;
      focusElement(menuButtonRef.current);
    };
  }, [overlay]);

  const onSidebarKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!overlay) return;
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      setNavOpen(false);
      return;
    }
    if (e.key !== "Tab") return;
    const panel = sidebarRef.current;
    if (!panel) return;
    const items = getFocusable(panel);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      focusElement(last);
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      focusElement(first);
    }
  };

  const signedIn = Boolean(me);
  const showSidebar = signedIn || loading;

  return (
    <IconProvider>
      <SkipLink />
      <div
        className={`pl-app pl-app--${width}${showSidebar ? "" : " pl-app--bare"}`}
        data-nav-open={overlay || undefined}
      >
        {showSidebar && (
          <>
            {overlay && (
              <div
                className="pl-sidebar-backdrop"
                aria-hidden="true"
                onClick={() => setNavOpen(false)}
              />
            )}
            <aside
              ref={sidebarRef}
              id={sidebarId}
              className="pl-sidebar"
              aria-label="Sidebar"
              // A modal dialog only while it slides over the page on small screens.
              {...(overlay ? { role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}
              onKeyDown={onSidebarKey}
            >
              <div className="pl-sidebar__head">
                <Link
                  to={me ? APP_ROUTES.dashboard : APP_ROUTES.home}
                  className="pl-sidebar__brand"
                >
                  <LogoMark size={16} />
                  <span className="pl-sidebar__word">Plinth</span>
                  <span className="visually-hidden">
                    {me ? ", go to your artifacts" : ", go to home"}
                  </span>
                </Link>
                {overlay && (
                  <IconButton
                    size="sm"
                    icon={XIcon}
                    label="Close navigation"
                    className="pl-sidebar__close"
                    onClick={() => setNavOpen(false)}
                  />
                )}
              </div>

              {nav.length > 0 && (
                <nav aria-label="Primary" className="pl-sidebar__nav">
                  <ul className="pl-sidebar__list">
                    {nav.map((item) => {
                      const active = isActive(pathname, item.to);
                      const ItemIcon = item.icon;
                      const exact = pathname === item.to;
                      return (
                        <li key={item.to}>
                          <Link
                            to={item.to}
                            className="pl-nav-item"
                            data-active={active || undefined}
                            aria-current={exact ? "page" : active ? "true" : undefined}
                          >
                            {ItemIcon ? (
                              <ItemIcon size={16} aria-hidden="true" />
                            ) : (
                              <span className="pl-nav-item__slot" aria-hidden="true" />
                            )}
                            <span className="pl-nav-item__label">{item.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              )}

              {me && (
                // Not a list on purpose: one link per agent, then "Connect an agent".
                <section className="pl-sidebar__group" aria-labelledby={agentsHeadingId}>
                  <h2 id={agentsHeadingId} className="pl-sidebar__heading">
                    Agents
                  </h2>
                  {agents?.map((a) => (
                    <Link
                      key={a.id}
                      to={APP_ROUTES.connections}
                      className="pl-nav-item pl-nav-item--agent"
                      title={a.label}
                    >
                      <span className="pl-agent-mark" aria-hidden="true">
                        {agentInitials(a.label)}
                      </span>
                      <span className="pl-nav-item__label">{a.label}</span>
                      <span className="pl-nav-item__end">
                        <span className="pl-status-dot" aria-hidden="true" />
                        <span className="visually-hidden">, connected</span>
                      </span>
                    </Link>
                  ))}
                  <Link to={CONNECT_AGENT_HREF} className="pl-nav-item pl-nav-item--connect">
                    <PlusIcon size={16} aria-hidden="true" />
                    <span className="pl-nav-item__label">Connect an agent</span>
                  </Link>
                </section>
              )}

              {me && (
                <div className="pl-sidebar__foot">
                  {/* Beside the trigger, not in it: the button's name is its visible label. */}
                  <span className="pl-avatar pl-account__avatar" aria-hidden="true">
                    {initials(me.email, me.name)}
                  </span>
                  {/* The name once set; the menu's header keeps the email. */}
                  <Menu
                    label={`Account: ${me.name ?? me.email}`}
                    variant="ghost"
                    align="start"
                    placement="up"
                    className="pl-account"
                    triggerClassName="pl-account__trigger"
                    items={menuItems}
                    header={
                      <>
                        <span className="pl-account__caption">Signed in as</span>
                        <span className="pl-account__email">{me.email}</span>
                      </>
                    }
                    triggerContent={
                      <span className="pl-account__label">{me.name ?? me.email}</span>
                    }
                  />
                </div>
              )}
            </aside>
          </>
        )}

        <div ref={mainColumnRef} className="pl-app__column">
          <header className="pl-topbar">
            {showSidebar && compact && (
              <IconButton
                ref={menuButtonRef}
                icon={ListIcon}
                label="Open navigation"
                className="pl-topbar__menu"
                aria-expanded={navOpen}
                aria-controls={sidebarId}
                onClick={() => setNavOpen(true)}
              />
            )}
            {!showSidebar && (
              <Link to={APP_ROUTES.home} className="pl-topbar__brand">
                <LogoMark size={16} />
                <span className="pl-sidebar__word">Plinth</span>
                <span className="visually-hidden">, go to home</span>
              </Link>
            )}
            <div className="pl-crumbs">
              {crumbs?.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional
                <Fragment key={i}>
                  {c.to ? (
                    <Link to={c.to} className="pl-crumbs__link">
                      {c.label}
                    </Link>
                  ) : (
                    <span className="pl-crumbs__step">{c.label}</span>
                  )}
                  <span className="pl-crumbs__sep" aria-hidden="true">
                    /
                  </span>
                </Fragment>
              ))}
              {title !== undefined ? (
                <h1 className="pl-crumbs__title">{title}</h1>
              ) : section ? (
                <span className="pl-crumbs__title">{section.label}</span>
              ) : null}
              {trail !== undefined && (
                <>
                  <span className="pl-crumbs__sep" aria-hidden="true">
                    /
                  </span>
                  <span className="pl-crumbs__trail">{trail}</span>
                </>
              )}
            </div>
            <div className="pl-topbar__actions">
              {actions}
              {!me && !loading && (
                <ButtonLink to={APP_ROUTES.login} variant="secondary">
                  Sign in
                </ButtonLink>
              )}
            </div>
          </header>
          <main id="main" tabIndex={-1} className={`pl-main pl-main--${width}`}>
            {width === "content" ? <div className="pl-page">{children}</div> : children}
          </main>
        </div>
      </div>
      {me && nameOpen && (
        <ProfileNameDialog
          current={me.name}
          onClose={() => setNameOpen(false)}
          onSaved={(saved) => {
            setNameOpen(false);
            setSessionMe(saved);
          }}
        />
      )}
      <Toaster />
    </IconProvider>
  );
}
