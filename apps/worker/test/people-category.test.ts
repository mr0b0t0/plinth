// The people list with category sharing (docs/spec.md "The people list"): the people an artifact
// reaches through its shared category are on it, once each at their highest role, exactly when
// policy.ts categoryRoleOf lets their grant count, under the same name rule and the same refusals
// as direct grantees. With ALLOW_CATEGORY_SHARING off the list is the direct grants alone.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { accessListSql } from "../src/services/people.ts";
import { owner, person, shareCategory } from "./category-helpers.ts";
import { call, fetchWith, json, mcpClient, publish, tool } from "./helpers.ts";
import { api, peoplePage, SECRET, setName } from "./people-helpers.ts";
import { cookieFor, grant } from "./room-helpers.ts";

const OFF = { ALLOW_CATEGORY_SHARING: "false" };

type Owner = Awaited<ReturnType<typeof owner>>;

interface Listed {
  /** REST and the summary name it viewer_id; the page route, id. */
  viewer_id?: string;
  id?: string;
  email: string;
  name: string | null;
  role: string;
}

/** A page that lists its people, filed under `category` by the owner's agent. */
async function peopleArtifact(o: Owner, category: string, title = "Team") {
  const { res, body } = await publish(o.auth, {
    title,
    category,
    visibility: "allowlist",
    html: peoplePage(),
  });
  expect(res.status).toBe(201);
  return body.id as string;
}

/** GET /api/v1/artifacts/:id/people with the owner's account-wide token. */
async function restPeople(o: Owner, id: string, vars?: Record<string, string>) {
  const init = { headers: o.auth };
  const path = `/api/v1/artifacts/${id}/people`;
  const res = vars ? await fetchWith(vars, path, init) : await call(path, init);
  expect(res.status).toBe(200);
  return (await json(res)) as { people: Listed[]; total: number };
}

const emailsRoles = (people: Listed[]) => people.map((p) => [p.email, p.role]);

/** [email, role] pairs in the list's order after the owner: by email. */
const byEmail = (pairs: string[][]) =>
  [...pairs].sort((a, b) => ((a[0] ?? "") < (b[0] ?? "") ? -1 : 1));

/**
 * The owner (named), and three people: `cv` on the share as a viewer only, `cc` on it as a
 * commenter with a direct viewer grant, `ce` on it as a viewer with a direct editor grant. `team`
 * is reviewed as shared into the share; `kept`, in the same category, is reviewed as private.
 */
async function sharedSetup() {
  const o = await owner();
  expect((await setName(o.user.id, "Olive Owner")).status).toBe(200);
  const team = await peopleArtifact(o, "Acme");
  const kept = await peopleArtifact(o, "Acme", "Kept");
  const cv = await person();
  const cc = await person();
  const ce = await person();
  for (const [p, name] of [
    [cv, "Vi Viewer"],
    [cc, "Cy Commenter"],
    [ce, "Ed Editor"],
  ] as const) {
    expect((await setName(p.user.id, name)).status).toBe(200);
  }
  await grant(team, cc.email, "viewer");
  await grant(team, ce.email, "editor");
  const made = await shareCategory(
    o,
    "Acme",
    [
      { email: cv.email, role: "viewer" },
      { email: cc.email, role: "commenter" },
      { email: ce.email, role: "viewer" },
    ],
    (r) => r.id === team,
  );
  return { o, team, kept, cv, cc, ce, shareId: made.share.id };
}

