// The legal links in the app and viewer footers. Terms and privacy only appear when the instance
// names an operator (AppConfig.operator); the acceptable use policy is always there.
import { APP_ROUTES } from "@plinth/shared";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.ts";

export function LegalLinks() {
  const { config } = useSession();
  return (
    <>
      {config?.operator && (
        <>
          <Link to={APP_ROUTES.terms}>Terms</Link>
          <Link to={APP_ROUTES.privacy}>Privacy</Link>
        </>
      )}
      <Link to={APP_ROUTES.acceptableUse}>Acceptable use</Link>
    </>
  );
}
