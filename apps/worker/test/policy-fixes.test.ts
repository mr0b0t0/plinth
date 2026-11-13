// Regression tests for two issues found in review: stale admin flags and a confirmed viewer email
// hidden behind a user session.
import { COOKIES } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, users } from "../src/db/schema.ts";
import { hashToken, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import { agent, browserSession, call, createUser, db, json, publish } from "./helpers.ts";

describe("policy fixes", () => {
  it("an is_admin flag in the database grants nothing unless the email is in ADMIN_EMAIL", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist" });
    const former = await createUser();
    await db().update(users).set({ isAdmin: true }).where(eq(users.id, former.id)).run();
    const s = await browserSession(former.id);
    expect((await call(`/api/v1/artifacts/${p.id}`, { headers: s.headers })).status).toBe(404);
    expect((await call("/api/v1/admin/reports", { headers: s.headers })).status).toBe(404);
  });

  it("a confirmed viewer email counts while signed in as someone else", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, {
      visibility: "allowlist",
      emails: ["listed@example.com"],
    });
    const other = await createUser();
    const s = await browserSession(other.id);
    const viewerValue = newToken("plinth_vs_");
    await db()
      .insert(sessions)
      .values({
        id: await hashToken(viewerValue),
        kind: "viewer",
        viewerEmail: "listed@example.com",
        expiresAt: isoIn(3600_000),
        createdAt: nowIso(),
      })
      .run();
    const without = await json(await call(`/api/v1/view/${p.slug}`, { headers: s.headers }));
    expect(without.status).toBe("email_required");
    const headers = {
      ...s.headers,
      Cookie: `${s.headers.Cookie}; ${COOKIES.viewer}=${viewerValue}`,
    };
    const withViewer = await json(await call(`/api/v1/view/${p.slug}`, { headers }));
    expect(withViewer.status).toBe("ok");
    expect((await call(`/api/v1/artifacts/${p.id}`, { headers })).status).toBe(200);
  });
});
