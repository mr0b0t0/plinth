// Admin stats (instance aggregates for ADMIN_EMAIL) and an owner's open counts
// (docs/spec.md "Admin stats and view counts"). Other test files share the database, so instance
// figures are checked as deltas, never as absolute totals.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AdminStats, type ArtifactViews, COOKIES, CSRF_HEADER } from "@plinth/shared";
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
  publish,
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

/** One counted open: an anonymous browser's gate, then its framed enter. */
async function countedOpen(ref: string) {
  const gate = await json(await run(`/api/v1/view/${ref}`));
  expect(gate.status).toBe("ok");
  const enter = await run(gate.enter_url, { headers: FRAME });
  expect(enter.status).toBe(302);
}

async function seedDay(artifactId: string, day: string, views: number) {
  await env.DB.prepare(
    "INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?1, ?2, ?3)",
  )
    .bind(artifactId, day, views)
    .run();
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

const views = (ref: string, headers: Record<string, string>, vars: Record<string, unknown> = {}) =>
  run(`/api/v1/artifacts/${ref}/views`, { headers }, vars);

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

describe("GET /api/v1/artifacts/:ref/views", () => {
  it("gives the owner the last 7 and 30 days and the all-time total, including folded days", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const now = Date.now();
    await seedDay(p.id, utcDay(now), 3);
    await seedDay(p.id, utcDay(now - 6 * DAY_MS), 1); // still in the last 7 days
    await seedDay(p.id, utcDay(now - 7 * DAY_MS), 4); // the last 30, not the last 7
    await seedDay(p.id, utcDay(now - 29 * DAY_MS), 5); // the oldest of the 30
    await seedDay(p.id, utcDay(now - 30 * DAY_MS), 6); // older than 30, still a daily row
    await env.DB.prepare(
      "INSERT INTO artifact_view_totals (artifact_id, views, first_day) VALUES (?1, 100, '2026-01-01')",
    )
      .bind(p.id)
      .run();

    const session = await browserSession(owner.user.id);
    for (const [name, headers, ref] of [
      ["session", session.headers, p.slug],
      ["agent", owner.auth, p.id],
    ] as const) {
      const res = await views(ref, headers);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const v = await json<ArtifactViews>(res);
      expect(v.enabled).toBe(true);
      expect(v.last_7).toBe(4);
      expect(v.last_30).toBe(13);
      expect(v.total).toBe(119);
      expect(v.since).toBe("2026-01-01");
      expect(v.days).toHaveLength(30);
      expect(v.days.at(-1)).toEqual({ day: utcDay(now), views: 3 });
      expect(v.days[0]).toEqual({ day: utcDay(now - 29 * DAY_MS), views: 5 });
      expect(v.days.filter((d) => d.views === 0)).toHaveLength(26);
    }
  });

  it("counts a real open", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const none = await json<ArtifactViews>(await views(p.id, owner.auth));
    expect(none).toMatchObject({ total: 0, since: null });
    const now = pinToday();
    await countedOpen(p.slug);
    const v = await json<ArtifactViews>(await views(p.id, owner.auth));
    expect(v).toMatchObject({ total: 1, last_7: 1, last_30: 1, since: utcDay(now) });
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
      const res = await views(p.id, (await browserSession(u.id)).headers);
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("forbidden");
    }
    const editorAgent = await createToken(editor.id);
    expect((await views(p.id, { Authorization: `Bearer ${editorAgent.token}` })).status).toBe(403);
    const stranger = await createUser();
    expect((await views(p.id, (await browserSession(stranger.id)).headers)).status).toBe(404);
    // Anonymous callers are asked to sign in, as on every other owner-only endpoint.
    expect((await views(p.id, {})).status).toBe(401);
    expect((await run(`/api/v1/artifacts/${p.id}/sharing`)).status).toBe(401);
    // An unlisted page: anyone with the link can view it, but only the owner sees its counts.
    const { body: u } = await publish(owner.auth);
    expect((await views(u.id, {})).status).toBe(401);
    expect((await views(u.id, (await browserSession(stranger.id)).headers)).status).toBe(403);
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
    const res = await views(p.id, adm.headers, adm.vars);
    expect(res.status).toBe(403);
  });

  it("needs artifacts:read from an agent", async () => {
    const owner = await agent({ scopes: "artifacts:read" });
    const writeOnly = await createToken(owner.user.id, { scopes: "mentions" });
    // The read-only agent's own artifact, published by a full-scope token of the same person.
    const full = await createToken(owner.user.id);
    const { body: mine } = await publish({ Authorization: `Bearer ${full.token}` });
    expect((await views(mine.id, owner.auth)).status).toBe(200);
    const res = await views(mine.id, { Authorization: `Bearer ${writeOnly.token}` });
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toMatch(/scope/);
  });

  it("answers taken_down for a takedown and 404 once deleted", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?2 WHERE id = ?1")
      .bind(p.id, new Date().toISOString())
      .run();
    const down = await views(p.id, owner.auth);
    expect(down.status).toBe(403);
    expect((await json(down)).error.details).toEqual({ reason: "taken_down" });
    const { body: q } = await publish(owner.auth);
    expect(
      (await run(`/api/v1/artifacts/${q.id}`, { method: "DELETE", headers: owner.auth })).status,
    ).toBeLessThan(300);
    expect((await views(q.id, owner.auth)).status).toBe(404);
  });

  it("says when counting is off, and still shows the stored numbers to the owner only", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    await seedDay(p.id, utcDay(Date.now()), 2);
    const off = { VIEW_COUNTS: "off" };
    const v = await json<ArtifactViews>(await views(p.id, owner.auth, off));
    expect(v).toMatchObject({ enabled: false, total: 2, last_7: 2 });
    const stranger = await createUser();
    expect((await views(p.id, (await browserSession(stranger.id)).headers, off)).status).toBe(403);
  });
});
