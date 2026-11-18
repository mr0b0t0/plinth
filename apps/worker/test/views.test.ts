// Open counts (docs/spec.md "Admin stats and view counts"): the gate seals a signed `w` flag into
// the enter token, the content host's enter exchange records one open per browser per content
// pass, and the daily cron folds old days into per-artifact totals. Every assertion reads only the
// test's own artifact's rows.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, parseConfig } from "../src/config.ts";
import { issueEnterUrl, verifyEnterToken } from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import { newId } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import { setThumbnailShooter } from "../src/services/thumbnails.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import { foldViewDays, isCountableRequest, looksLikeBot, utcDay } from "../src/services/views.ts";
import {
  APP,
  agent,
  browserSession,
  createUser,
  db,
  enterContent,
  json,
  mcpClient,
  publish,
  tool,
  uniqueEmail,
} from "./helpers.ts";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** What a browser sends when the app's frame loads the enter URL. */
const FRAME = { "sec-fetch-dest": "iframe", "user-agent": CHROME };
const DAY_MS = 86_400_000;

/** The Worker's fetch handler with extra vars, waiting for waitUntil work (the deferred count). */
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

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** Redeem an enter URL as the framed browser does, optionally holding an earlier content cookie. */
function redeem(
  enterUrl: string,
  opts: { cookie?: string; headers?: Record<string, string>; vars?: Record<string, unknown> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? FRAME) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return run(enterUrl, { headers }, opts.vars);
}

/** Gate then enter, as the SPA and its frame do. Returns the gate, the enter response and cookie. */
async function open(
  ref: string,
  opts: {
    headers?: Record<string, string>;
    cookie?: string;
    query?: string;
    vars?: Record<string, unknown>;
  } = {},
) {
  const gate = await json(
    await run(`/api/v1/view/${ref}${opts.query ?? ""}`, { headers: opts.headers }, opts.vars),
  );
  expect(gate.status, JSON.stringify(gate)).toBe("ok");
  const enter = await redeem(gate.enter_url, { cookie: opts.cookie, vars: opts.vars });
  expect(enter.status).toBe(302);
  return { gate, enter, cookie: cookieOf(enter) };
}

