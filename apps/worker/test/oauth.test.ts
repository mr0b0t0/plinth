import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConnections, oauthGrants } from "../src/db/schema.ts";
import { base64url, hashToken } from "../src/lib/crypto.ts";
import {
  APP,
  browserSession,
  call,
  createUser,
  db,
  json,
  mcpClient,
  tool,
  workerFetch,
} from "./helpers.ts";

const REDIRECT = "http://127.0.0.1:43123/callback";

type Session = Awaited<ReturnType<typeof browserSession>>;

/**
 * An OAuthClientProvider for the official MCP client. Its "browser" step performs the consent
 * through the API with a signed-in session, as the SPA would, and keeps the callback parameters.
 */
class ConsentingProvider implements OAuthClientProvider {
  info: StoredOAuthClientInformation | undefined;
  saved: StoredOAuthTokens | undefined;
  verifier = "";
  discovery: OAuthDiscoveryState | undefined;
  callback: URLSearchParams | undefined;
  constructor(
    private readonly session: Session,
    private readonly label = "Test Claude",
  ) {}
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Plinth test client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return "state-xyz";
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: StoredOAuthClientInformation) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: StoredOAuthTokens) {
    this.saved = t;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(s: OAuthDiscoveryState) {
    this.discovery = s;
  }
  discoveryState() {
    return this.discovery;
  }
  async redirectToAuthorization(url: URL) {
    const authorize = await call(url.toString());
    expect(authorize.status).toBe(302);
    const consentPage = new URL(authorize.headers.get("location") ?? "");
    expect(consentPage.origin + consentPage.pathname).toBe(`${APP}/oauth/consent`);
    const requestId = consentPage.searchParams.get("request") ?? "";
    const info = await call(`/api/v1/oauth/requests/${requestId}`, {
      headers: this.session.headers,
    });
    expect(info.status).toBe(200);
    const res = await call("/api/v1/oauth/consent", {
      method: "POST",
      headers: { ...this.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        label: this.label,
        client_type: "claude",
        approve: true,
      }),
    });
    expect(res.status).toBe(200);
    this.callback = new URL((await json(res)).redirect_to).searchParams;
  }
}

/** Connect the official MCP client through the full OAuth flow. */
async function connectWithOAuth(session: Session, label?: string) {
  const provider = new ConsentingProvider(session, label);
  const first = new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
    fetch: workerFetch,
    authProvider: provider,
  });
  await expect(new Client({ name: "t", version: "1" }).connect(first)).rejects.toBeInstanceOf(
    UnauthorizedError,
  );
  expect(provider.callback?.get("code")).toBeTruthy();
  expect(provider.callback?.get("state")).toBe("state-xyz");
  expect(provider.callback?.get("iss")).toBe(APP);
  await first.finishAuth(provider.callback as URLSearchParams);
  const transport = new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
    fetch: workerFetch,
    authProvider: provider,
  });
  const client = new Client({ name: "t", version: "1" });
  await client.connect(transport);
  return { client, provider };
}

// ---------- Raw protocol helpers ----------

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function register(redirectUris: unknown = [REDIRECT], extra: Record<string, unknown> = {}) {
  const res = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Raw client", redirect_uris: redirectUris, ...extra }),
  });
  return { res, body: await json(res) };
}

function authorizeUrl(params: Record<string, string>) {
  return `/oauth/authorize?${new URLSearchParams(params)}`;
}

/** Register, authorize and consent; returns a code ready for the token endpoint. */
async function getCode(opts: { approve?: boolean; scope?: string } = {}) {
  const user = await createUser();
  const session = await browserSession(user.id);
  const { body: client } = await register();
  const { verifier, challenge } = await pkce();
  const auth = await call(
    authorizeUrl({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
      resource: `${APP}/mcp`,
      ...(opts.scope ? { scope: opts.scope } : {}),
    }),
  );
  expect(auth.status).toBe(302);
  const requestId = new URL(auth.headers.get("location") ?? "").searchParams.get("request") ?? "";
  const consent = await call("/api/v1/oauth/consent", {
    method: "POST",
    headers: { ...session.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      label: "Raw",
      client_type: "other",
      approve: opts.approve ?? true,
    }),
  });
  expect(consent.status).toBe(200);
  const redirect = new URL((await json(consent)).redirect_to);
  return { user, session, clientId: client.client_id as string, verifier, redirect, requestId };
}

