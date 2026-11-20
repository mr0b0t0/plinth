// Helpers for the category sharing tests: an owner with a token and a session, people with
// sessions, and the share endpoints driven the way the app drives them.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CategoryRole } from "@plinth/shared";
import { desc, eq } from "drizzle-orm";
import { expect } from "vitest";
import { devOutbox } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  createToken,
  createUser,
  db,
  json,
  publish,
  uniqueEmail,
} from "./helpers.ts";

/** The Worker's fetch handler with extra vars, waiting for its waitUntil work (email, rooms). */
export async function run(
  path: string,
  init: RequestInit = {},
  vars: Record<string, unknown> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const url = path.startsWith("http") ? path : `${APP}${path}`;
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** An owner with a bearer token (their agent) and a signed-in browser session. */
export async function owner() {
  const a = await agent({ label: "Work Claude" });
  const session = await browserSession(a.user.id);
  return { ...a, session: session.headers };
}

export type Owner = Awaited<ReturnType<typeof owner>>;

/** Someone with an account, a browser session and a token of their own. */
export async function person(email = uniqueEmail("client")) {
  const user = await createUser(email);
  const session = await browserSession(user.id);
  const t = await createToken(user.id);
  return {
    user,
    email: user.email,
    session: session.headers,
    auth: { Authorization: `Bearer ${t.token}` },
  };
}

export type Person = Awaited<ReturnType<typeof person>>;

export const send = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  vars: Record<string, unknown> = {},
) =>
  run(
    path,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    vars,
  );

/** Publish one artifact under a category, as the owner's agent. */
export async function filed(o: Owner, category: string, title = "Report") {
  const { res, body } = await publish(o.auth, {
    title,
    category,
    visibility: "allowlist",
    html: `<!doctype html><title>${title}</title><p>${title}</p>`,
  });
  expect(res.status).toBe(201);
  return body as {
    id: string;
    slug: string;
    category_share?: { state: string; review_url?: string };
  };
}

export interface ShareArtifact {
  id: string;
  current_version: number;
  category_rev: number;
  state: string;
}

/** A review of `rows`: shared for those `share` picks, private for the rest. */
export function reviewOf(rows: ShareArtifact[], share: (r: ShareArtifact) => boolean) {
  return rows.map((r) => ({
    id: r.id,
    version: r.current_version,
    category_rev: r.category_rev,
    decision: share(r) ? "shared" : "private",
  }));
}

/** The artifacts a share dialog would show for a category before it is shared. */
export async function rowsOf(o: Owner, category: string): Promise<ShareArtifact[]> {
  const list = await json(
    await call(`/api/v1/artifacts?category=${encodeURIComponent(category)}`, { headers: o.auth }),
  );
  const out: ShareArtifact[] = [];
  for (const a of list.items as { id: string; current_version: number }[]) {
    const row = await env.DB.prepare("SELECT category_rev FROM artifacts WHERE id = ?1")
      .bind(a.id)
      .first<{ category_rev: number }>();
    out.push({
      id: a.id,
      current_version: a.current_version,
      category_rev: row?.category_rev ?? 0,
      state: "pending",
    });
  }
  return out;
}

/** Share a category with people, sharing every artifact `pick` keeps (all by default). */
export async function shareCategory(
  o: Owner,
  category: string,
  people: { email: string; role: CategoryRole }[],
  pick: (r: ShareArtifact) => boolean = () => true,
  extra: Record<string, unknown> = {},
) {
  const rows = await rowsOf(o, category);
  const res = await send("POST", "/api/v1/category-shares", o.session, {
    category,
    people,
    review: reviewOf(rows, pick),
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await json(res)) as {
    share: { id: string; title: string; portal_url: string; counts: Record<string, number> };
    review: { shared: number; private: number; skipped: { id: string; reason: string }[] };
  };
}

export async function shareDetail(o: Owner, id: string) {
  const res = await send("GET", `/api/v1/category-shares/${id}`, o.session);
  expect(res.status).toBe(200);
  return (await json(res)) as {
    artifacts: ShareArtifact[];
    people: unknown[];
    counts: Record<string, number>;
  };
}

/** What the artifacts table holds for one artifact's category columns. */
export async function categoryRow(id: string) {
  return env.DB.prepare(
    `SELECT category, category_key, category_rev, category_review, category_review_share,
            access_epoch, updated_at
       FROM artifacts WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      category: string | null;
      category_key: string | null;
      category_rev: number;
      category_review: string | null;
      category_review_share: string | null;
      access_epoch: number;
      updated_at: string;
    }>();
}

/** Can this caller view the artifact through the gate? */
export async function gateStatus(slug: string, headers: Record<string, string>) {
  return (await json(await call(`/api/v1/view/${slug}`, { headers }))).status as string;
}

export async function outboxFor(email: string) {
  return db()
    .select()
    .from(devOutbox)
    .where(eq(devOutbox.toEmail, email))
    .orderBy(desc(devOutbox.createdAt))
    .all();
}

let ip = 0;
/** An anonymous browser: CSRF cookie and header, its own client IP. */
export function browser(extraCookie = "") {
  ip += 1;
  const cookie = ["__Host-plinth_csrf=cat-csrf", extraCookie].filter(Boolean).join("; ");
  return {
    Cookie: cookie,
    "x-plinth-csrf": "cat-csrf",
    Origin: APP,
    "cf-connecting-ip": `203.0.113.${ip % 250}`,
  } as Record<string, string>;
}

export async function codeFor(email: string): Promise<string> {
  const [mail] = await outboxFor(email);
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error(`no code mailed to ${email}`);
  return code;
}
