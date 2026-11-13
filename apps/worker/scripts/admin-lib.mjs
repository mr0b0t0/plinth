// Pure helpers for the admin CLI (scripts/admin.mjs): argument parsing and SQL building. Kept free
// of Node imports so the Workers test pool can import and test them.
//
// The SQL is built from strictly validated values only: the email must match a conservative
// address pattern (no quotes, spaces or semicolons) and the limit must be a plain integer. Nothing
// else from the command line reaches the SQL text.

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const LIMIT_RE = /^(0|[1-9][0-9]{0,8})$/;
const ENV_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const USAGE = `Usage: pnpm --filter @plinth/worker admin -- <command> [options]

Commands:
  set-limit <email> <n|default>   Set a user's artifact quota (users.artifact_limit).
                                  "default" clears the override (MAX_ARTIFACTS_PER_USER applies).

Options (one of --local or --remote is required):
  --local          Run against the local D1 database used by wrangler dev
  --remote         Run against the deployed D1 database
  --env <name>     Wrangler environment (for example staging)
  -h, --help       Show this help`;

export class UsageError extends Error {}

/** Lowercase and check an email strictly; throws UsageError if it is not plain. */
export function validateEmail(raw) {
  const email = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new UsageError(`Not a plain email address: ${JSON.stringify(String(raw ?? ""))}`);
  }
  return email;
}

/** A non-negative integer, or null for "default". Throws UsageError otherwise. */
export function validateLimit(raw) {
  const s = String(raw ?? "").trim();
  if (s.toLowerCase() === "default") return null;
  if (!LIMIT_RE.test(s)) {
    throw new UsageError(
      `Limit must be a whole number (0-999999999) or "default", got ${JSON.stringify(s)}`,
    );
  }
  return Number(s);
}

/**
 * The SQL for set-limit. Inputs must already be validated. RETURNING lets the CLI tell whether a
 * user matched (local wrangler output has no change count).
 */
export function setLimitSql(email, limit) {
  const value = limit === null ? "NULL" : String(limit);
  return `UPDATE users SET artifact_limit = ${value} WHERE email = '${email}' RETURNING email`;
}

/**
 * Parse argv (without node and the script path). Returns the command, its validated values, the
 * target (local or remote), and the wrangler arguments to run.
 */
export function parseArgs(argv) {
  const args = argv.filter((a) => a !== "--");
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) return { help: true };
  let target = null;
  let env = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--local" || a === "--remote") {
      const t = a.slice(2);
      if (target && target !== t) throw new UsageError("Pass only one of --local or --remote");
      target = t;
    } else if (a === "--env") {
      i += 1;
      env = args[i];
      if (!env || !ENV_RE.test(env))
        throw new UsageError("--env needs a wrangler environment name");
    } else if (a.startsWith("-")) {
      throw new UsageError(`Unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  const [command, ...rest] = positional;
  if (command !== "set-limit") {
    throw new UsageError(`Unknown command ${JSON.stringify(command ?? "")}`);
  }
  if (rest.length !== 2) throw new UsageError("set-limit needs <email> and <n|default>");
  if (!target) throw new UsageError("Pass --local or --remote to choose the database");
  const email = validateEmail(rest[0]);
  const limit = validateLimit(rest[1]);
  const sql = setLimitSql(email, limit);
  const wranglerArgs = ["d1", "execute", "DB", `--${target}`, "--json", "--command", sql];
  if (env) wranglerArgs.push("--env", env);
  return { help: false, command, email, limit, target, sql, wranglerArgs };
}

/** Rows updated (rows RETURNING gave back), from `wrangler d1 execute --json` output. */
export function changesFromOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (Array.isArray(first?.results)) return first.results.length;
    const n = first?.meta?.changes;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}
