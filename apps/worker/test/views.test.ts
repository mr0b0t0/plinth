// Recording opens (docs/spec.md "Artifact stats"): the gate seals a signed `w` flag and the opener
// into the enter token, the content host's enter exchange records one artifact_opens row per
// browser per content pass, with who opened it and the browser's visitor id, and the daily cron
// folds opens past the retention into per-artifact totals. Every assertion reads only the test's
// own artifact's rows.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, parseConfig } from "../src/config.ts";
import { contentCookieName } from "../src/content/serve.ts";
import {
  issueEnterUrl,
  openOpener,
  signContentCookie,
  verifyEnterToken,
} from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import { newId } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import { setThumbnailShooter } from "../src/services/thumbnails.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import { foldOpens, isCountableRequest, looksLikeBot, utcDay } from "../src/services/views.ts";
import {
  APP,
  agent,
  browserSession,
  contentOrigin,
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

/** The content cookie's name on an artifact's content host. */
const cookieName = (id: string) =>
  contentCookieName(getConfig(env as never), new URL(contentOrigin(id)));

async function viewsOf(artifactId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT count(*) AS n FROM artifact_opens WHERE artifact_id = ?1")
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
async function confirmByCode(ref: string, email: string, vars: Record<string, unknown> = {}) {
  const headers = anonymousBrowser();
  const ask = await run(
    `/api/v1/view/${ref}/email`,
    { method: "POST", headers, body: JSON.stringify({ email }) },
    vars,
  );
  expect(ask.status).toBe(200);
  const ok = await run(
    `/api/v1/view/${ref}/code`,
    { method: "POST", headers, body: JSON.stringify({ email, code: await codeFor(email) }) },
    vars,
  );
  expect(ok.status).toBe(200);
  return json(ok);
}

afterEach(() => {
  setThumbnailShooter(null);
  vi.restoreAllMocks();
});

describe("who counts", () => {
  it("an anonymous visitor counts once per browser per content pass", async () => {
    const started = Date.now();
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
    // Stamped with the time of each open (two days only if the test crossed midnight).
    const rows = await env.DB.prepare("SELECT opened_at FROM artifact_opens WHERE artifact_id = ?1")
      .bind(p.id)
      .all<{ opened_at: string }>();
    const days = new Set([utcDay(started), utcDay(Date.now())]);
    for (const r of rows.results)
      expect(days.has(r.opened_at.slice(0, 10)), r.opened_at).toBe(true);
    expect(rows.results).toHaveLength(3);
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

  it("counts an editor's live open after the editor preview, and only once", async () => {
    const owner = await agent();
    const editor = await createUser();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [] });
    const put = await run(`/api/v1/artifacts/${p.id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [{ email: editor.email, role: "editor" }] }),
    });
    expect(put.status).toBe(200);
    const headers = (await browserSession(editor.id)).headers;
    const preview = `?next=${encodeURIComponent("/__plinth/preview")}`;
    // The editor opens /a/<slug>/edit first: its preview frame sets a view pass without counting.
    const edit = await open(p.slug, { headers, query: preview });
    expect(await viewsOf(p.id)).toBe(0);
    // Then the live page, holding that pass: this open counts.
    const live = await open(p.slug, { headers, cookie: edit.cookie });
    expect(await viewsOf(p.id)).toBe(1);
    // Back to the editor and history, then the live page again: the counted mark carries over.
    const again = await open(p.slug, { headers, query: preview, cookie: live.cookie });
    const history = await open(p.slug, { headers, query: "?version=1", cookie: again.cookie });
    await open(p.slug, { headers, cookie: history.cookie });
    expect(await viewsOf(p.id)).toBe(1);
  });

  it("counts a commenter whose frame first loaded in review mode", async () => {
    const { p } = await linkPage();
    const review = await open(p.slug, { query: "?review=1" });
    expect(await viewsOf(p.id)).toBe(0);
    const live = await open(p.slug, { cookie: review.cookie });
    expect(await viewsOf(p.id)).toBe(1);
    await open(p.slug, { cookie: live.cookie });
    expect(await viewsOf(p.id)).toBe(1);
  });

  it("counts an admin who holds a role, like anyone else with that role", async () => {
    const adm = await admin();
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [] });
    const put = await run(`/api/v1/artifacts/${p.id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [{ email: adm.user.email, role: "editor" }] }),
    });
    expect(put.status).toBe(200);
    const { gate } = await open(p.slug, { headers: adm.headers, vars: adm.vars });
    expect(gate.role).toBe("editor");
    expect((await tokenOf(gate.enter_url))?.w).toBe(1);
    expect(await viewsOf(p.id)).toBe(1);
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
    // Nor does a capture or preview cookie ever carry the counted mark.
    await expect(
      signContentCookie(config, art.id, 1, undefined, "capture", undefined, true),
    ).rejects.toThrow("A capture pass never counts as an open");
    await expect(
      signContentCookie(config, art.id, 1, undefined, "preview", 1, true),
    ).rejects.toThrow("A preview pass never counts as an open");
  });

  it("a capture pass in the browser does not stop a real open from counting", async () => {
    const { p } = await linkPage();
    const capture = await issueEnterUrl(
      getConfig(env as never),
      { id: p.id, accessEpoch: await epochOf(p.id) },
      "/__plinth/v/1/",
      undefined,
      { capture: true, captureVersion: 1 },
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

  it("never takes a real browser for a bot, on desktop or mobile", () => {
    const browsers = [
      CHROME,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
      // Phone models that contain "bot".
      "Mozilla/5.0 (Linux; Android 12; CUBOT KINGKONG 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Linux; Android 9; CUBOT X19 Build/PPR1.180610.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      // In-app browsers.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/490.0.0.0;]",
    ];
    for (const ua of browsers) expect(looksLikeBot(ua), ua).toBe(false);
  });

  it("knows the common crawlers, unfurlers and scripts", () => {
    const bots = [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BingPreview/1.0b",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Twitterbot/1.0",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
      "TelegramBot (like TwitterBot)",
      "WhatsApp/2.23.20.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Applebot/0.1; +http://www.apple.com/go/applebot)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
      "Go-http-client/2.0",
    ];
    for (const ua of bots) expect(looksLikeBot(ua), ua).toBe(true);
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
            if (!sql.includes("INSERT INTO artifact_opens")) return stmt;
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

describe("folding old opens", () => {
  /** One open `ageDays` before `now`, at that day's noon UTC (any kind, here an unknown one). */
  const seed = (id: string, ageDays: number, n = 1, now = Date.now()) =>
    env.DB.batch(
      Array.from({ length: n }, () =>
        env.DB.prepare(
          "INSERT INTO artifact_opens (artifact_id, opened_at, viewer_kind) VALUES (?1, ?2, 'unknown')",
        ).bind(id, `${utcDay(now - ageDays * DAY_MS)}T12:00:00.000Z`),
      ),
    );
  const daysOf = async (id: string) =>
    (
      await env.DB.prepare(
        `SELECT substr(opened_at, 1, 10) AS day, count(*) AS views FROM artifact_opens
          WHERE artifact_id = ?1 GROUP BY day ORDER BY day`,
      )
        .bind(id)
        .all<{ day: string; views: number }>()
    ).results;
  const totalOf = (id: string) =>
    env.DB.prepare("SELECT views, first_day FROM artifact_view_totals WHERE artifact_id = ?1")
      .bind(id)
      .first<{ views: number; first_day: string }>();

  it("moves opens older than the retention into the artifact's total, once, and keeps the rest", async () => {
    const { p } = await linkPage();
    const now = Date.now();
    await seed(p.id, 400, 4, now);
    await seed(p.id, 366, 3, now);
    await seed(p.id, 365, 2, now); // the cutoff day: kept
    await seed(p.id, 0, 1, now);
    await foldOpens(env.DB, 365, now);
    expect(await totalOf(p.id)).toEqual({ views: 7, first_day: utcDay(now - 400 * DAY_MS) });
    const kept = [
      { day: utcDay(now - 365 * DAY_MS), views: 2 },
      { day: utcDay(now), views: 1 },
    ];
    expect(await daysOf(p.id)).toEqual(kept);
    // A second run finds nothing to fold.
    await foldOpens(env.DB, 365, now);
    expect(await totalOf(p.id)).toEqual({ views: 7, first_day: utcDay(now - 400 * DAY_MS) });
    expect(await daysOf(p.id)).toEqual(kept);
    // A later fold adds to the total and keeps the earliest day.
    await seed(p.id, 370, 5, now);
    await foldOpens(env.DB, 365, now);
    expect(await totalOf(p.id)).toEqual({ views: 12, first_day: utcDay(now - 400 * DAY_MS) });
    expect(await daysOf(p.id)).toEqual(kept);
  });

  it("takes who opened with it: identified rows past the retention are gone", async () => {
    const owner = await agent();
    const viewer = await createUser();
    const { body: p } = await publish(owner.auth);
    const old = `${utcDay(Date.now() - 100 * DAY_MS)}T09:00:00.000Z`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO artifact_opens (artifact_id, version, opened_at, viewer_kind, user_id, role) VALUES (?1, 1, ?2, 'user', ?3, 'public')",
      ).bind(p.id, old, viewer.id),
      env.DB.prepare(
        "INSERT INTO artifact_opens (artifact_id, version, opened_at, viewer_kind, email, role) VALUES (?1, 1, ?2, 'email', 'gone@example.com', 'viewer')",
      ).bind(p.id, old),
    ]);
    await foldOpens(env.DB, 90, Date.now());
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM artifact_opens WHERE artifact_id = ?1",
    )
      .bind(p.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await totalOf(p.id))?.views).toBe(2);
  });

  it("runs from the hourly cron at 03 UTC only, with VIEW_LOG_RETENTION_DAYS, whether or not counting is on", async () => {
    const { p } = await linkPage();
    const at = (hour: number) => {
      const d = new Date();
      d.setUTCHours(hour, 0, 0, 0);
      return d.getTime();
    };
    await seed(p.id, 100, 6, at(4));
    await seed(p.id, 20, 1, at(4));
    const tick = async (hour: number, vars: Record<string, string>) => {
      const ctl = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ scheduledTime: at(hour), cron: "0 * * * *" }),
        { ...env, VIEW_COUNTS: "off", ...vars } as never,
        ctl,
      );
      await waitOnExecutionContext(ctl);
    };
    await tick(4, { VIEW_LOG_RETENTION_DAYS: "90" });
    expect(await totalOf(p.id)).toBeNull();
    // The default (365) keeps both.
    await tick(3, {});
    expect(await totalOf(p.id)).toBeNull();
    // A value the Worker refuses folds nothing, rather than guess a shorter window.
    await tick(3, { VIEW_LOG_RETENTION_DAYS: "30" });
    await tick(3, { VIEW_LOG_RETENTION_DAYS: "many" });
    expect(await totalOf(p.id)).toBeNull();
    await tick(3, { VIEW_LOG_RETENTION_DAYS: "90" });
    expect(await totalOf(p.id)).toEqual({ views: 6, first_day: utcDay(at(4) - 100 * DAY_MS) });
    expect(await daysOf(p.id)).toEqual([{ day: utcDay(at(4) - 20 * DAY_MS), views: 1 }]);
  });
});

