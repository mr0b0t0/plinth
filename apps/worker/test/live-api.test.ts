// On-page doc editing on the app host (#36): GET live, GET live/draft, POST live/checkpoint and
// DELETE live/draft. Policy (`live_edit`: signed-in owners and editors, never agents), CSRF and
// the exact Origin, zod inputs, the checkpoint steps, versions published from outside (merge or
// freeze), discard, and every path that clears a draft (delete, takedown, retention).
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { COOKIES, CSRF_HEADER } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { appCookieName } from "../src/lib/cookies.ts";
import { hashToken, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import { createReport, decideReport } from "../src/services/reports.ts";
import {
  APP,
  agent,
  browserSession,
  config,
  createUser,
  db,
  json,
  publish,
  serviceCtxFor,
  uniqueEmail,
  versionRow,
} from "./helpers.ts";
import {
  type Client,
  connectDoc,
  docSetup,
  type Frame,
  grant,
  person,
  readText,
  run,
  setup,
  type Vars,
  within,
} from "./room-helpers.ts";

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));

const BASE = "# Plan\n\nFirst.\n\nSecond.\n";

function api(
  path: string,
  headers: Record<string, string>,
  init: { method?: string; body?: unknown; vars?: Vars } = {},
) {
  return run(
    `${APP}/api/v1${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        ...headers,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    init.vars,
  );
}

const checkpoint = (
  id: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  vars?: Vars,
) => api(`/artifacts/${id}/live/checkpoint`, headers, { method: "POST", body, vars });

async function draft(id: string) {
  return env.DB.prepare("SELECT * FROM live_drafts WHERE artifact_id = ?1").bind(id).first<{
    content: string;
    rev: number;
    base_version: number;
    conflict_version: number | null;
  }>();
}

async function lease(c: Client & { welcome: Frame }, start: number, end: number, rev = 0) {
  c.send({ t: "lease", rev, start, end });
  for (;;) {
    const f = await c.next();
    if (f.t === "lease_denied") throw new Error(`lease denied: ${f.reason}`);
    if (f.t === "leased" && f.holder === c.welcome.you.id) return f.lease as string;
  }
}

/** Replace lines [start, end) and wait for the write to D1. */
async function editLines(
  c: Client & { welcome: Frame },
  start: number,
  end: number,
  text: string,
  rev = 0,
) {
  const l = await lease(c, start, end, rev);
  c.send({ t: "edit", lease: l, seq: 1, text });
  for (;;) {
    const f = await c.next();
    if (f.t === "op" && f.by === c.welcome.you.id) break;
  }
  c.send({ t: "release", lease: l });
  await c.nextOf("flushed");
}

/** A viewer session (an email confirmed by code, no account) with its CSRF pair. */
async function viewerSession(email: string) {
  const value = newToken("v_");
  await db()
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "viewer",
      viewerEmail: email,
      expiresAt: isoIn(3600_000),
      createdAt: nowIso(),
    })
    .run();
  const csrf = "csrf-test-token-0123456789";
  const cookie = `${appCookieName(config(), "viewer")}=${value}; ${COOKIES.csrf}=${csrf}`;
  return { Cookie: cookie, [CSRF_HEADER]: csrf, Origin: APP };
}

describe("live API: who may call it", () => {
  it("signed-in owners and editors only: commenters 403, strangers 404, agents 403, viewer principals 401", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const ed = await person(id, "editor");
    const commenter = await person(id, "commenter");
    const stranger = await createUser();
    const strangerS = await browserSession(stranger.id);
    const bot = await agent();
    await grant(id, bot.user.email, "editor");
    const coded = uniqueEmail("coded");
    await grant(id, coded, "editor");
    const viewerP = await viewerSession(coded);
    const routes: [string, string, unknown?][] = [
      ["GET", `/artifacts/${id}/live`],
      ["GET", `/artifacts/${id}/live/draft`],
      ["POST", `/artifacts/${id}/live/checkpoint`, { base_version: 1, rev: 0, reason: "save" }],
      ["DELETE", `/artifacts/${id}/live/draft?rev=0`],
    ];
    for (const [method, path, body] of routes) {
      const ask = (h: Record<string, string>) => api(path, h, { method, body });
      expect((await ask(ownerP.session.headers)).status, `${method} ${path} owner`).toBeLessThan(
        300,
      );
      expect((await ask(ed.session.headers)).status, `${method} ${path} editor`).toBeLessThan(300);
      expect((await ask(commenter.session.headers)).status, `${method} ${path} commenter`).toBe(
        403,
      );
      expect((await ask(strangerS.headers)).status, `${method} ${path} stranger`).toBe(404);
      expect((await ask(bot.auth)).status, `${method} ${path} agent`).toBe(403);
      expect((await ask(viewerP)).status, `${method} ${path} viewer principal`).toBe(401);
    }
  });

  it("needs the CSRF header and the exact Origin on writes; validates input after policy", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const body = { base_version: 1, rev: 0, reason: "save" };
    const noCsrf = { Cookie: h.Cookie as string, Origin: APP };
    const r1 = await checkpoint(id, noCsrf, body);
    expect(r1.status).toBe(403);
    expect((await json(r1)).error.code).toBe("csrf");
    const r2 = await checkpoint(id, { ...h, Origin: "https://evil.example" }, body);
    expect(r2.status).toBe(403);
    const bad = await checkpoint(id, h, { base_version: 0, rev: -1, reason: "whenever" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe("invalid_input");
    const noRev = await api(`/artifacts/${id}/live/draft`, h, { method: "DELETE" });
    expect(noRev.status).toBe(400);
  });

  it("is for docs only: an HTML artifact gets 400 unsupported_type", async () => {
    const { id, ownerP } = await setup("<!doctype html><title>Page</title><p>x</p>");
    const res = await api(`/artifacts/${id}/live`, ownerP.session.headers);
    expect(res.status).toBe(400);
    expect((await json(res)).error.details.reason).toBe("unsupported_type");
  });

  it("GET live reports the mode, the draft and who is online; checkpoint and draft need rooms", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    expect(await json(await api(`/artifacts/${id}/live`, h))).toEqual({
      mode: "room",
      draft: null,
      editors_online: 1,
      idle_checkpoint_s: 120,
      auto_checkpoint_min_s: 600,
    });
    await editLines(a, 2, 3, "First, edited.");
    const info = await json(await api(`/artifacts/${id}/live`, h));
    expect(info.draft).toMatchObject({
      base_version: 1,
      dirty: true,
      conflict_version: null,
      updated_by_email: ownerP.email,
    });
    const off = await json(
      await api(`/artifacts/${id}/live`, h, { vars: { ALLOW_ROOMS: "false" } }),
    );
    expect(off.mode).toBe("solo");
    expect(off.editors_online).toBeNull();
    const cp = await checkpoint(
      id,
      h,
      { base_version: 1, rev: 1, reason: "save" },
      { ALLOW_ROOMS: "false" },
    );
    expect(cp.status).toBe(503);
    expect((await json(cp)).error.details.reason).toBe("live_unavailable");
    a.ws.close(1000);
  });
});

describe("live API: checkpoints", () => {
  it("saves the draft as the next version with its base_version and a note; a clean draft writes nothing", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    const res = await checkpoint(id, h, { base_version: 1, rev: 1, reason: "save" });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out).toMatchObject({ saved: true, version: { version: 2 }, live: { dirty: false } });
    expect(out.version.warnings).toEqual([]);
    expect((await versionRow(id, 2))?.note).toBe("Edited on the page");
    expect(await a.nextOf("saved")).toEqual({ t: "saved", version: 2, rev: 1 });
    expect(await draft(id)).toBeNull();
    // Nothing left to save: no version, no publish spent.
    expect(
      await json(await checkpoint(id, h, { base_version: 2, rev: 1, reason: "save" })),
    ).toEqual({ saved: false, reason: "clean" });
    expect(await versionRow(id, 3)).toBeNull();
    // A note of the editor's own, and a stale base refused.
    await editLines(a, 4, 5, "Second, edited.", 1);
    const stale = await checkpoint(id, h, { base_version: 1, rev: 2, reason: "save" });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.details.current_version).toBe(2);
    const noted = await json(
      await checkpoint(id, h, { base_version: 2, rev: 2, reason: "done", note: "Tightened" }),
    );
    expect(noted.version.version).toBe(3);
    expect((await versionRow(id, 3))?.note).toBe("Tightened");
    a.ws.close(1000);
  });

  it("a draft back at its base writes nothing and spends no publish; the hourly limit gives 429 and keeps the draft", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const vars = { MAX_PUBLISHES_PER_HOUR: "2" };
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "Changed.");
    await editLines(a, 2, 3, "First.", 1);
    for (let i = 0; i < 3; i++) {
      const r = await json(
        await checkpoint(id, h, { base_version: 1, rev: 2, reason: "save" }, vars),
      );
      expect(r).toEqual({ saved: false, reason: "clean" });
    }
    await editLines(a, 2, 3, "Saved once.", 2);
    expect(
      (await json(await checkpoint(id, h, { base_version: 1, rev: 3, reason: "save" }, vars)))
        .saved,
    ).toBe(true);
    await editLines(a, 2, 3, "Saved twice.", 3);
    const limited = await checkpoint(id, h, { base_version: 2, rev: 4, reason: "save" }, vars);
    expect(limited.status).toBe(429);
    expect(await draft(id)).toMatchObject({
      content: BASE.replace("First.", "Saved twice."),
      base_version: 2,
    });
    // The lock was released: the next try is not "busy".
    expect(
      (await json(await checkpoint(id, h, { base_version: 2, rev: 4, reason: "save" }))).saved,
    ).toBe(true);
    a.ws.close(1000);
  });

  it("idle autosaves wait for LIVE_AUTO_CHECKPOINT_MIN_S and for quiet; a second save while one runs is busy", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    const early = await json(await checkpoint(id, h, { base_version: 1, rev: 1, reason: "idle" }));
    // Refused while v1 is younger than LIVE_AUTO_CHECKPOINT_MIN_S, with when to try again.
    expect(early).toMatchObject({ saved: false, reason: "too_soon" });
    expect(early.retry_in_s).toBeGreaterThan(590);
    expect(early.retry_in_s).toBeLessThanOrEqual(600);
    // The version is old enough now; but someone typed since the page asked (rev 0 seen).
    await env.DB.prepare("UPDATE versions SET created_at = ?1 WHERE artifact_id = ?2")
      .bind(new Date(Date.now() - 3600_000).toISOString(), id)
      .run();
    expect(
      await json(await checkpoint(id, h, { base_version: 1, rev: 0, reason: "idle" })),
    ).toEqual({
      saved: false,
      reason: "too_soon",
    });
    // Another save holds the lock.
    const other = await stubFor(id).docSnapshot(id);
    expect(
      await json(await checkpoint(id, h, { base_version: 1, rev: 1, reason: "save" })),
    ).toEqual({
      saved: false,
      reason: "busy",
    });
    await stubFor(id).docAbort(other.lock);
    const auto = await json(await checkpoint(id, h, { base_version: 1, rev: 1, reason: "idle" }));
    expect(auto.saved).toBe(true);
    expect((await versionRow(id, 2))?.note).toBe("Edited on the page (autosaved)");
    a.ws.close(1000);
  });

  it("edits made while a save runs are kept, and a lost finish is recovered by the version's hash", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    const snap = await stubFor(id).docSnapshot(id);
    expect(snap).toMatchObject({ state: "ready", rev: 1, base_version: 1, unchanged: false });
    // Someone types during the save.
    await editLines(a, 4, 5, "Second, typed during the save.", 1);
    // The version lands (as a checkpoint would write it), but no finish RPC follows: the
    // version notify carries the content hash, and the room recognizes its own checkpoint.
    const put = await api(`/artifacts/${id}`, h, {
      method: "PUT",
      body: { content: snap.text, base_version: 1 },
    });
    expect(put.status).toBe(200);
    expect(await a.nextOf("saved")).toEqual({ t: "saved", version: 2, rev: 2 });
    const row = await draft(id);
    expect(row).toMatchObject({
      base_version: 2,
      content: "# Plan\n\nFirst, edited.\n\nSecond, typed during the save.\n",
    });
    // A late finish is a no-op.
    expect(await stubFor(id).docFinish(id, 2, snap.text, snap.lock)).toEqual({
      rev: 2,
      dirty: true,
    });
    a.ws.close(1000);
  });
});

describe("live API: versions published from outside", () => {
  it("an agent's version that touches other lines is merged under the draft, with a live_draft warning", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    const res = await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: BASE.replace("Second.", "Second, by an agent."), base_version: 1 },
    });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.warnings).toContainEqual(expect.objectContaining({ code: "live_draft" }));
    const rebased = await a.nextOf("rebased");
    expect(rebased).toMatchObject({ version: 2, rev: 2 });
    expect(await readText(a, rebased.gen)).toBe(
      "# Plan\n\nFirst, by a person.\n\nSecond, by an agent.\n",
    );
    expect(await draft(id)).toMatchObject({ base_version: 2, conflict_version: null });
    const saved = await json(
      await checkpoint(id, ownerP.session.headers, { base_version: 2, rev: 2, reason: "save" }),
    );
    expect(saved.version.version).toBe(3);
    a.ws.close(1000);
  });

  it("one that changes the same lines freezes the draft: 409 until an editor resolves it", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: BASE.replace("First.", "First, by an agent."), base_version: 1 },
    });
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    expect(await draft(id)).toMatchObject({ base_version: 1, conflict_version: 2 });
    a.send({ t: "lease", rev: 1, start: 0, end: 1 });
    expect(await a.nextOf("lease_denied")).toEqual({ t: "lease_denied", reason: "frozen" });
    const refused = await checkpoint(id, h, { base_version: 1, rev: 1, reason: "save" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.details.reason).toBe("live_conflict");
    expect(await json(await api(`/artifacts/${id}/live/draft`, h))).toEqual({
      text: "# Plan\n\nFirst, by a person.\n\nSecond.\n",
      base_version: 1,
      rev: 1,
      conflict_version: 2,
    });
    const resolved = "# Plan\n\nFirst, by a person and an agent.\n\nSecond.\n";
    // A resolution must name the conflict it was reviewed against.
    const unnamed = await checkpoint(id, h, {
      base_version: 1,
      rev: 1,
      reason: "save",
      resolved_text: resolved,
    });
    expect(unnamed.status).toBe(400);
    const ok = await json(
      await checkpoint(id, h, {
        base_version: 1,
        rev: 1,
        reason: "save",
        resolved_text: resolved,
        conflict_version: 2,
      }),
    );
    expect(ok).toMatchObject({ saved: true, version: { version: 3 } });
    const reset = await a.nextOf("reset");
    expect(reset.version).toBe(3);
    expect(await readText(a, reset.gen)).toBe(resolved);
    expect(await draft(id)).toBeNull();
    // resolved_text outside a conflict is refused.
    await editLines(a, 2, 3, "Again.", reset.rev);
    const wrong = await checkpoint(id, h, {
      base_version: 3,
      rev: reset.rev + 1,
      reason: "save",
      resolved_text: "x",
      conflict_version: 3,
    });
    expect(wrong.status).toBe(400);
    a.ws.close(1000);
  });

  it("a draft nobody holds in memory is rebased when the room loads it", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    a.ws.close(1000);
    await new Promise((r) => setTimeout(r, 100));
    // Rooms off while the agent publishes: no notify reaches the room.
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: BASE.replace("Second.", "Second, by an agent."), base_version: 1 },
      vars: { ALLOW_ROOMS: "false" },
    });
    await runInDurableObject(stubFor(id), async (room) => {
      (room as any).doc.loaded = null;
    });
    const b = await connectDoc(id, ownerP.cookie);
    expect(b.welcome.base_version).toBe(2);
    expect(b.text).toBe("# Plan\n\nFirst, by a person.\n\nSecond, by an agent.\n");
    b.ws.close(1000);
  });
});

describe("live API: discard and cleanup", () => {
  it("discard drops the draft at the rev the editor saw, and open pages reset", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    const moved = await api(`/artifacts/${id}/live/draft?rev=0`, h, { method: "DELETE" });
    expect(moved.status).toBe(409);
    const ok = await api(`/artifacts/${id}/live/draft?rev=1`, h, { method: "DELETE" });
    expect(ok.status).toBe(204);
    const reset = await a.nextOf("reset");
    expect(await readText(a, reset.gen)).toBe(BASE);
    expect(await draft(id)).toBeNull();
    a.ws.close(1000);
    // Without rooms the row goes directly.
    await env.DB.prepare(
      `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, created_at, updated_at)
       VALUES (?1, 1, 'x', 1, 7, ?2, ?2)`,
    )
      .bind(id, nowIso())
      .run();
    const vars = { ALLOW_ROOMS: "false" };
    expect(
      (await api(`/artifacts/${id}/live/draft?rev=6`, h, { method: "DELETE", vars })).status,
    ).toBe(409);
    expect(
      (await api(`/artifacts/${id}/live/draft?rev=7`, h, { method: "DELETE", vars })).status,
    ).toBe(204);
    expect(await draft(id)).toBeNull();
  });

  it("deleting the artifact or taking it down clears the draft and closes the doc sockets", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    expect(await draft(id)).not.toBeNull();
    expect((await api(`/artifacts/${id}`, owner.auth, { method: "DELETE" })).status).toBe(204);
    expect(await draft(id)).toBeNull();
    expect(await within(a.closed)).toMatchObject({ code: 4404 });

    const t = await docSetup(BASE);
    const b = await connectDoc(t.id, t.ownerP.cookie);
    await editLines(b, 2, 3, "First, edited.");
    const admin = await createUser(uniqueEmail("admin"));
    const ctx = serviceCtxFor(
      { kind: "user", userId: admin.id, email: admin.email, isAdmin: true },
      { config: { adminEmails: [admin.email] } },
    );
    const reporter = serviceCtxFor({
      kind: "user",
      userId: t.owner.user.id,
      email: t.owner.user.email,
      isAdmin: false,
    });
    const report = await createReport(reporter, t.id, { reason: "spam" } as never);
    const waits: Promise<unknown>[] = [];
    await decideReport({ ...ctx, waitUntil: (p) => waits.push(p) }, report.id, "actioned");
    await Promise.all(waits);
    expect(await draft(t.id)).toBeNull();
    expect(await within(b.closed)).toMatchObject({ code: 4404 });
  });

  it("the hourly cron deletes drafts untouched for LIVE_DRAFT_RETENTION_DAYS", async () => {
    const { body: oldDoc } = await publish((await agent()).auth, {
      html: undefined,
      type: "doc",
      content: "# Old\n",
    });
    const { body: newDoc } = await publish((await agent()).auth, {
      html: undefined,
      type: "doc",
      content: "# New\n",
    });
    const ins = (aid: string, at: string) =>
      env.DB.prepare(
        `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, created_at, updated_at)
         VALUES (?1, 1, 'x', 1, 1, ?2, ?2)`,
      )
        .bind(aid, at)
        .run();
    await ins(oldDoc.id, new Date(Date.now() - 31 * 86_400_000).toISOString());
    await ins(newDoc.id, new Date(Date.now() - 29 * 86_400_000).toISOString());
    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "0 * * * *", noRetry() {} } as ScheduledController,
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await draft(oldDoc.id)).toBeNull();
    expect(await draft(newDoc.id)).not.toBeNull();
  });
});

describe("live API: resolving conflicts, and a room that missed a version", () => {
  it("a resolution reviewed against one conflict is refused once a newer version conflicts", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: BASE.replace("First.", "First, by an agent."), base_version: 1 },
    });
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    // The editor reviews against v2; meanwhile v3 rewrites the same paragraph again.
    const v3 = BASE.replace("First.", "First, by an agent, twice.");
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: v3, base_version: 2 },
    });
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 3 });
    const keepMine = {
      base_version: 1,
      rev: 1,
      reason: "save",
      resolved_text: "# Plan\n\nFirst, by a person.\n\nSecond.\n",
    };
    const stale = await checkpoint(id, h, { ...keepMine, conflict_version: 2 });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.details).toMatchObject({
      reason: "live_conflict",
      current_version: 3,
    });
    // Nothing was written over v3, and the refusal released its lock.
    expect(await versionRow(id, 4)).toBeFalsy();
    const ok = await json(await checkpoint(id, h, { ...keepMine, conflict_version: 3 }));
    expect(ok).toMatchObject({ saved: true, version: { version: 4 } });
    a.ws.close(1000);
  });

  it("taking the latest version drops the draft for everyone and writes no version", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    const theirs = BASE.replace("First.", "First, by an agent.");
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: theirs, base_version: 1 },
    });
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    const res = await checkpoint(id, h, {
      base_version: 1,
      rev: 1,
      reason: "save",
      resolved_text: theirs,
      conflict_version: 2,
    });
    expect(await json(res)).toEqual({ saved: false, reason: "unchanged" });
    const reset = await a.nextOf("reset");
    expect(reset.version).toBe(2);
    expect(await readText(a, reset.gen)).toBe(theirs);
    expect(await draft(id)).toBeNull();
    expect(await versionRow(id, 3)).toBeFalsy();
    // Unfrozen: the next lease works, and a save goes on top of v2.
    await editLines(a, 4, 5, "Second, after.", reset.rev);
    const saved = await json(
      await checkpoint(id, h, { base_version: 2, rev: reset.rev + 1, reason: "save" }),
    );
    expect(saved).toMatchObject({ saved: true, version: { version: 3 } });
    a.ws.close(1000);
  });

  it("a save whose room missed a version gets 409, leaves that version intact, and the room catches up", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    // Rooms off while the agent publishes: the open room never hears of v2.
    const theirs = BASE.replace("Second.", "Second, by an agent.");
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: theirs, base_version: 1 },
      vars: { ALLOW_ROOMS: "false" },
    });
    const refused = await checkpoint(id, h, { base_version: 1, rev: 1, reason: "save" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.details).toMatchObject({
      reason: "live_rebased",
      current_version: 2,
    });
    expect(await versionRow(id, 3)).toBeFalsy();
    const rebased = await a.nextOf("rebased");
    expect(rebased).toMatchObject({ version: 2 });
    const merged = "# Plan\n\nFirst, by a person.\n\nSecond, by an agent.\n";
    expect(await readText(a, rebased.gen)).toBe(merged);
    expect(await draft(id)).toMatchObject({ base_version: 2, content: merged });
    // The lock was released: saving again on the new base works.
    const ok = await json(
      await checkpoint(id, h, { base_version: 2, rev: rebased.rev, reason: "save" }),
    );
    expect(ok).toMatchObject({ saved: true, version: { version: 3 } });
    a.ws.close(1000);
  });

  it("when the missed version changed the same lines, the 409 sends the editor to review", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: BASE.replace("First.", "First, by an agent."), base_version: 1 },
      vars: { ALLOW_ROOMS: "false" },
    });
    const refused = await checkpoint(id, h, { base_version: 1, rev: 1, reason: "save" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.details).toMatchObject({
      reason: "live_conflict",
      current_version: 2,
    });
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    expect(await draft(id)).toMatchObject({ base_version: 1, conflict_version: 2 });
    a.ws.close(1000);
  });

  it("the room's alarm catches a draft up onto a version whose notify was lost", async () => {
    const { owner, id, ownerP } = await docSetup(BASE);
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, by a person.");
    await api(`/artifacts/${id}`, owner.auth, {
      method: "PUT",
      body: { content: BASE.replace("Second.", "Second, by an agent."), base_version: 1 },
      vars: { ALLOW_ROOMS: "false" },
    });
    await runInDurableObject(stubFor(id), async (room) => {
      await (room as any).alarm();
    });
    expect(await a.nextOf("rebased")).toMatchObject({ version: 2 });
    expect(await draft(id)).toMatchObject({ base_version: 2 });
    a.ws.close(1000);
  });
});

describe("live API: checkpoint locks", () => {
  it("two snapshots at once: one is busy; an abort releases only its own lock", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    const stub = stubFor(id);
    const both = await Promise.all([stub.docSnapshot(id), stub.docSnapshot(id)]);
    expect(both.map((s) => s.state).sort()).toEqual(["busy", "ready"]);
    const winner = both.find((s) => s.state === "ready");
    const loser = both.find((s) => s.state === "busy");
    expect(winner?.lock).toMatch(/^k_/);
    expect(loser?.lock).toBe("");
    // The busy one's abort (and any other id) leaves the winner's lock in place.
    await stub.docAbort(loser?.lock ?? "");
    await stub.docAbort("k_someone_else");
    expect((await stub.docSnapshot(id)).state).toBe("busy");
    await stub.docAbort(winner?.lock ?? "");
    expect((await stub.docSnapshot(id)).state).toBe("ready");
    a.ws.close(1000);
  });
});

describe("live API: the remaining refusals", () => {
  it("a room that answers 'gone' gives 404 on checkpoint and on the draft", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const h = ownerP.session.headers;
    await runInDurableObject(stubFor(id), async (room) => {
      const doc = (room as any).doc;
      doc.snapshot = async () => ({
        state: "gone",
        text: "",
        rev: 0,
        base_version: 1,
        conflict_version: null,
        hash: "",
        unchanged: true,
        lock: "",
      });
      doc.peek = async () => null;
    });
    expect((await checkpoint(id, h, { base_version: 1, rev: 0, reason: "save" })).status).toBe(404);
    expect((await api(`/artifacts/${id}/live/draft`, h)).status).toBe(404);
  });

  it("with LIVE_CHECKPOINT_IDLE_S=0 an idle save is always too_soon, with no retry", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    await env.DB.prepare("UPDATE versions SET created_at = ?1 WHERE artifact_id = ?2")
      .bind(new Date(Date.now() - 86_400_000).toISOString(), id)
      .run();
    const vars = { LIVE_CHECKPOINT_IDLE_S: "0" };
    const r = await json(
      await checkpoint(
        id,
        ownerP.session.headers,
        { base_version: 1, rev: 1, reason: "idle" },
        vars,
      ),
    );
    expect(r).toEqual({ saved: false, reason: "too_soon" });
    expect(await versionRow(id, 2)).toBeFalsy();
    // The lock was released: an explicit save still works.
    const saved = await json(
      await checkpoint(
        id,
        ownerP.session.headers,
        { base_version: 1, rev: 1, reason: "save" },
        vars,
      ),
    );
    expect(saved.saved).toBe(true);
    a.ws.close(1000);
  });

  it("a discard the room cannot carry out gives 503 and keeps the draft", async () => {
    const { id, ownerP } = await docSetup(BASE);
    const a = await connectDoc(id, ownerP.cookie);
    await editLines(a, 2, 3, "First, edited.");
    await runInDurableObject(stubFor(id), async (room) => {
      (room as any).doc.discard = async () => {
        throw new Error("unreachable");
      };
    });
    const res = await api(`/artifacts/${id}/live/draft?rev=1`, ownerP.session.headers, {
      method: "DELETE",
    });
    expect(res.status).toBe(503);
    expect((await json(res)).error.details).toEqual({ reason: "live_unavailable" });
    expect(await draft(id)).not.toBeNull();
    a.ws.close(1000);
  });
});
