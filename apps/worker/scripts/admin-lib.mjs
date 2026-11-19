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
// R2 keys Plinth writes: artifacts/<id>/v<n>[.<nonce>]/<asset path> (the nonce on versions written
// from 0.4.0 on); asset paths are validated on publish.
const KEY_RE = /^artifacts\/[a-z0-9]+\/v[0-9]+(\.[a-z0-9]{12})?\/[A-Za-z0-9._\-/]+$/;
const isPlinthKey = (key) =>
  KEY_RE.test(key) && !key.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
// A version prefix: artifacts/<id>/v<n>[.<nonce>]/
const PREFIX_RE = /^artifacts\/([a-z0-9]+)\/v[0-9]+(\.[a-z0-9]{12})?\/$/;
// A manifest entry's stored_at (packages/shared/src/constants.ts STORED_AT_RE), relative to the
// artifact's root. The path part is checked by isPlinthKey once joined.
const STORED_AT_RE = /^v([1-9][0-9]{0,8})(?:\.([a-z0-9]{12}))?\/(.+)$/;
const ARTIFACT_ID_RE = /^[a-z0-9]{20}$/;
const MINUTES_RE = /^[1-9][0-9]{0,5}$/;
/**
 * The lowest --older-than-minutes sweep-orphans accepts. A live attempt prefix must be older than
 * the threshold before it can be swept. A bundle must arrive within its receiving lease
 * (TTL.uploadReceivingMs, 10 minutes, enforced by redeemBundle), and a ticket can commit only
 * while it is open and unexpired (TTL.uploadTicketMs, 30 minutes, checked in the commit batch).
 * The floor sits above the ticket's whole lifetime with a margin, so it holds even if the
 * stream deadline were missed: 30 + 15 minutes.
 */
export const MIN_SWEEP_MINUTES = 45;

/**
 * started_at for the staging attempt rows of an erased artifact, by D1's clock: a tombstone
 * (services/attempts.ts tombstoneAt) that the Worker's sweep takes only once no attempt still
 * running can put any more (STAGING_SWEEP_AFTER_MS minus STAGING_SWEEP_CLAIM_MS, 35 minutes, from
 * now), and then deletes what it put after the erase.
 */
export const TOMBSTONE_SQL = "'0' || strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+35 minutes')";

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
  bump-epochs --category-shared   End every content pass and room socket opened through a
                                  category share at once (after ALLOW_CATEGORY_SHARING is
                                  turned off; passes issued earlier otherwise live out their
                                  12-hour lifetime).
  sweep-orphans                   Delete stored files no version points to, across the whole
                                  bucket. The Worker's hourly cron already removes what an
                                  interrupted publish left (its staging_attempts rows); this is
                                  for files no row names, such as those written before 0.4.0.
                                  Only prefixes whose
                                  newest file is older than --older-than-minutes (default 60,
                                  at least ${MIN_SWEEP_MINUTES}). The bucket is the FILES binding of the
                                  same wrangler config and environment as the database. Refuses
                                  when the database names no version, or none of its versions is
                                  in the bucket (a database and bucket of different instances).
    [--artifact <id|slug>]        Only this artifact's files.