function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  return call("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

async function exchange(c: Awaited<ReturnType<typeof getCode>>, overrides = {}) {
  return token({
    grant_type: "authorization_code",
    code: c.redirect.searchParams.get("code") ?? "",
    redirect_uri: REDIRECT,
    code_verifier: c.verifier,
    client_id: c.clientId,
    ...overrides,
  });
}

const mcpPing = (accessToken: string) =>
  call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("OAuth discovery", () => {
  it("serves RFC 8414 authorization server metadata", async () => {
    const res = await call("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const m = await json(res);
    expect(m).toMatchObject({
      issuer: APP,
      authorization_endpoint: `${APP}/oauth/authorize`,
      token_endpoint: `${APP}/oauth/token`,
      registration_endpoint: `${APP}/oauth/register`,
      revocation_endpoint: `${APP}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["artifacts:read", "artifacts:write", "mentions"],
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves RFC 9728 protected resource metadata pointing at this issuer", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const m = await json(await call(path));
      expect(m).toMatchObject({ resource: `${APP}/mcp`, authorization_servers: [APP] });
    }
  });
});

describe("OAuth with the official MCP client", () => {
  it("registers, consents, gets a token and calls publish_artifact through /mcp", async () => {
    const user = await createUser();
    const session = await browserSession(user.id);
    const { client, provider } = await connectWithOAuth(session, "Work laptop");
    expect(provider.saved?.access_token).toMatch(/^plinth_at_/);
    expect(provider.saved?.refresh_token).toMatch(/^plinth_rt_/);

    const pub = await tool(client, "publish_artifact", { title: "Via OAuth", html: "<p>hi</p>" });
    expect(pub.isError).toBe(false);
    expect(pub.data.version).toBe(1);

    // The connection shows up with the user's label; tokens are stored only as hashes.
    const list = await json(await call("/api/v1/connections", { headers: session.headers }));
    const conn = list.items.find((x: { label: string }) => x.label === "Work laptop");
    expect(conn).toMatchObject({ kind: "oauth", client_type: "claude", revoked_at: null });
    const grant = await db()
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.connectionId, conn.id))
      .get();
    expect(grant?.accessTokenHash).toBe(await hashToken(provider.saved?.access_token ?? ""));
    expect(JSON.stringify(grant)).not.toContain(provider.saved?.access_token);
    expect(JSON.stringify(grant)).not.toContain(provider.saved?.refresh_token);

    // Versions are attributed to the connection.
    const versions = await json(
      await call(`/api/v1/artifacts/${pub.data.id}/versions`, { headers: session.headers }),
    );
    expect(versions.items[0].author).toMatchObject({ kind: "connection", label: "Work laptop" });
  });

  it("revoking the connection cuts off the access token and the refresh token", async () => {
    const user = await createUser();
    const session = await browserSession(user.id);
    const { provider } = await connectWithOAuth(session);
    const at = provider.saved?.access_token ?? "";
    expect((await mcpPing(at)).status).toBe(200);

    const list = await json(await call("/api/v1/connections", { headers: session.headers }));
    const conn = list.items[0];
    const del = await call(`/api/v1/connections/${conn.id}`, {
      method: "DELETE",
      headers: session.headers,
    });
    expect(del.status).toBe(200);

    expect((await mcpPing(at)).status).toBe(401);
    expect(
      (await call("/api/v1/artifacts", { headers: { Authorization: `Bearer ${at}` } })).status,
    ).toBe(401);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: provider.saved?.refresh_token ?? "",
      client_id: provider.info?.client_id ?? "",
    });
    expect(refreshed.status).toBe(400);
    expect((await json(refreshed)).error).toBe("invalid_grant");
    // A new client from the revoked token is refused too.
    await expect(mcpClient(at)).rejects.toThrow();
  });
});

describe("OAuth endpoints", () => {
  it("exchanges a code once; a reused code is refused and revokes the grant", async () => {
    const c = await getCode();
    expect(c.redirect.origin + c.redirect.pathname).toBe(REDIRECT);
    expect(c.redirect.searchParams.get("state")).toBe("s1");
    expect(c.redirect.searchParams.get("iss")).toBe(APP);

    const res = await exchange(c);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const t = await json(res);
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(t.scope).toBe("artifacts:read artifacts:write mentions");
    expect((await mcpPing(t.access_token)).status).toBe(200);

    const reuse = await exchange(c);
    expect(reuse.status).toBe(400);
    expect((await json(reuse)).error).toBe("invalid_grant");
    // The tokens issued from that code stop working.
    expect((await mcpPing(t.access_token)).status).toBe(401);
  });

  it("refuses a PKCE mismatch", async () => {
    const c = await getCode();
    const other = await pkce();
    const res = await exchange(c, { code_verifier: other.verifier });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
  });

  it("refuses a different redirect_uri and a different client at the token endpoint", async () => {
    const c = await getCode();
    const res = await exchange(c, { redirect_uri: "http://127.0.0.1:43123/other" });
    expect((await json(res)).error).toBe("invalid_grant");

    const c2 = await getCode();
    const { body: other } = await register();
    const res2 = await exchange(c2, { client_id: other.client_id });
    expect((await json(res2)).error).toBe("invalid_grant");

    const res3 = await exchange(await getCode(), { client_id: "unknown-client" });
    expect(res3.status).toBe(401);
    expect((await json(res3)).error).toBe("invalid_client");
  });

  it("refuses an expired code", async () => {
    const c = await getCode();
    const code = c.redirect.searchParams.get("code") ?? "";
    await db()
      .update(oauthGrants)
      .set({ codeExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(oauthGrants.codeHash, await hashToken(code)))
      .run();
    expect((await json(await exchange(c))).error).toBe("invalid_grant");
  });

  it("rotates refresh tokens: the old one stops working", async () => {
    const c = await getCode();
    const t1 = await json(await exchange(c));
    const r1 = await token({
      grant_type: "refresh_token",
      refresh_token: t1.refresh_token,
      client_id: c.clientId,
    });
    expect(r1.status).toBe(200);
    const t2 = await json(r1);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(t2.access_token).not.toBe(t1.access_token);
    expect((await mcpPing(t2.access_token)).status).toBe(200);
    // The previous access token is replaced too.
    expect((await mcpPing(t1.access_token)).status).toBe(401);

    const old = await token({
      grant_type: "refresh_token",
      refresh_token: t1.refresh_token,
      client_id: c.clientId,
    });
    expect(old.status).toBe(400);
    expect((await json(old)).error).toBe("invalid_grant");

    // Narrowing scope on refresh is allowed; widening is not.
    const narrowed = await json(
      await token({
        grant_type: "refresh_token",
        refresh_token: t2.refresh_token,
        client_id: c.clientId,
        scope: "artifacts:read",
      }),
    );
    expect(narrowed.scope).toBe("artifacts:read");
    const widened = await token({
      grant_type: "refresh_token",
      refresh_token: narrowed.refresh_token,
      client_id: c.clientId,
      scope: "artifacts:read artifacts:write",
    });
    expect((await json(widened)).error).toBe("invalid_scope");
  });

  it("issues tokens limited to the consented scope", async () => {
    const c = await getCode({ scope: "artifacts:read" });
    const t = await json(await exchange(c));
    expect(t.scope).toBe("artifacts:read");
    const res = await call("/api/v1/artifacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", html: "<p>x</p>" }),
    });
    expect(res.status).toBe(403);
  });

  it("denied consent redirects with access_denied and creates nothing", async () => {
    const c = await getCode({ approve: false });
    expect(c.redirect.searchParams.get("error")).toBe("access_denied");
    expect(c.redirect.searchParams.get("state")).toBe("s1");
    expect(c.redirect.searchParams.get("code")).toBeNull();
    const conns = await db()
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.userId, c.user.id))
      .all();
    expect(conns).toHaveLength(0);
  });

  it("a consent request can be decided once and needs a signed-in person", async () => {
    const c = await getCode();
    const again = await call("/api/v1/oauth/consent", {
      method: "POST",
      headers: { ...c.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: c.requestId, label: "x", approve: true }),
    });
    expect(again.status).toBe(404);
    expect((await call(`/api/v1/oauth/requests/${c.requestId}`)).status).toBe(401);
  });

  it("revocation (RFC 7009) revokes the grant and its connection; unknown tokens are fine", async () => {
    const c = await getCode();
    const t = await json(await exchange(c));
    const revoke = (params: Record<string, string>) =>
      call("/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
    expect((await revoke({ token: "plinth_rt_unknown", client_id: c.clientId })).status).toBe(200);
    // Another client's revocation request is ignored.
    const { body: other } = await register();
    expect((await revoke({ token: t.refresh_token, client_id: other.client_id })).status).toBe(200);
    expect((await mcpPing(t.access_token)).status).toBe(200);

    expect((await revoke({ token: t.refresh_token, client_id: c.clientId })).status).toBe(200);
    expect((await mcpPing(t.access_token)).status).toBe(401);
    const list = await json(await call("/api/v1/connections", { headers: c.session.headers }));
    expect(list.items[0].revoked_at).toBeTruthy();
  });

  it("token, register and revoke need no CSRF and send no-store", async () => {
    // These calls carry neither the CSRF cookie nor the header and still succeed.
    const { res } = await register();
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bad = await token({ grant_type: "password", client_id: "x" });
    expect(bad.status).toBe(401);
    const { body: client } = await register();
    const unsupported = await token({ grant_type: "password", client_id: client.client_id });
    expect(unsupported.status).toBe(400);
    expect((await json(unsupported)).error).toBe("unsupported_grant_type");
    expect(unsupported.headers.get("cache-control")).toBe("no-store");
  });
});

describe("OAuth registration and authorization validation", () => {
  it("accepts https and loopback http redirect URIs only", async () => {
    for (const ok of [
      ["https://client.example/cb"],
      ["http://localhost:3000/cb"],
      ["http://127.0.0.1/cb"],
      ["http://[::1]:8080/cb"],
    ]) {
      expect((await register(ok)).res.status).toBe(201);
    }
    for (const bad of [
      [],
      ["http://client.example/cb"],
      ["https://client.example/cb#frag"],
      ["javascript:alert(1)"],
      ["custom-scheme://cb"],
      ["https://user:pw@client.example/cb"],
      [`https://client.example/${"a".repeat(2100)}`],
      Array.from({ length: 11 }, (_, i) => `https://c.example/${i}`),
      "https://client.example/cb",
    ]) {
      const { res, body } = await register(bad);
      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid_redirect_uri");
    }
    const big = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x".repeat(20_000) }),
    });
    expect(big.status).toBe(400);
    const grant = await register([REDIRECT], { grant_types: ["client_credentials"] });
    expect(grant.body.error).toBe("invalid_client_metadata");
  });

  it("rate limits registration per IP", async () => {
    const headers = { "Content-Type": "application/json", "cf-connecting-ip": "198.51.100.9" };
    const body = JSON.stringify({ redirect_uris: [REDIRECT] });
    for (let i = 0; i < 20; i++) {
      expect((await call("/oauth/register", { method: "POST", headers, body })).status).toBe(201);
    }
    const limited = await call("/oauth/register", { method: "POST", headers, body });
    expect(limited.status).toBe(429);
  });

  it("shows an error page (never redirects) for an unknown client or an unregistered redirect_uri", async () => {
    const { body: client } = await register();
    const { challenge } = await pkce();
    const base = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    for (const params of [
      { ...base, client_id: "nope" },
      { ...base, redirect_uri: "https://evil.example/cb" },
      { ...base, redirect_uri: `${REDIRECT}/extra` },
      { ...base, redirect_uri: "" },
    ]) {
      const res = await call(authorizeUrl(params));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("redirects errors for a valid client: missing PKCE, plain PKCE, bad scope, bad resource", async () => {
    const { body: client } = await register();
    const { challenge } = await pkce();
    const base = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st",
    };
    const cases: [Record<string, string>, string][] = [
      [{ ...base, code_challenge: "" }, "invalid_request"],
      [{ ...base, code_challenge_method: "plain" }, "invalid_request"],
      [{ ...base, response_type: "token" }, "unsupported_response_type"],
      [{ ...base, scope: "artifacts:read admin" }, "invalid_scope"],
      [{ ...base, resource: "https://other.example/mcp" }, "invalid_target"],
    ];
    for (const [params, error] of cases) {
      const res = await call(authorizeUrl(params));
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get("error")).toBe(error);
      expect(loc.searchParams.get("state")).toBe("st");
    }
  });

  it("the consent page data names the client, redirect host and scopes", async () => {
    const user = await createUser();
    const session = await browserSession(user.id);
    const { body: client } = await register();
    const { challenge } = await pkce();
    const res = await call(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "artifacts:read mentions",
      }),
    );
    const id = new URL(res.headers.get("location") ?? "").searchParams.get("request");
    const info = await json(
      await call(`/api/v1/oauth/requests/${id}`, { headers: session.headers }),
    );
    expect(info).toMatchObject({
      client_id: client.client_id,
      client_name: "Raw client",
      redirect_host: "127.0.0.1:43123",
      scopes: ["artifacts:read", "mentions"],
    });
    expect(
      (await call("/api/v1/oauth/requests/unknown", { headers: session.headers })).status,
    ).toBe(404);
  });
});
