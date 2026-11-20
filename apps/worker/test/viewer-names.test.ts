// Display names (docs/spec.md "Who is viewing: names and the people list"): the write rules on
// PATCH /api/v1/me, and the name a page sees wherever it sees an email (the session, document
// authors), read live from users.name, cleaned on read, and never for link viewers. Also what
// owners' and editors' agents and the owner's sharing settings get, and what the live viewer
// tells the viewer. Cookies are minted through the real gate and enter flow.
import { env } from "cloudflare:workers";
import { RATE_LIMITS, type ViewGate } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { eraseUserSql } from "../scripts/admin-lib.mjs";
import { viewerIdFor } from "../src/lib/crypto.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  createUser,
  json,
  mcpClient,
  publish,
  spy,
  tool,
} from "./helpers.ts";
import { api, holder, peoplePage, SECRET, setName, storeRawName } from "./people-helpers.ts";
import { cookieFor, grant, roomPage, run, sealedCookie, setup } from "./room-helpers.ts";

async function stored(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT name FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ name: string | null }>();
  return row?.name ?? null;
}

async function gateOf(id: string, headers: Record<string, string>) {
  return json<Extract<ViewGate, { status: "ok" }>>(await call(`/api/v1/view/${id}`, { headers }));
}

describe("PATCH /me: display name rules", () => {
  it("normalises, refuses @, control, bidi and zero-width characters, and '' clears", async () => {
    const u = await createUser();
    const ok = await setName(u.id, "  Ana\t\n  Lima  ");
    expect(ok.status).toBe(200);
    expect((await json(ok)).name).toBe("Ana Lima");
    expect(await stored(u.id)).toBe("Ana Lima");
    // NFC: a decomposed é is stored composed.
    await setName(u.id, "José");
    expect(await stored(u.id)).toBe("José");
    for (const bad of [
      "ana@example.com",
      "ana\uFF20example.com",
      "ana\uFE6Bexample.com",
      "Ana‮Owner",
      "An​a",
      "Ana\u0007",
      "x".repeat(101),
    ]) {
      const res = await setName(u.id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      // The reason, as one sentence: the same the app shows before it sends.
      expect((await json(res)).error.message, JSON.stringify(bad)).toMatch(/^A name .*\.$/);
    }
    for (const blank of ["\u3164", "\u115F", "\u1160", "\uFFA0", "\u2800", "\u0301\u0302"]) {
      const res = await setName(u.id, blank);
      expect(res.status, JSON.stringify(blank)).toBe(400);
      expect((await json(res)).error.message).toBe(
        "A name needs a letter, number or symbol you can see.",
      );
    }
    expect(await stored(u.id)).toBe("José");
    expect((await setName(u.id, "   ")).status).toBe(200);
    expect(await stored(u.id)).toBeNull();
  });
});

describe("names on the page", () => {
  it("the session has viewer.name with `viewer`, null without, and no viewer for link viewers", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    await setName(ownerP.userId, "Ana Owner");
    const s = await json(await api(id, "/session", { cookie: ownerP.cookie }));
    expect(s.viewer).toEqual({
      id: await viewerIdFor(SECRET, id, ownerP.email),
      email: ownerP.email,
      name: "Ana Owner",
      role: "owner",
    });
    const plain = await publish(owner.auth, {
      html: peoplePage({ viewer: false, people: false }),
      visibility: "allowlist",
    });
    const pc = await cookieFor(plain.body.id, ownerP.session.headers);
    expect((await json(await api(plain.body.id, "/session", { cookie: pc }))).viewer).toMatchObject(
      { email: null, name: null, role: "owner" },
    );
    const link = await publish(owner.auth, { html: peoplePage(), visibility: "unlisted" });
    const anon = await cookieFor(link.body.id);
    expect((await json(await api(link.body.id, "/session", { cookie: anon }))).viewer).toBeNull();
  });

  it("a viewer confirmed by code has no name without an account, and the account's with one", async () => {
    const { id } = await setup(peoplePage());
    const email = `coded-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await grant(id, email, "viewer");
    const cookie = await sealedCookie(id, email, "viewer", false);
    expect((await json(await api(id, "/session", { cookie }))).viewer.name).toBeNull();
    const later = await createUser(email);
    await setName(later.id, "Cy Coded");
    expect((await json(await api(id, "/session", { cookie }))).viewer.name).toBe("Cy Coded");
  });

  it("documents carry authors' names, renames show on the next read, erase-user clears them", async () => {
    const { id, ownerP } = await setup(peoplePage());
    const a = await holder(id, "commenter", "Al Writer");
    const e = await holder(id, "editor", "Ed Changer");
    const created = await api(id, "/data/notes/n1", { cookie: a.cookie, body: { data: { t: 1 } } });
    expect(created.status).toBe(201);
    expect((await json(created)).created_by).toEqual({
      email: a.email,
      name: "Al Writer",
      role: "commenter",
      via: "page",
    });
    await api(id, "/data/notes/n1", { cookie: e.cookie, body: { data: { t: 2 } } });
    const read = async () => json(await api(id, "/data/notes/n1", { cookie: ownerP.cookie }));
    expect((await read()).updated_by).toMatchObject({ email: e.email, name: "Ed Changer" });
    // Rename: the next read shows it, with nothing rewritten in the data.
    await setName(e.userId as string, "Ed Renamed");
    expect((await read()).updated_by.name).toBe("Ed Renamed");
    const listed = await json(await api(id, "/data/notes", { cookie: ownerP.cookie }));
    expect(listed.docs[0].created_by.name).toBe("Al Writer");
    expect(listed.docs[0].updated_by.name).toBe("Ed Renamed");
    // erase-user deletes the account: the name is gone everywhere.
    for (const stmt of eraseUserSql(e.email).split("; ")) await env.DB.prepare(stmt).all();
    expect((await read()).updated_by).toEqual({ email: null, name: null, role: null, via: "page" });
  });

  it("a name stored before the rules comes out cleaned, and cut at 64 code points", async () => {
    const { id, ownerP } = await setup(peoplePage());
    await storeRawName(ownerP.userId, "‮Ana​ Owner@home\u0007");
    expect((await json(await api(id, "/session", { cookie: ownerP.cookie }))).viewer.name).toBe(
      "Ana Ownerhome",
    );
    // Characters that render as "@" go too, so a stored name cannot pass for an address.
    await storeRawName(ownerP.userId, "boss\uFF20company\uFE6Bcom");
    expect((await json(await api(id, "/session", { cookie: ownerP.cookie }))).viewer.name).toBe(
      "bosscompanycom",
    );
    await storeRawName(ownerP.userId, "\u{1F600}".repeat(70));
    const long = (await json(await api(id, "/session", { cookie: ownerP.cookie }))).viewer.name;
    expect(Array.from(long)).toHaveLength(64);
    expect(long).toBe("\u{1F600}".repeat(64));
    // Nothing left after cleaning reads as no name.
    await storeRawName(ownerP.userId, "​​");
    expect(
      (await json(await api(id, "/session", { cookie: ownerP.cookie }))).viewer.name,
    ).toBeNull();
  });

  it("link viewers and pages without `viewer` get no authors and cause no users read", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    await setName(ownerP.userId, "Ana Owner");
    await api(id, "/data/notes/n1", { cookie: ownerP.cookie, body: { data: { t: 1 } } });
    const link = await publish(owner.auth, { html: peoplePage(), visibility: "unlisted" });
    const linkId = link.body.id as string;
    const oc = await cookieFor(linkId, ownerP.session.headers);
    await api(linkId, "/data/notes/n1", { cookie: oc, body: { data: { t: 1 } } });
    const anon = await cookieFor(linkId);
    const d1 = spy(env.DB);
    for (const path of ["/session", "/data/notes", "/data/notes/n1"]) {
      const res = await api(linkId, path, { cookie: anon, vars: { DB: d1.proxy } });
      expect(res.status, path).toBe(200);
      const body = await json(res);
      expect(JSON.stringify(body), path).not.toContain("Ana Owner");
      expect(JSON.stringify(body), path).not.toContain(ownerP.email);
    }
    const sql = d1.calls.filter((c) => c.method === "prepare").map((c) => String(c.arg));
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.some((s) => /\bFROM users\b/.test(s))).toBe(false);
  });
});

describe("names for agents, the owner and the viewer", () => {
  it("list_artifact_data: names on authors on any page, people in the summary only with `people`", async () => {
    const { owner, id, ownerP } = await setup(peoplePage({ people: false }));
    await setName(ownerP.userId, "Ana Owner");
    const ed = await holder(id, "editor", "Bo Editor");
    await api(id, "/data/notes/n1", { cookie: ed.cookie, body: { data: { t: 1 } } });
    const client = await mcpClient(owner.token);
    let sum = await tool(client, "list_artifact_data", { id });
    expect(sum.isError).toBe(false);
    // Without `people` the access list stays in the owner's sharing settings: no agent gets it.
    expect(sum.data).not.toHaveProperty("people");
    expect(sum.data.untrusted).toContain("Names are display text");
    const page = await tool(client, "list_artifact_data", { id, collection: "notes" });
    expect(page.data.docs[0].created_by).toMatchObject({
      email: ed.email,
      name: "Bo Editor",
      viewer_id: ed.viewerId,
    });
    const one = await tool(client, "list_artifact_data", { id, collection: "notes", doc_id: "n1" });
    expect(one.data.doc.updated_by.name).toBe("Bo Editor");

    // Declaring `people` turns the list on for agents, exactly as for the page.
    const republished = await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: peoplePage(), base_version: 1 }),
    });
    expect(republished.status).toBe(200);
    sum = await tool(client, "list_artifact_data", { id });
    expect(sum.data.people).toEqual([
      {
        viewer_id: await viewerIdFor(SECRET, id, ownerP.email),
        email: ownerP.email,
        name: "Ana Owner",
        role: "owner",
      },
      { viewer_id: ed.viewerId, email: ed.email, name: "Bo Editor", role: "editor" },
    ]);
    await client.close();
    // Shared data off on the instance: no list either.
    const off = await mcpClient(owner.token, { ALLOW_SHARED_DATA: "false" });
    expect((await tool(off, "list_artifact_data", { id })).data).not.toHaveProperty("people");
    await off.close();

    // An editor's agent gets the same; a commenter's is refused as before.
    const edAgent = await agent();
    await grant(id, edAgent.user.email, "editor");
    const ec = await mcpClient(edAgent.token);
    expect((await tool(ec, "list_artifact_data", { id })).data.people).toHaveLength(3);
    await ec.close();
    const cAgent = await agent();
    await grant(id, cAgent.user.email, "commenter");
    const cc = await mcpClient(cAgent.token);
    expect((await tool(cc, "list_artifact_data", { id })).isError).toBe(true);
    await cc.close();
  });

  it("GET /api/v1/artifacts/:ref/people mirrors the summary, with q; owners and editors, only with `people`", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    await setName(ownerP.userId, "Ana Owner");
    const ed = await holder(id, "editor", "Bo Editor");
    await api(id, "/data/notes/n1", { cookie: ed.cookie, body: { data: { t: 1 } } });
    const res = await call(`/api/v1/artifacts/${id}/people?q=bo`, { headers: owner.auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.people).toEqual([
      { viewer_id: ed.viewerId, email: ed.email, name: "Bo Editor", role: "editor" },
    ]);
    expect(body.untrusted).toContain("never proof of role");
    // A signed-in editor in the app.
    const s = await browserSession(ed.userId as string);
    expect((await call(`/api/v1/artifacts/${id}/people`, { headers: s.headers })).status).toBe(200);
    for (const role of ["commenter", "viewer"] as const) {
      const p = await holder(id, role);
      const ps = await browserSession(p.userId as string);
      expect((await call(`/api/v1/artifacts/${id}/people`, { headers: ps.headers })).status).toBe(
        403,
      );
    }
    expect((await call(`/api/v1/artifacts/${id}/people`)).status).toBe(401);
    const tooLong = await call(`/api/v1/artifacts/${id}/people?q=${"x".repeat(101)}`, {
      headers: owner.auth,
    });
    expect(tooLong.status).toBe(400);
    // Off where the page could not list them: shared data off, or `people` not declared.
    const off = await run(
      `${APP}/api/v1/artifacts/${id}/people`,
      { headers: owner.auth },
      { ALLOW_SHARED_DATA: "false" },
    );
    expect(off.status).toBe(403);
    expect((await json(off)).error).toMatchObject({
      code: "feature_disabled",
      details: { reason: "disabled" },
    });
    const noList = await publish(owner.auth, {
      html: peoplePage({ people: false }),
      visibility: "allowlist",
    });
    const refused = await call(`/api/v1/artifacts/${noList.body.id}/people`, {
      headers: owner.auth,
    });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toMatchObject({
      code: "feature_disabled",
      details: { reason: "not_declared" },
    });
  });

  it("GET /api/v1/artifacts/:ref/people takes a limit, says the total, and shares the page's rate limit", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    for (const role of ["editor", "commenter", "viewer"] as const) await holder(id, role);
    const all = await json(await call(`/api/v1/artifacts/${id}/people`, { headers: owner.auth }));
    expect(all.people).toHaveLength(4);
    expect(all.total).toBe(4);
    const two = await json(
      await call(`/api/v1/artifacts/${id}/people?limit=2`, { headers: owner.auth }),
    );
    expect(two.people).toEqual(all.people.slice(0, 2));
    expect(two.total).toBe(4);
    for (const bad of ["0", "202", "x", "1.5"]) {
      const res = await call(`/api/v1/artifacts/${id}/people?limit=${bad}`, {
        headers: owner.auth,
      });
      expect(res.status, bad).toBe(400);
    }
    // One bucket per reader per artifact, for the page and REST together.
    const hour = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3) ON CONFLICT (key, window_start) DO UPDATE SET count = ?3",
    )
      .bind(
        `people:${id}:${ownerP.email}`,
        hour - (hour % 3600),
        RATE_LIMITS.peopleReadsPerViewerPerHour,
      )
      .run();
    const limited = await call(`/api/v1/artifacts/${id}/people`, { headers: owner.auth });
    expect(limited.status).toBe(429);
    expect((await json(limited)).error.code).toBe("rate_limited");
    expect((await api(id, "/people", { cookie: ownerP.cookie })).status).toBe(429);
  });

  it("an address the owner adds says nothing about its account until its holder takes part", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    // Three accounts with names, which the owner knows only by address, and an address with none.
    const commenter = await createUser();
    const writer = await createUser();
    const publisher = await agent();
    await setName(commenter.id, "Cat Commenter");
    await setName(writer.id, "Wes Writer");
    await setName(publisher.user.id, "Pia Publisher");
    const put = await call(`/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        grants: [
          { email: commenter.email, role: "commenter" },
          { email: writer.email, role: "viewer" },
          { email: publisher.user.email, role: "editor" },
          { email: "nobody-yet@example.com", role: "viewer" },
        ],
      }),
    });
    expect(put.status).toBe(200);
    expect((await json(put)).grants.map((g: { name: string | null }) => g.name)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const ownerCookie = await cookieFor(id, ownerP.session.headers);
    const client = await mcpClient(owner.token);
    /** The name beside each address on every surface that lists access, which all agree. */
    const seen = async () => {
      const sharing = await json(
        await call(`/api/v1/artifacts/${id}/sharing`, { headers: ownerP.session.headers }),
      );
      const rest = await json(
        await call(`/api/v1/artifacts/${id}/people`, { headers: owner.auth }),
      );
      const page = await json(await api(id, "/people", { cookie: ownerCookie }));
      const sum = (await tool(client, "list_artifact_data", { id })).data;
      const of = (list: { email: string; name: string | null }[]) =>
        Object.fromEntries(
          list.filter((p) => p.email !== ownerP.email).map((p) => [p.email, p.name]),
        );
      const views = [of(sharing.grants), of(rest.people), of(page.people), of(sum.people)];
      for (const v of views.slice(1)) expect(v).toEqual(views[0]);
      return views[0];
    };
    const nobody = {
      [commenter.email]: null,
      [writer.email]: null,
      [publisher.user.email]: null,
      "nobody-yet@example.com": null,
    };
    expect(await seen()).toEqual(nobody);
    // A search cannot find a name the list keeps back.
    for (const q of ["cat", "wes", "pia publisher"]) {
      const onPage = await api(id, `/people?q=${encodeURIComponent(q)}`, { cookie: ownerCookie });
      expect((await json(onPage)).total, q).toBe(0);
      const rest = await call(`/api/v1/artifacts/${id}/people?q=${encodeURIComponent(q)}`, {
        headers: owner.auth,
      });
      expect((await json(rest)).people, q).toEqual([]);
    }

    // A comment, a shared-data entry and a version each show their author's name, and only theirs.
    const cs = await browserSession(commenter.id);
    const comment = await call(`/api/v1/artifacts/${id}/comments`, {
      method: "POST",
      headers: { ...cs.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Looks good" }),
    });
    expect(comment.status).toBe(201);
    expect(await seen()).toEqual({ ...nobody, [commenter.email]: "Cat Commenter" });
    const ws = await browserSession(writer.id);
    const wrote = await api(id, "/data/signups/~me", {
      cookie: await cookieFor(id, ws.headers),
      body: { data: { yes: true } },
    });
    expect(wrote.status).toBe(201);
    expect(await seen()).toEqual({
      ...nobody,
      [commenter.email]: "Cat Commenter",
      [writer.email]: "Wes Writer",
    });
    const published = await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...publisher.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: peoplePage(), base_version: 1 }),
    });
    expect(published.status).toBe(200);
    expect(await seen()).toEqual({
      ...nobody,
      [commenter.email]: "Cat Commenter",
      [writer.email]: "Wes Writer",
      [publisher.user.email]: "Pia Publisher",
    });
    await client.close();
  });

  it("the owner's sharing settings stay owner-only", async () => {
    const { id } = await setup(peoplePage());
    const ed = await holder(id, "editor", "Bo Editor");
    const es = await browserSession(ed.userId as string);
    expect((await call(`/api/v1/artifacts/${id}/sharing`, { headers: es.headers })).status).toBe(
      403,
    );
  });

  it("the gate tells an identified viewer their name and that the page lists people", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    let gate = await gateOf(id, ownerP.session.headers);
    expect(gate.people).toEqual({ list: true });
    await setName(ownerP.userId, "Ana Owner");
    gate = await gateOf(id, ownerP.session.headers);
    expect(gate.people).toEqual({ name: "Ana Owner", list: true });
    // A viewer is told too: their own address is on the list.
    const v = await holder(id, "viewer", "Vi Viewer");
    const vs = await browserSession(v.userId as string);
    expect((await gateOf(id, vs.headers)).people).toEqual({ name: "Vi Viewer", list: true });
    // Without `people`: the name only. Without `viewer`: nothing.
    const noList = await publish(owner.auth, {
      html: peoplePage({ people: false }),
      visibility: "allowlist",
    });
    expect((await gateOf(noList.body.id, ownerP.session.headers)).people).toEqual({
      name: "Ana Owner",
    });
    const noViewer = await publish(owner.auth, {
      html: peoplePage({ viewer: false, people: false }),
      visibility: "allowlist",
    });
    expect((await gateOf(noViewer.body.id, ownerP.session.headers)).people).toBeUndefined();
    // A live room that shows the email shows the name too.
    const room = await publish(owner.auth, { html: roomPage(), visibility: "allowlist" });
    expect((await gateOf(room.body.id, ownerP.session.headers)).people).toEqual({
      name: "Ana Owner",
    });
    // Link viewers: nothing.
    const link = await publish(owner.auth, { html: peoplePage(), visibility: "unlisted" });
    expect((await gateOf(link.body.id, {})).people).toBeUndefined();
  });
});

