// OAuth 2.1 authorization server for /mcp: discovery metadata, dynamic client registration,
// authorize (PKCE S256) handing off to the SPA consent page, token and revoke endpoints.
//
// These routes are mounted on the root app, not under /api/v1, so they are outside the cookie
// session and CSRF middleware: register, token and revoke are called by non-browser clients with
// no ambient credentials, and /oauth/authorize only validates and stores a pending request.
import { Hono } from "hono";
import type { AppEnv } from "../api/context.ts";
import { escapeHtml } from "../email/templates.ts";
import { hit } from "../lib/ratelimit.ts";
import {
  authorizationServerMetadata,
  OAuthError,
  REGISTRATIONS_PER_IP_PER_HOUR,
  registerClient,
  revokeToken,
  startAuthorization,
  tokenRequest,
} from "./service.ts";

export const oauthRoutes = new Hono<AppEnv>();

const MAX_REGISTER_BODY = 16 * 1024;
const MAX_TOKEN_BODY = 8 * 1024;

/** Responses carrying tokens or client data must never be cached (RFC 6749 §5.1). */
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/**
 * Discovery, registration, token and revocation carry no cookies, so any origin may call them
 * (browser-based MCP clients such as inspectors need this). Never applied to cookie routes.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, ...extra } });
}

function oauthError(e: OAuthError): Response {
  return json(e.toBody(), e.status, NO_STORE);
}

const PUBLIC_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
];
for (const path of PUBLIC_PATHS) {
  oauthRoutes.options(path, () => new Response(null, { status: 204, headers: CORS }));
}

/** RFC 9728 protected resource metadata for /mcp. */
oauthRoutes.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  protectedResource(c.get("config").appOrigin),
);
oauthRoutes.get("/.well-known/oauth-protected-resource", (c) =>
  protectedResource(c.get("config").appOrigin),
);

function protectedResource(origin: string): Response {
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["artifacts:read", "artifacts:write", "mentions"],
    bearer_methods_supported: ["header"],
    resource_name: "Plinth MCP",
  });
}

export function mcpResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

/** RFC 8414 authorization server metadata. */
oauthRoutes.get("/.well-known/oauth-authorization-server", (c) =>
  json(authorizationServerMetadata(c.get("config"))),
);

/** Read a body up to a size cap. Returns null if it is larger. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  // Read bytes, not text(): workerd warns on text() for form bodies.
  const bytes = await req.arrayBuffer();
  return bytes.byteLength > max ? null : new TextDecoder().decode(bytes);
}

/** RFC 7591 dynamic client registration (public clients only). */
oauthRoutes.post("/oauth/register", async (c) => {
  try {
    const ip = c.req.header("cf-connecting-ip");
    if (ip) {
      const r = await hit(c.env.DB, `oauth:register:ip:${ip}`, REGISTRATIONS_PER_IP_PER_HOUR, 3600);
      if (!r.allowed) {
        return json(
          { error: "too_many_requests", error_description: "Too many registrations, try later" },
          429,
          { ...NO_STORE, "Retry-After": String(r.retryAfter) },
        );
      }
    }
    const text = await readCapped(c.req.raw, MAX_REGISTER_BODY);
    if (text === null) throw new OAuthError("invalid_client_metadata", "Registration too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "Body must be JSON");
    }
    return json(await registerClient(c.get("db"), body), 201, NO_STORE);
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    throw e;
  }
});

/**
 * Authorization endpoint. Validates the request, stores it, and sends the browser to the SPA
 * consent page. Problems with the client or redirect URI show an error page: redirecting to an
 * unvalidated URI would make this an open redirector.
 */
oauthRoutes.get("/oauth/authorize", async (c) => {
  const url = new URL(c.req.url);
  const out = await startAuthorization(c.get("db"), c.get("config"), url.searchParams);
  if (out.kind === "redirect") {
    return new Response(null, { status: 302, headers: { Location: out.location, ...NO_STORE } });
  }
  return errorPage(out.message);
});

function errorPage(message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Cannot connect</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-weight:500">Cannot connect this application</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to Plinth</a></p>
</body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

/** Parse a token or revocation request: form-encoded per RFC 6749; JSON tolerated. */
async function readParams(req: Request, max: number): Promise<URLSearchParams> {
  const text = await readCapped(req, max);
  if (text === null) throw new OAuthError("invalid_request", "Request too large");
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  let params: URLSearchParams;
  if (type.includes("application/json")) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_request", "Body must be form-encoded");
    }
    if (!obj || typeof obj !== "object") throw new OAuthError("invalid_request", "Bad body");
    params = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") params.append(k, v);
  } else {
    params = new URLSearchParams(text);
  }
  // Public clients may also send their id as the Basic username (with an empty password).
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (basic && !params.has("client_id")) {
    try {
      const user = atob(basic).split(":")[0];
      if (user) params.set("client_id", decodeURIComponent(user));
    } catch {
      throw new OAuthError("invalid_client", "Malformed Basic credentials", 401);
    }
  }
  return params;
}

oauthRoutes.post("/oauth/token", async (c) => {
  try {
    const params = await readParams(c.req.raw, MAX_TOKEN_BODY);
    const tokens = await tokenRequest(c.get("db"), c.env.DB, c.get("config"), params);
    return json(tokens, 200, NO_STORE);
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    throw e;
  }
});

oauthRoutes.post("/oauth/revoke", async (c) => {
  try {
    const params = await readParams(c.req.raw, MAX_TOKEN_BODY);
    await revokeToken(c.get("db"), params);
    return new Response(null, { status: 200, headers: { ...CORS, ...NO_STORE } });
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    throw e;
  }
});
