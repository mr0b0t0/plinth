// Invitation emails (docs/spec.md "Invitation emails"), the recipient's side and the review
// follow-ups: a person signed in as an address turns invitation emails to it off (and on again) on
// the app's /invitation-emails page; an owner who shares with that address still gives access and
// is told `opted_out`, and nothing is sent or counted. Every invitation carries a List-Unsubscribe
// header and a footer line pointing there, with no token or address in the URL. Bare host names in
// untrusted text are defanged. A full invitation budget never holds back sign-in codes, and
// EMAIL_PROVIDER=console counts as off outside development.
import { env } from "cloudflare:workers";
import { CSRF_HEADER, INVITATION_DEFAULTS, RATE_LIMITS } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invitationEmailsActive, parseConfig } from "../src/config.ts";
import { defangHosts, emailText, invitationEmail } from "../src/email/templates.ts";
import { invitationAddressHash, invitationMailbox } from "../src/services/invitations.ts";
import {
  browser,
  filed,
  type Owner,
  outboxFor,
  owner,
  person,
  reviewOf,
  rowsOf,
  send,
} from "./category-helpers.ts";
import { APP, json, mcpClient, publish, tool, uniqueEmail } from "./helpers.ts";

const PAGE_API = "/api/v1/me/invitation-emails";
const DAY = 86_400;
const windowStart = () => {
  const s = Math.floor(Date.now() / 1000);
  return s - (s % DAY);
};
const counterOf = async (key: string) =>
  (
    await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2")
      .bind(key, windowStart())
      .first<{ count: number }>()
  )?.count ?? 0;

async function artifactOf(o: Owner, title = "Q3 plan") {
  const { res, body } = await publish(o.auth, {
    title,
    visibility: "allowlist",
    html: `<!doctype html><title>Plan</title><p>Plan</p>`,
  });
  expect(res.status).toBe(201);
  return body as { id: string; slug: string };
}

const share = (
  o: Owner,
  id: string,
  emails: string[],
  vars: Record<string, unknown> = {},
  headers: Record<string, string> = o.session,
) =>
  send(
    "PUT",
    `/api/v1/artifacts/${id}/sharing`,
    headers,
    { grants: emails.map((email) => ({ email, role: "viewer" })), notify: true },
    vars,
  );

/** Every counter an invitation from `o` to `email` about `artifactId` would touch, today. */
async function countersFor(o: Owner, artifactId: string, email: string) {
  const h = await invitationAddressHash(email);
  return {
    owner: await counterOf(`invite:owner:${o.user.id}`),
    instance: await counterOf("invite:instance"),
    to: await counterOf(`invite:to:${h}`),
    pair: await counterOf(`invite:pair:${o.user.id}:${h}`),
    mark: await counterOf(`invite:sent:a:${artifactId}:${h}`),
  };
}

