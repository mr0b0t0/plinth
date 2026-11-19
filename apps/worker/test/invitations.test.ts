// Invitation emails (docs/spec.md "Invitation emails"): the sharing list, set_visibility over REST
// and MCP, and category shares email the people a change adds only when the request asks
// (`notify`), once per artifact or share and address within a day, never the owner, never from
// an unverified owner or for a taken-down artifact, within a per-owner and a per-recipient daily
// limit. The message carries the one link and the role; titles and names are cleaned and escaped.
import { env } from "cloudflare:workers";
import { RATE_LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { escapeHtml, invitationEmail } from "../src/email/templates.ts";
import {
  invitationAddressHash,
  newInvitees,
  pruneInvitationMarks,
} from "../src/services/invitations.ts";
import {
  filed,
  type Owner,
  outboxFor,
  owner,
  reviewOf,
  rowsOf,
  send,
  shareCategory,
} from "./category-helpers.ts";
import { APP, json, mcpClient, publish, tool, uniqueEmail } from "./helpers.ts";

async function artifactOf(o: Owner, title = "Q3 plan") {
  const { res, body } = await publish(o.auth, {
    title,
    visibility: "allowlist",
    html: `<!doctype html><title>Plan</title><p>Plan</p>`,
  });
  expect(res.status).toBe(201);
  return body as { id: string; slug: string };
}

const putSharing = (
  o: Owner,
  id: string,
  grants: { email: string; role: string }[],
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = o.session,
) => send("PUT", `/api/v1/artifacts/${id}/sharing`, headers, { grants, ...extra });

const DAY = 86_400;
const windowStart = (now = Date.now()) => {
  const s = Math.floor(now / 1000);
  return s - (s % DAY);
};
const addressHash = invitationAddressHash;

describe("invitation emails: the sharing list", () => {
  it("emails a person the owner adds with notify, with the link and the role", async () => {
    const o = await owner();
    const a = await artifactOf(o, "Q3 plan");
    const bo = uniqueEmail("bo");
    const res = await putSharing(o, a.id, [{ email: bo, role: "commenter" }], { notify: true });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.invitations).toEqual({ emailed: [bo], skipped: [] });
    expect(body.grants).toEqual([expect.objectContaining({ email: bo, role: "commenter" })]);

    const mail = await outboxFor(bo);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe(`${o.user.email} shared "Q3 plan" with you`);
    expect(mail[0]?.text).toContain(`${APP}/a/${a.slug}`);
    expect(mail[0]?.text).toContain("You can view it and comment on it.");
    // One link, and no code or token of any kind.
    expect(mail[0]?.text.match(/https?:\/\//g)).toHaveLength(1);
    expect(mail[0]?.text).not.toMatch(/\b\d{6}\b/);
    expect(mail[0]?.text).not.toContain("plinth_");
  });

  it("sends nothing without notify, and the result keeps its shape", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const cy = uniqueEmail("cy");
    const res = await putSharing(o, a.id, [{ email: cy, role: "viewer" }]);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).not.toHaveProperty("invitations");
    expect(await outboxFor(cy)).toHaveLength(0);
    const off = await json(
      await putSharing(o, a.id, [{ email: cy, role: "viewer" }], { notify: false }),
    );
    expect(off).not.toHaveProperty("invitations");
    expect(await outboxFor(cy)).toHaveLength(0);
  });

  it("re-saving does not resend; only people the change adds are emailed", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const bo = uniqueEmail("bo");
    const cy = uniqueEmail("cy");
    await putSharing(o, a.id, [{ email: bo, role: "viewer" }], { notify: true });
    // The same list again, and a role change: bo already had access.
    const again = await json(
      await putSharing(o, a.id, [{ email: bo, role: "editor" }], { notify: true }),
    );
    expect(again.invitations).toEqual({ emailed: [], skipped: [] });
    // Adding cy emails cy only.
    const more = await json(
      await putSharing(
        o,
        a.id,
        [
          { email: bo, role: "editor" },
          { email: cy, role: "viewer" },
        ],
        { notify: true },
      ),
    );
    expect(more.invitations).toEqual({ emailed: [cy], skipped: [] });
    expect(await outboxFor(bo)).toHaveLength(1);
    expect(await outboxFor(cy)).toHaveLength(1);

    // Removed and added back the same day: the de-dupe holds.
    await putSharing(o, a.id, [{ email: cy, role: "viewer" }]);
    const back = await json(
      await putSharing(
        o,
        a.id,
        [
          { email: bo, role: "viewer" },
          { email: cy, role: "viewer" },
        ],
        { notify: true },
      ),
    );
    expect(back.invitations).toEqual({
      emailed: [],
      skipped: [{ email: bo, reason: "already_emailed" }],
    });
    expect(await outboxFor(bo)).toHaveLength(1);
  });

  it("an email from the day before counts too", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const bo = uniqueEmail("bo");
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)")
      .bind(`invite:sent:a:${a.id}:${await addressHash(bo)}`, windowStart() - DAY)
      .run();
    const res = await json(
      await putSharing(o, a.id, [{ email: bo, role: "viewer" }], { notify: true }),
    );
    expect(res.invitations.skipped).toEqual([{ email: bo, reason: "already_emailed" }]);
    expect(await outboxFor(bo)).toHaveLength(0);
  });

  it("never emails from an unverified owner or about a taken-down artifact", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const bo = uniqueEmail("bo");
    await env.DB.prepare("UPDATE users SET email_verified_at = NULL WHERE id = ?1")
      .bind(o.user.id)
      .run();
    const unverified = await json(
      await putSharing(o, a.id, [{ email: bo, role: "viewer" }], { notify: true }),
    );
    expect(unverified.invitations).toEqual({
      emailed: [],
      skipped: [{ email: bo, reason: "owner_unverified" }],
    });
    // The grant itself was saved.
    expect(unverified.grants).toEqual([expect.objectContaining({ email: bo })]);

    await env.DB.prepare("UPDATE users SET email_verified_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), o.user.id)
      .run();
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), a.id)
      .run();
    const cy = uniqueEmail("cy");
    const down = await json(
      await putSharing(o, a.id, [{ email: cy, role: "viewer" }], { notify: true }),
    );
    expect(down.invitations).toEqual({
      emailed: [],
      skipped: [{ email: cy, reason: "taken_down" }],
    });
    expect(await outboxFor(bo)).toHaveLength(0);
    expect(await outboxFor(cy)).toHaveLength(0);
  });

  it("stops at the per-owner and the per-recipient daily limits", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)")
      .bind(`invite:owner:${o.user.id}`, windowStart(), RATE_LIMITS.invitationsPerOwnerPerDay)
      .run();
    const bo = uniqueEmail("bo");
    const capped = await json(
      await putSharing(o, a.id, [{ email: bo, role: "viewer" }], { notify: true }),
    );
    expect(capped.invitations.skipped).toEqual([{ email: bo, reason: "owner_limit" }]);

    const o2 = await owner();
    const b = await artifactOf(o2);
    const popular = uniqueEmail("popular");
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)")
      .bind(
        `invite:to:${await addressHash(popular)}`,
        windowStart(),
        RATE_LIMITS.invitationsPerRecipientPerDay,
      )
      .run();
    const full = await json(
      await putSharing(o2, b.id, [{ email: popular, role: "viewer" }], { notify: true }),
    );
    expect(full.invitations.skipped).toEqual([{ email: popular, reason: "recipient_limit" }]);
    expect(await outboxFor(bo)).toHaveLength(0);
    expect(await outboxFor(popular)).toHaveLength(0);
  });

  it("emails at most invitationsPerChange people in one change; the rest are named", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const n = RATE_LIMITS.invitationsPerChange + 2;
    const people = Array.from({ length: n }, (_, i) => ({
      email: uniqueEmail(`many${i}-`),
      role: "viewer",
    }));
    const res = await json(await putSharing(o, a.id, people, { notify: true }));
    expect(res.grants).toHaveLength(n);
    expect(res.invitations.emailed).toEqual(
      people.slice(0, RATE_LIMITS.invitationsPerChange).map((p) => p.email),
    );
    expect(res.invitations.skipped).toEqual(
      people
        .slice(RATE_LIMITS.invitationsPerChange)
        .map((p) => ({ email: p.email, reason: "change_limit" })),
    );
    const owned = await env.DB.prepare(
      "SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2",
    )
      .bind(`invite:owner:${o.user.id}`, windowStart())
      .first<{ count: number }>();
    expect(owned?.count).toBe(RATE_LIMITS.invitationsPerChange);
    expect(await outboxFor(people[0]?.email ?? "")).toHaveLength(1);
    expect(await outboxFor(people[n - 1]?.email ?? "")).toHaveLength(0);
  });

  it("a mark another save wrote today makes the person already emailed", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const bo = uniqueEmail("bo");
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)")
      .bind(`invite:sent:a:${a.id}:${await invitationAddressHash(bo)}`, windowStart())
      .run();
    const res = await json(
      await putSharing(o, a.id, [{ email: bo, role: "viewer" }], { notify: true }),
    );
    expect(res.invitations).toEqual({
      emailed: [],
      skipped: [{ email: bo, reason: "already_emailed" }],
    });
  });

  it("counts every email against the owner's and the recipient's limits", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const bo = uniqueEmail("bo");
    await putSharing(o, a.id, [{ email: bo, role: "viewer" }], { notify: true });
    const counts = await env.DB.prepare(
      "SELECT key, count FROM rate_limits WHERE key IN (?1, ?2) AND window_start = ?3 ORDER BY key",
    )
      .bind(`invite:owner:${o.user.id}`, `invite:to:${await addressHash(bo)}`, windowStart())
      .all<{ key: string; count: number }>();
    expect(counts.results.map((r) => r.count)).toEqual([1, 1]);
    // The address itself is never stored in a key.
    const { results } = await env.DB.prepare("SELECT key FROM rate_limits WHERE key LIKE ?1")
      .bind(`%${bo}%`)
      .all();
    expect(results).toEqual([]);
  });

  it("the owner's agent asks over REST; the owner's own address is never emailed", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const bo = uniqueEmail("bo");
    const res = await putSharing(
      o,
      a.id,
      [
        { email: o.user.email, role: "editor" },
        { email: bo, role: "viewer" },
      ],
      { notify: true },
      o.auth,
    );
    expect(res.status).toBe(200);
    expect((await json(res)).invitations).toEqual({ emailed: [bo], skipped: [] });
    const own = (await outboxFor(o.user.email)).filter((m) => m.subject.includes("shared"));
    expect(own).toEqual([]);
  });
});