describe("names in the app and for agents: cleaned on every read, never the owner's mark", () => {
  /** An owner (an account-wide Claude token, a browser session) and a commenter, both named. */
  async function named(ownerName: string, commenterName: string) {
    const owner = await agent({ label: "Work Claude", clientType: "claude" });
    const browser = (await browserSession(owner.user.id)).headers;
    const jsonHeaders = { ...browser, "Content-Type": "application/json" };
    // v1 by the owner in person, so the version is labelled with the name.
    const res = await call("/api/v1/artifacts", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ title: "Notes", html: "<!doctype html><h1>Notes</h1>" }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const id = (await json(res)).id as string;
    const commenter = await createUser();
    await grant(id, commenter.email, "commenter");
    await storeRawName(owner.user.id, ownerName);
    await storeRawName(commenter.id, commenterName);
    const commenterBrowser = (await browserSession(commenter.id)).headers;
    const post = async (headers: Record<string, string>, body: string) => {
      const r = await call(`/api/v1/artifacts/${id}/comments`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      expect(r.status, await r.clone().text()).toBe(201);
      return json(r);
    };
    return { owner, browser, id, commenter, commenterBrowser, post };
  }

  it("a legacy name with U+202E and U+FF20 comes back cleaned from comments, mentions, summaries, versions and the gate", async () => {
    const s = await named("Ana\u202E Owner\uFF20home", "Bob\u202E \uFF20Lima");
    const posted = await s.post(s.commenterBrowser, "@claude please look");
    expect(posted.author.label).toBe("Bob Lima");
    const comments = await json(
      await call(`/api/v1/artifacts/${s.id}/comments`, { headers: s.browser }),
    );
    expect(comments.items.map((c: { author: { label: string } }) => c.author.label)).toEqual([
      "Bob Lima",
    ]);
    // MCP: list_comments, and list_mentions' comment_author.
    const c = await mcpClient(s.owner.token);
    const listed = await tool(c, "list_comments", { id: s.id });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).not.toMatch(/[\u202E\uFF20]/);
    const mentions = await tool(c, "list_mentions", {});
    expect(mentions.data.items[0].comment_author).toBe("Bob Lima");
    // The owner's name on summaries and the version label.
    const got = await tool(c, "get_artifact", { id: s.id });
    expect(got.data.owner.name).toBe("Ana Ownerhome");
    const listedArtifacts = await tool(c, "list_artifacts", {});
    expect(listedArtifacts.text).not.toMatch(/[\u202E\uFF20]/);
    const versions = await tool(c, "list_versions", { id: s.id });
    expect(versions.data.items[0].author.label).toBe("Ana Ownerhome");
    await c.close();
    const rest = await json(await call(`/api/v1/artifacts/${s.id}`, { headers: s.owner.auth }));
    expect(rest.owner.name).toBe("Ana Ownerhome");
    const restVersions = await json(
      await call(`/api/v1/artifacts/${s.id}/versions`, { headers: s.owner.auth }),
    );
    expect(JSON.stringify(restVersions)).not.toMatch(/[\u202E\uFF20]/);
    expect(JSON.stringify(restVersions)).toContain("Ana Ownerhome");
    // The gate names the owner to every viewer.
    expect((await gateOf(s.id, s.commenterBrowser)).artifact.owner_name).toBe("Ana Ownerhome");
    // A stored name that is nothing but a Hangul filler reads as no name: the address shows.
    await storeRawName(s.commenter.id, "\u3164\u3164");
    const again = await json(
      await call(`/api/v1/artifacts/${s.id}/comments`, { headers: s.browser }),
    );
    expect(again.items[0].author.label).toBe(s.commenter.email);
  });

  it("marks the owner's comments and versions from ids, so a lookalike name lacks the mark", async () => {
    const s = await named("Ana Owner", "Ana Owner");
    const mine = await s.post(s.browser, "From the owner");
    const theirs = await s.post(s.commenterBrowser, "From someone named like the owner");
    expect(mine.author).toMatchObject({ label: "Ana Owner", is_owner: true });
    expect(theirs.author).toMatchObject({ label: "Ana Owner", is_owner: false });
    const comments = await json(
      await call(`/api/v1/artifacts/${s.id}/comments`, { headers: s.browser }),
    );
    expect(comments.items.map((c: { author: { is_owner: boolean } }) => c.author.is_owner)).toEqual(
      [true, false],
    );
    // A version by the owner (in person, then by their agent) carries the mark; an editor's not.
    const editor = await agent({ label: "Ana Owner" });
    await grant(s.id, editor.user.email, "editor");
    await storeRawName(editor.user.id, "Ana Owner");
    const up = await call(`/api/v1/artifacts/${s.id}`, {
      method: "PUT",
      headers: { ...s.owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><h1>v2</h1>", base_version: 1 }),
    });
    expect(up.status).toBe(200);
    const byEditor = await call(`/api/v1/artifacts/${s.id}`, {
      method: "PUT",
      headers: { ...editor.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><h1>v3</h1>", base_version: 2 }),
    });
    expect(byEditor.status, await byEditor.clone().text()).toBe(200);
    const { items } = (await json(
      await call(`/api/v1/artifacts/${s.id}/versions`, { headers: s.browser }),
    )) as { items: { number: number; author: { label: string; is_owner: boolean } }[] };
    expect(items.map((v) => [v.number, v.author.label, v.author.is_owner])).toEqual([
      [3, "Ana Owner", false],
      [2, "Work Claude", true],
      [1, "Ana Owner", true],
    ]);
  });
});
