// Portals (docs/spec.md "Category sharing and personal categories"): the collections an owner
// shared with people, at /p/<share id> in the app. People only: a session, or a viewer confirmed
// by code on the portal or on an artifact. The code flow mirrors the allowlist's (api/view.ts).
import { API, TTL, viewerCodeInput, viewerEmailInput } from "@plinth/shared";
import { Hono } from "hono";
import { appCookieName, secureFlag, serializeCookie } from "../lib/cookies.ts";
import type { Principal } from "../policy.ts";
import {
  listPortals,
  portalGate,
  requestPortalCode,
  verifyPortalCode,
} from "../services/portals.ts";
import { sessionCookie } from "../services/sessions.ts";
import { refuseBoundTokens } from "./categoryShares.ts";
import { type AppEnv, parseBody, serviceCtx } from "./context.ts";

export const portalsApi = new Hono<AppEnv>();

portalsApi.use(API.portals, refuseBoundTokens);
portalsApi.use(`${API.portals}/*`, refuseBoundTokens);

portalsApi.get(API.portals, async (c) => {
  return c.json({ items: await listPortals(serviceCtx(c)) });
});

portalsApi.get(API.portal, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await portalGate(serviceCtx(c), c.req.param("id")));
});

/** Ask for a code: the same answer whether or not the email holds a grant on the share. */
portalsApi.post(API.portalEmail, async (c) => {
  const { email } = await parseBody(c, viewerEmailInput);
  await requestPortalCode(serviceCtx(c), c.req.param("id"), email);
  return c.json({ ok: true });
});

/** Confirm the code: a viewer session for a grant holder, or the owner signed in; then the gate. */
portalsApi.post(API.portalCode, async (c) => {
  const { email, code } = await parseBody(c, viewerCodeInput);
  const ctx = serviceCtx(c);
  const id = c.req.param("id");
  const result = await verifyPortalCode(ctx, id, email, code);
  const config = c.get("config");
  let principal: Principal;
  if (result.kind === "user") {
    c.header("Set-Cookie", sessionCookie(config, result.value), { append: true });
    principal = {
      kind: "user",
      userId: result.user.id,
      email: result.user.email,
      isAdmin: config.adminEmails.includes(result.user.email),
    };
  } else {
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
    principal = { kind: "viewer", email };
  }
  return c.json(
    await portalGate(
      { ...ctx, principal, viewerEmail: principal.kind === "viewer" ? email : null },
      id,
    ),
  );
});
