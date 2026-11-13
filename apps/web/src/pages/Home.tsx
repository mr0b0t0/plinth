// Page: /. Signed in, go to the dashboard. Signed out, a short note on what Plinth is.
import { APP_ROUTES } from "@plinth/shared";
import "../components/account/account.css";
import { useDocumentTitle } from "../components/account/hooks.tsx";
import { LogoMark } from "../components/Logo.tsx";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { ButtonLink } from "../components/ui/index.ts";
import { Redirect } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

const POINTS: { title: string; body: string }[] = [
  {
    title: "Agents publish",
    body: "Connect Claude, Codex or any MCP client once. Each piece it makes lands here with one tool call.",
  },
  {
    title: "You choose who sees it",
    body: "Anyone with the link, a password, or only the people you name. Viewers need no AI account.",
  },
  {
    title: "Nothing is overwritten",
    body: "Every publish is a new version. Compare, comment, edit in the browser, restore any of them.",
  },
];

export default function Home() {
  useDocumentTitle(null);
  const { loading, me } = useSession();
  if (me) return <Redirect to={APP_ROUTES.dashboard} />;

  return (
    <PublicShell width="content">
      {loading ? null : (
        <div className="pl-acct-home">
          <section className="pl-acct-home__hero" aria-labelledby="home-title">
            <LogoMark size={48} />
            <h1 id="home-title" className="type-display pl-acct-home__title">
              A quiet place to show what your agents make.
            </h1>
            <p className="type-lead pl-acct-home__lead">
              Plinth is an open home for HTML artifacts. Your agents publish them here, and you
              decide who sees each piece.
            </p>
            <div className="pl-acct-home__actions">
              <ButtonLink to={APP_ROUTES.login} variant="primary" size="lg">
                Sign in
              </ButtonLink>
              <span className="type-small text-muted">
                Works with Claude, Codex and any MCP client.
              </span>
            </div>
          </section>
          <ul className="pl-acct-home__points">
            {POINTS.map((p) => (
              <li key={p.title} className="pl-acct-home__point">
                <h2 className="type-heading pl-acct-home__point-title">{p.title}</h2>
                <p className="text-muted">{p.body}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </PublicShell>
  );
}
