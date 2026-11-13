// App shell for signed-in pages: top bar (logo, primary nav, theme toggle, user menu), a skip
// link, and the <main id="main"> landmark. It reads the session through useSession() only.
import { CaretDownIcon, SignOutIcon, UserCircleIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@plinth/shared";
import type { ReactNode } from "react";
import { Link, useLocation } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.ts";
import { LogoMark } from "../Logo.tsx";
import {
  ButtonLink,
  Container,
  IconProvider,
  Menu,
  type MenuEntry,
  ThemeToggle,
  Toaster,
} from "../ui/index.ts";
import "./shell.css";

export interface NavItem {
  label: string;
  to: string;
}

const PRIMARY_NAV: NavItem[] = [
  { label: "Dashboard", to: APP_ROUTES.dashboard },
  { label: "Connections", to: APP_ROUTES.connections },
];

export interface AppShellProps {
  children: ReactNode;
  /** Called by "Sign out" in the user menu. The item is hidden when this is absent. */
  onSignOut?: () => void;
  /** Extra user-menu entries, shown above "Sign out". */
  userMenuItems?: MenuEntry[];
  /** Extra links after Dashboard and Connections (e.g. admin pages). */
  extraNav?: NavItem[];
  /**
   * content (default): children sit in the centered 72rem column with the page gutter.
   * full: children get the whole width below the top bar (artifact page, editor, compare).
   */
  width?: "content" | "full";
}

export function SkipLink() {
  return (
    <a className="pl-skip-link" href="#main">
      Skip to content
    </a>
  );
}

function isActive(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppShell({
  children,
  onSignOut,
  userMenuItems = [],
  extraNav = [],
  width = "content",
}: AppShellProps) {
  const { pathname } = useLocation();
  const { me, loading } = useSession();
  const nav = me ? [...PRIMARY_NAV, ...extraNav] : [];

  const menuItems: MenuEntry[] = [
    ...userMenuItems,
    ...(onSignOut && userMenuItems.length > 0 ? [{ type: "separator" as const }] : []),
    ...(onSignOut ? [{ label: "Sign out", icon: SignOutIcon, onSelect: onSignOut }] : []),
  ];

  return (
    <IconProvider>
      <SkipLink />
      <div className={`pl-shell pl-shell--${width}`}>
        <header className="pl-topbar">
          <div className="pl-topbar__inner">
            <Link to={me ? APP_ROUTES.dashboard : APP_ROUTES.home} className="pl-topbar__brand">
              <LogoMark size={24} />
              <span className="pl-topbar__word">Plinth</span>
              <span className="visually-hidden">{me ? ", go to dashboard" : ", go to home"}</span>
            </Link>

            {nav.length > 0 && (
              <nav className="pl-topbar__nav" aria-label="Primary">
                <ul>
                  {nav.map((item) => {
                    const active = isActive(pathname, item.to);
                    return (
                      <li key={item.to}>
                        <Link
                          to={item.to}
                          className="pl-topbar__link"
                          aria-current={active ? "page" : undefined}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            )}

            <div className="pl-topbar__end">
              <ThemeToggle />
              {me && menuItems.length === 0 ? (
                <span className="pl-topbar__email pl-topbar__email--static">{me.email}</span>
              ) : me ? (
                <Menu
                  label={`Account: ${me.email}`}
                  variant="ghost"
                  align="end"
                  items={menuItems}
                  header={
                    <>
                      <span className="pl-topbar__menu-caption">Signed in as</span>
                      <span className="pl-topbar__menu-email">{me.email}</span>
                    </>
                  }
                  triggerContent={
                    <>
                      <UserCircleIcon size={20} aria-hidden="true" />
                      <span className="pl-topbar__email">{me.email}</span>
                      <CaretDownIcon size={16} aria-hidden="true" className="pl-topbar__caret" />
                    </>
                  }
                />
              ) : loading ? null : (
                <ButtonLink to={APP_ROUTES.login} variant="secondary" size="sm">
                  Sign in
                </ButtonLink>
              )}
            </div>
          </div>
        </header>
        <main id="main" tabIndex={-1} className={`pl-main pl-main--${width}`}>
          {width === "content" ? <Container>{children}</Container> : children}
        </main>
      </div>
      <Toaster />
    </IconProvider>
  );
}
