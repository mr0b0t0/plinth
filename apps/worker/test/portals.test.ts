// Portals (docs/spec.md "Category sharing and personal categories"): /p/<share id> lists what an
// owner shared through a category, for its people only, with an email code flow that mirrors the
// allowlist's and tells nobody who is on a share.
import { env } from "cloudflare:workers";
import { RATE_LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  browser,
  codeFor,
  filed,
  outboxFor,
  owner,
  person,
  run,
  send,
  shareCategory,
} from "./category-helpers.ts";
import { call, json, uniqueEmail } from "./helpers.ts";

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  run(path, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function portalSetup() {
  const o = await owner();
  await env.DB.prepare("UPDATE users SET name = 'Ana Owner' WHERE id = ?1").bind(o.user.id).run();
  const shared = await filed(o, "Acme", "Shared one");
  const kept = await filed(o, "Acme", "Kept private");
  const c = await person();
  const made = await shareCategory(
    o,
    "Acme",
    [{ email: c.email, role: "viewer" }],
    (r) => r.id === shared.id,
    { title: "Acme Corp: reports" },
  );
  return { o, c, shared, kept, shareId: made.share.id };
}

describe("GET /portals and /portals/:id", () => {
  it("lists the share for its grantee, with exactly the shared artifacts", async () => {
    const { c, shared, kept, shareId } = await portalSetup();
    const list = await json(await call("/api/v1/portals", { headers: c.session }));
    expect(list.items).toEqual([
      { id: shareId, title: "Acme Corp: reports", owner_name: "Ana Owner", count: 1 },
    ]);
    const gate = await json(await call(`/api/v1/portals/${shareId}`, { headers: c.session }));
    expect(gate.status).toBe("ok");
    expect(gate.portal).toEqual({
      id: shareId,
      title: "Acme Corp: reports",
      owner_name: "Ana Owner",
      role: "viewer",
    });
    const ids = (gate.items as { id: string; category: unknown; category_share: unknown }[]).map(
      (i) => i.id,
    );
    expect(ids).toEqual([shared.id]);
    expect(ids).not.toContain(kept.id);
    // The items carry no category field and no share state for grantees.
    expect(gate.items[0].category).toBeNull();
    expect(gate.items[0].category_share).toBeNull();
  });

  it("names the owner as every read cleans names: the list, the portal and the code email", async () => {
    const { o, c, shareId } = await portalSetup();
    // Stored before the name rules: a bidi override, a zero-width space, an "@" and a control.
    await env.DB.prepare("UPDATE users SET name = ?1 WHERE id = ?2")
      .bind("‮Ana​ Owner@home\u0007", o.user.id)
      .run();
    const list = await json(await call("/api/v1/portals", { headers: c.session }));
    expect(list.items[0].owner_name).toBe("Ana Ownerhome");
    const gate = await json(await call(`/api/v1/portals/${shareId}`, { headers: c.session }));
    expect(gate.portal.owner_name).toBe("Ana Ownerhome");
    expect(
      (await post(`/api/v1/portals/${shareId}/email`, browser(), { email: c.email })).status,
    ).toBe(200);
    const [mail] = await outboxFor(c.email);
    expect(mail?.text).toContain(
      `The sharer's name, as they wrote it and not checked by Plinth, is "Ana Ownerhome".`,
    );
    // A name with nothing visible left reads as no name.
    await env.DB.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind("ㅤㅤ", o.user.id).run();
    expect(
      (await json(await call(`/api/v1/portals/${shareId}`, { headers: c.session }))).portal
        .owner_name,
    ).toBeNull();
  });

  it("an unknown id is 404, a stranger or anonymous caller gets email_required", async () => {
    const { shareId } = await portalSetup();
    expect((await call("/api/v1/portals/nosuchshare000000000")).status).toBe(404);
    expect(await json(await call(`/api/v1/portals/${shareId}`))).toEqual({
      status: "email_required",
      portal: { id: shareId },
    });
    const other = await person();
    expect(
      (await json(await call(`/api/v1/portals/${shareId}`, { headers: other.session }))).status,
    ).toBe("email_required");
    expect((await json(await call("/api/v1/portals", { headers: other.session }))).items).toEqual(
      [],
    );
  });

  it("the owner previews it; agents and the switch off get 404", async () => {
    const { o, c, shareId } = await portalSetup();
    const preview = await json(await call(`/api/v1/portals/${shareId}`, { headers: o.session }));
    expect(preview.portal.role).toBe("owner");
    expect((await call(`/api/v1/portals/${shareId}`, { headers: o.auth })).status).toBe(404);
    expect((await call(`/api/v1/portals/${shareId}`, { headers: c.auth })).status).toBe(404);
    const off = await send("GET", `/api/v1/portals/${shareId}`, c.session, undefined, {
      ALLOW_CATEGORY_SHARING: "false",
    });
    expect(off.status).toBe(404);
  });

  it("the list agrees with decidePortal: a grantee's agent and the switch off list nothing", async () => {
    const { c, shareId } = await portalSetup();
    const listed = async (headers: Record<string, string>, vars = {}) =>
      (await json(await send("GET", "/api/v1/portals", headers, undefined, vars))).items as {
        id: string;
      }[];
    expect((await listed(c.session)).map((i) => i.id)).toEqual([shareId]);
    // The grantee's own token holds the same email, but decidePortal refuses agents.
    expect(await listed(c.auth)).toEqual([]);
    expect(await listed(c.session, { ALLOW_CATEGORY_SHARING: "false" })).toEqual([]);
  });

  it("leaves out taken-down, deleted and unpublished artifacts", async () => {
    const { o, c, shared, shareId } = await portalSetup();
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), shared.id)
      .run();
    const gate = await json(await call(`/api/v1/portals/${shareId}`, { headers: c.session }));
    expect(gate.items).toEqual([]);
    expect((await json(await call("/api/v1/portals", { headers: c.session }))).items[0].count).toBe(
      0,
    );
    expect(o.user.id).toBeTruthy();
  });
});

