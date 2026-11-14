// Test helpers: drive the real Worker through exports.default.fetch, seed users and tokens.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { COOKIES, CSRF_HEADER } from "@plinth/shared";
import { and, eq } from "drizzle-orm";
import { TOKEN_PREFIX } from "../src/auth/principal.ts";
import { getConfig } from "../src/config.ts";
import { getDb } from "../src/db/client.ts";
import { agentConnections, sessions, versions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { hashToken, newId, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import type { Principal } from "../src/policy.ts";
import type { Ctx } from "../src/services/context.ts";
import { fileKey, type ManifestEntry, parseManifest } from "../src/services/storage.ts";
import { getOrCreateUser } from "../src/services/users.ts";

export const APP = "http://app.localhost:8787";
export const CONTENT_HOST = "content.localhost:8787";
export const contentOrigin = (id: string) => `http://${id}.${CONTENT_HOST}`;

export const db = () => getDb(env.DB);
export const config = () => getConfig(env as unknown as Record<string, unknown>);

/** Fetch through the Worker's real fetch handler. Relative paths go to the app host. */
export function call(input: string, init?: RequestInit): Promise<Response> {
  const url = input.startsWith("http") ? input : `${APP}${input}`;
  return exports.default.fetch(new Request(url, { redirect: "manual", ...init }));
}

export const workerFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  exports.default.fetch(new Request(input, init));

let counter = 0;
export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}${counter}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export async function createUser(email = uniqueEmail()) {
  return getOrCreateUser(db(), config(), email, { verified: true });
}

/** Create a personal access token directly in the database. */
export async function createToken(
  userId: string,
  opts: { label?: string; clientType?: "claude" | "codex" | "other"; scopes?: string } = {},
) {
  const token = newToken(TOKEN_PREFIX.pat);
  const id = newId();
  await db()
    .insert(agentConnections)
    .values({
      id,
      userId,
      label: opts.label ?? "Test token",
      clientType: opts.clientType ?? "other",
      kind: "token",
      tokenHash: await hashToken(token),
      scopes: opts.scopes ?? "artifacts:read artifacts:write mentions",
      createdAt: nowIso(),
    })
    .run();
  return { token, connectionId: id };
}

/** A user with a token, ready to call the API or MCP. */
export async function agent(opts: Parameters<typeof createToken>[1] = {}) {
  const user = await createUser();
  const t = await createToken(user.id, opts);
  return { user, ...t, auth: { Authorization: `Bearer ${t.token}` } };
}

/** A signed-in browser session: session cookie plus CSRF cookie and header. */
export async function browserSession(userId: string) {
  const value = newToken("s_");
  await db()
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "user",
      userId,
      expiresAt: isoIn(3600_000),
      createdAt: nowIso(),
    })
    .run();
  const csrf = "csrf-test-token-0123456789";
  return {
    cookie: `${COOKIES.session}=${value}; ${COOKIES.csrf}=${csrf}`,
    headers: {
      Cookie: `${COOKIES.session}=${value}; ${COOKIES.csrf}=${csrf}`,
      [CSRF_HEADER]: csrf,
      Origin: APP,
    } as Record<string, string>,
  };
}