describe("invitation emails: the recipient turns them off", () => {
  it("off, an owner's share still grants access, says opted_out, and sends nothing", async () => {
    const bo = await person(uniqueEmail("bo"));
    const off = await send("PUT", PAGE_API, bo.session, { receive: false });
    expect(off.status).toBe(200);
    expect(await json(off)).toEqual({ email: bo.email, receive: false });
    // Only a hash of the address is stored.
    const stored = await env.DB.prepare("SELECT address_hash FROM invitation_opt_outs").all<{
      address_hash: string;
    }>();
    expect(stored.results.map((r) => r.address_hash)).toContain(
      await invitationAddressHash(bo.email),
    );
    expect(JSON.stringify(stored.results)).not.toContain(bo.email);

    const o = await owner();
    const a = await artifactOf(o);
    const before = await countersFor(o, a.id, bo.email);
    const res = await share(o, a.id, [bo.email]);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.grants).toEqual([expect.objectContaining({ email: bo.email, role: "viewer" })]);
    expect(body.invitations).toEqual({
      emailed: [],
      skipped: [{ email: bo.email, reason: "opted_out" }],
    });
    // The answer costs the owner one of the day's invitations, as an email would; nothing of
    // the person's own, the instance's or the artifact's is counted.
    expect(await countersFor(o, a.id, bo.email)).toEqual({ ...before, owner: before.owner + 1 });
    expect((await outboxFor(bo.email)).filter((m) => m.subject.includes("shared"))).toEqual([]);
  });

  it("says opted_out over MCP set_visibility and on a category share as well", async () => {
    const cy = await person(uniqueEmail("cy"));
    expect((await send("PUT", PAGE_API, cy.session, { receive: false })).status).toBe(200);
    const o = await owner();
    const a = await artifactOf(o);
    const client = await mcpClient(o.token);
    try {
      const vis = await tool(client, "set_visibility", {
        id: a.id,
        visibility: "allowlist",
        emails: [cy.email],
        notify: true,
      });
      expect(vis.isError).toBe(false);
      expect(vis.data.invitations).toEqual({
        emailed: [],
        skipped: [{ email: cy.email, reason: "opted_out" }],
      });
    } finally {
      await client.close();
    }
    await filed(o, "Opted", "Plan");
    const res = await send("POST", "/api/v1/category-shares", o.session, {
      category: "opted",
      people: [{ email: cy.email, role: "viewer" }],
      review: reviewOf(await rowsOf(o, "opted"), () => true),
      notify: true,
    });
    expect(res.status).toBe(201);
    expect((await json(res)).invitations).toEqual({
      emailed: [],
      skipped: [{ email: cy.email, reason: "opted_out" }],
    });
    expect((await outboxFor(cy.email)).filter((m) => m.subject.includes("shared"))).toEqual([]);
  });

  it("turned back on, the next share emails them again", async () => {
    const di = await person(uniqueEmail("di"));
    expect(await json(await send("GET", PAGE_API, di.session))).toEqual({
      email: di.email,
      receive: true,
    });
    await send("PUT", PAGE_API, di.session, { receive: false });
    // Twice is the same as once.
    expect((await send("PUT", PAGE_API, di.session, { receive: false })).status).toBe(200);
    expect((await json(await send("GET", PAGE_API, di.session))).receive).toBe(false);
    const on = await send("PUT", PAGE_API, di.session, { receive: true });
    expect(await json(on)).toEqual({ email: di.email, receive: true });
    expect((await json(await send("GET", PAGE_API, di.session))).receive).toBe(true);

    const o = await owner();
    const a = await artifactOf(o);
    const body = await json(await share(o, a.id, [di.email]));
    expect(body.invitations).toEqual({ emailed: [di.email], skipped: [] });
    expect((await outboxFor(di.email)).filter((m) => m.subject.includes("shared"))).toHaveLength(1);
  });

  it("works only for the signed-in person's own address: never anonymous, an agent or another address", async () => {
    const ed = await person(uniqueEmail("ed"));
    const fi = uniqueEmail("fi");
    // Nobody signed in: the page sends them to sign in.
    expect((await send("GET", PAGE_API, browser())).status).toBe(401);
    expect((await send("PUT", PAGE_API, browser(), { receive: false })).status).toBe(401);
    // Their own agent cannot turn it off for them.
    expect((await send("GET", PAGE_API, ed.auth)).status).toBe(403);
    expect((await send("PUT", PAGE_API, ed.auth, { receive: false })).status).toBe(403);
    // A write without the CSRF pair is refused.
    const { [CSRF_HEADER]: _csrf, ...noCsrf } = ed.session;
    expect((await send("PUT", PAGE_API, noCsrf, { receive: false })).status).toBe(403);
    expect((await json(await send("GET", PAGE_API, ed.session))).receive).toBe(true);
    // An address in the body is ignored: it is always the session's own address.
    const res = await send("PUT", PAGE_API, ed.session, { receive: false, email: fi });
    expect(await json(res)).toEqual({ email: ed.email, receive: false });
    expect(
      await env.DB.prepare("SELECT 1 FROM invitation_opt_outs WHERE address_hash = ?1")
        .bind(await invitationAddressHash(fi))
        .first(),
    ).toBeNull();
    expect((await send("PUT", PAGE_API, ed.session, { receive: "no" })).status).toBe(400);

    const o = await owner();
    const a = await artifactOf(o);
    const body = await json(await share(o, a.id, [fi, ed.email]));
    expect(body.invitations).toEqual({
      emailed: [fi],
      skipped: [{ email: ed.email, reason: "opted_out" }],
    });
  });
});