async function viewsOf(artifactId: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT coalesce(sum(views), 0) AS n FROM artifact_view_days WHERE artifact_id = ?1",
  )
    .bind(artifactId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function tokenOf(enterUrl: string) {
  const t = new URL(enterUrl).searchParams.get("t") ?? "";
  return verifyEnterToken(getConfig(env as never), t);
}

const bumpEpoch = (id: string) =>
  env.DB.prepare("UPDATE artifacts SET access_epoch = access_epoch + 1 WHERE id = ?1")
    .bind(id)
    .run();

async function epochOf(id: string): Promise<number> {
  const r = await env.DB.prepare("SELECT access_epoch FROM artifacts WHERE id = ?1")
    .bind(id)
    .first<{ access_epoch: number }>();
  return r?.access_epoch as number;
}

/** A link-viewable page (unlisted, or public through the database). */
async function linkPage(visibility: "unlisted" | "public" = "unlisted") {
  const owner = await agent();
  const { body } = await publish(owner.auth, { title: "Counted page", visibility: "unlisted" });
  if (visibility === "public")
    await env.DB.prepare("UPDATE artifacts SET visibility = 'public' WHERE id = ?1")
      .bind(body.id)
      .run();
  return { owner, p: body as { id: string; slug: string } };
}

/** An admin: a signed-in person whose email is in ADMIN_EMAIL. */
async function admin() {
  const email = uniqueEmail("admin");
  const vars = { ADMIN_EMAIL: email };
  const config = parseConfig({ ...env, ...vars } as unknown as Record<string, unknown>);
  const user = await getOrCreateUser(db(), config, email, { verified: true });
  const s = await browserSession(user.id);
  return { user, vars, headers: s.headers };
}

let ip = 0;
function anonymousBrowser() {
  ip += 1;
  return {
    Cookie: "__Host-plinth_csrf=views-csrf",
    "x-plinth-csrf": "views-csrf",
    Origin: APP,
    "Content-Type": "application/json",
    "cf-connecting-ip": `192.0.2.${ip % 250}`,
  };
}

async function codeFor(email: string): Promise<string> {
  const r = await env.DB.prepare(
    "SELECT text FROM dev_outbox WHERE to_email = ?1 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(email)
    .first<{ text: string }>();
  const code = /\b(\d{6})\b/.exec(r?.text ?? "")?.[1];
  if (!code) throw new Error("no code mailed");
  return code;
}

/** Confirm an allowlist email by code; returns the gate the confirm call answers with. */
async function confirmByCode(ref: string, email: string) {
  const headers = anonymousBrowser();
  const ask = await run(`/api/v1/view/${ref}/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email }),
  });
  expect(ask.status).toBe(200);
  const ok = await run(`/api/v1/view/${ref}/code`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, code: await codeFor(email) }),
  });
  expect(ok.status).toBe(200);
  return json(ok);
}

afterEach(() => {
  setThumbnailShooter(null);
  vi.restoreAllMocks();
});

describe("who counts", () => {
  it("an anonymous visitor counts once per browser per content pass", async () => {
    const { p } = await linkPage("public");
    const first = await open(p.slug);
    expect(await viewsOf(p.id)).toBe(1);
    // The same browser reloads (fresh gate, fresh token) holding its content cookie: no new open.
    await open(p.slug, { cookie: first.cookie });
    expect(await viewsOf(p.id)).toBe(1);
    // Another browser.
    await open(p.slug);
    expect(await viewsOf(p.id)).toBe(2);
    // Access changed: the old cookie is no longer a pass, so the next open counts again.
    await bumpEpoch(p.id);
    await open(p.slug, { cookie: first.cookie });
    expect(await viewsOf(p.id)).toBe(3);
    // Counted under today's UTC day.
    const row = await env.DB.prepare(
      "SELECT day, views FROM artifact_view_days WHERE artifact_id = ?1",
    )
      .bind(p.id)
      .all<{ day: string; views: number }>();
    expect(row.results).toEqual([{ day: utcDay(Date.now()), views: 3 }]);
  });

  it("never counts the owner, signed in or through their own allowlist code", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, {
      visibility: "allowlist",
      emails: [uniqueEmail("listed")],
    });
    const s = await browserSession(owner.user.id);
    const mine = await open(p.slug, { headers: s.headers });
    expect(mine.gate.role).toBe("owner");
    const gate = await confirmByCode(p.id, owner.user.email);
    expect(gate.role).toBe("owner");
    expect((await redeem(gate.enter_url)).status).toBe(302);
    expect(await viewsOf(p.id)).toBe(0);
  });

  it("counts editors, commenters, allowlist viewers and password viewers", async () => {
    const owner = await agent();
    const editor = await createUser();
    const commenter = await createUser();
    const listed = uniqueEmail("listed");
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [listed] });
    const put = await run(`/api/v1/artifacts/${p.id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        grants: [
          { email: editor.email, role: "editor" },
          { email: commenter.email, role: "commenter" },
          { email: listed, role: "viewer" },
        ],
      }),
    });
    expect(put.status).toBe(200);

    const asEditor = await open(p.slug, { headers: (await browserSession(editor.id)).headers });
    expect(asEditor.gate.role).toBe("editor");
    expect(await viewsOf(p.id)).toBe(1);
    const asCommenter = await open(p.slug, {
      headers: (await browserSession(commenter.id)).headers,
    });
    expect(asCommenter.gate.role).toBe("commenter");
    expect(await viewsOf(p.id)).toBe(2);
    const viewerGate = await confirmByCode(p.id, listed);
    expect(viewerGate.role).toBe("viewer");
    expect((await redeem(viewerGate.enter_url)).status).toBe(302);
    expect(await viewsOf(p.id)).toBe(3);

    const { body: pw } = await publish(owner.auth, {
      visibility: "password",
      password: "letmein1",
    });
    const res = await run(`/api/v1/view/${pw.slug}/password`, {
      method: "POST",
      headers: anonymousBrowser(),
      body: JSON.stringify({ password: "letmein1" }),
    });
    const pwGate = await json(res);
    expect(pwGate.status).toBe("ok");
    expect((await redeem(pwGate.enter_url)).status).toBe(302);
    expect(await viewsOf(pw.id)).toBe(1);
  });

  it("never counts an admin without a role, on a reported private page or a public one", async () => {
    const adm = await admin();
    const owner = await agent();
    const { body: p } = await publish(owner.auth, {
      visibility: "allowlist",
      emails: [uniqueEmail("listed")],
    });
    await env.DB.prepare(
      "INSERT INTO reports (id, artifact_id, reason, state, created_at) VALUES (?1, ?2, 'spam', 'open', ?3)",
    )
      .bind(newId(), p.id, nowIso())
      .run();
    const reviewed = await open(p.slug, { headers: adm.headers, vars: adm.vars });
    expect(reviewed.gate.role).toBeNull();
    expect((await tokenOf(reviewed.gate.enter_url))?.w).toBeUndefined();
    expect(await viewsOf(p.id)).toBe(0);

    const { p: pub } = await linkPage("public");
    await open(pub.slug, { headers: adm.headers, vars: adm.vars });
    expect(await viewsOf(pub.id)).toBe(0);
  });

  it("never counts review mode", async () => {
    const { p } = await linkPage();
    const { gate } = await open(p.slug, { query: "?review=1" });
    expect((await tokenOf(gate.enter_url))?.w).toBeUndefined();
    expect(await viewsOf(p.id)).toBe(0);
  });
});

