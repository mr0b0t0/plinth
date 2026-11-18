// The people list on an artifact's own content origin (/__plinth/api/v1/people): the dispatcher's
// caller checks, then availability, the pass, the declaration, policy and the rate limit, in
// order; what owners and editors see; and that nobody else sees anything. Cookies are minted
// through the real gate and enter flow; previews and captures are signed as Plinth signs them.
import { env } from "cloudflare:workers";
import { RATE_LIMITS } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { contentCookieName } from "../src/content/serve.ts";
import { signContentCookie } from "../src/content/tokens.ts";
import { accessGrants, artifacts } from "../src/db/schema.ts";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { browserSession, call, config, contentOrigin, db, json, publish } from "./helpers.ts";
import { api, errOf, holder, peoplePage, SECRET, setName } from "./people-helpers.ts";
import { cookieFor, grant, setup } from "./room-helpers.ts";

function noCors(res: Response, label = "") {
  for (const [k] of res.headers) {
    expect(k.startsWith("access-control-"), `${label} ${k}`).toBe(false);
  }
}

/** Every people response: JSON, no-store, the content CSP and no CORS. */
function contentHeaders(res: Response, label = "") {
  expect(res.headers.get("content-type"), label).toBe("application/json; charset=utf-8");
  expect(res.headers.get("cache-control"), label).toBe("no-store");
  const csp = res.headers.get("content-security-policy");
  // Under opaque isolation the CSP adds its sandbox; it is always there.
  if (csp?.includes("sandbox")) expect(csp, label).toContain(contentCsp(config()).split(";")[0]);
  else expect(csp, label).toBe(contentCsp(config()));
  noCors(res, label);
}

async function refused(res: Response, status: number, code: string, reason?: string) {
  const label = `${status} ${code} ${reason ?? ""}`;
  expect(res.status, label).toBe(status);
  contentHeaders(res, label);
  const e = await errOf(res);
  expect(e.code, label).toBe(code);
  if (reason !== undefined) expect(e.details?.reason, label).toBe(reason);
}

async function epochOf(id: string): Promise<number> {
  const row = await db().select().from(artifacts).where(eq(artifacts.id, id)).get();
  return row?.accessEpoch ?? 0;
}

async function passCookie(id: string, kind: "preview" | "capture"): Promise<string> {
  const value = await signContentCookie(
    config(),
    id,
    await epochOf(id),
    undefined,
    kind,
    kind === "preview" ? 1 : undefined,
  );
  return `${contentCookieName(config(), new URL(contentOrigin(id)))}=${value}`;
}

