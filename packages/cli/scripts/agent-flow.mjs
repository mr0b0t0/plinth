// The way an owner and an agent use a localhost-only instance, for the smoke tests (smoke.mjs for
// the npm package, scripts/docker-smoke.mjs for the image): sign in with the code the instance
// logs, connect an agent with OAuth (dynamic registration, PKCE, consent), then call /mcp.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** A browser-like client for the app at `origin`: keeps cookies and sends the CSRF header. */
export function appClient(origin) {
  const jar = new Map();
  function keep(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  }
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const csrfToken = () => [...jar].find(([k]) => /plinth_csrf$/.test(k))?.[1] ?? "";
  return async function app(pathname, init = {}) {
    const headers = { cookie: cookieHeader(), origin, ...(init.headers ?? {}) };
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      headers["x-plinth-csrf"] = csrfToken();
    }
    return keep(
      await fetch(`${origin}${pathname}`, {
        method: init.method ?? (init.json === undefined ? "GET" : "POST"),
        headers,
        body: init.json === undefined ? init.body : JSON.stringify(init.json),
        redirect: "manual",
      }),
    );
  };
}

/**
 * Sign `email` in with the six-digit code the console email provider writes to the instance log.
 * `readLog()` returns the log so far (sync or async).
 */
export async function signIn(app, email, readLog) {
  await (await app("/api/v1/config")).arrayBuffer();
  const mark = (await readLog()).length;
  const r = await app("/api/v1/auth/login", { json: { email } });
  assert(r.status === 200, `login ${r.status}`);
  let code = null;
  for (let i = 0; i < 50 && !code; i++) {
    const text = (await readLog()).slice(mark);
    const at = text.lastIndexOf(`[email:console] to=${email}`);
    code = at >= 0 ? (/\b(\d{6})\b/.exec(text.slice(at))?.[1] ?? null) : null;
    if (!code) await new Promise((res) => setTimeout(res, 200));
  }
  assert(code, `no sign-in code for ${email} in the instance log`);
  const v = await app("/api/v1/auth/verify-code", { json: { email, code } });
  assert(v.status === 200, `verify ${v.status} ${await v.text()}`);
}

/** Connect an agent the way MCP clients do; resolves with its access token. */
export async function connectAgent(app, origin, label) {
  const redirectUri = "http://127.0.0.1:9/callback";
  const reg = await (
    await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: label,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  ).json();
  assert(reg.client_id, `registration: ${JSON.stringify(reg)}`);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "smoke",
    scope: "artifacts:read artifacts:write mentions",
    resource: `${origin}/mcp`,
  });
  const auth = await app(`/oauth/authorize?${q}`);
  const consentUrl = new URL(auth.headers.get("location") ?? "", origin);
  const requestId = consentUrl.searchParams.get("request");
  assert(auth.status === 302 && requestId, `authorize ${auth.status} -> ${consentUrl}`);
  const consent = await app("/api/v1/oauth/consent", {
    json: { request_id: requestId, label, client_type: "other", approve: true },
  });
  const consentBody = await consent.text();
  assert(consent.status === 200, `consent ${consent.status} ${consentBody}`);
  const back = new URL(JSON.parse(consentBody).redirect_to);
  assert(back.searchParams.get("state") === "smoke", `state ${back}`);
  const tok = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  const t = await tok.json();
  assert(tok.status === 200 && t.access_token, `token ${tok.status} ${JSON.stringify(t)}`);
  return t.access_token;
}

/** One JSON-RPC call to /mcp with a bearer token. */
export async function mcp(origin, token, method, params, id) {
  const r = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status} ${text.slice(0, 200)}`);
  const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "");
  return JSON.parse(json);
}

/** Initialize an MCP session and call one tool; resolves with its JSON result. */
export async function callTool(origin, token, name, args) {
  const clientInfo = { name: "smoke", version: "1" };
  await mcp(
    origin,
    token,
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
    1,
  );
  const res = await mcp(origin, token, "tools/call", { name, arguments: args }, 2);
  assert(!res.result?.isError, `${name}: ${JSON.stringify(res).slice(0, 500)}`);
  return JSON.parse(res.result.content[0].text);
}

/** Initialize an MCP session and publish one artifact; resolves with { id, slug, ... }. */
export async function publishArtifact(origin, token, title) {
  const clientInfo = { name: "smoke", version: "1" };
  await mcp(
    origin,
    token,
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
    1,
  );
  const args = { title, html: "<!doctype html><h1>Hello</h1>" };
  const res = await mcp(
    origin,
    token,
    "tools/call",
    { name: "publish_artifact", arguments: args },
    2,
  );
  assert(!res.result?.isError, JSON.stringify(res));
  const published = JSON.parse(res.result.content[0].text);
  assert(published.id && published.slug, JSON.stringify(published));
  return published;
}

/**
 * GET http://127.0.0.1:<port><path> with an explicit Host header, e.g. an artifact's
 * <id>.localhost:<port>, without relying on the system resolver for *.localhost names.
 */
export function getWithHost(port, host, pathname = "/") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, headers: { host }, timeout: 10000 },
      (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`GET ${host}${pathname} timed out`)));
    req.end();
  });
}