describe("the people list: people on a shared category", () => {
  it("lists a category grantee, each person once at their highest role, on every way to read it", async () => {
    const s = await sharedSetup();
    const grantees = byEmail([
      [s.cv.email, "viewer"],
      [s.cc.email, "commenter"],
      [s.ce.email, "editor"],
    ]);
    const rest = await restPeople(s.o, s.team);
    // The owner first, then by email: the category viewer, the commenter whose category role beats
    // a direct viewer grant, and the editor whose direct grant beats a category viewer.
    expect(emailsRoles(rest.people)).toEqual([[s.o.user.email, "owner"], ...grantees]);
    expect(rest.total).toBe(4);
    expect(rest.people.find((p) => p.email === s.cv.email)?.viewer_id).toBe(
      await viewerIdFor(SECRET, s.team, s.cv.email),
    );

    // The page's own route and the agent's summary list exactly the same people.
    const cookie = await cookieFor(s.team, s.o.session);
    const page = await json(await api(s.team, "/people", { cookie }));
    expect(emailsRoles(page.people)).toEqual(emailsRoles(rest.people));
    expect(page.total).toBe(4);
    const c = await mcpClient(s.o.token);
    const summary = await tool(c, "list_artifact_data", { id: s.team });
    await c.close();
    expect(summary.isError, summary.text).toBe(false);
    expect(emailsRoles(summary.data.people)).toEqual(emailsRoles(rest.people));
    // /people/<id> finds a category grantee by their u_ id.
    const cvId = await viewerIdFor(SECRET, s.team, s.cv.email);
    const one = await json(await api(s.team, `/people/${cvId}`, { cookie }));
    expect(one).toMatchObject({ id: cvId, email: s.cv.email, role: "viewer" });

    // A search runs over the same list.
    const found = await json(
      await call(`/api/v1/artifacts/${s.team}/people?q=${encodeURIComponent(s.cv.email)}`, {
        headers: s.o.auth,
      }),
    );
    expect(emailsRoles(found.people)).toEqual([[s.cv.email, "viewer"]]);
  });

  it("names a category grantee only once they have taken part, as for direct grantees", async () => {
    const s = await sharedSetup();
    const names = async () =>
      Object.fromEntries((await restPeople(s.o, s.team)).people.map((p) => [p.email, p.name]));
    expect(await names()).toEqual({
      [s.o.user.email]: "Olive Owner",
      [s.cv.email]: null,
      [s.cc.email]: null,
      [s.ce.email]: null,
    });
    // The category commenter enters something through the page (their pass comes from the share).
    const cookie = await cookieFor(s.team, s.cc.session);
    const w = await api(s.team, "/data/signups/~me", { cookie, body: { data: { yes: true } } });
    expect(w.status).toBe(201);
    expect(await names()).toMatchObject({ [s.cc.email]: "Cy Commenter", [s.cv.email]: null });
    // The reader's own row carries their name: the editor reads the list as themselves.
    const edCookie = await cookieFor(s.team, s.ce.session);
    const seen = await json(await api(s.team, "/people", { cookie: edCookie }));
    expect(seen.people.find((p: Listed) => p.email === s.ce.email).name).toBe("Ed Editor");
    expect(seen.people.find((p: Listed) => p.email === s.cv.email).name).toBeNull();
  });

  it("leaves out the share's people on an artifact not reviewed as shared into it", async () => {
    const s = await sharedSetup();
    // Reviewed as private.
    expect(emailsRoles((await restPeople(s.o, s.kept)).people)).toEqual([
      [s.o.user.email, "owner"],
    ]);
    // Filed under the shared category after it was shared: pending, never reviewed.
    const pending = await peopleArtifact(s.o, "Acme", "Filed later");
    const row = await env.DB.prepare("SELECT category_review FROM artifacts WHERE id = ?1")
      .bind(pending)
      .first<{ category_review: string | null }>();
    expect(row?.category_review).toBeNull();
    expect(emailsRoles((await restPeople(s.o, pending)).people)).toEqual([
      [s.o.user.email, "owner"],
    ]);
    // Moved out of the category: the review resets, and the people go with it.
    const moved = await call(`/api/v1/artifacts/${s.team}`, {
      method: "PATCH",
      headers: { ...s.o.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ category: "Elsewhere" }),
    });
    expect(moved.status).toBe(200);
    // Direct grants stay: the commenter's direct viewer grant and the editor's.
    expect(emailsRoles((await restPeople(s.o, s.team)).people)).toEqual([
      [s.o.user.email, "owner"],
      ...byEmail([
        [s.cc.email, "viewer"],
        [s.ce.email, "editor"],
      ]),
    ]);
  });

  it("never counts a share owned by someone else, even one the review names", async () => {
    const o = await owner();
    const team = await peopleArtifact(o, "Acme");
    // Another owner shares their own "Acme" with someone.
    const other = await owner();
    await peopleArtifact(other, "Acme", "Theirs");
    const stranger = await person();
    const theirs = await shareCategory(other, "Acme", [
      { email: stranger.email, role: "commenter" },
    ]);
    // A hand-edited review on the first owner's artifact naming the other owner's share, on the
    // same key: categoryRoleOf's owner binding refuses it, and the loader never fetches it.
    await env.DB.prepare(
      "UPDATE artifacts SET category_review = 'shared', category_review_share = ?1 WHERE id = ?2",
    )
      .bind(theirs.share.id, team)
      .run();
    const listed = await restPeople(o, team);
    expect(emailsRoles(listed.people)).toEqual([[o.user.email, "owner"]]);
    expect(JSON.stringify(listed)).not.toContain(stranger.email);
  });

  it("with ALLOW_CATEGORY_SHARING off, lists the direct grants alone, as before", async () => {
    const s = await sharedSetup();
    const direct = byEmail([
      [s.cc.email, "viewer"],
      [s.ce.email, "editor"],
    ]);
    const rest = await restPeople(s.o, s.team, OFF);
    expect(emailsRoles(rest.people)).toEqual([[s.o.user.email, "owner"], ...direct]);
    expect(rest.total).toBe(3);
    expect(JSON.stringify(rest)).not.toContain(s.cv.email);
    const c = await mcpClient(s.o.token, OFF);
    const summary = await tool(c, "list_artifact_data", { id: s.team });
    await c.close();
    expect(emailsRoles(summary.data.people)).toEqual(emailsRoles(rest.people));
    const cookie = await cookieFor(s.team, s.o.session);
    const page = await json(await api(s.team, "/people", { cookie, vars: OFF }));
    expect(emailsRoles(page.people)).toEqual(emailsRoles(rest.people));
    // Off, the statement never reads a share or its grants.
    expect(accessListSql(false)).not.toMatch(/category_shares|category_grants/);
  });
});