describe("which gates carry the flag", () => {
  it("only a live-page gate does: never an explicit version or a Plinth path", async () => {
    const { p } = await linkPage();
    const w = async (query: string) => {
      const gate = await json(await run(`/api/v1/view/${p.slug}${query}`));
      expect(gate.status).toBe("ok");
      return (await tokenOf(gate.enter_url))?.w;
    };
    expect(await w("")).toBe(1);
    expect(await w(`?next=${encodeURIComponent("/docs/page.html")}`)).toBe(1);
    expect(await w("?version=1")).toBeUndefined();
    expect(await w(`?next=${encodeURIComponent("/__plinth/preview")}`)).toBeUndefined();
    expect(await w(`?next=${encodeURIComponent("/__plinth/v/1/")}`)).toBeUndefined();
  });

  it("an agent's gate never does, not even on someone else's page", async () => {
    const { owner, p } = await linkPage();
    const other = await agent();
    for (const auth of [owner.auth, other.auth]) {
      const gate = await json(await run(`/api/v1/view/${p.id}`, { headers: auth }));
      expect(gate.status).toBe("ok");
      expect((await tokenOf(gate.enter_url))?.w).toBeUndefined();
      expect((await redeem(gate.enter_url)).status).toBe(302);
    }
    expect(await viewsOf(p.id)).toBe(0);
  });
});