it("enterContent passes headers to the exchange and waits for the count", async () => {
  const { p } = await linkPage();
  const r = await enterContent(p.slug, { enterHeaders: FRAME, vars: {} });
  expect(r.location).toBe("/");
  expect(await viewsOf(p.id)).toBe(1);
});

// ---------- who is recorded ----------

interface OpenRow {
  version: number | null;
  viewer_kind: string;
  user_id: string | null;
  email: string | null;
  visitor: string | null;
  role: string | null;
  opened_at: string;
}

async function opensOf(artifactId: string): Promise<OpenRow[]> {
  const r = await env.DB.prepare(
    `SELECT version, viewer_kind, user_id, email, visitor, role, opened_at FROM artifact_opens
      WHERE artifact_id = ?1 ORDER BY id`,
  )
    .bind(artifactId)
    .all<OpenRow>();
  return r.results;
}

/** The decoded (signed, not encrypted) body of a token in a URL or cookie. */
function bodyOf(token: string): Record<string, unknown> {
  const body = token.split(".")[0] ?? "";
  const pad = body.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(pad + "=".repeat((4 - (pad.length % 4)) % 4)));
}
const cookieBody = (cookie: string) => bodyOf(cookie.slice(cookie.indexOf("=") + 1));

describe("who is recorded", () => {
  it("an anonymous link visitor: no person, the browser's visitor id, the version shown", async () => {
    const { owner, p } = await linkPage();
    const before = Date.now();
    const first = await open(p.slug);
    const [row] = await opensOf(p.id);
    expect(row).toMatchObject({
      version: 1,
      viewer_kind: "anonymous",
      user_id: null,
      email: null,
      role: "link",
    });
    expect(row?.visitor).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(row?.visitor).toBe(cookieBody(first.cookie).i);
    expect(Date.parse(row?.opened_at ?? "")).toBeGreaterThanOrEqual(before - 1000);
    // A new version: the next browser's open records it.
    const res = await run(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><p>two</p>", base_version: 1 }),
    });
    expect(res.status).toBe(200);
    await open(p.slug);
    expect((await opensOf(p.id)).map((r) => r.version)).toEqual([1, 2]);
  });

  it("public and password visitors are anonymous, with how they got in", async () => {
    const { p } = await linkPage("public");
    await open(p.slug);
    expect((await opensOf(p.id))[0]).toMatchObject({ viewer_kind: "anonymous", role: "public" });

    const owner = await agent();
    const { body: pw } = await publish(owner.auth, {
      visibility: "password",
      password: "letmein1",
    });
    const res = await run(`/api/v1/view/${pw.slug}/password`, {
      method: "POST",
      headers: anonymousBrowser(),
      body: JSON.stringify({ password: "letmein1" }),
    });
    const gate = await json(res);
    expect((await redeem(gate.enter_url)).status).toBe(302);
    expect((await opensOf(pw.id))[0]).toMatchObject({
      viewer_kind: "anonymous",
      role: "password",
      user_id: null,
      email: null,
    });
  });

  it("anyone signed in is recorded as their account, with or without a grant", async () => {
    const { p } = await linkPage("public");
    const reader = await createUser();
    await open(p.slug, { headers: (await browserSession(reader.id)).headers });
    const [row] = await opensOf(p.id);
    expect(row).toMatchObject({
      viewer_kind: "user",
      user_id: reader.id,
      email: null,
      visitor: null,
      role: "public",
    });

    const owner = await agent();
    const editor = await createUser();
    const { body: q } = await publish(owner.auth, { visibility: "allowlist", emails: [] });
    const put = await run(`/api/v1/artifacts/${q.id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [{ email: editor.email, role: "editor" }] }),
    });
    expect(put.status).toBe(200);
    await open(q.slug, { headers: (await browserSession(editor.id)).headers });
    expect((await opensOf(q.id))[0]).toMatchObject({
      viewer_kind: "user",
      user_id: editor.id,
      role: "editor",
    });
  });

  it("an allowlisted email confirmed by code is signed in by it, and recorded by its account", async () => {
    const owner = await agent();
    const listed = uniqueEmail("listed");
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [listed] });
    const gate = await confirmByCode(p.id, listed);
    expect((await redeem(gate.enter_url)).status).toBe(302);
    const account = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(listed)
      .first<{ id: string }>();
    expect(account?.id).toBeTruthy();
    expect((await opensOf(p.id))[0]).toMatchObject({
      viewer_kind: "user",
      user_id: account?.id,
      email: null,
      visitor: null,
      role: "viewer",
    });
  });

  it("where the address may not sign in (single-user mode), a code confirmed without an account is recorded by email", async () => {
    const owner = await agent();
    const listed = uniqueEmail("listed");
    const vars = { SINGLE_USER_MODE: "true", ADMIN_EMAIL: uniqueEmail("admin") };
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [listed] });
    const gate = await confirmByCode(p.id, listed, vars);
    expect((await redeem(gate.enter_url, { vars })).status).toBe(302);
    expect((await opensOf(p.id))[0]).toMatchObject({
      viewer_kind: "email",
      email: listed,
      user_id: null,
      visitor: null,
      role: "viewer",
    });
  });

  it("never puts who is opening in the URL: the opener is sealed", async () => {
    const owner = await agent();
    const editor = await createUser();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", emails: [] });
    await run(`/api/v1/artifacts/${p.id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [{ email: editor.email, role: "editor" }] }),
    });
    const gate = await json(
      await run(`/api/v1/view/${p.slug}`, { headers: (await browserSession(editor.id)).headers }),
    );
    const url = decodeURIComponent(gate.enter_url);
    const payload = bodyOf(new URL(gate.enter_url).searchParams.get("t") ?? "");
    expect(payload.w).toBe(1);
    expect(typeof payload.o).toBe("string");
    for (const needle of [editor.id, editor.email, "editor", "user"]) {
      expect(url).not.toContain(needle);
      expect(JSON.stringify(payload)).not.toContain(needle);
    }
    // Sealed to its artifact: moved onto another artifact's token it opens to nothing.
    const config = getConfig(env as never);
    expect(await openOpener(config, p.id, payload.o)).toEqual({
      kind: "user",
      userId: editor.id,
      role: "editor",
    });
    expect(await openOpener(config, "b".repeat(20), payload.o)).toBeNull();
    // An uncounted gate carries no opener at all.
    const history = await json(
      await run(`/api/v1/view/${p.slug}?version=1`, {
        headers: (await browserSession(editor.id)).headers,
      }),
    );
    expect(bodyOf(new URL(history.enter_url).searchParams.get("t") ?? "").o).toBeUndefined();
  });

  it("records an open whose token has no opener as unknown", async () => {
    const { p } = await linkPage();
    const url = await issueEnterUrl(
      getConfig(env as never),
      { id: p.id, accessEpoch: await epochOf(p.id) },
      "/",
      undefined,
      { countView: true },
    );
    expect((await redeem(url)).status).toBe(302);
    expect((await opensOf(p.id))[0]).toMatchObject({
      viewer_kind: "unknown",
      role: null,
      visitor: null,
      version: 1,
    });
  });

  it("the issuer refuses an opener on an uncounted token", async () => {
    await expect(
      issueEnterUrl(
        getConfig(env as never),
        { id: "a".repeat(20), accessEpoch: 1 },
        "/",
        undefined,
        {
          opener: { kind: "anonymous", role: "link" },
        },
      ),
    ).rejects.toThrow("Only a counted open carries an opener");
  });
});