describe("invitation emails: set_visibility", () => {
  it("REST PUT /visibility emails people the allowlist adds when asked", async () => {
    const o = await owner();
    const a = await artifactOf(o, "Board deck");
    const bo = uniqueEmail("bo");
    const res = await send("PUT", `/api/v1/artifacts/${a.id}/visibility`, o.auth, {
      visibility: "allowlist",
      emails: [bo, o.user.email],
      notify: true,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).toBe(a.id);
    expect(body.invitations).toEqual({ emailed: [bo], skipped: [] });
    const mail = await outboxFor(bo);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.text).toContain("You can view it.");
    expect((await outboxFor(o.user.email)).filter((m) => m.subject.includes("shared"))).toEqual([]);
  });

  it("MCP set_visibility emails only with notify: true, and says so in its description", async () => {
    const o = await owner();
    const a = await artifactOf(o);
    const client = await mcpClient(o.token, {});
    try {
      const { tools } = await client.listTools();
      const desc = tools.find((t) => t.name === "set_visibility")?.description ?? "";
      expect(desc).toContain("Set it only when the user asked you to notify them");
      expect(desc).toContain("by default nobody is emailed");

      const quiet = uniqueEmail("quiet");
      const off = await tool(client, "set_visibility", {
        id: a.id,
        visibility: "allowlist",
        emails: [quiet],
      });
      expect(off.isError).toBe(false);
      expect(off.data).not.toHaveProperty("invitations");
      expect(await outboxFor(quiet)).toHaveLength(0);

      const told = uniqueEmail("told");
      const on = await tool(client, "set_visibility", {
        id: a.id,
        visibility: "allowlist",
        emails: [quiet, told],
        notify: true,
      });
      expect(on.isError).toBe(false);
      // quiet already had access, so only told is new.
      expect(on.data.invitations).toEqual({ emailed: [told], skipped: [] });
      expect(await outboxFor(told)).toHaveLength(1);
      expect(await outboxFor(quiet)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});

describe("invitation emails: category shares", () => {
  it("a new share with notify emails its people the share's name and the portal link", async () => {
    const o = await owner();
    await filed(o, "Zeta", "Q3 report");
    const client = uniqueEmail("client");
    const made = await shareCategory(o, "zeta", [{ email: client, role: "commenter" }], undefined, {
      title: "Client reports",
      notify: true,
    });
    expect((made as { invitations?: unknown }).invitations).toEqual({
      emailed: [client],
      skipped: [],
    });
    const mail = await outboxFor(client);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe(`${o.user.email} shared "Client reports" with you`);
    expect(mail[0]?.text).toContain(`${APP}/p/${made.share.id}`);
    expect(mail[0]?.text).toContain("comment on them");
    // The people see the share's name, never the category's.
    expect(mail[0]?.text).not.toContain("Zeta");
  });

  it("a people change emails only the people it adds; without notify nobody", async () => {
    const o = await owner();
    await filed(o, "Beta", "Spec");
    const first = uniqueEmail("first");
    const made = await shareCategory(o, "beta", [{ email: first, role: "viewer" }]);
    expect(made).not.toHaveProperty("invitations");
    expect(await outboxFor(first)).toHaveLength(0);

    const second = uniqueEmail("second");
    const rows = await rowsOf(o, "beta");
    const res = await send("PATCH", `/api/v1/category-shares/${made.share.id}`, o.session, {
      people: [
        { email: first, role: "viewer" },
        { email: second, role: "viewer" },
      ],
      review: reviewOf(rows, () => true),
      notify: true,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).invitations).toEqual({ emailed: [second], skipped: [] });
    expect(await outboxFor(first)).toHaveLength(0);
    expect(await outboxFor(second)).toHaveLength(1);
  });
});

describe("invitation emails: the message", () => {
  const base = {
    to: "bo@example.org",
    kind: "artifact" as const,
    ownerEmail: "ada@example.org",
    ownerName: null,
    title: "Plan",
    role: "viewer" as const,
    link: "https://app.example/a/abc",
  };

  it("escapes titles and names in HTML and offers no link but the artifact's", () => {
    const m = invitationEmail({
      ...base,
      ownerName: 'Eve "Admin" <b>visit https://phish.example</b>',
      title: "<img src=x onerror=alert(1)> see www.evil.example or https://evil.example/login",
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("<b>");
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(m.html?.match(/<a /g)).toHaveLength(1);
    expect(m.html).toContain(`<a href="${escapeHtml(base.link)}">`);
    for (const body of [m.text, m.html ?? "", m.subject]) {
      expect(body).not.toContain("https://evil.example");
      expect(body).not.toContain("https://phish.example");
      expect(body).not.toContain("www.evil.example");
    }
    expect(m.text).toContain("https[:]//evil.example/login");
    expect(m.text).toContain("www[.]evil.example");
    expect(m.text.match(/https?:\/\//g)).toEqual(["https://"]);
    // Who shared it is named with the address, so a name cannot pass for someone else.
    expect(m.text).toContain("(ada@example.org) shared");
    expect(m.text).toContain("written by the person who shared it");
  });

  it("drops control and bidi characters and line breaks, and keeps the subject short", () => {
    const m = invitationEmail({
      ...base,
      title: `Plan\r\nBcc: x@y‮​ ${"long ".repeat(60)}`,
    });
    expect(m.subject).not.toMatch(/[\r\n‮​]/);
    expect(m.subject).toContain('"Plan Bcc: x@y long');
    expect(m.subject.length).toBeLessThan(140);
    expect(m.text.split("\n")[0]).toMatch(/^ada@example\.org shared "Plan Bcc: x@y long/);
  });

  it("subject names the owner by display name when they have one", () => {
    const m = invitationEmail({ ...base, ownerName: "Ada Lovelace", role: "editor" });
    expect(m.subject).toBe('Ada Lovelace shared "Plan" with you');
    expect(m.text).toContain("Ada Lovelace (ada@example.org) shared");
    expect(m.text).toContain("publish new versions of it");
  });

  it("newInvitees keeps only addresses that held no grant, never the owner, each once", () => {
    expect(
      newInvitees(
        ["old@example.org"],
        [
          { email: "old@example.org", role: "viewer" },
          { email: "new@example.org", role: "editor" },
          { email: "ada@example.org", role: "viewer" },
          { email: "new@example.org", role: "viewer" },
        ],
        "ada@example.org",
      ),
    ).toEqual([{ email: "new@example.org", role: "editor" }]);
  });
});

describe("invitation emails: the hourly cron", () => {
  it("removes invitation counters older than two days and nothing else", async () => {
    const now = Date.now();
    const old = windowStart(now) - 3 * DAY;
    const key = `invite:to:${"0".repeat(31)}${Math.floor(Math.random() * 10)}-${now}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)").bind(
        key,
        old,
      ),
      env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)").bind(
        `${key}-today`,
        windowStart(now),
      ),
      env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)").bind(
        `login:other-${now}`,
        old,
      ),
    ]);
    await pruneInvitationMarks(env.DB, now);
    const { results } = await env.DB.prepare(
      "SELECT key FROM rate_limits WHERE key IN (?1, ?2, ?3) ORDER BY key",
    )
      .bind(key, `${key}-today`, `login:other-${now}`)
      .all<{ key: string }>();
    expect(results.map((r) => r.key).sort()).toEqual([`${key}-today`, `login:other-${now}`].sort());
  });
});
