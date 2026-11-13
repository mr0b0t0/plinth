// Test helpers: drive the real Worker through exports.default.fetch, seed users and tokens.

import { env, exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { COOKIES, CSRF_HEADER } from "@plinth/shared";
import { TOKEN_PREFIX } from "../src/auth/principal.ts";
import { getConfig } from "../src/config.ts";
import { getDb } from "../src/db/client.ts";
import { agentConnections, sessions } from "../src/db/schema.ts";
import { hashToken, newId, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
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
    body: JSON.stringify({
      title: "Test artifact",
      html: "<!doctype html><h1>Hello</h1>",
      ...body,
    }),
  });
  return { res, body: await json(res) };
}

/** Official MCP client connected to the real /mcp endpoint. */
export async function mcpClient(token: string | null) {
  const client = new Client({ name: "plinth-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
    fetch: workerFetch,
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