describe("captures and previews", () => {
  it("a thumbnail capture never counts", async () => {
    const seen: number[] = [];
    setThumbnailShooter(async (_browser, url) => {
      // Even when the capture's request looks like a framed browser.
      seen.push((await redeem(url)).status);
      return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    });
    const owner = await agent();
    const res = await run(
      "/api/v1/artifacts",
      {
        method: "POST",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Captured", html: "<!doctype html><h1>Hi</h1>" }),
      },
      { BROWSER: {} as Fetcher },
    );
    expect(res.status).toBe(201);
    const p = await json(res);
    expect(seen).toEqual([302]);
    expect(await viewsOf(p.id)).toBe(0);
  });

  it("an MCP in-chat preview never counts", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const published = await tool(client, "publish_artifact", {
      title: "Previewed",
      html: "<!doctype html><h1>Hi</h1>",
    });
    const link = await tool(client, "preview_artifact", { id: published.data.id });
    expect(link.isError).toBe(false);
    expect((await tokenOf(link.data.preview_url))?.w).toBeUndefined();
    expect((await redeem(link.data.preview_url)).status).toBe(302);
    expect(await viewsOf(published.data.id)).toBe(0);
  });

  it("the issuer refuses the flag on a capture or a preview", async () => {
    const config = getConfig(env as never);
    const art = { id: "aaaaaaaaaaaaaaaaaaaa", accessEpoch: 1 };
    await expect(
      issueEnterUrl(config, art, "/", undefined, { countView: true, capture: true }),
    ).rejects.toThrow("A capture or preview never counts as a view");
    await expect(
      issueEnterUrl(config, art, "/__plinth/v/1/", undefined, {
        countView: true,
        previewVersion: 1,
      }),
    ).rejects.toThrow("A capture or preview never counts as a view");
  });

  it("a capture pass in the browser does not stop a real open from counting", async () => {
    const { p } = await linkPage();
    const capture = await issueEnterUrl(
      getConfig(env as never),
      { id: p.id, accessEpoch: await epochOf(p.id) },
      "/__plinth/v/1/",
      undefined,
      { capture: true },
    );
    const captured = await redeem(capture);
    expect(await viewsOf(p.id)).toBe(0);
    await open(p.slug, { cookie: cookieOf(captured) });
    expect(await viewsOf(p.id)).toBe(1);
  });
});