describe("people list: the checks, in order", () => {
  it("1 to 4: method, header, fetch metadata and Origin, never with CORS", async () => {
    const { id, ownerP } = await setup(peoplePage());
    for (const path of ["/people", `/people/${await viewerIdFor(SECRET, id, ownerP.email)}`]) {
      const preflight = await api(id, path, { method: "OPTIONS", cookie: ownerP.cookie });
      expect(preflight.status, path).toBe(405);
      noCors(preflight, path);
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await api(id, path, { method, cookie: ownerP.cookie, body: { data: {} } });
        expect(res.status, `${method} ${path}`).toBe(405);
        noCors(res);
      }
      await refused(
        await api(id, path, { cookie: ownerP.cookie, headers: { "x-plinth-data": null } }),
        403,
        "forbidden",
      );
      await refused(
        await api(id, path, { cookie: ownerP.cookie, headers: { "sec-fetch-site": "same-site" } }),
        403,
        "forbidden",
      );
      for (const origin of [contentOrigin("b".repeat(20)), "null"]) {
        await refused(
          await api(id, path, { cookie: ownerP.cookie, headers: { origin } }),
          403,
          "forbidden",
        );
      }
    }
  });

  it("5: opaque isolation and shared data off, before any cookie is read", async () => {
    const { id, ownerP } = await setup(peoplePage());
    for (const cookie of [ownerP.cookie, null]) {
      await refused(
        await api(id, "/people", { cookie, vars: { CONTENT_ISOLATION: "opaque" } }),
        403,
        "feature_disabled",
        "opaque_isolation",
      );
      await refused(
        await api(id, "/people", { cookie, vars: { ALLOW_SHARED_DATA: "false" } }),
        403,
        "feature_disabled",
        "disabled",
      );
    }
  });

  it("7 and 8: a missing or taken-down artifact is 404, a missing or stale pass 401", async () => {
    const { id, ownerP } = await setup(peoplePage());
    await refused(
      await api("z".repeat(20), "/people", { cookie: ownerP.cookie }),
      404,
      "not_found",
    );
    await refused(await api(id, "/people"), 401, "unauthorized", "expired");
    // A grant change bumps the epoch: the old pass stops at once.
    const before = ownerP.cookie;
    await call(`/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [{ email: "late@example.com", role: "viewer" }] }),
    });
    await refused(await api(id, "/people", { cookie: before }), 401, "unauthorized", "expired");
    // Taken down: gone, whoever asks.
    const fresh = await cookieFor(id, ownerP.session.headers);
    expect((await api(id, "/people", { cookie: fresh })).status).toBe(200);
    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, id))
      .run();
    await refused(await api(id, "/people", { cookie: fresh }), 404, "not_found");
  });

  it("9 and 11: previews, captures and link viewers learn nothing", async () => {
    const { owner, id } = await setup(peoplePage());
    await refused(
      await api(id, "/people", { cookie: await passCookie(id, "preview") }),
      403,
      "feature_disabled",
      "preview",
    );
    await refused(
      await api(id, "/people", { cookie: await passCookie(id, "capture") }),
      403,
      "feature_disabled",
      "not_identified",
    );
    // An unlisted copy opened by a link viewer: a pass without a claim.
    const { body } = await publish(owner.auth, { html: peoplePage(), visibility: "unlisted" });
    const anon = await cookieFor(body.id);
    await refused(
      await api(body.id, "/people", { cookie: anon }),
      403,
      "feature_disabled",
      "not_identified",
    );
    // The session agrees: no list for them.
    expect((await json(await api(body.id, "/session", { cookie: anon }))).can_list_people).toBe(
      false,
    );
  });

  it("12: a page that does not declare `people` (or `viewer`) has no list", async () => {
    for (const html of [peoplePage({ people: false }), peoplePage({ viewer: false })]) {
      const { id, ownerP } = await setup(html);
      await refused(
        await api(id, "/people", { cookie: ownerP.cookie }),
        403,
        "feature_disabled",
        "not_declared",
      );
      expect(
        (await json(await api(id, "/session", { cookie: ownerP.cookie }))).can_list_people,
      ).toBe(false);
    }
    // `people` without `data` declares nothing: a room page has no session and no list.
    const { id, ownerP } = await setup(`<!doctype html><title>Board</title>
<meta name="plinth-capabilities" content="room viewer people"><p>board</p>`);
    await refused(
      await api(id, "/people", { cookie: ownerP.cookie }),
      403,
      "feature_disabled",
      "not_declared",
    );
  });

  it("13: commenters and viewers are refused; owners and editors are not", async () => {
    const { id, ownerP } = await setup(peoplePage());
    for (const role of ["commenter", "viewer"] as const) {
      const p = await holder(id, role);
      await refused(await api(id, "/people", { cookie: p.cookie }), 403, "forbidden");
      await refused(await api(id, `/people/${p.viewerId}`, { cookie: p.cookie }), 403, "forbidden");
      expect((await json(await api(id, "/session", { cookie: p.cookie }))).can_list_people).toBe(
        false,
      );
    }
    const ed = await holder(id, "editor");
    expect((await api(id, "/people", { cookie: ed.cookie })).status).toBe(200);
    expect((await json(await api(id, "/session", { cookie: ed.cookie }))).can_list_people).toBe(
      true,
    );
    expect((await json(await api(id, "/session", { cookie: ownerP.cookie }))).can_list_people).toBe(
      true,
    );
  });

  it("an editor demoted to viewer is refused on the next pass", async () => {
    const { id } = await setup(peoplePage());
    const ed = await holder(id, "editor");
    expect((await api(id, "/people", { cookie: ed.cookie })).status).toBe(200);
    await grant(id, ed.email, "viewer");
    // A role change through SQL keeps the epoch; the sharing API bumps it (tested above).
    await db()
      .update(artifacts)
      .set({ accessEpoch: (await epochOf(id)) + 1 })
      .where(eq(artifacts.id, id))
      .run();
    await refused(await api(id, "/people", { cookie: ed.cookie }), 401, "unauthorized", "expired");
    const s = await browserSession(ed.userId as string);
    const again = await cookieFor(id, s.headers);
    await refused(await api(id, "/people", { cookie: again }), 403, "forbidden");
  });

  it("14: a rate limit per reader, with Retry-After", async () => {
    const { id, ownerP } = await setup(peoplePage());
    const hour = Math.floor(Date.now() / 1000);
    const windowStart = hour - (hour % 3600);
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3) ON CONFLICT (key, window_start) DO UPDATE SET count = ?3",
    )
      .bind(`people:${id}:${ownerP.email}`, windowStart, RATE_LIMITS.peopleReadsPerViewerPerHour)
      .run();
    const res = await api(id, "/people", { cookie: ownerP.cookie });
    expect(res.status).toBe(429);
    contentHeaders(res);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await errOf(res)).code).toBe("rate_limited");
  });
});

describe("people list: what owners and editors see", () => {
  it("the owner first, then grants by email, with u_ ids, names, roles and `you`", async () => {
    const { id, ownerP } = await setup(peoplePage());
    expect((await setName(ownerP.userId, "  Ana   Owner ")).status).toBe(200);
    const ed = await holder(id, "editor", "Bo Editor");
    const vw = await holder(id, "viewer");
    // A confirmed-by-code address with no account: on the list, without a name.
    await grant(id, "zed-no-account@example.com", "commenter");
    // A grant on the owner's own address (only possible by hand) is not listed twice.
    await db()
      .insert(accessGrants)
      .values({ artifactId: id, email: ownerP.email, role: "viewer", createdAt: "2026-11-19" })
      .onConflictDoNothing()
      .run();
    const res = await api(id, "/people", { cookie: ownerP.cookie });
    expect(res.status).toBe(200);
    contentHeaders(res);
    const body = await json(res);
    const grants = [
      { id: ed.viewerId, email: ed.email, name: "Bo Editor", role: "editor", you: false },
      { id: vw.viewerId, email: vw.email, name: null, role: "viewer", you: false },
      {
        id: await viewerIdFor(SECRET, id, "zed-no-account@example.com"),
        email: "zed-no-account@example.com",
        name: null,
        role: "commenter",
        you: false,
      },
    ].sort((a, b) => (a.email < b.email ? -1 : 1));
    expect(body).toEqual({
      people: [
        {
          id: await viewerIdFor(SECRET, id, ownerP.email),
          email: ownerP.email,
          name: "Ana Owner",
          role: "owner",
          you: true,
        },
        ...grants,
      ],
      total: 4,
    });
    // The editor sees the same list, with their own row marked.
    const seen = await json(await api(id, "/people", { cookie: ed.cookie }));
    expect(
      seen.people.filter((p: { you: boolean }) => p.you).map((p: { id: string }) => p.id),
    ).toEqual([ed.viewerId]);
  });

  it("q matches every term in names and emails, ignoring case; limit and total", async () => {
    const { id, ownerP } = await setup(peoplePage());
    await setName(ownerP.userId, "Ana Owner");
    const ed = await holder(id, "editor", "Bo Editor");
    await holder(id, "viewer", "Cy Viewer");
    const q = async (query: string) =>
      json(await api(id, `/people?${query}`, { cookie: ownerP.cookie }));
    expect((await q("q=bo")).people.map((p: { id: string }) => p.id)).toEqual([ed.viewerId]);
    expect((await q("q=EDITOR%20bo")).people.map((p: { id: string }) => p.id)).toEqual([
      ed.viewerId,
    ]);
    expect((await q(`q=${encodeURIComponent(ed.email.toUpperCase())}`)).total).toBe(1);
    expect((await q("q=bo%20nobody")).people).toEqual([]);
    expect((await q("q=example.com")).total).toBe(3);
    const limited = await q("q=example.com&limit=1");
    expect(limited.people).toHaveLength(1);
    expect(limited.total).toBe(3);
    for (const bad of [`q=${"x".repeat(101)}`, "limit=0", "limit=202", "limit=a"]) {
      const res = await api(id, `/people?${bad}`, { cookie: ownerP.cookie });
      expect(res.status, bad).toBe(400);
      contentHeaders(res);
    }
  });

  it("/people/<id>: a person with access now, else 404", async () => {
    const { id, ownerP } = await setup(peoplePage());
    const ed = await holder(id, "editor", "Bo Editor");
    const one = await api(id, `/people/${ed.viewerId}`, { cookie: ownerP.cookie });
    expect(one.status).toBe(200);
    contentHeaders(one);
    expect(await json(one)).toEqual({
      id: ed.viewerId,
      email: ed.email,
      name: "Bo Editor",
      role: "editor",
      you: false,
    });
    // A malformed id, an id from another artifact, and a removed grant: not found.
    const other = await viewerIdFor(SECRET, "q".repeat(20), ed.email);
    for (const bad of ["u_nothex", "u_0123", other, "not-an-id"]) {
      await refused(await api(id, `/people/${bad}`, { cookie: ownerP.cookie }), 404, "not_found");
    }
    await db().delete(accessGrants).where(eq(accessGrants.email, ed.email)).run();
    await refused(
      await api(id, `/people/${ed.viewerId}`, { cookie: ownerP.cookie }),
      404,
      "not_found",
    );
  });

  it("republishing without `people` switches the list off at once", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    expect((await api(id, "/people", { cookie: ownerP.cookie })).status).toBe(200);
    const res = await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: peoplePage({ people: false }), base_version: 1 }),
    });
    expect(res.status).toBe(200);
    await refused(
      await api(id, "/people", { cookie: ownerP.cookie }),
      403,
      "feature_disabled",
      "not_declared",
    );
  });
});
