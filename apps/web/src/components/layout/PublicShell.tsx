// Minimal shell for signed-out pages (home, sign-in, consent, viewer gates, legal, not found):
// logo, theme toggle, a centered column, and the legal links.
import { APP_ROUTES } from "@plinth/shared";
import type { ReactNode } from "react";
import { Link } from "../../lib/router.tsx";
import { LogoMark } from "../Logo.tsx";
import { Container, IconProvider, ThemeToggle, Toaster } from "../ui/index.ts";
import { SkipLink } from "./AppShell.tsx";
import "./shell.css";

export interface PublicShellProps {
  children: ReactNode;
  /** narrow (default, 28rem): forms. reading: 40rem. content: 72rem. */
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
        <header className="pl-topbar pl-topbar--public">
          <div className="pl-topbar__inner">
            <Link to={APP_ROUTES.home} className="pl-topbar__brand">
              <LogoMark size={24} />
              <span className="pl-topbar__word">Plinth</span>
              <span className="visually-hidden">, go to home</span>
            </Link>
            <div className="pl-topbar__end">
              {headerEnd}
              <ThemeToggle />
            </div>
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
