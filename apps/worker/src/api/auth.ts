// Sign-in for people: magic link and six-digit code, sessions, logout. Every POST here sits behind
// the CSRF middleware in api/index.ts (anonymous POSTs included), which also stops login CSRF.
import {
  API,
  type DevOutboxItem,
  type LoginRequestResult,
  type LoginResult,
  requestLoginInput,
  verifyLoginCodeInput,
  verifyMagicLinkInput,
} from "@plinth/shared";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type LoginDeps, requestLogin, verifyLoginCode, verifyMagicLink } from "../auth/login.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { devOutbox, type UserRow } from "../db/schema.ts";
import { createEmailAdapter } from "../email/index.ts";
import { appCookieName } from "../lib/cookies.ts";
import { ApiError } from "../lib/errors.ts";
import {
  clearSessionCookie,
  createUserSession,
  deleteSession,
  sessionCookie,
} from "../services/sessions.ts";
import { type AppContext, type AppEnv, clientIp, parseBody } from "./context.ts";

export const authApi = new Hono<AppEnv>();

function loginDeps(c: AppContext): LoginDeps {
  const config = c.get("config");
  return {
    config,
    db: c.get("db"),
    d1: c.env.DB,
    mailer: createEmailAdapter(config, c.env),
    ip: clientIp(c),
  };
}

async function signedIn(c: AppContext, user: UserRow): Promise<Response> {
  const value = await createUserSession(c.get("db"), user.id);
  const body: LoginResult = { ok: true, user: { id: user.id, email: user.email } };
  const res = c.json(body);
  res.headers.append("Set-Cookie", sessionCookie(c.get("config"), value));
  return res;
}

authApi.post(API.loginRequest, async (c) => {
  const { email } = await parseBody(c, requestLoginInput);
  await requestLogin(loginDeps(c), email);
  const body: LoginRequestResult = { ok: true };
  return c.json(body);
});

authApi.post(API.loginVerifyCode, async (c) => {
  const { email, code } = await parseBody(c, verifyLoginCodeInput);
  return signedIn(c, await verifyLoginCode(loginDeps(c), email, code));
});

authApi.post(API.loginVerifyLink, async (c) => {
  const { token } = await parseBody(c, verifyMagicLinkInput);
  return signedIn(c, await verifyMagicLink(loginDeps(c), token));
});

authApi.post(API.logout, async (c) => {
  const value = c.get("cookies").get(appCookieName(c.get("config"), "session"));
  if (value) await deleteSession(c.get("db"), value);
  const res = c.json({ ok: true });
  res.headers.append("Set-Cookie", clearSessionCookie(c.get("config")));
  return res;
});

/**
 * Development only: emails the console provider kept, newest first. Playwright and the Vitest suite
 * read sign-in codes here. 404 unless ENVIRONMENT=development and DEV_OUTBOX=true.
 */
export async function readDevOutbox(
  config: Config,
  db: Db,
  to: string | undefined,
): Promise<{ items: DevOutboxItem[] } | null> {
  if (!config.devOutbox) return null;
  const email = (to ?? "").trim().toLowerCase();
  if (!email) throw new ApiError("invalid_input", "Pass ?to=<email>");
  const rows = await db
    .select()
    .from(devOutbox)
    .where(eq(devOutbox.toEmail, email))
    .orderBy(desc(devOutbox.createdAt), desc(sql`rowid`))
    .limit(50)
    .all();
  return {
    items: rows.map((r) => ({
      to: r.toEmail,
      subject: r.subject,
      text: r.text,
      created_at: r.createdAt,
    })),
  };
}

authApi.get(API.devOutbox, async (c) => {
  const out = await readDevOutbox(c.get("config"), c.get("db"), c.req.query("to"));
  if (!out) throw new ApiError("not_found", "No such API endpoint");
  return c.json(out);
});
