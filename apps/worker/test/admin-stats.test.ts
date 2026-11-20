// Admin stats (instance aggregates for ADMIN_EMAIL) and an owner's artifact stats (docs/spec.md
// "Artifact stats"). Other test files share the database, so instance figures are checked as
// deltas, never as absolute totals.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type AdminStats,
  type ArtifactStats,
  type ArtifactStatsSummary,
  COOKIES,
  CSRF_HEADER,
  LIMITS,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.ts";
import { sessions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { hashToken, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import { storageUsed } from "../src/services/stage.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import { utcDay } from "../src/services/views.ts";
import {
  APP,
  agent,
  browserSession,
  createToken,
  createUser,
  db,
  json,
  mcpClient,
  publish,
  tool,
  uniqueEmail,
} from "./helpers.ts";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FRAME = { "sec-fetch-dest": "iframe", "user-agent": CHROME };
const DAY_MS = 86_400_000;

/** The Worker's fetch handler with extra vars, waiting for waitUntil work (a deferred count). */
async function run(
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

/** An admin: a signed-in person whose email is in ADMIN_EMAIL. */
async function admin() {
  const email = uniqueEmail("admin");
  const vars = { ADMIN_EMAIL: email };
  const config = parseConfig({ ...env, ...vars } as unknown as Record<string, unknown>);
  const user = await getOrCreateUser(db(), config, email, { verified: true });
  expect(user.isAdmin).toBe(true);
  const s = await browserSession(user.id);
  const stats = async (days?: number, extra: Record<string, unknown> = {}) => {
    const res = await run(
      `/api/v1/admin/stats${days === undefined ? "" : `?days=${days}`}`,
      { headers: s.headers },
      { ...vars, ...extra },
    );
    expect(res.status).toBe(200);
    return json<AdminStats>(res);
  };
  return { user, vars, headers: s.headers, stats };
}

/** A confirmed allowlist viewer without an account (app-host viewer cookie). */
async function viewerSession(email: string) {
  const value = newToken("v_");
  await db()
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "viewer",
      viewerEmail: email,
      expiresAt: isoIn(3600_000),
      createdAt: nowIso(),
    })
    .run();
  return {
    Cookie: `${COOKIES.viewer}=${value}; ${COOKIES.csrf}=c`,
    [CSRF_HEADER]: "c",
    Origin: APP,
  };
}

/** One counted open: a browser's gate (anonymous unless `headers` say who), then its framed enter. */
async function countedOpen(ref: string, headers: Record<string, string> = {}) {
  const gate = await json(await run(`/api/v1/view/${ref}`, { headers }));
  expect(gate.status).toBe("ok");
  const enter = await run(gate.enter_url, { headers: FRAME });
  expect(enter.status).toBe(302);
}

/** `views` unknown opens at noon UTC of `day`, as migrated daily counts are. */
async function seedDay(artifactId: string, day: string, views: number) {
  await env.DB.batch(
    Array.from({ length: views }, () =>
      env.DB.prepare(
        "INSERT INTO artifact_opens (artifact_id, opened_at, viewer_kind) VALUES (?1, ?2, 'unknown')",
      ).bind(artifactId, `${day}T12:00:00.000Z`),
    ),
  );
}

/** Pin the clock to midday UTC of today, so a run that crosses midnight keeps one "today". */
function pinToday() {
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"], now: noon.getTime() });
  return noon.getTime();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/v1/admin/stats: who may call it", () => {
  it("gives everyone but a current admin the same 404", async () => {
    const adm = await admin();
    const user = await createUser();
    const owner = await agent();
    const ownToken = await createToken(adm.user.id);
    const callers: {
      name: string;
      headers: Record<string, string>;
      vars?: Record<string, string>;
    }[] = [
      { name: "anonymous", headers: {} },
      { name: "signed-in user", headers: (await browserSession(user.id)).headers },
      // An email in ADMIN_EMAIL confirmed by code is a viewer, not a sign-in.
      { name: "viewer session", headers: await viewerSession(adm.user.email), vars: adm.vars },
      { name: "agent token of a user", headers: owner.auth },
      {
        name: "agent token of the admin",
        headers: { Authorization: `Bearer ${ownToken.token}` },
        vars: adm.vars,
      },
      // Flagged admin in the database, but not in ADMIN_EMAIL (the default config has none).
      { name: "former admin", headers: adm.headers },
    ];
    const bodies = new Set<string>();
    for (const caller of callers) {
      for (const q of ["", "?days=7", "?days=5"]) {
        const res = await run(`/api/v1/admin/stats${q}`, { headers: caller.headers }, caller.vars);
        expect(res.status, `${caller.name} ${q}`).toBe(404);
        bodies.add(await res.text());
      }
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0] as string).error.message).toBe("No such API endpoint");
  });

  it("rejects any window but 7, 30 or 90 days", async () => {
    const adm = await admin();
    for (const q of ["5", "0", "abc", "", "31"]) {
      const res = await run(`/api/v1/admin/stats?days=${q}`, { headers: adm.headers }, adm.vars);
      expect(res.status, q).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_input");
    }
  });
});

