// Minimal shell for signed-out pages (home, sign-in, consent, viewer gates, legal, not found):
// a 44px bar with the logo and the theme toggle, a centered column, and the legal links.
import { APP_ROUTES } from "@plinth/shared";
import type { ReactNode } from "react";
import { Link } from "../../lib/router.tsx";
import { LogoMark } from "../Logo.tsx";
import { Container, IconProvider, ThemeToggle, Toaster } from "../ui/index.ts";
import { SkipLink } from "./AppShell.tsx";
import "./shell.css";

export interface PublicShellProps {
  children: ReactNode;
  /** narrow (default, 24rem): forms. reading: 40rem. content: 68rem. */
  width?: "narrow" | "reading" | "content";
  /** Center the column vertically (sign-in, gates). */
  centered?: boolean;
  /** Extra content on the right of the top bar, before the theme toggle. */
  headerEnd?: ReactNode;
}

export function PublicShell({
  children,
  width = "narrow",
  centered = false,
  headerEnd,
}: PublicShellProps) {
  return (
    <IconProvider>
      <SkipLink />
      <div className="pl-shell pl-shell--public">
        <header className="pl-public-bar">
          <Link to={APP_ROUTES.home} className="pl-topbar__brand pl-public-bar__brand">
            <LogoMark size={16} />
            <span className="pl-sidebar__word">Plinth</span>
            <span className="visually-hidden">, go to home</span>
          </Link>
          <div className="pl-public-bar__end">
            {headerEnd}
            <ThemeToggle />
          </div>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className={`pl-main pl-main--public${centered ? " pl-main--centered" : ""}`}
        >
          <Container width={width}>{children}</Container>
        </main>
        <footer className="pl-footer">
          <Container>
            <nav aria-label="Legal" className="pl-footer__nav">
              <Link to={APP_ROUTES.terms}>Terms</Link>
              <Link to={APP_ROUTES.privacy}>Privacy</Link>
              <Link to={APP_ROUTES.acceptableUse}>Acceptable use</Link>
            </nav>
          </Container>
        </footer>
      </div>
      <Toaster />
    </IconProvider>
  );
}
