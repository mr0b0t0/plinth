// Development-only seeding for the end-to-end suite: users, personal access tokens and sessions,
// written through the Worker's own D1 connection (writing the local SQLite file from another
// process caused SQLITE_BUSY under parallel tests). Served only when ENVIRONMENT=development and
// DEV_SEED=true; it is an authentication bypass by design and must never run anywhere else.
// GET /__dev/data/:id is its read-side twin: an artifact's shared-data row counts, for checks no
// API can make once the artifact is gone (a takedown's wipe), without spawning wrangler.
// POST /__dev/capture-url mints what a thumbnail capture opens (the enter URL of a capture pass
// for one version, no identity, and the cookies its browser sets first), so the suite can load a
// page top-level as Plinth's own browser does. POST /__dev/export-url does the same for what a
// design export opens (services/designExport.ts).
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
import { exportLoad } from "../services/designExport.ts";
import { captureLoad } from "../services/thumbnails.ts";
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

const captureInput = z.object({
  artifact_id: z.string().regex(/^[a-z0-9]{20}$/),
  version: z.number().int().min(1),
});

/** What services/thumbnails.ts would open for this version, and the cookies it would set first. */
devSeed.post("/__dev/capture-url", async (c) => {
  const config = c.get("config");
  devOnly(config);
  const parsed = captureInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ApiError("invalid_input", "Invalid input", { issues: parsed.error.issues });
  const { artifact_id: id, version } = parsed.data;
  const row = await c.env.DB.prepare(
    "SELECT access_epoch AS e, type FROM artifacts WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(id)
    .first<{ e: number; type: string }>();
  if (!row) throw new ApiError("not_found", "Not found");
  const load = await captureLoad(config, {
    artifactId: id,
    accessEpoch: row.e,
    type: row.type,
    number: version,
  });
  return c.json(load, 201);
});

const exportInput = captureInput.extend({
  board: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .nullable()
    .default(null),
});

/**
 * What services/designExport.ts would open for a design export of this version (one board, or
 * every board with board null), and the cookies it would set first. No rate limit, no render: the
 * suite loads it in its own Chromium and prints or screenshots it as Browser Rendering would.
 */
devSeed.post("/__dev/export-url", async (c) => {
  const config = c.get("config");
  devOnly(config);
  const parsed = exportInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ApiError("invalid_input", "Invalid input", { issues: parsed.error.issues });
  const { artifact_id: id, version, board } = parsed.data;
  const row = await c.env.DB.prepare(
    "SELECT access_epoch AS e FROM artifacts WHERE id = ?1 AND deleted_at IS NULL AND type = 'design'",
  )
    .bind(id)
    .first<{ e: number }>();
  if (!row) throw new ApiError("not_found", "Not found");
  return c.json(
    await exportLoad(config, { artifactId: id, accessEpoch: row.e }, version, board),
    201,
  );
});
