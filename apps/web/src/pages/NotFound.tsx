// Page: not found. Any path the route table does not know lands here.
import { APP_ROUTES } from "@plinth/shared";
import { AppShell } from "../components/layout/AppShell.tsx";
import { ButtonLink, EmptyState } from "../components/ui/index.ts";
import { useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

export default function NotFound() {
  const { pathname } = useLocation();
  const { me } = useSession();
  return (
    <AppShell>
      <EmptyState
        size="lg"
        headingLevel={1}
        title="Page not found"
        description={
          <>
            Nothing stands at <code>{pathname}</code>. The link may be mistyped, or the artifact was
            moved or deleted. If someone shared it with you, ask them for a new link.
          </>
        }
        action={
          me ? (
            <ButtonLink to={APP_ROUTES.dashboard} variant="primary">
              Go to dashboard
            </ButtonLink>
          ) : (
            <ButtonLink to={APP_ROUTES.home} variant="primary">
              Go to home
            </ButtonLink>
          )
        }
      />
    </AppShell>
  );
}
