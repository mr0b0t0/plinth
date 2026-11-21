// Portals (docs/spec.md "Category sharing and personal categories"): the collections an owner
// shared with people, at /p/<share id> in the app. People only: a session, or a viewer confirmed
// by code on the portal or on an artifact. The code flow mirrors the allowlist's (api/view.ts).
import { API, viewerCodeInput, viewerEmailInput } from "@plinth/shared";
import { Hono } from "hono";
import {
  listPortals,
  portalGate,
  requestPortalCode,
  verifyPortalCode,
} from "../services/portals.ts";
import { refuseBoundTokens } from "./categoryShares.ts";
import { setCodeSession } from "./codeSession.ts";
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

/**
 * Confirm the code, then the gate: a grant holder or the owner signs in with the address; where
 * the instance does not let it sign in (single-user mode), a grant holder gets a viewer session.
 */
portalsApi.post(API.portalCode, async (c) => {
  const { email, code } = await parseBody(c, viewerCodeInput);
  const ctx = serviceCtx(c);
  const id = c.req.param("id");
  const result = await verifyPortalCode(ctx, id, email, code);
  const principal = await setCodeSession(c, result, email);
  return c.json(
    await portalGate(
      { ...ctx, principal, viewerEmail: principal.kind === "viewer" ? email : null },
      id,
    ),
  );
});
