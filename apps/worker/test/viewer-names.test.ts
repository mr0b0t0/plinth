// Display names (docs/spec.md "Who is viewing: names and the people list"): the write rules on
// PATCH /api/v1/me, and the name a page sees wherever it sees an email (the session, document
// authors), read live from users.name, cleaned on read, and never for link viewers. Also what
// owners' and editors' agents and the owner's sharing settings get, and what the live viewer
// tells the viewer. Cookies are minted through the real gate and enter flow.
import { env } from "cloudflare:workers";
import type { ViewGate } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { eraseUserSql } from "../scripts/admin-lib.mjs";
import { viewerIdFor } from "../src/lib/crypto.ts";
import {
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
import { cookieFor, grant, roomPage, sealedCookie, setup } from "./room-helpers.ts";

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
    for (const bad of ["ana@example.com", "Ana‮Owner", "An​a", "Ana\u0007", "x".repeat(101)]) {
      const res = await setName(u.id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
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
  it("list_artifact_data: people in the summary and names on authors, for owners and editors", async () => {
    const { owner, id, ownerP } = await setup(peoplePage({ people: false }));
    await setName(ownerP.userId, "Ana Owner");
    const ed = await holder(id, "editor", "Bo Editor");
    await api(id, "/data/notes/n1", { cookie: ed.cookie, body: { data: { t: 1 } } });
    const client = await mcpClient(owner.token);
    const sum = await tool(client, "list_artifact_data", { id });
    expect(sum.isError).toBe(false);
    // The access list, whatever the page declares.
    expect(sum.data.people).toEqual([
      {
        viewer_id: await viewerIdFor(SECRET, id, ownerP.email),
        email: ownerP.email,
        name: "Ana Owner",
        role: "owner",
      },
      { viewer_id: ed.viewerId, email: ed.email, name: "Bo Editor", role: "editor" },
    ]);
    expect(sum.data.untrusted).toContain("Names are display text");
    const page = await tool(client, "list_artifact_data", { id, collection: "notes" });
    expect(page.data.docs[0].created_by).toMatchObject({ email: ed.email, name: "Bo Editor" });
    const one = await tool(client, "list_artifact_data", { id, collection: "notes", doc_id: "n1" });
    expect(one.data.doc.updated_by.name).toBe("Bo Editor");
    await client.close();

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

  it("GET /api/v1/artifacts/:ref/people mirrors the summary, with q; owners and editors only", async () => {
    const { owner, id, ownerP } = await setup(peoplePage());
    await setName(ownerP.userId, "Ana Owner");
    const ed = await holder(id, "editor", "Bo Editor");
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
  });

  it("the owner's sharing settings name the person behind each address; editors still get 403", async () => {
    const { id, ownerP } = await setup(peoplePage());
    const ed = await holder(id, "editor", "Bo Editor");
    await grant(id, "nobody-yet@example.com", "viewer");
    const res = await call(`/api/v1/artifacts/${id}/sharing`, { headers: ownerP.session.headers });
    expect(res.status).toBe(200);
    const grants = (await json(res)).grants as { email: string; name: string | null }[];
    expect(grants.find((g) => g.email === ed.email)?.name).toBe("Bo Editor");
    expect(grants.find((g) => g.email === "nobody-yet@example.com")?.name).toBeNull();
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