describe("GET /api/v1/admin/stats: the figures", () => {
  it("returns one zero-filled day per day of the window, oldest first, uncached", async () => {
    const now = pinToday();
    const adm = await admin();
    for (const days of [7, 30, 90]) {
      const s = await adm.stats(days);
      expect(s.days).toBe(days);
      expect(s.series).toHaveLength(days);
      expect(s.series.at(-1)?.day).toBe(utcDay(now));
      expect(s.series[0]?.day).toBe(utcDay(now - (days - 1) * DAY_MS));
      const sorted = [...s.series.map((d) => d.day)].sort();
      expect(s.series.map((d) => d.day)).toEqual(sorted);
      for (const d of s.series)
        for (const k of ["users", "artifacts", "publishes", "agent_publishes", "views"] as const)
          expect(d[k]).toBeGreaterThanOrEqual(0);
      expect(Object.keys(s.totals.artifacts_by_visibility).sort()).toEqual(
        ["allowlist", "password", "public", "unlisted"].sort(),
      );
      expect(Object.keys(s.totals.connections_by_client).sort()).toEqual(
        ["claude", "codex", "other"].sort(),
      );
    }
    expect((await adm.stats()).days).toBe(30);
    const res = await run("/api/v1/admin/stats", { headers: adm.headers }, adm.vars);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("moves with each publish, version, data write, connection, report and counted open", async () => {
    pinToday();
    const adm = await admin();
    const before = await adm.stats(7);

    // A new person with an agent connection (Claude) publishes an unlisted page with shared data.
    const owner = await agent({ clientType: "claude" });
    const { body: p } = await publish(owner.auth, {
      html: '<!doctype html><title>Poll</title><meta name="plinth-capabilities" content="data">',
    });
    const put = await run(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><h1>Two</h1>", base_version: 1 }),
    });
    expect(put.status).toBe(200);
    const write = await run(`/api/v1/artifacts/${p.id}/data`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "set", collection: "votes", doc_id: "a", data: { choice: "x" }, if_rev: 0 }],
      }),
    });
    expect(write.status).toBe(200);
    // The connection is used (the publish above), so it counts as used in the window.
    const report = await run(`/api/v1/artifacts/${p.id}/report`, {
      method: "POST",
      headers: {
        Cookie: "__Host-plinth_csrf=r",
        "x-plinth-csrf": "r",
        Origin: APP,
        "Content-Type": "application/json",
        "cf-connecting-ip": "198.51.100.77",
      },
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(report.status).toBe(201);
    await countedOpen(p.slug);

    const after = await adm.stats(7);
    const t = (k: keyof AdminStats["totals"]) =>
      (after.totals[k] as number) - (before.totals[k] as number);
    const w = (k: keyof AdminStats["window"]) => after.window[k] - before.window[k];
    expect(t("users")).toBe(1);
    expect(w("new_users")).toBe(1);
    expect(t("artifacts")).toBe(1);
    expect(
      after.totals.artifacts_by_visibility.unlisted -
        before.totals.artifacts_by_visibility.unlisted,
    ).toBe(1);
    expect(w("new_artifacts")).toBe(1);
    expect(t("versions")).toBe(2);
    expect(t("agent_versions")).toBe(2);
    expect(w("publishes")).toBe(2);
    expect(w("agent_publishes")).toBe(2);
    // The quota's own measure: the new owner's live versions, stored bytes.
    const used = await storageUsed({ env } as never, owner.user.id);
    expect(used).toBeGreaterThan(0);
    expect(t("storage_bytes")).toBe(used);
    const usage = await env.DB.prepare(
      "SELECT docs, bytes FROM artifact_data_usage WHERE artifact_id = ?1",
    )
      .bind(p.id)
      .first<{ docs: number; bytes: number }>();
    expect(usage?.bytes).toBeGreaterThan(0);
    expect(t("data_docs")).toBe(1);
    expect(t("data_bytes")).toBe(usage?.bytes);
    expect(t("data_artifacts")).toBe(1);
    expect(t("connections")).toBe(1);
    expect(
      after.totals.connections_by_client.claude - before.totals.connections_by_client.claude,
    ).toBe(1);
    expect(w("connections_used")).toBe(1);
    expect(t("open_reports")).toBe(1);
    expect(t("views")).toBe(1);
    expect(w("views")).toBe(1);
    expect(w("artifacts_viewed")).toBe(1);
    const today = (s: AdminStats) => s.series.at(-1) as AdminStats["series"][number];
    expect(today(after).publishes - today(before).publishes).toBe(2);
    expect(today(after).views - today(before).views).toBe(1);
    expect(today(after).users - today(before).users).toBe(1);
  });

  it("counts a connection used in the window and revoked since as used", async () => {
    pinToday();
    const adm = await admin();
    const before = await adm.stats(7);
    const owner = await agent({ clientType: "codex" });
    await publish(owner.auth);
    const conn = await env.DB.prepare(
      "SELECT id FROM agent_connections WHERE user_id = ?1 AND last_used_at IS NOT NULL",
    )
      .bind(owner.user.id)
      .first<{ id: string }>();
    expect(conn).toBeTruthy();
    await env.DB.prepare("UPDATE agent_connections SET revoked_at = ?2 WHERE id = ?1")
      .bind(conn?.id, nowIso())
      .run();
    const after = await adm.stats(7);
    // No longer a live connection, but its publish is in the window and so is its use.
    expect(after.totals.connections - before.totals.connections).toBe(0);
    expect(after.window.agent_publishes - before.window.agent_publishes).toBe(1);
    expect(after.window.connections_used - before.window.connections_used).toBe(1);
  });

  it("counts live artifacts only, and keeps the opens of deleted ones in the view totals", async () => {
    const adm = await admin();
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    await countedOpen(p.slug);
    const before = await adm.stats(7);
    const del = await run(`/api/v1/artifacts/${p.id}`, { method: "DELETE", headers: owner.auth });
    expect(del.status).toBeLessThan(300);
    const after = await adm.stats(7);
    expect(after.totals.artifacts - before.totals.artifacts).toBe(-1);
    expect(after.totals.versions - before.totals.versions).toBe(-1);
    expect(after.totals.views).toBe(before.totals.views);
    // The publish stays in the activity series.
    expect(after.window.publishes).toBe(before.window.publishes);
  });

  it("adds folded totals to the all-time opens", async () => {
    const adm = await admin();
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const before = await adm.stats(7);
    await env.DB.prepare(
      "INSERT INTO artifact_view_totals (artifact_id, views, first_day) VALUES (?1, 40, '2026-01-01')",
    )
      .bind(p.id)
      .run();
    await seedDay(p.id, utcDay(Date.now() - 20 * DAY_MS), 2);
    const after = await adm.stats(7);
    expect(after.totals.views - before.totals.views).toBe(42);
    // Neither is inside a 7-day window.
    expect(after.window.views).toBe(before.window.views);
  });

  it("names no artifact, owner or viewer", async () => {
    const adm = await admin();
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { title: "Quarterly secret plan" });
    await countedOpen(p.slug);
    const text = await (
      await run("/api/v1/admin/stats?days=90", { headers: adm.headers }, adm.vars)
    ).text();
    for (const needle of [p.id, p.slug, "Quarterly secret plan", owner.user.email, owner.user.id])
      expect(text).not.toContain(needle);
  });

  it("reports counting off, and still answers", async () => {
    const adm = await admin();
    const s = await adm.stats(7, { VIEW_COUNTS: "off" });
    expect(s.view_counts).toBe(false);
    expect((await adm.stats(7)).view_counts).toBe(true);
  });
});

