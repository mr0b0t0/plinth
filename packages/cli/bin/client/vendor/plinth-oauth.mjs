// Plinth's OAuth client for command-line tools: the mention watcher (plinth-mentions.mjs) and the
// `plinth` CLI's client commands (login, publish, ...). One sign-in per tool and instance: dynamic
// client registration, PKCE, a loopback redirect, then refresh tokens.
//
// State lives in $XDG_CONFIG_HOME/plinth (default ~/.config/plinth), one file per tool and
// instance (`<prefix><host>.json`, mode 0600 in a 0700 directory). Several processes share it, so a
// refresh happens under a lock and re-reads the file first: Plinth rotates refresh tokens and
// revokes the grant if an old one is presented again, so two processes must never both use one.
//
// The registered client (`<prefix><host>-client.json`) outlives a logout and is reused by the next
// login when its loopback port is free and the server still knows it; otherwise a new one is
// registered. Every request names the tool in its User-Agent and refuses redirects, so a token is
// only ever sent to the instance it belongs to.
//
// Plain Node (18+), no dependencies. Source: integrations/watcher/; scripts/integrations.mjs copies
// it into the plugin (next to plinth-mentions.mjs) and into packages/cli/bin/client/vendor/.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOGIN_TIMEOUT_MS = 5 * 60_000;
export const LOCK_STALE_MS = 30_000;
/** Refresh this long before the access token expires. */
const EXPIRY_SKEW_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** True for hosts that only this computer can reach (http is allowed there). */
export function isLoopbackHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/** An instance's origin from a URL: https, or http on a loopback host. Throws on anything else. */
export function normalizeOrigin(raw, label = "PLINTH_URL") {
  const text = String(raw).trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`${label} is not a URL: ${text}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    throw new Error(`${label} must be https (or http on localhost): ${text}`);
  }
  return u.origin;
}

/** Where the tools keep their state: $XDG_CONFIG_HOME/plinth, default ~/.config/plinth. */
export function configDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "plinth");
}

/** The file-name key for an instance: its host, with anything unusual replaced. */
export function hostKey(base) {
  return new URL(base).host.replace(/[^A-Za-z0-9.-]/g, "_");
}

function defaultOpenBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {}
}

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const DONE_PAGE = (title, text) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem}</style>" +
  `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;

/**
 * An OAuth client for one tool.
 *
 * - clientName: shown on the consent page and the Connections page.
 * - scope: space-separated scopes to ask for.
 * - filePrefix: state file prefix, e.g. "mentions-" or "cli-".
 * - userAgent: sent on every request, e.g. "plinth-cli/0.4.0".
 * - copy: { approve, doneTitle, doneText, failText, lockName } for what the tool prints and shows.
 * - env, fetch, openBrowser, log: injectable for tests.
 */
export function createOAuth(options) {
  const {
    clientName,
    scope,
    filePrefix,
    userAgent,
    copy = {},
    env = process.env,
    fetch: fetchFn = globalThis.fetch,
    openBrowser = defaultOpenBrowser,
    log = console.log,
  } = options;
  if (!clientName || !scope || !filePrefix || !userAgent) {
    throw new Error("createOAuth needs clientName, scope, filePrefix and userAgent");
  }
  const text = {
    approve: `Approve ${clientName} in your browser.`,
    doneTitle: "Connected",
    doneText: `${clientName} is connected. You can close this tab.`,
    failText: `Plinth did not connect ${clientName}. You can close this tab.`,
    lockName: clientName,
    ...copy,
  };

  function paths(base) {
    const dir = configDir(env);
    const key = hostKey(base);
    return {
      dir,
      state: join(dir, `${filePrefix}${key}.json`),
      lock: join(dir, `${filePrefix}${key}.lock`),
      client: join(dir, `${filePrefix}${key}-client.json`),
    };
  }

  function ensureDir(p) {
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(p.dir, 0o700);
    } catch {}
  }

  function readJson(file) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  function writeJson(p, file, value) {
    ensureDir(p);
    const tmp = `${file}.${process.pid}.${b64url(randomBytes(4))}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  const readState = (base) => readJson(paths(base).state);
  const writeState = (base, state) => writeJson(paths(base), paths(base).state, state);

  /** Every request: this tool's User-Agent, JSON accepted, and never a redirect. */
  function request(url, init = {}) {
    return fetchFn(url, {
      ...init,
      redirect: "error",
      headers: { "User-Agent": userAgent, Accept: "application/json", ...(init.headers ?? {}) },
    });
  }

  /** The authorization server metadata; every endpoint must be on the instance's own origin. */
  async function metadata(base) {
    const res = await request(`${base}/.well-known/oauth-authorization-server`);
    if (!res.ok) throw new Error(`${base} does not look like a Plinth instance (${res.status})`);
    const meta = await res.json();
    for (const k of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      if (meta[k] === undefined) continue;
      let o = null;
      try {
        o = new URL(meta[k]).origin;
      } catch {}
      if (o !== base) throw new Error(`${base} names an OAuth endpoint on another origin (${k})`);
    }
    return meta;
  }

  async function tokenRequest(endpoint, form) {
    const res = await request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  function saveTokens(base, state, body) {
    const next = {
      ...state,
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? state.refresh_token,
      expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      signed_out: false,
    };
    writeState(base, next);
    return next;
  }

  /** Run `fn` holding a lock directory (mkdir is atomic). A lock older than LOCK_STALE_MS is broken. */
  async function withLock(base, fn) {
    const p = paths(base);
    ensureDir(p);
    const until = Date.now() + LOCK_STALE_MS;
    for (;;) {
      try {
        mkdirSync(p.lock);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(p.lock).mtimeMs > LOCK_STALE_MS)
            rmSync(p.lock, { recursive: true });
        } catch {}
        if (Date.now() > until) throw new Error(`Timed out waiting for the ${text.lockName} lock`);
        await sleep(100 + Math.random() * 200);
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(p.lock, { recursive: true, force: true });
    }
  }

  /**
   * A usable access token, refreshing under the lock when it is about to expire. Returns null when
   * not connected or when the grant (or the client) is gone: revoked on the Connections page, or
   * expired. `force` refreshes even a token that looks fresh (after a 401).
   */
  async function accessToken(base, { force = false } = {}) {
    const fresh = (s) => s && !s.signed_out && !force && s.expires_at - EXPIRY_SKEW_MS > Date.now();
    const s0 = readState(base);
    if (!s0 || s0.signed_out) return null;
    if (fresh(s0)) return s0.access_token;
    return withLock(base, async () => {
      const s = readState(base);
      if (!s || s.signed_out) return null;
      // Another process refreshed while this one waited for the lock.
      if (s.access_token !== s0.access_token && s.expires_at - EXPIRY_SKEW_MS > Date.now()) {
        return s.access_token;
      }
      if (fresh(s)) return s.access_token;
      const meta = await metadata(s.origin);
      const r = await tokenRequest(meta.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: s.refresh_token,
        client_id: s.client_id,
        resource: `${s.origin}/mcp`,
      });
      if (r.ok) return saveTokens(base, s, r.body).access_token;
      if (r.body?.error === "invalid_grant" || r.body?.error === "invalid_client") {
        writeState(base, { ...s, signed_out: true });
        if (r.body.error === "invalid_client") rmSync(paths(base).client, { force: true });
        return null;
      }
      throw new Error(`Token refresh failed (${r.status})`);
    });
  }

  /** Whether the server still knows this client id (the token endpoint checks it first). */
  async function clientKnown(meta, clientId) {
    const r = await tokenRequest(meta.token_endpoint, { client_id: clientId });
    return r.body?.error !== "invalid_client";
  }

  function listen(server, port) {
    return new Promise((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve(true);
      });
    });
  }

  /**
   * Sign in through the browser. Resolves with the saved state once the person clicked Allow.
   * `noBrowser` only prints the address.
   */
  async function login(base, { noBrowser = false } = {}) {
    const p = paths(base);
    const meta = await metadata(base);
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));

    let finish;
    const result = new Promise((resolve, reject) => {
      finish = { resolve, reject };
    });
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const q = u.searchParams;
      const fail = (msg) => {
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
          .end(DONE_PAGE("Not connected", text.failText));
        finish.reject(new Error(msg));
      };
      if (q.get("state") !== state) return fail("The answer did not match this login (state)");
      if (q.get("iss") && q.get("iss") !== meta.issuer)
        return fail("The answer came from another server");
      if (q.get("error")) return fail(`Not approved: ${q.get("error")}`);
      const code = q.get("code");
      if (!code) return fail("No authorization code in the answer");
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
        .end(DONE_PAGE(text.doneTitle, text.doneText));
      finish.resolve(code);
    });

    // Reuse the client registered last time when its loopback port is free and the server still
    // knows it; otherwise listen anywhere and register a new one.
    let clientId = null;
    let redirectUri = null;
    const saved = readJson(p.client);
    if (
      saved?.origin === base &&
      typeof saved.client_id === "string" &&
      typeof saved.redirect_uri === "string"
    ) {
      const port = Number(new URL(saved.redirect_uri).port);
      if (port > 0 && (await listen(server, port))) {
        if (await clientKnown(meta, saved.client_id).catch(() => false)) {
          clientId = saved.client_id;
          redirectUri = saved.redirect_uri;
        } else {
          server.closeAllConnections?.();
          await new Promise((r) => server.close(() => r()));
        }
      }
    }
    if (!server.listening && !(await listen(server, 0))) {
      throw new Error("Could not listen on a loopback port for the sign-in answer");
    }
    const timer = setTimeout(
      () => finish.reject(new Error("Timed out waiting for approval")),
      LOGIN_TIMEOUT_MS,
    );

    try {
      if (!clientId) {
        redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const reg = await request(meta.registration_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: clientName,
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
        if (!reg.ok) throw new Error(`Client registration failed (${reg.status})`);
        clientId = (await reg.json()).client_id;
        if (typeof clientId !== "string" || !clientId)
          throw new Error("Client registration returned no client_id");
        writeJson(p, p.client, { origin: base, client_id: clientId, redirect_uri: redirectUri });
      }

      const auth = new URL(meta.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${base}/mcp`,
      })) {
        auth.searchParams.set(k, v);
      }
      log(`${text.approve} If no tab opened, visit:\n${auth}`);
      if (!noBrowser) openBrowser(auth.toString());

      const code = await result;
      const t = await tokenRequest(meta.token_endpoint, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        resource: `${base}/mcp`,
      });
      if (!t.ok)
        throw new Error(`Token exchange failed (${t.status}: ${t.body?.error ?? "error"})`);
      return saveTokens(
        base,
        { origin: base, client_id: clientId, connected_at: new Date().toISOString() },
        t.body,
      );
    } finally {
      clearTimeout(timer);
      // Node 18 keeps idle keep-alive connections open after close(); a later login on the same
      // port would otherwise have its answer delivered to this finished server.
      server.closeAllConnections?.();
      server.close();
    }
  }

  /** Revoke the grant (best effort) and forget the tokens. False when there was nothing to forget. */
  async function logout(base) {
    const s = readState(base);
    if (!s) return false;
    try {
      const meta = await metadata(s.origin);
      if (meta.revocation_endpoint && s.refresh_token) {
        await tokenRequest(meta.revocation_endpoint, {
          token: s.refresh_token,
          client_id: s.client_id,
        });
      }
    } catch {}
    rmSync(paths(base).state, { force: true });
    return true;
  }

  return { paths, readState, request, metadata, accessToken, login, logout, withLock };
}
