// Personal access tokens and agent connections, plus the OAuth consent endpoints the SPA calls.
// People only: an agent's bearer token can never mint, list or revoke tokens (policy module).
import {
  API,
  type ConnectionInfo,
  createTokenInput,
  oauthConsentInput,
  type Paged,
  renameConnectionInput,
} from "@plinth/shared";
import { Hono } from "hono";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { decideConsent, describeRequest } from "../oauth/service.ts";
import { canManageConnections, type Principal } from "../policy.ts";
import {
  createPersonalToken,
  listConnections,
  type PersonCtx,
  renameConnection,
  revokeConnection,
} from "../services/connections.ts";
import { type AppContext, type AppEnv, parseBody, serviceCtx } from "./context.ts";

export const connectionsApi = new Hono<AppEnv>();

/** The signed-in person, or 401 (nobody) / 403 (an agent or a viewer). */
function person(p: Principal): Extract<Principal, { kind: "user" }> {
  if (canManageConnections(p)) return p;
  if (p.kind === "anonymous") throw unauthorized();
  throw forbidden("Only a signed-in person can manage connections");
}

/** The service context for a signed-in person (person() has checked the principal). */
function personCtx(c: AppContext): PersonCtx {
  const principal = person(c.get("principal"));
  return { ...serviceCtx(c), principal };
}

connectionsApi.get(API.connections, async (c) => {
  const ctx = personCtx(c);
  const body: Paged<ConnectionInfo> = { items: await listConnections(ctx) };
  return c.json(body);
});

connectionsApi.post(API.connections, async (c) => {
  const ctx = personCtx(c);
  const input = await parseBody(c, createTokenInput);
  return c.json(await createPersonalToken(ctx, input), 201);
});

connectionsApi.patch(API.connection, async (c) => {
  const ctx = personCtx(c);
  const { label } = await parseBody(c, renameConnectionInput);
  return c.json(await renameConnection(ctx, c.req.param("id"), label));
});

connectionsApi.delete(API.connection, async (c) => {
  const ctx = personCtx(c);
  return c.json(await revokeConnection(ctx, c.req.param("id")));
});

connectionsApi.get(API.oauthRequest, async (c) => {
  person(c.get("principal"));
  return c.json(await describeRequest(c.get("db"), c.req.param("id")));
});

connectionsApi.post(API.oauthConsent, async (c) => {
  const p = person(c.get("principal"));
  const input = await parseBody(c, oauthConsentInput);
  return c.json(await decideConsent(c.get("db"), c.get("config"), p.userId, input));
});