// ---------- the owner's artifact stats ----------

const stats = (
  ref: string,
  headers: Record<string, string>,
  query = "",
  vars: Record<string, unknown> = {},
) => run(`/api/v1/artifacts/${ref}/stats${query}`, { headers }, vars);

/** One artifact_opens row, `ageDays` before the pinned noon (plus `minutes`). */
function openRow(
  artifactId: string,
  now: number,
  ageDays: number,
  row: {
    kind: "user" | "email" | "anonymous" | "unknown";
    userId?: string;
    email?: string;
    visitor?: string;
    role?: string;
    version?: number | null;
    minutes?: number;
  },
) {
  const at = new Date(now - ageDays * DAY_MS + (row.minutes ?? 0) * 60_000).toISOString();
  return env.DB.prepare(
    `INSERT INTO artifact_opens (artifact_id, version, opened_at, viewer_kind, user_id, email, visitor, role)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    artifactId,
    row.version === undefined ? 1 : row.version,
    at,
    row.kind,
    row.userId ?? null,
    row.email ?? null,
    row.visitor ?? null,
    row.role ?? null,
  );
}

const A = "A".repeat(22);
const B = "B".repeat(22);

describe("GET /api/v1/artifacts/:ref/stats", () => {
  async function seeded() {
    const now = pinToday();
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    // Two versions, so "not the latest" means something.
    await env.DB.prepare("UPDATE artifacts SET current_version = 2 WHERE id = ?1").bind(p.id).run();
    const editor = await createUser(uniqueEmail("editor"));
    await env.DB.prepare("UPDATE users SET name = 'Ana Editor' WHERE id = ?1")
      .bind(editor.id)
      .run();
    const listedEmail = uniqueEmail("listed");
    const listed = await createUser(listedEmail);
    const commenter = await createUser(uniqueEmail("commenter"));
    await env.DB.batch([
      // The editor: yesterday on v1, today on v2.
      openRow(p.id, now, 1, { kind: "user", userId: editor.id, role: "editor", version: 1 }),
      openRow(p.id, now, 0, { kind: "user", userId: editor.id, role: "editor", version: 2 }),
      // One person by code three days ago, then signed in to an account with that email.
      openRow(p.id, now, 3, { kind: "email", email: listedEmail, role: "viewer" }),
      openRow(p.id, now, 2, { kind: "user", userId: listed.id, role: "viewer" }),
      // Ten days ago: inside 30 days, not 7.
      openRow(p.id, now, 10, { kind: "user", userId: commenter.id, role: "commenter" }),
      // Two anonymous browsers.
      openRow(p.id, now, 0, {
        kind: "anonymous",
        visitor: A,
        role: "link",
        version: 2,
        minutes: -5,
      }),
      openRow(p.id, now, 1, { kind: "anonymous", visitor: A, role: "link", version: 2 }),
      openRow(p.id, now, 2, { kind: "anonymous", visitor: B, role: "link" }),
      // Old daily counts: no version, no viewer.
      openRow(p.id, now, 5, { kind: "unknown", version: null }),
      openRow(p.id, now, 5, { kind: "unknown", version: null }),
      openRow(p.id, now, 5, { kind: "unknown", version: null }),
      // Forty days ago: only the 90- and 365-day windows.
      openRow(p.id, now, 40, { kind: "user", userId: editor.id, role: "editor" }),
      env.DB.prepare(
        "INSERT INTO artifact_view_totals (artifact_id, views, first_day) VALUES (?1, 100, '2026-01-01')",
      ).bind(p.id),
    ]);
    return { now, owner, p, editor, listed, listedEmail, commenter };
  }

  it("gives the owner totals, a zero-filled daily series, people and versions", async () => {
    const { now, owner, p, editor, listedEmail, commenter } = await seeded();
    const session = await browserSession(owner.user.id);
    for (const [name, headers, ref] of [
      ["session", session.headers, p.slug],
      ["agent", owner.auth, p.id],
    ] as const) {
      const res = await stats(ref, headers);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const s = await json<ArtifactStats>(res);
      expect(s).toMatchObject({ enabled: true, days: 30, retention_days: 365, current_version: 2 });
      expect(s.totals).toEqual({
        opens: 11,
        viewers: 5,
        people: 3,
        anonymous_visitors: 2,
        anonymous_opens: 3,
        all_time_opens: 112,
        since: "2026-01-01",
      });
      expect(s.series).toHaveLength(30);
      expect(s.series.at(-1)).toEqual({ day: utcDay(now), opens: 2, viewers: 2 });
      expect(s.series.find((d) => d.day === utcDay(now - 5 * DAY_MS))).toEqual({
        day: utcDay(now - 5 * DAY_MS),
        opens: 3,
        viewers: 0,
      });
      expect(s.series.reduce((n, d) => n + d.opens, 0)).toBe(11);
      expect(s.people_total).toBe(3);
      expect(s.people).toEqual([
        {
          name: "Ana Editor",
          email: editor.email,
          kind: "user",
          role: "editor",
          first_opened_at: new Date(now - DAY_MS).toISOString(),
          last_opened_at: new Date(now).toISOString(),
          opens: 2,
          last_version_seen: 2,
        },
        {
          name: null,
          email: listedEmail,
          kind: "user",
          role: "viewer",
          first_opened_at: new Date(now - 3 * DAY_MS).toISOString(),
          last_opened_at: new Date(now - 2 * DAY_MS).toISOString(),
          opens: 2,
          last_version_seen: 1,
        },
        {
          name: null,
          email: commenter.email,
          kind: "user",
          role: "commenter",
          first_opened_at: new Date(now - 10 * DAY_MS).toISOString(),
          last_opened_at: new Date(now - 10 * DAY_MS).toISOString(),
          opens: 1,
          last_version_seen: 1,
        },
      ]);
      expect(s.versions).toEqual([
        { version: 2, opens: 3, viewers: 2 },
        { version: 1, opens: 5, viewers: 4 },
      ]);
    }
  });

  it("follows the window: 7 days leaves out older people, 365 takes in older opens", async () => {
    const { owner, p, editor, commenter, now } = await seeded();
    const week = await json<ArtifactStats>(await stats(p.id, owner.auth, "?days=7"));
    expect(week.days).toBe(7);
    expect(week.series).toHaveLength(7);
    expect(week.totals.opens).toBe(10);
    expect(week.people.map((x) => x.email)).not.toContain(commenter.email);
    const year = await json<ArtifactStats>(await stats(p.id, owner.auth, "?days=365"));
    expect(year.series).toHaveLength(365);
    expect(year.totals.opens).toBe(12);
    const ana = year.people.find((x) => x.email === editor.email);
    expect(ana).toMatchObject({
      opens: 3,
      first_opened_at: new Date(now - 40 * DAY_MS).toISOString(),
    });
    for (const bad of ["5", "0", "all", "30d"]) {
      const res = await stats(p.id, owner.auth, `?days=${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });

  it("records real opens of each kind and shows them", async () => {
    const owner = await agent();
    const listed = uniqueEmail("listed");
    const member = await createUser();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [listed] });
    const put = await run(`/api/v1/artifacts/${p.id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        grants: [
          { email: listed, role: "viewer" },
          { email: member.email, role: "commenter" },
        ],
      }),
    });
    expect(put.status).toBe(200);
    const none = await json<ArtifactStats>(await stats(p.id, owner.auth));
    expect(none.totals).toMatchObject({ opens: 0, all_time_opens: 0, since: null });
    expect(none.people).toEqual([]);
    // The member signed in, the listed email by code (viewer session), the owner (never counted).
    await countedOpen(p.slug, (await browserSession(member.id)).headers);
    await countedOpen(p.slug, await viewerSession(listed));
    await countedOpen(p.slug, (await browserSession(owner.user.id)).headers);
    const s = await json<ArtifactStats>(await stats(p.id, owner.auth));
    expect(s.totals).toMatchObject({ opens: 2, people: 2, viewers: 2, anonymous_visitors: 0 });
    expect(s.people.map((x) => [x.email, x.kind, x.role, x.last_version_seen]).sort()).toEqual(
      [
        [listed, "email", "viewer", 1],
        [member.email, "user", "commenter", 1],
      ].sort(),
    );
    // A link visitor on an unlisted page is an anonymous visitor.
    const { body: u } = await publish(owner.auth);
    await countedOpen(u.slug);
    await countedOpen(u.slug);
    const anon = await json<ArtifactStats>(await stats(u.id, owner.auth));
    expect(anon.totals).toMatchObject({
      opens: 2,
      people: 0,
      anonymous_visitors: 2,
      anonymous_opens: 2,
      viewers: 2,
    });
  });

  it("lists at most LIMITS.maxStatsPeople people, most recent first, and says how many", async () => {
    const now = pinToday();
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const n = LIMITS.maxStatsPeople + 1;
    const rows = Array.from({ length: n }, (_, i) =>
      openRow(p.id, now, 0, {
        kind: "email",
        email: `p${i}@example.com`,
        role: "viewer",
        minutes: -i,
      }),
    );
    for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
    const s = await json<ArtifactStats>(await stats(p.id, owner.auth));
    expect(s.people_total).toBe(n);
    expect(s.people).toHaveLength(LIMITS.maxStatsPeople);
    expect(s.people[0]?.email).toBe("p0@example.com");
    expect(s.people.at(-1)?.email).toBe(`p${LIMITS.maxStatsPeople - 1}@example.com`);
  });

  it("is the owner's only: collaborators get 403, strangers 404, anonymous 401", async () => {
    const owner = await agent();
    const editor = await createUser();
    const viewer = await createUser();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [] });
    const put = await run(`/api/v1/artifacts/${p.id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        grants: [
          { email: editor.email, role: "editor" },
          { email: viewer.email, role: "viewer" },
        ],
      }),
    });
    expect(put.status).toBe(200);
    for (const u of [editor, viewer]) {
      const res = await stats(p.id, (await browserSession(u.id)).headers);
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("forbidden");
    }
    const editorAgent = await createToken(editor.id);
    expect((await stats(p.id, { Authorization: `Bearer ${editorAgent.token}` })).status).toBe(403);
    const stranger = await createUser();
    expect((await stats(p.id, (await browserSession(stranger.id)).headers)).status).toBe(404);
    expect((await stats(p.id, {})).status).toBe(401);
    // An unlisted page: anyone with the link can view it, but only the owner sees its stats.
    const { body: u } = await publish(owner.auth);
    expect((await stats(u.id, {})).status).toBe(401);
    expect((await stats(u.id, (await browserSession(stranger.id)).headers)).status).toBe(403);
  });

  it("denies an admin without a role", async () => {
    const adm = await admin();
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [] });
    await env.DB.prepare(
      "INSERT INTO reports (id, artifact_id, reason, state, created_at) VALUES (?1, ?2, 'spam', 'open', ?3)",
    )
      .bind(crypto.randomUUID(), p.id, nowIso())
      .run();
    const res = await stats(p.id, adm.headers, "", adm.vars);
    expect(res.status).toBe(403);
  });

  it("needs artifacts:read from an agent", async () => {
    const owner = await agent({ scopes: "artifacts:read" });
    const writeOnly = await createToken(owner.user.id, { scopes: "mentions" });
    const full = await createToken(owner.user.id);
    const { body: mine } = await publish({ Authorization: `Bearer ${full.token}` });
    expect((await stats(mine.id, owner.auth)).status).toBe(200);
    const res = await stats(mine.id, { Authorization: `Bearer ${writeOnly.token}` });
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toMatch(/scope/);
  });

  it("answers taken_down for a takedown and 404 once deleted", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?2 WHERE id = ?1")
      .bind(p.id, new Date().toISOString())
      .run();
    const down = await stats(p.id, owner.auth);
    expect(down.status).toBe(403);
    expect((await json(down)).error.details).toEqual({ reason: "taken_down" });
    const { body: q } = await publish(owner.auth);
    expect(
      (await run(`/api/v1/artifacts/${q.id}`, { method: "DELETE", headers: owner.auth })).status,
    ).toBeLessThan(300);
    expect((await stats(q.id, owner.auth)).status).toBe(404);
  });

  it("says when counting is off, and still shows what was recorded to the owner only", async () => {
    const now = pinToday();
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    await env.DB.batch([
      openRow(p.id, now, 0, { kind: "anonymous", visitor: A, role: "link" }),
      openRow(p.id, now, 0, { kind: "unknown", version: null }),
    ]);
    const off = { VIEW_COUNTS: "off", VIEW_LOG_RETENTION_DAYS: "120" };
    const s = await json<ArtifactStats>(await stats(p.id, owner.auth, "", off));
    expect(s).toMatchObject({ enabled: false, retention_days: 120 });
    expect(s.totals).toMatchObject({ opens: 2, anonymous_visitors: 1 });
    const stranger = await createUser();
    expect((await stats(p.id, (await browserSession(stranger.id)).headers, "", off)).status).toBe(
      403,
    );
  });

  it("the old /views route is gone", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    expect((await run(`/api/v1/artifacts/${p.id}/views`, { headers: owner.auth })).status).toBe(
      404,
    );
  });
});