/** A fresh Gmail address, and the same inbox with a dot in its local part. */
const gmail = (prefix: string) => {
  const local = (uniqueEmail(prefix).split("@")[0] ?? prefix).replaceAll("-", "");
  return {
    dotted: `${local.slice(0, 2)}.${local.slice(2)}@gmail.com`,
    plain: `${local}@gmail.com`,
  };
};

describe("invitation emails: one inbox, many addresses", () => {
  it("folds a +tag, and Gmail's dots and googlemail.com, into one mailbox", () => {
    expect(invitationMailbox("Bo+News@Example.org")).toBe("bo@example.org");
    expect(invitationMailbox("b.o+1@gmail.com")).toBe("bo@gmail.com");
    expect(invitationMailbox("B.O@googlemail.com")).toBe("bo@gmail.com");
    // Elsewhere a dot is part of the name.
    expect(invitationMailbox("b.o@example.org")).toBe("b.o@example.org");
    expect(invitationMailbox("+tag@example.org")).toBe("+tag@example.org");
  });

  it("an opt-out of bo@gmail.com stops bo+x@gmail.com, b.o@gmail.com and bo@googlemail.com", async () => {
    const { dotted, plain } = gmail("bo");
    const bo = await person(plain);
    expect((await send("PUT", PAGE_API, bo.session, { receive: false })).status).toBe(200);
    const [local] = plain.split("@");
    const o = await owner();
    for (const variant of [
      `${local}+x@gmail.com`,
      dotted,
      `${local}@googlemail.com`,
      `${dotted.split("@")[0]}+2@googlemail.com`,
    ]) {
      const a = await artifactOf(o);
      const body = await json(await share(o, a.id, [variant]));
      expect(body.grants).toEqual([expect.objectContaining({ email: variant })]);
      expect(body.invitations).toEqual({
        emailed: [],
        skipped: [{ email: variant, reason: "opted_out" }],
      });
      expect(await outboxFor(variant)).toEqual([]);
    }
  });

  it("an opt-out signed in as a variant covers the plain address too", async () => {
    const { plain } = gmail("cy");
    const [local] = plain.split("@");
    const variant = await person(`${local}+plinth@gmail.com`);
    await send("PUT", PAGE_API, variant.session, { receive: false });
    const o = await owner();
    const a = await artifactOf(o);
    expect((await json(await share(o, a.id, [plain]))).invitations).toEqual({
      emailed: [],
      skipped: [{ email: plain, reason: "opted_out" }],
    });
  });

  it("variants share the per-owner-and-recipient limit and the per-artifact mark", async () => {
    const o = await owner();
    const local = uniqueEmail("dee").split("@")[0];
    const n = RATE_LIMITS.invitationsPerOwnerPerRecipientPerDay;
    const variants = Array.from({ length: n + 1 }, (_, i) => `${local}+${i}@example.org`);
    for (const [i, v] of variants.entries()) {
      const a = await artifactOf(o);
      const body = await json(await share(o, a.id, [v]));
      expect(body.invitations).toEqual(
        i < n
          ? { emailed: [v], skipped: [] }
          : { emailed: [], skipped: [{ email: v, reason: "recipient_limit" }] },
      );
    }
    // Two variants in one change are one inbox: one email, the other named already_emailed.
    const o2 = await owner();
    const a = await artifactOf(o2);
    const ee = uniqueEmail("ee").split("@")[0];
    const body = await json(await share(o2, a.id, [`${ee}@example.org`, `${ee}+b@example.org`]));
    expect(body.grants).toHaveLength(2);
    expect(body.invitations).toEqual({
      emailed: [`${ee}@example.org`],
      skipped: [{ email: `${ee}+b@example.org`, reason: "already_emailed" }],
    });
    // Another variant added later reaches the same inbox about the same artifact within a day.
    const later = `${ee}+c@example.org`;
    const again = await json(
      await share(o2, a.id, [`${ee}@example.org`, `${ee}+b@example.org`, later]),
    );
    expect(again.invitations).toEqual({
      emailed: [],
      skipped: [{ email: later, reason: "already_emailed" }],
    });
  });
});