export async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Not JSON (${res.status}): ${text.slice(0, 300)}`);
  }
}

export async function publish(auth: Record<string, string>, body: Record<string, unknown> = {}) {
  const res = await call("/api/v1/artifacts", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    // The API defaults to private (allowlist); most tests are about link viewers, so they say
    // "unlisted" explicitly. Tests of the default pass `visibility: undefined`.
    body: JSON.stringify({
      title: "Test artifact",
      html: "<!doctype html><h1>Hello</h1>",
      visibility: "unlisted",
      ...body,
    }),
  });
  return { res, body: await json(res) };
}

/**
 * Official MCP client connected to the real /mcp endpoint. With `vars`, every request runs against
 * the Worker with those env vars over the test env (as tests that pass vars to worker.fetch do).
 */
export async function mcpClient(token: string | null, vars?: Record<string, string>) {
  const client = new Client({ name: "plinth-test", version: "1.0.0" });
  const fetchWith = vars
    ? async (input: RequestInfo | URL, init?: RequestInit) => {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new Request(input, init), { ...env, ...vars } as never, ctx);
        await waitOnExecutionContext(ctx);
        return res;
      }
    : workerFetch;
  const transport = new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
    fetch: fetchWith,
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** Call a tool and parse its JSON text result. */
export async function tool<T = any>(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: !!r.isError, data: data as T, text };
}

/** Open an artifact as a browser would: gate on the app, exchange the token, return the cookie. */
export async function enterContent(
  slugOrId: string,
  init: { headers?: Record<string, string> } = {},
) {
  const gate = await json(await call(`/api/v1/view/${slugOrId}`, { headers: init.headers }));
  if (gate.status !== "ok")
    return { gate, cookie: null as string | null, location: null as string | null };
  const enter = await call(gate.enter_url);
  const setCookie = enter.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? null;
  return { gate, cookie, location: enter.headers.get("location"), enter };
}

/** One version row of an artifact, or null. */
export async function versionRow(artifactId: string, n: number) {
  return (
    (await db()
      .select()
      .from(versions)
      .where(and(eq(versions.artifactId, artifactId), eq(versions.number, n)))
      .get()) ?? null
  );
}

/** A version's manifest, as stored (stored_at included). */
export async function manifestOf(artifactId: string, n: number): Promise<ManifestEntry[]> {
  const v = await versionRow(artifactId, n);
  return v ? parseManifest(v.manifest) : [];
}

/**
 * The R2 object a version serves at `path` (through the manifest and fileKey, so reused files
 * resolve to their origin), or null when the version does not list the path or the object is gone.
 */
export async function storedFile(artifactId: string, n: number, path: string) {
  const v = await versionRow(artifactId, n);
  if (!v) return null;
  const e = parseManifest(v.manifest).find((m) => m.path === path);
  if (!e) return null;
  return env.FILES.get(fileKey(artifactId, v, e));
}

/** Every R2 key under a prefix. */
export async function r2Keys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Lowercase hex SHA-256 of a string or bytes. */
export async function sha256Of(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Wrap a binding so every method call is recorded (name and first argument). */
export function spy<T extends object>(
  target: T,
): { proxy: T; calls: { method: string; arg: unknown }[] } {
  const calls: { method: string; arg: unknown }[] = [];
  const proxy = new Proxy(target, {
    get(t, prop, _receiver) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), arg: args[0] });
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { proxy, calls };
}

/** The principal an agent() token resolves to (all scopes unless given). */
export function agentPrincipal(
  a: { user: { id: string; email: string }; connectionId: string },
  scopes: string[] = ["artifacts:read", "artifacts:write", "mentions"],
): Principal {
  return {
    kind: "agent",
    userId: a.user.id,
    email: a.user.email,
    connectionId: a.connectionId,
    connectionLabel: "Test token",
    clientType: "other",
    scopes: new Set(scopes) as Set<never>,
  };
}

/** A service Ctx for direct calls, with optional bindings (spies) and config over the test's. */
export function serviceCtxFor(
  principal: Principal,
  opts: { env?: Partial<Ctx["env"]>; config?: Partial<ReturnType<typeof config>> } = {},
): Ctx {
  return {
    env: { ...(env as unknown as Ctx["env"]), ...opts.env },
    config: { ...config(), ...opts.config },
    db: db(),
    principal,
    passwordPasses: new Map(),
    ip: null,
    waitUntil: () => undefined,
  };
}

/** Run a request through the Worker with some bindings or vars replaced (spies, env vars). */
export async function fetchWith(
  overrides: Record<string, unknown>,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const url = input.startsWith("http") ? input : `${APP}${input}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    { ...env, ...overrides } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
