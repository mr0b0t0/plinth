// Test setup that should not depend on the UI or hit sign-in rate limits: users, personal access
// tokens and signed-in sessions, created through the e2e Worker's development-only seed endpoint
// (POST /__dev/seed, served only with ENVIRONMENT=development and DEV_SEED=true). Going through the
// Worker avoids writing the local SQLite file from another process, which locked it under load.
// `origin` picks the Worker (the opaque-isolation project runs a second one).
import type { BrowserContext } from "@playwright/test";
import { APP_ORIGIN } from "./api.ts";

interface SeedResponse {
  user_id: string;
  token?: string;
  connection_id?: string;
  session_cookie_name?: string;
  session_cookie_value?: string;
}

async function seed(body: Record<string, unknown>, origin = APP_ORIGIN): Promise<SeedResponse> {
  const res = await fetch(`${origin}/__dev/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 201) throw new Error(`seed failed: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as SeedResponse;
}

/** Create a verified user if missing. Returns the user's id. */
export async function seedUser(email: string, _opts: { name?: string } = {}): Promise<string> {
  return (await seed({ email })).user_id;
}

export interface SeededToken {
  token: string;
  userId: string;
  connectionId: string;
}

/** A personal access token for `email` (the user is created if missing). */
export async function seedToken(
  email: string,
  opts: {
    label?: string;
    clientType?: "claude" | "codex" | "other";
    scopes?: string;
    origin?: string;
  } = {},
): Promise<SeededToken> {
  const r = await seed(
    {
      email,
      token: {
        label: opts.label ?? "E2E token",
        client_type: opts.clientType ?? "other",
        scopes: opts.scopes ?? "artifacts:read artifacts:write mentions",
      },
    },
    opts.origin,
  );
  if (!r.token || !r.connection_id) throw new Error(`could not create a token for ${email}`);
  return { token: r.token, userId: r.user_id, connectionId: r.connection_id };
}

/** Sign a browser context in as `email` without the sign-in form. Returns the user's id. */
export async function seedSession(
  context: BrowserContext,
  email: string,
  origin = APP_ORIGIN,
): Promise<string> {
  const r = await seed({ email, session: true }, origin);
  if (!r.session_cookie_name || !r.session_cookie_value) throw new Error("no session returned");
  await context.addCookies([
    {
      name: r.session_cookie_name,
      value: r.session_cookie_value,
      // A domain without a leading dot is host-only, which a __Host- cookie must be.
      domain: new URL(origin).hostname,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  return r.user_id;
}

/**
 * An artifact's shared-data row counts (GET /__dev/data/:id, development only, with DEV_SEED):
 * for checks no API can make once the artifact is gone, such as a takedown's wipe.
 */
export async function dataCounts(
  artifactId: string,
  origin = APP_ORIGIN,
): Promise<{ docs: number; usage_rows: number }> {
  const res = await fetch(`${origin}/__dev/data/${encodeURIComponent(artifactId)}`);
  const text = await res.text();
  if (res.status !== 200)
    throw new Error(`data counts failed: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as { docs: number; usage_rows: number };
}
