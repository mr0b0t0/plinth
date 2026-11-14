// Pure helpers for the admin CLI (scripts/admin.mjs): argument parsing and SQL building. Kept free
// of Node imports so the Workers test pool can import and test them.
//
// The SQL is built from strictly validated values only: the email must match a conservative
// address pattern (no quotes, spaces or semicolons) and the limit must be a plain integer. Nothing
// else from the command line reaches the SQL text.

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const LIMIT_RE = /^(0|[1-9][0-9]{0,8})$/;
const ENV_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REF_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONFIG_RE = /^[A-Za-z0-9._/-]{1,200}\.jsonc?$/;
// R2 keys Plinth writes: artifacts/<id>/v<n>/<asset path>; asset paths are validated on publish.
const KEY_RE = /^artifacts\/[a-z0-9]+\/v[0-9]+\/[A-Za-z0-9._\-/]+$/;
const isPlinthKey = (key) =>
  KEY_RE.test(key) && !key.split("/").some((seg) => seg === "" || seg === "." || seg === "..");

export const USAGE = `Usage: pnpm --filter @plinth/worker admin -- <command> [options]

Commands:
  set-limit <email> <n|default>   Set a user's artifact quota (users.artifact_limit).
                                  "default" clears the override (MAX_ARTIFACTS_PER_USER applies).
  erase-user <email>              Erase a person for good (a privacy request): their account,
                                  every artifact they own with all versions and stored files,
                                  their comments, connections and sessions, sharing entries for
                                  their address, and their address on reports.
  erase-artifact <id|slug>        Erase one artifact for good: all versions, stored files,
                                  comments, sharing and reports. Works on deleted artifacts too.

Options (one of --local or --remote is required):
  --local            Run against the local D1 database and R2 bucket used by wrangler dev
  --remote           Run against the deployed database and bucket
  --env <name>       Wrangler environment (for example staging)
  --config <file>    Wrangler config, e.g. wrangler.production.jsonc (relative to apps/worker)
  --bucket <name>    R2 bucket (erase commands; default plinth-files)
  --dry-run          Erase commands: list what would be erased and change nothing
  -h, --help         Show this help`;

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
  let config = null;
  let bucket = "plinth-files";
  let dryRun = false;
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
    } else if (a === "--config") {
      i += 1;
      config = args[i];
      if (!config || !CONFIG_RE.test(config) || config.includes(".."))
        throw new UsageError("--config needs a wrangler config file name");
    } else if (a === "--bucket") {
      i += 1;
      bucket = args[i];
      if (!bucket || !BUCKET_RE.test(bucket)) throw new UsageError("--bucket needs a bucket name");
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a.startsWith("-")) {
      throw new UsageError(`Unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  const [command, ...rest] = positional;
  if (command === "erase-user" || command === "erase-artifact") {
    if (rest.length !== 1) throw new UsageError(`${command} needs exactly one argument`);
    if (!target) throw new UsageError("Pass --local or --remote to choose the database");
    const subject =
      command === "erase-user" ? validateEmail(rest[0]) : validateArtifactRef(rest[0]);
    const extra = [...(env ? ["--env", env] : []), ...(config ? ["--config", config] : [])];
    const sqlArgs = (sql) => [
      "d1",
      "execute",
      "DB",
      `--${target}`,
      "--json",
      "--command",
      sql,
      ...extra,
    ];
    const [keysSql, eraseSql] =
      command === "erase-user"
        ? [userKeysSql(subject), eraseUserSql(subject)]
        : [artifactKeysSql(subject), eraseArtifactSql(subject)];
    return {
      help: false,
      command,
      subject,
      target,
      dryRun,
      keysArgs: sqlArgs(keysSql),
      eraseArgs: sqlArgs(eraseSql),
      deleteObjectArgs: (key) => [
        "r2",
        "object",
        "delete",
        `${bucket}/${key}`,
        `--${target}`,
        ...extra,
      ],
    };
  }
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
  if (config) wranglerArgs.push("--config", config);
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

/** An artifact id or slug: lowercase letters, digits and dashes only. */
export function validateArtifactRef(raw) {
  const ref = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!REF_RE.test(ref))
    throw new UsageError(`Not an artifact id or slug: ${JSON.stringify(String(raw ?? ""))}`);
  return ref;
}

/** Every stored version of the artifacts a person owns: r2_prefix plus the file manifest. */
export function userKeysSql(email) {
  return `SELECT v.r2_prefix AS prefix, v.manifest AS manifest FROM versions v JOIN artifacts a ON a.id = v.artifact_id JOIN users u ON u.id = a.owner_id WHERE u.email = '${email}'`;
}

export function artifactKeysSql(ref) {
  return `SELECT v.r2_prefix AS prefix, v.manifest AS manifest FROM versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.id = '${ref}' OR a.slug = '${ref}'`;
}

/**
 * Erase a person. Deleting the user cascades (migrations/0001_init.sql) to their artifacts with all
 * versions, grants, comments, mention tasks and reports on them, their connections, OAuth grants
 * and sessions. Before that: comments they wrote on other people's artifacts, grants to their
 * address, codes and viewer sessions for it, rate-limit counters naming it, their address on
 * reports, shared-data documents they created (personal ones included) and their name, role and
 * agent connection label on documents they last changed. The last statement returns the erased user, so the CLI can tell whether one matched.
 */
export function eraseUserSql(email) {
  return [
    `DELETE FROM comments WHERE author_user_id IN (SELECT id FROM users WHERE email = '${email}')`,
    `DELETE FROM access_grants WHERE email = '${email}'`,
    `DELETE FROM login_codes WHERE email = '${email}'`,
    `DELETE FROM sessions WHERE viewer_email = '${email}'`,
    `DELETE FROM rate_limits WHERE instr(key, '${email}') > 0`,
    `UPDATE reports SET reporter_email = NULL WHERE reporter_email = '${email}'`,
    // Shared data on other people's artifacts (their own artifacts' data cascades with them).
    `DELETE FROM artifact_docs WHERE created_by_email = '${email}'`,
    `UPDATE artifact_docs SET updated_by_email = NULL, updated_by_role = NULL, updated_by_label = NULL WHERE updated_by_email = '${email}'`,
    `DELETE FROM users WHERE email = '${email}' RETURNING id`,
  ].join("; ");
}

/** Erase one artifact; its versions, grants, comments, tasks and reports cascade. */
export function eraseArtifactSql(ref) {
  return `DELETE FROM artifacts WHERE id = '${ref}' OR slug = '${ref}' RETURNING id`;
}

/** Result rows of every statement in `wrangler d1 execute --json` output. */
export function resultSets(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((r) =>
      Array.isArray(r?.results) ? r.results : [],
    );
  } catch {
    return [];
  }
}

/** The R2 keys of the stored versions in `rows` ({prefix, manifest}). Unexpected keys are skipped. */
export function keysFromRows(rows) {
  const keys = new Set();
  for (const row of rows) {
    let entries = [];
    try {
      entries = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    for (const e of Array.isArray(entries) ? entries : []) {
      const key = `${row.prefix}${e?.path ?? ""}`;
      if (isPlinthKey(key)) keys.add(key);
    }
  }
  return [...keys];
}
