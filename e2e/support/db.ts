// Direct access to the e2e Worker's local D1 (e2e/.wrangler-state), for test setup that should not
// depend on the UI or hit sign-in rate limits. Uses `wrangler d1 execute --local`, which works
// while `wrangler dev` runs on the same state directory.
import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { promisify } from "node:util";
import { STATE_DIR, WORKER_DIR, WRANGLER } from "./paths.ts";

const run = promisify(execFile);

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz0123456789";
const random = (n: number, alphabet: string) =>
  Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join("");

/** SQL string literal. */
export const sql = (v: string | null) => (v === null ? "NULL" : `'${v.replaceAll("'", "''")}'`);

/**
 * Run SQL against the e2e database; returns the rows of the last statement. Parallel test workers
 * can briefly lock the SQLite file, so a failed call is retried a few times.
 */
export async function d1<T = Record<string, unknown>>(statement: string): Promise<T[]> {
  const args = ["d1", "execute", "DB", "--local", "--persist-to", STATE_DIR, "--json"];
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { stdout } = await run(WRANGLER, [...args, "--command", statement], {
        cwd: WORKER_DIR,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      });
      const out = JSON.parse(stdout) as { results: T[] }[];
      return out.at(-1)?.results ?? [];
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 200 + randomInt(400) * (attempt + 1)));
    }
  }
  const err = last as { stderr?: string; stdout?: string; message?: string };
  throw new Error(`d1 execute failed: ${err.stderr || err.stdout || err.message}`);
}

const userInsert = (email: string, name: string | null, now: string) =>
  "INSERT INTO users (id, email, name, email_verified_at, is_admin, created_at) " +
  `VALUES (${sql(random(20, LOWER))}, ${sql(email)}, ${sql(name)}, ${sql(now)}, 0, ${sql(now)}) ` +
  "ON CONFLICT(email) DO NOTHING;";

/** Create a verified user if missing. Returns the user's id. */
export async function seedUser(email: string, opts: { name?: string } = {}): Promise<string> {
  const e = email.toLowerCase();
  const rows = await d1<{ id: string }>(
    `${userInsert(e, opts.name ?? null, new Date().toISOString())} ` +
      `SELECT id FROM users WHERE email = ${sql(e)};`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`could not create user ${email}`);
  return id;
}

export interface SeededToken {
  token: string;
  userId: string;
  connectionId: string;
}

/**
 * A personal access token for `email` (the user is created if missing), stored as its SHA-256
 * hash exactly as the Worker stores tokens. One d1 call.
 */
export async function seedToken(
  email: string,
  opts: { label?: string; clientType?: "claude" | "codex" | "other"; scopes?: string } = {},
): Promise<SeededToken> {
  const e = email.toLowerCase();
  const now = new Date().toISOString();
  const token = `plinth_pat_${random(40, BASE62)}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const connectionId = random(20, LOWER);
  const rows = await d1<{ id: string }>(
    `${userInsert(e, null, now)} ` +
      "INSERT INTO agent_connections " +
      "(id, user_id, label, client_type, kind, token_hash, scopes, created_at) " +
      `SELECT ${sql(connectionId)}, id, ${sql(opts.label ?? "E2E token")}, ` +
      `${sql(opts.clientType ?? "other")}, 'token', ${sql(hash)}, ` +
      `${sql(opts.scopes ?? "artifacts:read artifacts:write mentions")}, ${sql(now)} ` +
      `FROM users WHERE email = ${sql(e)}; ` +
      `SELECT user_id AS id FROM agent_connections WHERE id = ${sql(connectionId)};`,
  );
  const userId = rows[0]?.id;
  if (!userId) throw new Error(`could not create a token for ${email}`);
  return { token, userId, connectionId };
}
