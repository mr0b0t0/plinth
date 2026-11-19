// Helpers for the data-source tests: a dashboard whose collection `issues` is sourced, people with
// each role (an account, an agent token, a browser session and a content cookie), and requests the
// way each channel makes them (the page's data API, the app's REST, an agent's REST or MCP).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Role } from "@plinth/shared";
import { accessGrants } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { nowIso } from "../src/lib/time.ts";
import {
  agent,
  browserSession,
  call,
  contentOrigin,
  createToken,
  createUser,
  db,
  enterContent,
  json,
  publish,
} from "./helpers.ts";

export const DASHBOARD = `<!doctype html><title>Issues</title>
<meta name="plinth-capabilities" content="data viewer">
<meta name="plinth-data-sourced" content="issues">
<p>dashboard</p>`;

export const LINEAR = {
  id: "linear",
  label: "Open issues",
  connector: "Linear",
  recipe: "Linear: count open issues in team ENG by state; one document per state in issues.",
  collection: "issues",
};

type Vars = Record<string, string>;

export async function run(url: string, init: RequestInit = {}, vars: Vars = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** A request the way the runtime makes it: same-origin fetch with the custom header. */
export function pageApi(
  id: string,
  path: string,
  opts: { method?: string; cookie?: string | null; body?: unknown } = {},
): Promise<Response> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "PUT");
  const headers = new Headers({
    "x-plinth-data": "1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  });
  if (method !== "GET") headers.set("origin", contentOrigin(id));
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return run(`${contentOrigin(id)}/__plinth/api/v1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

export async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

export interface Person {
  userId: string;
  email: string;
  /** The person's personal access token. */
  token: string;
  auth: Record<string, string>;
  connectionId: string;
  session: Record<string, string>;
  cookie: () => Promise<string>;
}

async function personFor(
  id: string,
  user: { id: string; email: string },
  token: { token: string; connectionId: string },
): Promise<Person> {
  const s = await browserSession(user.id);
  return {
    userId: user.id,
    email: user.email,
    token: token.token,
    auth: { Authorization: `Bearer ${token.token}` },
    connectionId: token.connectionId,
    session: s.headers,
    cookie: async () => {
      const { cookie, gate } = await enterContent(id, { headers: s.headers });
      if (!cookie) throw new Error(`no content cookie (gate ${gate.status})`);
      return cookie;
    },
  };
}

/** A published dashboard with its owner, and a person with each granted role. */
export async function dashboard(html = DASHBOARD, opts: { clientType?: "claude" | "codex" } = {}) {
  const ownerAgent = await agent({ clientType: opts.clientType ?? "claude", label: "laptop" });
  const { body } = await publish(ownerAgent.auth, { html, visibility: "allowlist" });
  const id = body.id as string;
  const slug = body.slug as string;
  const owner = await personFor(id, ownerAgent.user, ownerAgent);
  const as = async (role: Role) => {
    const u = await createUser();
    await grant(id, u.email, role);
    return personFor(id, u, await createToken(u.id, { label: `${role} agent` }));
  };
  return { id, slug, owner, as };
}

/** REST with JSON, as an agent (bearer) or the app (session headers). */
export async function rest(
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await call(`/api/v1${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** PUT the sources list. */
export const setSources = (id: string, headers: Record<string, string>, sources: unknown[]) =>
  rest(`/artifacts/${id}/sources`, headers, "PUT", { sources });

/** write_artifact_data's REST mirror: one set op. */
export async function writeOne(
  id: string,
  headers: Record<string, string>,
  op: Record<string, unknown>,
) {
  const r = await rest(`/artifacts/${id}/data`, headers, "POST", {
    ops: [{ op: "set", collection: "issues", if_rev: 0, ...op }],
  });
  return r.body?.results?.[0] ?? r.body;
}

/** The stored provenance columns of one document. */
export async function stampRow(id: string, collection: string, docId: string) {
  return env.DB.prepare(
    `SELECT source_id, source_label, source_connector, source_ref, fetched_at, source_connection, rev
       FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2 AND doc_id = ?3`,
  )
    .bind(id, collection, docId)
    .first<Record<string, string | number | null>>();
}

export { json };
