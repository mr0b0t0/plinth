// The cookie a confirmed viewing code sets, on an allowlist gate (api/view.ts) and on a portal
// (api/portals.ts): the app session for an address that may sign in, or the viewer session where
// it may not (services/viewers.ts sessionForCode). Signing in with the confirmed address replaces
// the app session this browser held, which ends that session, as signing out would.
import { TTL } from "@plinth/shared";
import { appCookieName, secureFlag, serializeCookie } from "../lib/cookies.ts";
import type { Principal } from "../policy.ts";
import { deleteSession, sessionCookie } from "../services/sessions.ts";
import type { ViewerCodeResult } from "../services/viewers.ts";
import type { AppContext } from "./context.ts";

/** Set the session cookie for a confirmed code and return the principal it stands for. */
export async function setCodeSession(
  c: AppContext,
  result: ViewerCodeResult,
  email: string,
): Promise<Principal> {
  const config = c.get("config");
  if (result.kind === "user") {
    const previous = c.get("cookies").get(appCookieName(config, "session"));
    if (previous) await deleteSession(c.get("db"), previous);
    c.header("Set-Cookie", sessionCookie(config, result.value), { append: true });
    return {
      kind: "user",
      userId: result.user.id,
      email: result.user.email,
      isAdmin: config.adminEmails.includes(result.user.email),
    };
  }
  c.header(
    "Set-Cookie",
    serializeCookie(appCookieName(config, "viewer"), result.value, {
      httpOnly: true,
      secure: secureFlag(config.scheme, config.appHost),
      sameSite: "Lax",
      maxAge: TTL.viewerSessionS,
    }),
    { append: true },
  );
  return { kind: "viewer", email };
}