describe("the people list with category grantees: the refusals hold", () => {
  async function boundToken(o: Owner, artifact: string) {
    const res = await call("/api/v1/connections", {
      method: "POST",
      headers: { ...o.session, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "CI: team", artifact }),
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(201);
    return { token: body.token as string, auth: { Authorization: `Bearer ${body.token}` } };
  }

  it("a token limited to the artifact gets token_bound, and learns no grantee", async () => {
    const s = await sharedSetup();
    const t = await boundToken(s.o, s.team);
    const res = await call(`/api/v1/artifacts/${s.team}/people`, { headers: t.auth });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.details.reason).toBe("token_bound");
    for (const p of [s.cv, s.cc, s.ce]) expect(JSON.stringify(body)).not.toContain(p.email);
    const c = await mcpClient(t.token);
    const summary = await tool(c, "list_artifact_data", { id: s.team });
    await c.close();
    expect(summary.data.error.details.reason).toBe("token_bound");
    expect(summary.text).not.toContain(s.cv.email);
  });

  it("once such a token has published a version, the page lists nobody, category grantees included", async () => {
    const s = await sharedSetup();
    const t = await boundToken(s.o, s.team);
    const c = await mcpClient(t.token);
    const up = await tool(c, "update_artifact", {
      id: s.team,
      html: peoplePage().replace("<p>team</p>", "<p>team v2</p>"),
      base_version: 1,
    });
    expect(up.isError, up.text).toBe(false);
    await c.close();
    const res = await call(`/api/v1/artifacts/${s.team}/people`, { headers: s.o.auth });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.message).toMatch(/token limited to one artifact/);
    expect(JSON.stringify(body)).not.toContain(s.cv.email);
    const owners = await mcpClient(s.o.token);
    const summary = await tool(owners, "list_artifact_data", { id: s.team });
    await owners.close();
    expect(summary.data.people).toBeUndefined();
    expect(summary.text).not.toContain(s.cv.email);
  });
});

describe("the access list statement", () => {
  it("reaches every table by key, with category sharing on and off", async () => {
    for (const sharing of [true, false]) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${accessListSql(sharing)}`)
        .bind("a_plan")
        .all<{ detail: string }>();
      const details = results.map((r) => r.detail);
      // No table is scanned; a scan of the UNION's own rows (its subquery) is no table.
      expect(
        details.filter((d) => /^SCAN /.test(d) && !/^SCAN \(subquery|^SCAN CONSTANT/.test(d)),
        details.join(" | "),
      ).toEqual([]);
      if (sharing) {
        expect(details.join(" | ")).toMatch(/category_shares/);
        expect(details.join(" | ")).toMatch(/SEARCH cg USING (INDEX|PRIMARY KEY)/);
      }
    }
  });
});