describe("invitation emails: opted_out costs what an email costs", () => {
  it("takes one of the owner's day, and once that is used up says owner_limit instead", async () => {
    const vars = { INVITATION_EMAILS_PER_OWNER_PER_DAY: "1" };
    const fay = await person(uniqueEmail("fay"));
    const gil = await person(uniqueEmail("gil"));
    for (const p of [fay, gil]) await send("PUT", PAGE_API, p.session, { receive: false });
    const o = await owner();
    const a = await artifactOf(o);
    const first = await json(await share(o, a.id, [fay.email], vars));
    expect(first.invitations.skipped).toEqual([{ email: fay.email, reason: "opted_out" }]);
    expect((await countersFor(o, a.id, fay.email)).owner).toBe(1);
    // The owner's day is used up: the next answer gives nothing away about gil.
    const b = await artifactOf(o);
    const second = await json(await share(o, b.id, [gil.email], vars));
    expect(second.invitations).toEqual({
      emailed: [],
      skipped: [{ email: gil.email, reason: "owner_limit" }],
    });
    expect((await countersFor(o, b.id, gil.email)).owner).toBe(1);
  });

  it("takes a place in the change, so one change answers at most invitationsPerChange people", async () => {
    const hal = await person(uniqueEmail("hal"));
    await send("PUT", PAGE_API, hal.session, { receive: false });
    const o = await owner();
    const a = await artifactOf(o);
    const rest = Array.from({ length: RATE_LIMITS.invitationsPerChange }, (_, i) =>
      uniqueEmail(`r${i}-`),
    );
    const body = await json(
      await share(o, a.id, [hal.email, ...rest], { INVITATION_EMAILS_PER_OWNER_PER_DAY: "200" }),
    );
    expect(body.invitations.emailed).toEqual(rest.slice(0, -1));
    expect(body.invitations.skipped).toHaveLength(2);
    expect(body.invitations.skipped).toEqual(
      expect.arrayContaining([
        { email: hal.email, reason: "opted_out" },
        { email: rest.at(-1), reason: "change_limit" },
      ]),
    );
  });

  it("is not given while the instance's day is used up", async () => {
    const ivo = await person(uniqueEmail("ivo"));
    await send("PUT", PAGE_API, ivo.session, { receive: false });
    const used = await counterOf("invite:instance");
    if (used === 0) {
      await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)")
        .bind("invite:instance", windowStart())
        .run();
    }
    const vars = { INVITATION_EMAILS_PER_DAY: String(Math.max(used, 1)) };
    const o = await owner();
    const a = await artifactOf(o);
    const body = await json(await share(o, a.id, [ivo.email], vars));
    expect(body.invitations.skipped).toEqual([{ email: ivo.email, reason: "instance_limit" }]);
  });
});

