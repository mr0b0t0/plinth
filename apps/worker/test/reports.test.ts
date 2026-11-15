// Reports and the admin takedown backend.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { artifacts, devOutbox, reports, versions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { STAGING_SWEEP_CRON } from "../src/services/attempts.ts";
import { openStager, updateTarget } from "../src/services/stage.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import {
  APP,
  agent,
  agentPrincipal,
  browserSession,
  call,
  contentOrigin,
  createUser,
  db,
  enterContent,
  json,
  publish,
  r2Keys,
  serviceCtxFor,
  uniqueEmail,
} from "./helpers.ts";

/** The Worker's fetch handler with extra vars (here: ADMIN_EMAIL), waiting for waitUntil work. */
async function run(
  path: string,
  init: RequestInit = {},
  vars: Record<string, string> = {},
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

let ip = 0;
function anonymous() {
  ip += 1;
  return {
    Cookie: "__Host-plinth_csrf=r",
    "x-plinth-csrf": "r",
    Origin: APP,
    "Content-Type": "application/json",
    "cf-connecting-ip": `203.0.113.${ip % 250}`,
  };
}

/** An admin: a signed-in person whose email is in ADMIN_EMAIL. */
async function admin() {
  const email = uniqueEmail("admin");
  const vars = { ADMIN_EMAIL: email };
  const config = parseConfig({ ...env, ...vars } as unknown as Record<string, unknown>);
  const user = await getOrCreateUser(db(), config, email, { verified: true });
  expect(user.isAdmin).toBe(true);
  const s = await browserSession(user.id);
  return {
    user,
    vars,
    get: (path: string) => run(path, { headers: s.headers }, vars),
    post: (path: string, body: unknown, bindings: Record<string, unknown> = {}) =>
      run(
        path,
        {
          method: "POST",
          headers: { ...s.headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        { ...vars, ...(bindings as Record<string, string>) },
      ),
  };
}

const report = (ref: string, body: unknown, headers = anonymous(), vars = {}) =>
  run(
    `/api/v1/artifacts/${ref}/report`,
    { method: "POST", headers, body: JSON.stringify(body) },
    vars,
  );

describe("reports", () => {
  it("anyone who can view an artifact can report it; admins are emailed", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { title: "Suspicious page" });
    const adm = await admin();
    const res = await report(p.slug, { reason: "Phishing for bank logins" }, anonymous(), adm.vars);
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created).toEqual({ id: expect.any(String), state: "open" });
    const row = await db().select().from(reports).where(eq(reports.id, created.id)).get();
    expect(row).toMatchObject({
      artifactId: p.id,
      reason: "Phishing for bank logins",
      reporterEmail: null,
      state: "open",
    });
    const mail = await db()
      .select()
      .from(devOutbox)
      .where(eq(devOutbox.toEmail, adm.user.email))
      .all();
    expect(mail).toHaveLength(1);
    expect(mail[0]?.text).toContain(`/a/${p.slug}`);
  });

  it("keeps the reporter email when given, and the signed-in email otherwise", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const given = await json(
      await report(p.id, { reason: "spam", reporter_email: "Reporter@Example.com" }),
    );
    expect(
      (await db().select().from(reports).where(eq(reports.id, given.id)).get())?.reporterEmail,
    ).toBe("reporter@example.com");
    const user = await createUser();
    const s = await browserSession(user.id);
    const signedIn = await json(
      await report(
        p.id,
        { reason: "spam" },
        {
          ...anonymous(),
          ...s.headers,
          "Content-Type": "application/json",
        },
      ),
    );
    expect(
      (await db().select().from(reports).where(eq(reports.id, signedIn.id)).get())?.reporterEmail,
    ).toBe(user.email);
  });

  it("someone who cannot view the artifact cannot report it", async () => {
    const a = await agent();
    const { body: listed } = await publish(a.auth, {
      visibility: "allowlist",
      emails: [uniqueEmail()],
    });
    // Anonymous: "shared with specific people" (the gate says the same); a signed-in stranger: 404.
    expect((await report(listed.id, { reason: "x" })).status).toBe(403);
    const stranger = await browserSession((await createUser()).id);
    const asStranger = { ...anonymous(), ...stranger.headers, "Content-Type": "application/json" };
    expect((await report(listed.id, { reason: "x" }, asStranger)).status).toBe(404);
    const { body: pw } = await publish(a.auth, { visibility: "password", password: "secret99" });
    expect((await report(pw.id, { reason: "x" })).status).toBe(403);
    expect((await report("no-such-artifact", { reason: "x" })).status).toBe(404);
    for (const id of [listed.id, pw.id]) {
      expect(await db().select().from(reports).where(eq(reports.artifactId, id)).all()).toEqual([]);
    }
  });

  it("validates the reason", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    expect((await report(p.id, { reason: "   " })).status).toBe(400);
    expect((await report(p.id, { reason: "x".repeat(2001) })).status).toBe(400);
    expect((await report(p.id, { reason: "x", reporter_email: "not an email" })).status).toBe(400);
  });

  it("is rate limited per IP (10 per hour)", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const headers = anonymous();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await report(p.id, { reason: `r${i}` }, headers)).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("admin takedown", () => {
  it("lists reports by state", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { title: "Listed in queue" });
    const adm = await admin();
    const { id } = await json(await report(p.id, { reason: "malware download" }));
    const res = await adm.get("/api/v1/admin/reports?state=open");
    expect(res.status).toBe(200);
    const { items } = await json(res);
    const mine = items.find((r: { id: string }) => r.id === id);
    expect(mine).toEqual({
      id,
      artifact_id: p.id,
      artifact_slug: p.slug,
      artifact_title: "Listed in queue",
      reason: "malware download",
      reporter_email: null,
      state: "open",
      created_at: expect.any(String),
    });
    const dismissedOnly = await json(await adm.get("/api/v1/admin/reports?state=dismissed"));
    expect(dismissedOnly.items.some((r: { id: string }) => r.id === id)).toBe(false);
    expect((await adm.get("/api/v1/admin/reports?state=bogus")).status).toBe(400);
  });

  it("actioned: takes the artifact down at once and closes its other open reports", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: "<p>bad stuff</p>" });
    const adm = await admin();
    // A viewer already has the content open, and another has a fresh token in hand.
    const { cookie } = await enterContent(p.id);
    const pending = await json(await call(`/api/v1/view/${p.id}`));
    const page = () => call(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie ?? "" } });
    expect((await page()).status).toBe(200);

    const r1 = await json(await report(p.id, { reason: "first" }));
    const r2 = await json(await report(p.id, { reason: "second" }));
    const before = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();

    const res = await adm.post(`/api/v1/admin/reports/${r1.id}`, { state: "actioned" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: r1.id, state: "actioned", artifact_id: p.id });

    const after = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(after?.takenDownAt).toBeTruthy();
    expect(after?.accessEpoch).toBe((before?.accessEpoch ?? 0) + 1);
    const other = await db().select().from(reports).where(eq(reports.id, r2.id)).get();
    expect(other?.state).toBe("actioned");
    expect(other?.decidedBy).toBe(adm.user.id);

    // Content stops immediately: the existing cookie, the pending token and new gates all fail.
    const gone = await page();
    expect(gone.status).toBe(404);
    expect(await gone.text()).not.toContain("bad stuff");
    expect((await call(pending.enter_url)).status).toBe(403);
    expect((await json(await call(`/api/v1/view/${p.slug}`))).status).toBe("taken_down");
    // Admins and the owner get no content token either; the source stays readable for review.
    expect((await json(await adm.get(`/api/v1/view/${p.id}`))).status).toBe("taken_down");
    // A taken-down artifact cannot be reported again.
    expect((await report(p.id, { reason: "again" })).status).toBe(403);

    // A decided report cannot be decided again.
    const twice = await adm.post(`/api/v1/admin/reports/${r1.id}`, { state: "dismissed" });
    expect(twice.status).toBe(409);
  });

  it("actioned: removes the artifact's staging attempts and their files, keeps its versions", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const ctx = serviceCtxFor(agentPrincipal(a));
    const stager = await openStager(ctx, await updateTarget(ctx, p.id, {}));
    await stager.add("index.html", new TextEncoder().encode("<p>in flight</p>"));
    await stager.finish();
    const rows = () =>
      env.DB.prepare("SELECT prefix FROM staging_attempts WHERE artifact_id = ?").bind(p.id).all();
    expect((await rows()).results).toHaveLength(1);
    const v1 = await db().select().from(versions).where(eq(versions.artifactId, p.id)).get();
    const live = await r2Keys(v1?.r2Prefix ?? "-");
    const adm = await admin();
    const r = await json(await report(p.id, { reason: "takedown wipe" }));
    expect((await adm.post(`/api/v1/admin/reports/${r.id}`, { state: "actioned" })).status).toBe(
      200,
    );
    expect((await rows()).results).toEqual([]);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await r2Keys(v1?.r2Prefix ?? "-")).toEqual(live);
  });

  it("actioned while R2 fails: the takedown completes and the sweep deletes the attempt's files", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const ctx = serviceCtxFor(agentPrincipal(a));
    const stager = await openStager(ctx, await updateTarget(ctx, p.id, {}));
    await stager.add("index.html", new TextEncoder().encode("<p>in flight</p>"));
    await stager.finish();
    const keys = await r2Keys(stager.prefix);
    expect(keys.length).toBe(1);
    const adm = await admin();
    const r1 = await json(await report(p.id, { reason: "one" }));
    const r2 = await json(await report(p.id, { reason: "two" }));
    const FILES = new Proxy(env.FILES, {
      get(t, prop) {
        if (prop === "delete")
          return async () => {
            throw new Error("injected: R2 down");
          };
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const res = await adm.post(`/api/v1/admin/reports/${r1.id}`, { state: "actioned" }, { FILES });
    expect(res.status).toBe(200);
    expect((await db().select().from(reports).where(eq(reports.id, r2.id)).get())?.state).toBe(
      "actioned",
    );
    const art = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(art?.takenDownAt).toBeTruthy();
    // The row stays (it can no longer commit) until the files are gone.
    expect(await r2Keys(stager.prefix)).toEqual(keys);
    const ctl = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: STAGING_SWEEP_CRON }),
      env as never,
      ctl,
    );
    await waitOnExecutionContext(ctl);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(
      (
        await env.DB.prepare("SELECT prefix FROM staging_attempts WHERE artifact_id = ?")
          .bind(p.id)
          .all()
      ).results,
    ).toEqual([]);
  });

  it("dismissed: closes only that report, the artifact stays up", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const adm = await admin();
    const r1 = await json(await report(p.id, { reason: "meh" }));
    const r2 = await json(await report(p.id, { reason: "meh too" }));
    const res = await adm.post(`/api/v1/admin/reports/${r1.id}`, { state: "dismissed" });
    expect(res.status).toBe(200);
    expect((await json(res)).state).toBe("dismissed");
    expect((await db().select().from(reports).where(eq(reports.id, r2.id)).get())?.state).toBe(
      "open",
    );
    const row = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(row?.takenDownAt).toBeNull();
    expect((await json(await call(`/api/v1/view/${p.id}`))).status).toBe("ok");
    expect((await adm.post(`/api/v1/admin/reports/${r1.id}`, { state: "open" })).status).toBe(400);
    expect((await adm.post(`/api/v1/admin/reports/nope`, { state: "dismissed" })).status).toBe(404);
  });

  it("non-admins get 404 on every admin endpoint", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { id } = await json(await report(p.id, { reason: "x" }));
    const adm = await admin();
    const user = await createUser();
    const s = await browserSession(user.id);
    // Flagged admin in the database but no longer in ADMIN_EMAIL (the default config has none).
    const formerAdmin = await browserSession(adm.user.id);
    const callers: {
      name: string;
      headers: Record<string, string>;
      vars?: Record<string, string>;
    }[] = [
      { name: "anonymous", headers: anonymous() },
      { name: "signed-in user", headers: s.headers },
      { name: "agent token of a user", headers: a.auth },
      {
        name: "agent token of the admin",
        headers: (await adminToken(adm.user.id)).auth,
        vars: adm.vars,
      },
      { name: "former admin", headers: formerAdmin.headers },
    ];
    for (const caller of callers) {
      const list = await run("/api/v1/admin/reports", { headers: caller.headers }, caller.vars);
      expect(list.status, caller.name).toBe(404);
      const decide = await run(
        `/api/v1/admin/reports/${id}`,
        {
          method: "POST",
          headers: { ...caller.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ state: "actioned" }),
        },
        caller.vars,
      );
      expect(decide.status, caller.name).toBe(404);
    }
    const row = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(row?.takenDownAt).toBeNull();
  });
});

async function adminToken(userId: string) {
  const { createToken } = await import("./helpers.ts");
  const t = await createToken(userId);
  return { auth: { Authorization: `Bearer ${t.token}` } };
}