Options (one of --local or --remote is required):
  --local            Run against the local D1 database and R2 bucket used by wrangler dev
  --remote           Run against the deployed database and bucket
  --env <name>       Wrangler environment (for example staging)
  --config <file>    Wrangler config, e.g. wrangler.production.jsonc (relative to apps/worker)
  --bucket <name>    Check the R2 bucket: refuse unless the config's FILES binding names it
                     (the bucket always comes from --config and --env)
  --dry-run          Erase and sweep: list what would be deleted and change nothing
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
  let bucket = null;
  let dryRun = false;
  let artifact = null;
  let olderThanMinutes = 60;
  let categoryShared = false;
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
    } else if (a === "--category-shared") {
      categoryShared = true;
    } else if (a === "--artifact") {
      i += 1;
      artifact = validateArtifactRef(args[i]);
    } else if (a === "--older-than-minutes") {
      i += 1;
      if (!MINUTES_RE.test(String(args[i] ?? "")) || Number(args[i]) < MIN_SWEEP_MINUTES)
        throw new UsageError(
          `--older-than-minutes needs a whole number of minutes, ${MIN_SWEEP_MINUTES} or more (an upload ticket may still commit for 30 minutes)`,
        );
      olderThanMinutes = Number(args[i]);
    } else if (a.startsWith("-")) {
      throw new UsageError(`Unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  const [command, ...rest] = positional;
  const wranglerExtra = [...(env ? ["--env", env] : []), ...(config ? ["--config", config] : [])];
  if (command === "sweep-orphans") {
    if (rest.length !== 0) throw new UsageError("sweep-orphans takes no arguments; use --artifact");
    if (!target) throw new UsageError("Pass --local or --remote to choose the database");
    return {
      help: false,
      command,
      target,
      dryRun,
      artifact,
      bucket,
      env,
      config,
      minAgeMs: olderThanMinutes * 60_000,
      prefixesArgs: [
        "d1",
        "execute",
        "DB",
        `--${target}`,
        "--json",
        "--command",
        versionPrefixesSql(artifact),
        ...wranglerExtra,
      ],
    };
  }
  if (artifact !== null) throw new UsageError("--artifact is for sweep-orphans");
  if (command === "bump-epochs") {
    if (rest.length !== 0 || !categoryShared) {
      throw new UsageError("bump-epochs takes --category-shared and no arguments");
    }
    if (!target) throw new UsageError("Pass --local or --remote to choose the database");
    const sql = bumpCategorySharedEpochsSql();
    return {
      help: false,
      command,
      target,
      sql,
      wranglerArgs: [
        "d1",
        "execute",
        "DB",
        `--${target}`,
        "--json",
        "--command",
        sql,
        ...wranglerExtra,
      ],
    };
  }
  if (categoryShared) throw new UsageError("--category-shared is for bump-epochs");
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
      bucket,
      env,
      config,
      keysArgs: sqlArgs(keysSql),
      eraseArgs: sqlArgs(eraseSql),
      deleteObjectArgs: (bucketName, key) => [
        "r2",
        "object",
        "delete",
        `${bucketName}/${key}`,
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

/**
 * bump-epochs --category-shared: a new access epoch for every artifact reviewed as shared into a
 * category share, so content passes, password passes and room sockets issued through a share end
 * now (docs/self-hosting.md, ALLOW_CATEGORY_SHARING). Rows the owner or a direct grant opens get
 * new passes on their next visit.
 */
export function bumpCategorySharedEpochsSql() {
  return "UPDATE artifacts SET access_epoch = access_epoch + 1 WHERE category_review = 'shared' AND deleted_at IS NULL RETURNING id";
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

/**
 * Every stored version of the artifacts a person owns: r2_prefix plus the file manifest, and every
 * artifact of theirs (a LEFT JOIN, so one with no version row still names its id and its whole
 * root is removed).
 */
export function userKeysSql(email) {
  return `SELECT a.id AS artifact_id, v.r2_prefix AS prefix, v.manifest AS manifest FROM artifacts a JOIN users u ON u.id = a.owner_id LEFT JOIN versions v ON v.artifact_id = a.id WHERE u.email = '${email}'`;
}

export function artifactKeysSql(ref) {
  return `SELECT a.id AS artifact_id, v.r2_prefix AS prefix, v.manifest AS manifest FROM artifacts a LEFT JOIN versions v ON v.artifact_id = a.id WHERE a.id = '${ref}' OR a.slug = '${ref}'`;
}

/** The version prefixes the database names: every artifact's, or one artifact's (id or slug). */
export function versionPrefixesSql(ref) {
  return ref === null
    ? "SELECT v.artifact_id AS artifact_id, v.r2_prefix AS prefix FROM versions v"
    : `SELECT a.id AS artifact_id, v.r2_prefix AS prefix FROM artifacts a LEFT JOIN versions v ON v.artifact_id = a.id WHERE a.id = '${ref}' OR a.slug = '${ref}'`;
}

/**
 * Erase a person. Deleting the user cascades (migrations/0001_init.sql) to their artifacts with all
 * versions, grants, comments, mention tasks and reports on them, their connections, OAuth grants
 * and sessions. Before that: comments they wrote on other people's artifacts, grants to their
 * address, codes and viewer sessions for it, rate-limit counters naming it, their address on
 * reports, shared-data documents they created (personal ones included) and their name, role and
 * agent connection label on documents they last changed. Their artifacts' staging attempt rows (no
 * foreign key) become tombstones: the files go with each artifact's root, and the Worker's sweep
 * deletes what an attempt still running puts after that, then the rows. The last statement
 * returns the erased user, so the CLI can tell whether one matched.
 */
export function eraseUserSql(email) {
  return ERASE_USER_STEPS.map((s) => s.sql(email)).join("; ");
}

/**
 * The statements of eraseUserSql, one per line, in order: each names the table it changes. A
 * feature whose table holds a person's id or address adds its step before the last one, unless a
 * foreign key to users already cascades or sets it null (a schema test checks every table).
 */
export const ERASE_USER_STEPS = [
  {
    table: "staging_attempts",
    sql: (email) =>
      `UPDATE staging_attempts SET started_at = ${TOMBSTONE_SQL} WHERE artifact_id IN (SELECT a.id FROM artifacts a JOIN users u ON u.id = a.owner_id WHERE u.email = '${email}')`,
  },
  {
    table: "comments",
    sql: (email) =>
      `DELETE FROM comments WHERE author_user_id IN (SELECT id FROM users WHERE email = '${email}')`,
  },
  { table: "access_grants", sql: (email) => `DELETE FROM access_grants WHERE email = '${email}'` },
  // Category shares of other people's that hold this address (0013_category_sharing); the
  // person's own shares, and their personal categories, cascade with the users row.
  {
    table: "category_grants",
    sql: (email) => `DELETE FROM category_grants WHERE email = '${email}'`,
  },
  { table: "login_codes", sql: (email) => `DELETE FROM login_codes WHERE email = '${email}'` },
  { table: "sessions", sql: (email) => `DELETE FROM sessions WHERE viewer_email = '${email}'` },
  {
    table: "rate_limits",
    sql: (email) => `DELETE FROM rate_limits WHERE instr(key, '${email}') > 0`,
  },
  {
    table: "reports",
    sql: (email) => `UPDATE reports SET reporter_email = NULL WHERE reporter_email = '${email}'`,
  },
  // Shared data on other people's artifacts (their own artifacts' data cascades with them).
  {
    table: "artifact_docs",
    sql: (email) => `DELETE FROM artifact_docs WHERE created_by_email = '${email}'`,
  },
  {
    table: "artifact_docs",
    sql: (email) =>
      `UPDATE artifact_docs SET updated_by_email = NULL, updated_by_role = NULL, updated_by_label = NULL WHERE updated_by_email = '${email}'`,
  },
  // Files they added to other people's pages (0014_artifact_files): tombstones without their name
  // or address, whose objects the Worker's hourly sweep deletes. Their own artifacts' files go
  // with each artifact's root and rows.
  {
    table: "artifact_files",
    sql: (email) =>
      `UPDATE artifact_files SET state = 'deleting', claimed_at = NULL, name = '', created_by_email = NULL, created_by_role = NULL WHERE created_by_email = '${email}'`,
  },
  // Unsaved page edits on other people's docs keep their text, not who made them.
  {
    table: "live_drafts",
    sql: (email) =>
      `UPDATE live_drafts SET updated_by_user = NULL WHERE updated_by_user IN (SELECT id FROM users WHERE email = '${email}')`,
  },
  { table: "users", sql: (email) => `DELETE FROM users WHERE email = '${email}' RETURNING id` },
];

/**
 * Tables with a person's address that erase-user leaves alone, and why. Everything else with an
 * address or a user id has a step above or a foreign key to users that cascades or sets null.
 */
export const ERASE_USER_KEPT = {
  dev_outbox: "development only: the console email provider's outbox, never written in production",
};

/**
 * Erase one artifact; its versions, grants, comments, tasks, reports and update tickets cascade.
 * The ticket that published it names it only in result_artifact_id (no foreign key) and holds
 * the title the agent gave, so it goes first. Its staging attempt rows (no foreign key either)
 * become tombstones, as in eraseUserSql. The last statement's rows say what was erased.
 */
export function eraseArtifactSql(ref) {
  return ERASE_ARTIFACT_STEPS.map((s) => s.sql(ref)).join("; ");
}

/**
 * The statements of eraseArtifactSql, one per line, in order. A feature whose table names an
 * artifact without a foreign key that cascades adds its step before the last one.
 */
export const ERASE_ARTIFACT_STEPS = [
  {
    table: "staging_attempts",
    sql: (ref) =>
      `UPDATE staging_attempts SET started_at = ${TOMBSTONE_SQL} WHERE artifact_id IN (SELECT id FROM artifacts WHERE id = '${ref}' OR slug = '${ref}')`,
  },
  {
    table: "upload_tickets",
    sql: (ref) =>
      `DELETE FROM upload_tickets WHERE result_artifact_id IN (SELECT id FROM artifacts WHERE id = '${ref}' OR slug = '${ref}')`,
  },
  {
    table: "artifacts",
    sql: (ref) => `DELETE FROM artifacts WHERE id = '${ref}' OR slug = '${ref}' RETURNING id`,
  },
];

/**
 * The R2 bucket the wrangler config binds as FILES (`r2_buckets` of the config wrangler resolved
 * for --config and --env, the same resolution `wrangler d1 execute` uses for the database). With
 * `explicit` (--bucket), refuse unless it is that bucket.
 */
export function filesBucket(r2Buckets, explicit) {
  const found = (Array.isArray(r2Buckets) ? r2Buckets : []).find((b) => b?.binding === "FILES");
  const name = found?.bucket_name;
  if (typeof name !== "string" || !BUCKET_RE.test(name)) {
    throw new UsageError(
      "The wrangler config (with --config and --env) binds no FILES bucket; pass the config and environment the database belongs to",
    );
  }
  if (explicit !== null && explicit !== undefined && explicit !== name) {
    throw new UsageError(
      `--bucket ${explicit} is not the bucket this config and environment use (${name}); refusing, since the database and the bucket would belong to different instances`,
    );
  }
  return name;
}

/**
 * Result rows of every statement in `wrangler d1 execute --json` output, or null when the output
 * is not that (unparseable, or a statement without a results array). Callers that delete what the
 * rows do not name must use this, never resultSets, so a garbled answer cannot read as "no rows".
 */
export function parseResultSets(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0 || !list.every((r) => Array.isArray(r?.results))) return null;
  return list.map((r) => r.results);
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

/** `artifacts/<id>/` for a version prefix, or null when the prefix is not in Plinth's layout. */
export function artifactRootOf(prefix) {
  const m = PREFIX_RE.exec(String(prefix ?? ""));
  return m ? `artifacts/${m[1]}/` : null;
}

/**
 * The R2 keys of the stored versions in `rows` ({prefix, manifest}). An entry with `stored_at`
 * names its object relative to the artifact's root (a file reused from an earlier version);
 * others sit under the row's prefix. Unexpected keys are skipped.
 */
export function keysFromRows(rows) {
  const keys = new Set();
  for (const row of rows) {
    if (typeof row?.prefix !== "string" || typeof row?.manifest !== "string") continue;
    const root = artifactRootOf(row.prefix);
    if (!root) continue;
    let entries = [];
    try {
      entries = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    for (const e of Array.isArray(entries) ? entries : []) {
      const storedAt = e?.stored_at;
      let key;
      if (storedAt === undefined) key = `${row.prefix}${e?.path ?? ""}`;
      else if (typeof storedAt === "string" && STORED_AT_RE.test(storedAt))
        key = `${root}${storedAt}`;
      else continue;
      if (isPlinthKey(key)) keys.add(key);
    }
  }
  return [...keys];
}

/** The artifact roots (`artifacts/<id>/`) that rows ({artifact_id}) name. */
export function rootsFromRows(rows) {
  const roots = new Set();
  for (const row of rows) {
    const id = row?.artifact_id;
    if (typeof id === "string" && ARTIFACT_ID_RE.test(id)) roots.add(`artifacts/${id}/`);
  }
  return [...roots];
}

/** Every object under a prefix of an R2 bucket binding ({key, uploaded}). */
export async function listObjects(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const o of page.objects) out.push({ key: o.key, uploaded: o.uploaded });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Group objects by version prefix (`artifacts/<id>/<segment>/`) and keep the prefixes no version
 * row names whose newest object is older than `minAgeMs`: what an interrupted publish left behind.
 * A prefix still being written (a publish in flight) is younger than that and is left alone.
 */
export function orphanPrefixes(objects, referenced, { now, minAgeMs }) {
  const groups = new Map();
  for (const o of objects) {
    const parts = String(o.key).split("/");
    if (parts.length < 4 || parts[0] !== "artifacts") continue;
    const prefix = `${parts[0]}/${parts[1]}/${parts[2]}/`;
    if (!PREFIX_RE.test(prefix)) continue;
    const g = groups.get(prefix) ?? { prefix, keys: [], newest: 0 };
    g.keys.push(o.key);
    const t = new Date(o.uploaded).getTime();
    if (Number.isFinite(t) && t > g.newest) g.newest = t;
    groups.set(prefix, g);
  }
  return [...groups.values()].filter((g) => !referenced.has(g.prefix) && now - g.newest > minAgeMs);
}

/** sweep-orphans would delete what it cannot tell apart from live files; nothing was deleted. */
export class SweepRefused extends Error {}

/**
 * sweep-orphans against an R2 bucket binding; `root` is `artifacts/` or one artifact's root.
 * The bucket is listed first and `loadRows` (versionPrefixesSql results) is read after, so a
 * version that commits while the sweep runs is in the rows. Fails closed: when the rows name no
 * version, or none of the versions they name is in the bucket, it throws SweepRefused and deletes
 * nothing. Returns what was (or, with dryRun, would be) deleted.
 */
export async function sweepOrphans(bucket, { root, now, minAgeMs, dryRun, loadRows }) {
  const objects = await listObjects(bucket, root);
  if (objects.length === 0) return [];
  const rows = await loadRows();
  if (!Array.isArray(rows)) throw new SweepRefused("The database answer could not be read");
  const referenced = new Set(
    rows.map((r) => r?.prefix).filter((p) => typeof p === "string" && PREFIX_RE.test(p)),
  );
  if (referenced.size === 0) {
    throw new SweepRefused(
      `The database names no stored version${root === "artifacts/" ? "" : ` under ${root}`}, so every file would count as orphaned`,
    );
  }
  const listed = new Set(
    orphanPrefixes(objects, new Set(), { now, minAgeMs: -Infinity }).map((g) => g.prefix),
  );
  if (![...referenced].some((p) => listed.has(p))) {
    throw new SweepRefused(
      `None of the ${referenced.size} version(s) the database names is in this bucket, so the database and the bucket belong to different instances`,
    );
  }
  const orphans = orphanPrefixes(objects, referenced, { now, minAgeMs });
  if (!dryRun) {
    for (const g of orphans) {
      for (let i = 0; i < g.keys.length; i += 1000) await bucket.delete(g.keys.slice(i, i + 1000));
    }
  }
  return orphans.map((g) => ({ prefix: g.prefix, files: g.keys.length }));
}

/** Delete every object under each root (erase: files no version row names go too). */
export async function deleteRoots(bucket, roots) {
  let n = 0;
  for (const root of roots) {
    if (!/^artifacts\/[a-z0-9]{20}\/$/.test(root)) continue;
    const keys = (await listObjects(bucket, root)).map((o) => o.key);
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    n += keys.length;
  }
  return n;
}