describe("invitation emails: List-Unsubscribe and the footer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("every invitation names the page in a List-Unsubscribe header, without a token or address", () => {
    const m = invitationEmail({
      to: "bo@example.org",
      kind: "artifact",
      ownerEmail: "ada@example.org",
      ownerName: null,
      title: "Plan",
      role: "viewer",
      link: "https://app.example/a/abc",
      optOutLink: "https://app.example/invitation-emails",
    });
    expect(m.headers).toEqual({ "List-Unsubscribe": "<https://app.example/invitation-emails>" });
    // RFC 8058 one-click needs a token in the URL; there is none (DECISIONS.md).
    expect(Object.keys(m.headers ?? {})).not.toContain("List-Unsubscribe-Post");
    expect(m.text.trimEnd().split("\n").at(-1)).toBe(
      "Stop these emails: https://app.example/invitation-emails",
    );
    expect(m.html).toContain(
      '<a href="https://app.example/invitation-emails">Stop these emails</a>',
    );
  });

  it("the footer's first line agrees with what it names: the title, or the title and the name", () => {
    const base = {
      to: "bo@example.org",
      kind: "artifact" as const,
      ownerEmail: "ada@example.org",
      title: "Plan",
      role: "viewer" as const,
      link: "https://app.example/a/abc",
      optOutLink: "https://app.example/invitation-emails",
    };
    expect(invitationEmail({ ...base, ownerName: null }).text).toContain(
      "The title above was written by the person who shared it, not by Plinth.",
    );
    expect(invitationEmail({ ...base, ownerName: "Ada" }).text).toContain(
      "The title and the name above were written by the person who shared it, not by Plinth.",
    );
  });

  it("reaches the provider: a share's request to Resend carries the header", async () => {
    const real = globalThis.fetch;
    const sent: { to: string[]; headers?: Record<string, string>; text: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (new URL(req.url).host !== "api.resend.com") return real(input, init);
      const body = (await req.json()) as typeof sent | (typeof sent)[number];
      sent.push(...(Array.isArray(body) ? body : [body]));
      return Response.json({ data: [] });
    });
    const o = await owner();
    const a = await artifactOf(o);
    const gus = uniqueEmail("gus");
    const res = await share(o, a.id, [gus], {
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_opt_out",
    });
    expect((await json(res)).invitations).toEqual({ emailed: [gus], skipped: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual([gus]);
    expect(sent[0]?.headers).toEqual({ "List-Unsubscribe": `<${APP}/invitation-emails>` });
    expect(sent[0]?.text).toContain(`${APP}/invitation-emails`);
  });
});

describe("invitation emails: bare host names in untrusted text", () => {
  it("defangs host names under a real public suffix, in the subject and both bodies", () => {
    expect(emailText("reset at office365-reset.co", 200)).toBe("reset at office365-reset[.]co");
    const m = invitationEmail({
      to: "bo@example.org",
      kind: "artifact",
      ownerEmail: "ada@example.org",
      ownerName: "Help at support.office365-reset.co",
      title: "Password reset at office365-reset.co",
      role: "viewer",
      link: "https://app.example/a/abc",
      optOutLink: "https://app.example/invitation-emails",
    });
    for (const part of [m.subject, m.text, m.html ?? ""]) {
      expect(part).not.toContain("office365-reset.co");
      expect(part).toContain("office365-reset[.]co");
    }
    expect(m.text).toContain("support[.]office365-reset[.]co");
  });

  it("leaves words that only look dotted alone", () => {
    for (const s of ["Node.js guide", "v1.2.3 notes", "e.g. this", "Q3.plan", "1.5x faster"]) {
      expect(defangHosts(s)).toBe(s);
    }
    // A reserved name is not a public suffix, and mail clients do not link it.
    expect(defangHosts("see evil.example")).toBe("see evil.example");
  });

  it("covers paths, IDNs, punycode, trailing dots, addresses and private suffixes", () => {
    expect(defangHosts("example.com/path?x=1")).toBe("example[.]com/path?x=1");
    expect(defangHosts("пример.рф")).toBe("пример[.]рф");
    expect(defangHosts("xn--e1afmkfd.xn--p1ai")).toBe("xn--e1afmkfd[.]xn--p1ai");
    expect(defangHosts("münchen.de")).toBe("münchen[.]de");
    expect(defangHosts("Visit evil.com.")).toBe("Visit evil[.]com.");
    expect(defangHosts("write to bob@evil.com")).toBe("write to bob@evil[.]com");
    expect(defangHosts("sub.evil.co.uk")).toBe("sub[.]evil[.]co[.]uk");
    expect(defangHosts("me.github.io")).toBe("me[.]github[.]io");
    // Ideographic and full-width dots read as dots in host names.
    expect(defangHosts("evil。com and evil．com")).toBe("evil[.]com and evil[.]com");
  });

  it("still defangs schemes and www, on top of the host", () => {
    expect(emailText("go to https://evil.com/login now", 200)).toBe(
      "go to https[:]//evil[.]com/login now",
    );
    expect(emailText("www.evil.com", 200)).toBe("www[.]evil[.]com");
  });
});