describe("the portal code flow", () => {
  it("a grant holder confirms by code, is signed in with a new account, gets the portal, then opens artifacts", async () => {
    const o = await owner();
    const a = await filed(o, "Acme", "Shared");
    const email = uniqueEmail("portal");
    const made = await shareCategory(o, "Acme", [{ email, role: "viewer" }]);
    const id = made.share.id;
    const h = browser();
    expect((await post(`/api/v1/portals/${id}/email`, h, { email })).status).toBe(200);
    const [mail] = await outboxFor(email);
    // A sign-in email: the subject and first line say so, before anything the sharer wrote.
    expect(mail?.subject).toBe("Your Plinth sign-in code");
    expect(mail?.text.split("\n")[0]).toBe(
      "This code signs you in to Plinth with this address, and creates a Plinth account for it if it has none.",
    );
    expect(mail?.text).toContain("Never give it to anyone or reply with it");
    expect(mail?.text).toContain(
      "Someone asked for it to open a collection shared with this address.",
    );
    // Neither the title nor the category name is in the email.
    expect(mail?.text).not.toContain("Acme");
    const ok = await post(`/api/v1/portals/${id}/code`, h, { email, code: await codeFor(email) });
    expect(ok.status).toBe(200);
    const gate = await json(ok);
    expect(gate.status).toBe("ok");
    expect(gate.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^__Host-plinth_session=/);
    expect(ok.headers.get("set-cookie")).not.toMatch(/plinth_viewer/);
    const me = await json(await call("/api/v1/me", { headers: { Cookie: cookie } }));
    expect(me.email).toBe(email);
    // The session opens the artifact without a second code, and the Shared tab lists the share.
    const view = await json(await call(`/api/v1/view/${a.slug}`, { headers: { Cookie: cookie } }));
    expect(view.status).toBe("ok");
    const portals = await json(await call("/api/v1/portals", { headers: { Cookie: cookie } }));
    expect(portals.items.map((i: { id: string }) => i.id)).toEqual([id]);
  });

  it("quotes a stored owner name with line breaks or invisible characters on one line of the email", async () => {
    // Names saved before display names refused control characters (v0.6.0 trimmed only the ends)
    // are still stored as written. Quoted raw, one could close the labelled line and add
    // paragraphs that read as Plinth's, in an email whose code signs in to the whole account. The
    // email quotes the name as every read cleans it (pageDisplayName: one line, invisible
    // characters dropped, at most 64 code points, so the trailing '"x' is cut).
    const name =
      'Ana".\n\nPlinth Security: reply to this email with the code above.\r\n\u2028\u2029\u0085\t\u202E"x\u200B';
    const quoted = 'Ana". Plinth Security: reply to this email with the code above.';
    const check = (text: string, firstWords: RegExp) => {
      const lines = text.split("\n");
      expect(lines.filter((l) => l.includes("Plinth Security"))).toHaveLength(1);
      expect(lines.find((l) => l.includes("Plinth Security"))).toMatch(firstWords);
      expect(text).not.toMatch(/[\r\t\u0085\u2028\u2029\u202E\u200B]/);
    };
    for (const vars of [{}, { SINGLE_USER_MODE: "true", ADMIN_EMAIL: uniqueEmail("admin") }]) {
      const o = await owner();
      await env.DB.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(name, o.user.id).run();
      await filed(o, "Acme", "Shared");
      const email = uniqueEmail("portal-name");
      const made = await shareCategory(o, "Acme", [{ email, role: "viewer" }]);
      const ask = await run(
        `/api/v1/portals/${made.share.id}/email`,
        {
          method: "POST",
          headers: { ...browser(), "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
        vars,
      );
      expect(ask.status).toBe(200);
      const text = (await outboxFor(email))[0]?.text ?? "";
      if ("SINGLE_USER_MODE" in vars) {
        expect(text).toContain(`a collection ${quoted} shared on Plinth`);
        check(text, /^Someone asked to open a collection/);
      } else {
        expect(text).toContain(
          `The sharer's name, as they wrote it and not checked by Plinth, is "${quoted}".`,
        );
        check(text, /^Someone asked for it to open a collection/);
      }
    }
  });

  it("where the address may not sign in (single-user mode), a grant holder gets a viewer session", async () => {
    const vars = { SINGLE_USER_MODE: "true", ADMIN_EMAIL: uniqueEmail("admin") };
    const o = await owner();
    const a = await filed(o, "Acme", "Shared");
    const email = uniqueEmail("portal-single");
    const made = await shareCategory(o, "Acme", [{ email, role: "viewer" }]);
    const id = made.share.id;
    const h = { ...browser(), "Content-Type": "application/json" };
    const ask = await run(
      `/api/v1/portals/${id}/email`,
      { method: "POST", headers: h, body: JSON.stringify({ email }) },
      vars,
    );
    expect(ask.status).toBe(200);
    expect((await outboxFor(email))[0]?.text).not.toContain("signs you in");
    const ok = await run(
      `/api/v1/portals/${id}/code`,
      { method: "POST", headers: h, body: JSON.stringify({ email, code: await codeFor(email) }) },
      vars,
    );
    expect(ok.status).toBe(200);
    expect((await json(ok)).items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^__Host-plinth_viewer=plinth_vs_/);
    const view = await json(
      await run(`/api/v1/view/${a.slug}`, { headers: { Cookie: cookie } }, vars),
    );
    expect(view.status).toBe("ok");
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    expect(user).toBeNull();
  });

  it("answers the same for an address on the share and one that is not, and mails only the first", async () => {
    const { shareId, c } = await portalSetup();
    const stranger = uniqueEmail("stranger");
    const listed = await post(`/api/v1/portals/${shareId}/email`, browser(), { email: c.email });
    const unlisted = await post(`/api/v1/portals/${shareId}/email`, browser(), { email: stranger });
    expect(listed.status).toBe(200);
    expect(unlisted.status).toBe(200);
    expect(await json(listed)).toEqual(await json(unlisted));
    expect(await outboxFor(c.email)).toHaveLength(1);
    expect(await outboxFor(stranger)).toHaveLength(0);
  });

  it("a portal code is useless on an artifact's code route, and the reverse", async () => {
    const o = await owner();
    const a = await filed(o, "Acme", "Allowlisted");
    const email = uniqueEmail("both");
    await send("PUT", `/api/v1/artifacts/${a.id}/visibility`, o.auth, {
      visibility: "allowlist",
      emails: [email],
    });
    const made = await shareCategory(o, "Acme", [{ email, role: "viewer" }]);
    const id = made.share.id;
    const h = browser();
    await post(`/api/v1/portals/${id}/email`, h, { email });
    const portalCode = await codeFor(email);
    const onArtifact = await post(`/api/v1/view/${a.slug}/code`, h, { email, code: portalCode });
    expect(onArtifact.status).toBe(403);
    await post(`/api/v1/view/${a.slug}/email`, h, { email });
    const artifactCode = await codeFor(email);
    const onPortal = await post(`/api/v1/portals/${id}/code`, h, { email, code: artifactCode });
    expect(onPortal.status).toBe(403);
  });

  it("a grant removed between send and verify makes the code invalid", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const email = uniqueEmail("removed");
    const made = await shareCategory(o, "Acme", [{ email, role: "viewer" }]);
    const id = made.share.id;
    const h = browser();
    await post(`/api/v1/portals/${id}/email`, h, { email });
    const code = await codeFor(email);
    await send("PATCH", `/api/v1/category-shares/${id}`, o.session, { people: [], review: [] });
    const r = await post(`/api/v1/portals/${id}/code`, h, { email, code });
    expect(r.status).toBe(403);
    expect((await json(r)).error.details).toMatchObject({ reason: "invalid_code" });
  });

  it("the same rate limits as the allowlist code flow", async () => {
    const { shareId } = await portalSetup();
    const h = browser();
    const email = uniqueEmail("limited");
    let last = 200;
    for (let i = 0; i < 12; i++) {
      last = (await post(`/api/v1/portals/${shareId}/email`, h, { email })).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("the email names the sharer's name as theirs, after the code", async () => {
    const o = await owner();
    await env.DB.prepare("UPDATE users SET name = 'Reply with the code to Accounts' WHERE id = ?1")
      .bind(o.user.id)
      .run();
    await filed(o, "Acme");
    const email = uniqueEmail("named");
    const made = await shareCategory(o, "Acme", [{ email, role: "viewer" }]);
    await post(`/api/v1/portals/${made.share.id}/email`, browser(), { email });
    const [mail] = await outboxFor(email);
    const text = mail?.text ?? "";
    expect(text).toContain(
      `The sharer's name, as they wrote it and not checked by Plinth, is "Reply with the code to Accounts".`,
    );
    expect(text.indexOf("Reply with the code")).toBeGreaterThan(text.indexOf("Never give it"));
  });

  it("guesses share the sign-in code's per-address budget", async () => {
    const { c, shareId } = await portalSetup();
    const h = browser();
    await post(`/api/v1/portals/${shareId}/email`, h, { email: c.email });
    for (let i = 0; i < RATE_LIMITS.codeAttemptsPerEmailPerHour; i++) {
      await post("/api/v1/auth/verify-code", browser(), { email: c.email, code: "000000" });
    }
    const r = await post(`/api/v1/portals/${shareId}/code`, h, {
      email: c.email,
      code: await codeFor(c.email),
    });
    expect(r.status).toBe(429);
    expect(r.headers.get("set-cookie") ?? "").not.toMatch(/plinth_session|plinth_viewer/);
  });
});