describe("request checks at enter", () => {
  it("counts only a framed load from a browser that does not announce itself as a bot", async () => {
    const { p } = await linkPage();
    const cases: Record<string, string>[] = [
      { "user-agent": CHROME },
      { "sec-fetch-dest": "document", "user-agent": CHROME },
      {
        "sec-fetch-dest": "iframe",
        "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
      },
      { "sec-fetch-dest": "iframe", "user-agent": "facebookexternalhit/1.1" },
      {
        "sec-fetch-dest": "iframe",
        "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0",
      },
      { "sec-fetch-dest": "iframe", "user-agent": "" },
      { "sec-fetch-dest": "iframe" },
    ];
    for (const headers of cases) {
      const gate = await json(await run(`/api/v1/view/${p.slug}`));
      expect((await tokenOf(gate.enter_url))?.w).toBe(1);
      expect((await redeem(gate.enter_url, { headers })).status).toBe(302);
    }
    expect(await viewsOf(p.id)).toBe(0);
  });

  it("the bot pattern and the frame check", () => {
    expect(looksLikeBot(CHROME)).toBe(false);
    expect(looksLikeBot(null)).toBe(true);
    expect(looksLikeBot("  ")).toBe(true);
    for (const ua of ["curl/8.5.0", "python-requests/2.32", "Wget/1.21", "Slackbot-LinkExpanding"])
      expect(looksLikeBot(ua)).toBe(true);
    const req = (h: Record<string, string>) => new Request("https://x.invalid/", { headers: h });
    expect(isCountableRequest(req(FRAME))).toBe(true);
    expect(isCountableRequest(req({ "user-agent": CHROME }))).toBe(false);
  });

  it("a replayed token is refused and adds nothing", async () => {
    const { p } = await linkPage();
    const gate = await json(await run(`/api/v1/view/${p.slug}`));
    expect((await redeem(gate.enter_url)).status).toBe(302);
    expect(await viewsOf(p.id)).toBe(1);
    expect((await redeem(gate.enter_url)).status).toBe(403);
    expect(await viewsOf(p.id)).toBe(1);
  });

  it("a token from before an access change is refused and adds nothing", async () => {
    const { p } = await linkPage();
    const gate = await json(await run(`/api/v1/view/${p.slug}`));
    await bumpEpoch(p.id);
    expect((await redeem(gate.enter_url)).status).toBe(403);
    expect(await viewsOf(p.id)).toBe(0);
  });

  it("a flag added to an unflagged token breaks its signature", async () => {
    const { p } = await linkPage();
    const gate = await json(await run(`/api/v1/view/${p.slug}?version=1`));
    const u = new URL(gate.enter_url);
    const [body, sig] = (u.searchParams.get("t") ?? "").split(".");
    const pad = (body ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(pad + "=".repeat((4 - (pad.length % 4)) % 4)));
    expect(payload.w).toBeUndefined();
    const forged = btoa(JSON.stringify({ ...payload, w: 1 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    u.searchParams.set("t", `${forged}.${sig}`);
    expect((await redeem(u.toString())).status).toBe(403);
    expect(await viewsOf(p.id)).toBe(0);
  });
});

describe("VIEW_COUNTS=off", () => {
  it("issues no flag, and records nothing even for a token flagged while it was on", async () => {
    const off = { VIEW_COUNTS: "off" };
    const { p } = await linkPage();
    const gate = await json(await run(`/api/v1/view/${p.slug}`, {}, off));
    expect((await tokenOf(gate.enter_url))?.w).toBeUndefined();
    expect((await redeem(gate.enter_url, { vars: off })).status).toBe(302);
    const flagged = await json(await run(`/api/v1/view/${p.slug}`));
    expect((await tokenOf(flagged.enter_url))?.w).toBe(1);
    expect((await redeem(flagged.enter_url, { vars: off })).status).toBe(302);
    expect(await viewsOf(p.id)).toBe(0);
  });
});

describe("the enter response does not depend on counting", () => {
  /** Every header, with the cookie's value (a fresh signature each time) blanked. */
  const shape = async (res: Response) => ({
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()].map(([k, v]) =>
      k === "set-cookie" ? [k, v.replace(/^([^=]+)=[^;]*/, "$1=")] : [k, v],
    ),
  });

  for (const isolation of ["origin", "opaque"]) {
    it(`is the same counted or not (CONTENT_ISOLATION=${isolation})`, async () => {
      const vars = { CONTENT_ISOLATION: isolation };
      const { p } = await linkPage();
      const first = await open(p.slug, { vars });
      expect(await viewsOf(p.id)).toBe(1);
      // The same browser again: not counted.
      const second = await open(p.slug, { vars, cookie: first.cookie });
      // A bot: not counted either.
      const gate = await json(await run(`/api/v1/view/${p.slug}`, {}, vars));
      const bot = await redeem(gate.enter_url, {
        vars,
        headers: { "sec-fetch-dest": "iframe", "user-agent": "facebookexternalhit/1.1" },
      });
      expect(await viewsOf(p.id)).toBe(1);
      const counted = await shape(first.enter);
      expect(await shape(second.enter)).toEqual(counted);
      expect(await shape(bot)).toEqual(counted);
      expect(first.enter.headers.get("content-security-policy")).toBeTruthy();
      expect(first.enter.headers.get("set-cookie")).toMatch(
        /; HttpOnly; Secure; SameSite=None; Partitioned/,
      );
      if (isolation === "opaque") {
        const csp = first.enter.headers.get("content-security-policy") ?? "";
        expect(csp).toMatch(/sandbox/);
        expect(csp).not.toMatch(/allow-same-origin/);
      }
      for (const [k] of first.enter.headers) expect(k).not.toMatch(/^access-control-/i);
    });
  }

  it("still lets the viewer in when the count cannot be written", async () => {
    const { p } = await linkPage();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The artifact is gone by the time the deferred write runs: the row's foreign key fails.
    const realDb = env.DB;
    const DB = new Proxy(realDb, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes("INSERT INTO artifact_view_days")) return stmt;
            return {
              bind: (_id: string, ...rest: unknown[]) => stmt.bind("z".repeat(20), ...rest),
            };
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const { enter, cookie } = await open(p.slug, { vars: { DB } });
    expect(enter.status).toBe(302);
    expect(enter.headers.get("location")).toBe("/");
    expect(cookie).toMatch(/plinth_content=/);
    expect(errors).toHaveBeenCalledWith("view count failed");
    for (const call of errors.mock.calls) expect(call).toEqual(["view count failed"]);
    expect(await viewsOf(p.id)).toBe(0);
  });
});

describe("folding old days", () => {
  const seed = (id: string, ageDays: number, views: number, now = Date.now()) =>
    env.DB.prepare("INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?1, ?2, ?3)")
      .bind(id, utcDay(now - ageDays * DAY_MS), views)
      .run();
  const daysOf = async (id: string) =>
    (
      await env.DB.prepare(
        "SELECT day, views FROM artifact_view_days WHERE artifact_id = ?1 ORDER BY day",
      )
        .bind(id)
        .all<{ day: string; views: number }>()
    ).results;
  const totalOf = (id: string) =>
    env.DB.prepare("SELECT views, first_day FROM artifact_view_totals WHERE artifact_id = ?1")
      .bind(id)
      .first<{ views: number; first_day: string }>();

  it("moves days older than 90 into the artifact's total, once, and keeps recent days", async () => {
    const { p } = await linkPage();
    const now = Date.now();
    await seed(p.id, 120, 4, now);
    await seed(p.id, 100, 3, now);
    await seed(p.id, 10, 2, now);
    await seed(p.id, 0, 1, now);
    await foldViewDays(env.DB, now);
    expect(await totalOf(p.id)).toEqual({ views: 7, first_day: utcDay(now - 120 * DAY_MS) });
    const recent = [
      { day: utcDay(now - 10 * DAY_MS), views: 2 },
      { day: utcDay(now), views: 1 },
    ];
    expect(await daysOf(p.id)).toEqual(recent);
    // A second run finds nothing to fold.
    await foldViewDays(env.DB, now);
    expect(await totalOf(p.id)).toEqual({ views: 7, first_day: utcDay(now - 120 * DAY_MS) });
    expect(await daysOf(p.id)).toEqual(recent);
    // A later fold adds to the total and keeps the earliest day.
    await seed(p.id, 95, 5, now);
    await foldViewDays(env.DB, now);
    expect(await totalOf(p.id)).toEqual({ views: 12, first_day: utcDay(now - 120 * DAY_MS) });
    expect(await daysOf(p.id)).toEqual(recent);
  });

  it("runs from the hourly cron at 03 UTC only, whether or not counting is on", async () => {
    const { p } = await linkPage();
    const at = (hour: number) => {
      const d = new Date();
      d.setUTCHours(hour, 0, 0, 0);
      return d.getTime();
    };
    await seed(p.id, 100, 6, at(4));
    const tick = async (hour: number) => {
      const ctl = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ scheduledTime: at(hour), cron: "0 * * * *" }),
        { ...env, VIEW_COUNTS: "off" } as never,
        ctl,
      );
      await waitOnExecutionContext(ctl);
    };
    await tick(4);
    expect(await totalOf(p.id)).toBeNull();
    expect(await daysOf(p.id)).toHaveLength(1);
    await tick(3);
    expect(await totalOf(p.id)).toEqual({ views: 6, first_day: utcDay(at(4) - 100 * DAY_MS) });
    expect(await daysOf(p.id)).toEqual([]);
  });
});

it("enterContent passes headers to the exchange and waits for the count", async () => {
  const { p } = await linkPage();
  const r = await enterContent(p.slug, { enterHeaders: FRAME, vars: {} });
  expect(r.location).toBe("/");
  expect(await viewsOf(p.id)).toBe(1);
});