describe("invitation emails: the email budget", () => {
  it("defaults to 20 per owner a day", () => {
    expect(INVITATION_DEFAULTS.perOwnerPerDay).toBe(20);
    expect(parseConfig({ ...(env as unknown as Record<string, unknown>) }).invitations).toEqual({
      perDay: 1000,
      perOwnerPerDay: 20,
    });
  });

  it("a used-up instance budget for invitations still lets sign-in codes go out", async () => {
    const used = await counterOf("invite:instance");
    const vars = { INVITATION_EMAILS_PER_DAY: String(Math.max(used, 1)) };
    if (used === 0) {
      await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)")
        .bind("invite:instance", windowStart())
        .run();
    }
    const o = await owner();
    const a = await artifactOf(o);
    const hal = uniqueEmail("hal");
    const full = await json(await share(o, a.id, [hal], vars));
    expect(full.invitations.skipped).toEqual([{ email: hal, reason: "instance_limit" }]);

    // The sign-in counters are their own (login:...), so the address still gets its code.
    const login = await send("POST", "/api/v1/auth/login", browser(), { email: hal }, vars);
    expect(login.status).toBe(200);
    const mail = await outboxFor(hal);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toMatch(/sign-in code/);
  });
});

describe("invitation emails: EMAIL_PROVIDER=console and single-user mode", () => {
  const vars = () => ({ ...(env as unknown as Record<string, unknown>) });

  it("console counts as off outside development; in development it logs and counts as on", () => {
    expect(invitationEmailsActive(parseConfig(vars()))).toBe(true);
    const staging = { ...vars(), ENVIRONMENT: "staging" };
    const off = parseConfig(staging);
    expect(off.emailProvider).toBe("console");
    expect(invitationEmailsActive(off)).toBe(false);
    expect(
      invitationEmailsActive(
        parseConfig({ ...staging, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_staging" }),
      ),
    ).toBe(true);
    // Production refuses console outright, except in single-user mode, which is off anyway.
    expect(
      invitationEmailsActive({
        ...off,
        environment: "production",
        singleUserMode: false,
      }),
    ).toBe(false);
  });

  it("staging with console: the app shows no Notify box and a share says invitations_off", async () => {
    const staging = { ENVIRONMENT: "staging" };
    expect(
      (await json(await send("GET", "/api/v1/config", {}, undefined, staging))).invitation_emails,
    ).toBe(false);
    const o = await owner();
    const a = await artifactOf(o);
    const ivy = uniqueEmail("ivy");
    const used = await counterOf("invite:instance");
    const body = await json(await share(o, a.id, [ivy], staging));
    expect(body.invitations).toEqual({
      emailed: [],
      skipped: [{ email: ivy, reason: "invitations_off" }],
    });
    expect(await counterOf("invite:instance")).toBe(used);
  });

  it("single-user mode sends none: nobody else can sign in to turn them off", () => {
    const single = parseConfig({
      ...vars(),
      SINGLE_USER_MODE: "true",
      ADMIN_EMAIL: "admin@example.com",
    });
    expect(invitationEmailsActive(single)).toBe(false);
  });
});