describe("the anonymous visitor id", () => {
  it("is carried forward by the content cookie, across reloads and access changes", async () => {
    const { p } = await linkPage();
    const first = await open(p.slug);
    const id = cookieBody(first.cookie).i as string;
    expect(id).toMatch(/^[A-Za-z0-9]{22}$/);
    const again = await open(p.slug, { cookie: first.cookie });
    expect(cookieBody(again.cookie).i).toBe(id);
    expect(await viewsOf(p.id)).toBe(1);
    // A new epoch counts again (the pass is gone), as the same visitor.
    await bumpEpoch(p.id);
    const later = await open(p.slug, { cookie: again.cookie });
    expect(cookieBody(later.cookie).i).toBe(id);
    // Another browser is another visitor.
    const other = await open(p.slug);
    expect(cookieBody(other.cookie).i).not.toBe(id);
    expect((await opensOf(p.id)).map((r) => r.visitor)).toEqual([
      id,
      id,
      cookieBody(other.cookie).i,
    ]);
  });

  it("outlives the 12-hour pass while the cookie lasts, up to 30 days", async () => {
    const { p } = await linkPage();
    const config = getConfig(env as never);
    const epoch = await epochOf(p.id);
    const visitor = "Vv".repeat(11);
    const cookieAt = async (agoMs: number) => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - agoMs });
      try {
        const value = await signContentCookie(
          config,
          p.id,
          epoch,
          undefined,
          "view",
          undefined,
          true,
          visitor,
        );
        return `${cookieName(p.id)}=${value}`;
      } finally {
        vi.useRealTimers();
      }
    };
    // 20 hours old: the pass expired (the open counts again), the visitor id is still read.
    const day = await open(p.slug, { cookie: await cookieAt(20 * 3_600_000) });
    expect(cookieBody(day.cookie).i).toBe(visitor);
    expect(await viewsOf(p.id)).toBe(1);
    // 31 days old: a new visitor.
    const month = await open(p.slug, { cookie: await cookieAt(31 * DAY_MS) });
    expect(cookieBody(month.cookie).i).not.toBe(visitor);
    expect((await opensOf(p.id)).map((r) => r.visitor)).toEqual([
      visitor,
      cookieBody(month.cookie).i,
    ]);
  });

  it("is not taken from another artifact's cookie, a capture or a forged value", async () => {
    const { p } = await linkPage();
    const { p: q } = await linkPage();
    const config = getConfig(env as never);
    const fromQ = await signContentCookie(
      config,
      q.id,
      await epochOf(q.id),
      undefined,
      "view",
      undefined,
      false,
      "Q".repeat(22),
    );
    const r1 = await open(p.slug, { cookie: `${cookieName(p.id)}=${fromQ}` });
    expect(cookieBody(r1.cookie).i).not.toBe("Q".repeat(22));
    const forged = btoa(
      JSON.stringify({ k: "content", a: p.id, e: 1, exp: Date.now() + 1e6, i: "F".repeat(22) }),
    );
    const r2 = await open(p.slug, { cookie: `${cookieName(p.id)}=${forged}.AAAA` });
    expect(cookieBody(r2.cookie).i).not.toBe("F".repeat(22));
    await expect(
      signContentCookie(config, p.id, 1, undefined, "capture", undefined, false, "C".repeat(22)),
    ).rejects.toThrow("A capture pass never carries a visitor id");
  });

  it("is stored for anonymous visitors only, though every view cookie carries one", async () => {
    const { p } = await linkPage("public");
    const reader = await createUser();
    const signedIn = await open(p.slug, { headers: (await browserSession(reader.id)).headers });
    expect(cookieBody(signedIn.cookie).i).toMatch(/^[A-Za-z0-9]{22}$/);
    expect((await opensOf(p.id))[0]).toMatchObject({ viewer_kind: "user", visitor: null });
  });

  it("makes the cookie last 30 days while counting is on, and 12 hours (with no id) when off", async () => {
    const { p } = await linkPage();
    const on = await open(p.slug);
    expect(on.enter.headers.get("set-cookie")).toMatch(/; Max-Age=2592000;/);
    // The pass inside still expires after 12 hours.
    const exp = cookieBody(on.cookie).exp as number;
    expect(exp - Date.now()).toBeLessThanOrEqual(12 * 3_600_000);
    expect(exp - Date.now()).toBeGreaterThan(11 * 3_600_000);
    const off = await open(p.slug, { vars: { VIEW_COUNTS: "off" } });
    expect(off.enter.headers.get("set-cookie")).toMatch(/; Max-Age=43200;/);
    expect(cookieBody(off.cookie).i).toBeUndefined();
  });
});
