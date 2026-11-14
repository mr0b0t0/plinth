// Development-only seeding for the end-to-end suite: users, personal access tokens and sessions,
// written through the Worker's own D1 connection (writing the local SQLite file from another
// process caused SQLITE_BUSY under parallel tests). Served only when ENVIRONMENT=development and
// DEV_SEED=true; it is an authentication bypass by design and must never run anywhere else.
// GET /__dev/data/:id is its read-side twin: an artifact's shared-data row counts, for checks no
// API can make once the artifact is gone (a takedown's wipe), without spawning wrangler.
import { TTL } from "@plinth/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/context.ts";
import { TOKEN_PREFIX } from "../auth/principal.ts";
import { agentConnections, sessions } from "../db/schema.ts";
import { appCookieName } from "../lib/cookies.ts";
import { hashToken, newId, newToken } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { isoIn, nowIso } from "../lib/time.ts";
import { getOrCreateUser } from "../services/users.ts";

const seedInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  token: z
    .object({
      label: z.string().min(1).max(80).default("E2E token"),
      client_type: z.enum(["claude", "codex", "other"]).default("other"),
      scopes: z.string().default("artifacts:read artifacts:write mentions"),
    })
    .optional(),
  session: z.boolean().optional(),
});

export const devSeed = new Hono<AppEnv>();

function devOnly(config: AppEnv["Variables"]["config"]): void {
  if (!config.devSeed || config.environment !== "development") {
    throw new ApiError("not_found", "Not found");
  }
}

devSeed.post("/__dev/seed", async (c) => {
  const config = c.get("config");
  devOnly(config);
  const parsed = seedInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ApiError("invalid_input", "Invalid input", { issues: parsed.error.issues });
  const input = parsed.data;
  const db = c.get("db");
  const user = await getOrCreateUser(db, config, input.email, { verified: true });
  const out: Record<string, string> = { user_id: user.id };
  if (input.token) {
    const token = newToken(TOKEN_PREFIX.pat);
    const id = newId();
    await db
      .insert(agentConnections)
      .values({
        id,
        userId: user.id,
        label: input.token.label,
        clientType: input.token.client_type,
        kind: "token",
        tokenHash: await hashToken(token),
        scopes: input.token.scopes,
        createdAt: nowIso(),
      })
      .run();
    out.token = token;
    out.connection_id = id;
  }
  if (input.session) {
    const value = newToken("s_");
    await db
      .insert(sessions)
      .values({
        id: await hashToken(value),
        kind: "user",
        userId: user.id,
        expiresAt: isoIn(TTL.sessionS * 1000),
        createdAt: nowIso(),
      })
      .run();
    out.session_cookie_name = appCookieName(config, "session");
    out.session_cookie_value = value;
  }
  return c.json(out, 201);
});

/** Counts only: how many documents an artifact holds and whether its usage row exists. */
devSeed.get("/__dev/data/:id", async (c) => {
  devOnly(c.get("config"));
  const id = c.req.param("id");
  const [docs, usage] = await c.env.DB.batch<{ n: number }>([
    c.env.DB.prepare("SELECT count(*) AS n FROM artifact_docs WHERE artifact_id = ?1").bind(id),
    c.env.DB.prepare("SELECT count(*) AS n FROM artifact_data_usage WHERE artifact_id = ?1").bind(
      id,
    ),
  ]);
  return c.json({ docs: docs?.results[0]?.n ?? 0, usage_rows: usage?.results[0]?.n ?? 0 });
});