describe("GET /api/v1/stats/artifacts", () => {
  const summary = (headers: Record<string, string>, vars: Record<string, unknown> = {}) =>
    run("/api/v1/stats/artifacts", { headers }, vars);

  it("lists the caller's own live artifacts with 7- and 30-day opens, most recently opened first", async () => {
    const now = pinToday();
    const owner = await agent();
    const other = await agent();
    const { body: busy } = await publish(owner.auth, { title: "Busy" });
    const { body: quiet } = await publish(owner.auth, { title: "Quiet" });
    const { body: unopened } = await publish(owner.auth, { title: "Unopened" });
    const { body: gone } = await publish(owner.auth, { title: "Gone" });
    const { body: down } = await publish(owner.auth, { title: "Down" });
    const { body: theirs } = await publish(other.auth, { title: "Theirs" });
    const viewer = await createUser();
    await env.DB.batch([
      openRow(busy.id, now, 0, { kind: "anonymous", visitor: A, role: "link" }),
      openRow(busy.id, now, 1, { kind: "anonymous", visitor: A, role: "link" }),
      openRow(busy.id, now, 2, { kind: "user", userId: viewer.id, role: "link" }),
      openRow(busy.id, now, 20, { kind: "anonymous", visitor: B, role: "link" }),
      openRow(busy.id, now, 60, { kind: "unknown", version: null }),
      openRow(quiet.id, now, 15, { kind: "unknown", version: null }),
      openRow(gone.id, now, 0, { kind: "unknown", version: null }),
      openRow(down.id, now, 0, { kind: "unknown", version: null }),
      openRow(theirs.id, now, 0, { kind: "unknown", version: null }),
      env.DB.prepare(
        "INSERT INTO artifact_view_totals (artifact_id, views, first_day) VALUES (?1, 7, '2026-01-01')",
      ).bind(quiet.id),
    ]);
    expect(
      (await run(`/api/v1/artifacts/${gone.id}`, { method: "DELETE", headers: owner.auth })).status,
    ).toBeLessThan(300);
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?2 WHERE id = ?1")
      .bind(down.id, new Date().toISOString())
      .run();

    for (const headers of [owner.auth, (await browserSession(owner.user.id)).headers]) {
      const res = await summary(headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const s = await json<ArtifactStatsSummary>(res);
      expect(s).toMatchObject({ enabled: true, retention_days: 365 });
      expect(s.items.map((i) => i.title)).toEqual(["Busy", "Quiet", "Unopened"]);
      expect(s.items[0]).toEqual({
        id: busy.id,
        slug: busy.slug,
        title: "Busy",
        type: "html",
        visibility: busy.visibility,
        current_version: 1,
        opens_7d: 3,
        opens_30d: 4,
        viewers_7d: 2,
        viewers_30d: 3,
        all_time_opens: 5,
        last_opened_at: new Date(now).toISOString(),
      });
      expect(s.items[1]).toMatchObject({ opens_7d: 0, opens_30d: 1, all_time_opens: 8 });
      expect(s.items[2]).toMatchObject({
        id: unopened.id,
        opens_30d: 0,
        all_time_opens: 0,
        last_opened_at: null,
      });
    }
    const theirsList = await json<ArtifactStatsSummary>(await summary(other.auth));
    expect(theirsList.items.map((i) => i.id)).toEqual([theirs.id]);
  });

  it("asks anonymous callers to sign in and needs artifacts:read from an agent", async () => {
    expect((await summary({})).status).toBe(401);
    const owner = await agent({ scopes: "mentions" });
    const res = await summary(owner.auth);
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toMatch(/scope/);
    const listed = uniqueEmail("listed");
    expect((await summary(await viewerSession(listed))).status).toBe(401);
  });
});

describe("get_artifact_stats (MCP)", () => {
  it("returns one artifact's stats with an id and the summary without, for the owner only", async () => {
    const owner = await agent();
    const client = await mcpClient(owner.token);
    const published = await tool(client, "publish_artifact", {
      title: "Counted",
      html: "<!doctype html><h1>Hi</h1>",
      visibility: "unlisted",
    });
    await countedOpen(published.data.id);
    const one = await tool<ArtifactStats>(client, "get_artifact_stats", {
      id: published.data.id,
      days: 7,
    });
    expect(one.isError).toBe(false);
    expect(one.data).toMatchObject({ days: 7, totals: { opens: 1, anonymous_visitors: 1 } });
    const all = await tool<ArtifactStatsSummary>(client, "get_artifact_stats", {});
    expect(all.isError).toBe(false);
    expect(all.data.items.map((i) => i.id)).toContain(published.data.id);
    const stranger = await agent();
    const theirs = await tool(await mcpClient(stranger.token), "get_artifact_stats", {
      id: published.data.id,
    });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toMatch(/forbidden|not_found/);
  });
});
