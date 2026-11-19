// Data sources (docs/spec.md "Live data from the owner's agents"): where a page's figures come
// from. A source is owner-only metadata on an artifact, set by the owner's agent and confirmed by
// the signed-in owner; documents an owner's agent writes with `source` carry a copy of its label
// and connector. Plinth stores no credential and never fetches: agents push. Pure code (inputs,
// text rules, the secret check and the canonical config the confirmation hash covers), used by
// the Worker, the web app and tests.
import { z } from "zod";
import { CLIENT_TYPES, type ClientType, LIMITS } from "./constants.ts";
import { DATA_SOURCE_ID_RE, dataCollectionSchema } from "./data.ts";
import { artifactRefSchema } from "./schemas.ts";
import { REFUSED_CHARS } from "./text.ts";

/** Who may ask for a refresh of a source (data_sources.requestable_by); `editor` by default. */
export const REQUESTABLE_BY = ["owner", "editor", "commenter", "viewer"] as const;
export type RequestableBy = (typeof REQUESTABLE_BY)[number];

/**
 * `active` while the owner's confirmation covers the source's current config (confirmed_hash
 * equals config_hash); `awaiting_confirmation` after an agent set or changed it, or after the
 * connection it was pinned to was revoked.
 */
export const SOURCE_STATUSES = ["active", "awaiting_confirmation"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** The confirmation hash: 32 lowercase hex characters (the first half of a SHA-256). */
export const SOURCE_HASH_RE = /^[0-9a-f]{32}$/;

// ---------- text rules ----------

/** A label or connector as stored: NFC, every whitespace run -> one space, trimmed. */
export function normalizeSourceText(s: string): string {
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** A recipe as stored: NFC, line breaks as \n, spaces at the ends of the whole text trimmed. */
export function normalizeRecipe(s: string): string {
  return s.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

/**
 * A piece of a long run that reads as a word or an identifier, not as random characters: a word
 * (capitalised or camel case), an upper-case code with digits (`ENG`, `Q4`, `2026`) or lower-case
 * letters and digits (`v2`, a Notion page id). Written without nested quantifiers that could
 * backtrack.
 */
const WORDLIKE_PIECE = /^(?:[A-Z]?[a-z]+(?:[A-Z][a-z]+)*|[A-Z0-9]+|[a-z0-9]+)$/;

/**
 * A long run of key-like characters is taken for a credential when it mixes upper case, lower
 * case and digits, unless every piece between its separators (`-`, `_`, `/`, `+`, `=`) reads as
 * a word or an identifier. So a path such as `/acme/issue/ENG-123/fix-the-login-redirect` or a
 * Notion page name passes, and a random key, with or without the odd separator, does not.
 */
function keyLikeRun(run: string): boolean {
  if (!(/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run))) return false;
  return !run
    .split(/[-_/+=]+/)
    .filter((piece) => piece.length > 0)
    .every((piece) => WORDLIKE_PIECE.test(piece));
}

/** A URL of any scheme (`https:`, `postgres:`, `mongodb+srv:`) up to its query or fragment. */
const URL_UP_TO_QUERY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*/gi;
/** The same URL in parts: scheme with `://`, authority, path, and the query when there is one. */
const URL_PARTS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)([^\s?#]*)(\?[^\s#]*)?/gi;
/** In a URL's path `/` separates segments, so a run stops there: base64url and `+`, `=`. */
const PATH_RUN = /[A-Za-z0-9_+=-]{40,}/g;
/** Anywhere else `/` stays in the run, so a standard-base64 key with slashes is one run. */
const TEXT_RUN = /[A-Za-z0-9_+/=-]{40,}/g;
/** 32 or more hex characters: a hex API key, an MD5-sized secret, a SHA-1 or a SHA-256. */
const HEX_RUN = /[0-9a-fA-F]{32,}/;

/**
 * Well-known credential prefixes, at the start of the text or after a character that is not a
 * letter or digit: OpenAI and Anthropic `sk-`, GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and
 * `github_pat_`, GitLab `glpat-`, Slack `xox?-`, AWS `AKIA` (and `ASIA` with its 16 characters),
 * a Google API key (`AIza` and 35 more), Stripe secret, restricted and webhook keys (`sk_live_`,
 * `rk_live_`, `sk_test_`, `rk_test_`, `whsec_`), and Plinth's own `plinth_`.
 */
const TOKEN_PREFIX =
  /(?:^|[^A-Za-z0-9])(?:sk-|gh[pousr]_|github_pat_|glpat-|xox[abprse]-|AKIA|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_|whsec_|plinth_)/;
/** Anthropic and OpenAI key prefixes in any case (`SK-ant-`); a bare `SK-` is a Jira key. */
const TOKEN_PREFIX_ANY_CASE = /(?:^|[^A-Za-z0-9])sk-(?:ant|proj|svcacct|admin)-/i;
/**
 * Where a credential word starts: the start of the text or any character that is not a letter or
 * a digit. `_` and `-` count, so `DB_PASSWORD=`, `db-password:` and `X_API_KEY=` are caught, which
 * a `\b` word boundary misses after an `_`.
 */
const WORD_START = "(?:^|[^A-Za-z0-9])";
/** A bearer token: `Bearer abc`. */
const BEARER = new RegExp(String.raw`${WORD_START}bearer\s+\S`, "i");
/** A header that carries a credential: `Authorization:` (Basic, Bearer or any) or `X-Api-Key`. */
const CREDENTIAL_HEADER = new RegExp(
  String.raw`${WORD_START}(?:(?:proxy[-_])?authorization\s*:|x[-_](?:api[-_]key|api[-_]token|auth[-_]token|access[-_]token)(?![A-Za-z0-9]))`,
  "i",
);
/**
 * A credential written as a field: `api_key=…`, `client_secret: …`, `DB_PASSWORD=…`, and a JSON
 * or YAML key in quotes (`"db_password": "…"`).
 */
const CREDENTIAL_FIELD = new RegExp(
  String.raw`${WORD_START}(?:api[-_]?key|api[-_]?token|access[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|password|passwd)["']?\s*[:=]\s*\S`,
  "i",
);
/**
 * A query or fragment parameter named like a secret, with or without a prefix: `?token=`,
 * `?client_secret=`, `#access_token=`, `&X-Amz-Signature=`. Each prefix piece ends with a
 * separator the piece cannot hold, so the match never backtracks.
 */
const SECRET_PARAM =
  /[?&;#](?:[A-Za-z0-9]+[_.-])*(?:token|key|secret|sig|signature|password|passwd|pwd|apikey|accesstoken|credential|auth)=/i;
/**
 * A token (text between whitespace) of the form `<non-space>:<non-space>@`: a `:` after its first
 * character and a later `@` with at least one character between them. That is the shape of every
 * `user:password@host`, with or without a scheme (`postgres://admin:pw@db`,
 * `admin:p(a)ss@db.internal`, `admin:pw@[::1]:5432`, `jdbc:oracle:thin:scott/tiger@//db`),
 * whatever characters the password holds: the check finds a `:` and an `@` by position, so no
 * character in the password can end it early. It also refuses some text without a password
 * (`mailto:sales@example.com`, `github:owner/repo@v1`, a URL with an `@` in its path), which a
 * recipe, a label or a connector never needs.
 */
function hasUserPasswordToken(text: string): boolean {
  for (const token of text.split(/\s+/u)) {
    const colon = token.indexOf(":", 1);
    if (colon >= 0 && token.indexOf("@", colon + 2) >= 0) return true;
  }
  return false;
}

/**
 * What follows the `@` of a pasted connection string: `//host`, a host with a port, an IPv6
 * address in brackets, an IPv4 address, `localhost`, or a dotted host whose last label is letters
 * (`db.internal`, `db_1.example.com`). A ref or a version (`@v4`, `@v1.2.3`, `@main`) is none of
 * these, so `actions/checkout@v4` passes.
 */
const HOST_AFTER_AT =
  /^(?:\/\/|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+:\d{1,5}(?![A-Za-z0-9])|\[[0-9A-Fa-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}(?![A-Za-z0-9.])|localhost(?![A-Za-z0-9.-])|(?:[A-Za-z0-9_-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9.-]))/;

/**
 * Oracle's `user/password@host` (EZConnect): a token with a `/` after its first character and a
 * later `@`, with at least one character between them, that a host follows (HOST_AFTER_AT). Found
 * by position like hasUserPasswordToken, so the password may hold any character.
 */
function hasOraclePasswordToken(text: string): boolean {
  for (const token of text.split(/\s+/u)) {
    const slash = token.indexOf("/", 1);
    if (slash < 0) continue;
    for (let at = token.indexOf("@", slash + 2); at >= 0; at = token.indexOf("@", at + 1)) {
      if (HOST_AFTER_AT.test(token.slice(at + 1))) return true;
    }
  }
  return false;
}

/**
 * An Oracle login with its password, whatever follows: a command-line tool's
 * `user/password[@alias]` (`sqlplus -s scott/tiger@orcl`, `rman target sys/pw@db`, `expdp
 * scott/tiger`), `userid=user/password`, and SQL*Plus `CONNECT user/password` ending at `@`, `;`
 * or the line's end. The password may start with any character but a space or an `@`. `sqlplus
 * /nolog`, `sqlplus / as sysdba` and `rman target /` hold none.
 */
const ORACLE_LOGIN = [
  /\b(?:sqlplus|sqlldr|expdp|impdp|rman|dgmgrl)(?:\s+-\S+)*\s+(?:(?:target|catalog|auxiliary)\s*=?\s*)?["']?[^\s"'/@=-][^\s"'/@=]*\/[^\s@]/i,
  /\buserid\s*=\s*["']?[^\s"'/@=]+\/[^\s@]/i,
  /\bconn(?:ect)?\s+["']?[^\s"'/@=]+\/[^\s@;]+(?=[@;]|[ \t]*$)/im,
];

// Each id may be followed by the punctuation of the sentence the link sits in ("…/edit).").
/** A Google Docs, Sheets, Slides, Forms or Drive id, the segment after `/d/`, `/e/` or `/folders/`. */
const GOOGLE_ID = /^[A-Za-z0-9_-]+[.,;:!)'"\]]*$/;
/** A full commit SHA (SHA-1 or SHA-256), the segment after `/commit/`, `/commits/`, `/blob/` or `/tree/`. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})[.,;:!)'"\]]*$/;
/** A Notion page id: 32 hex characters, the whole segment or the end of the page's name. */
const NOTION_ID = /(^|-)[0-9a-f]{32}(?=[.,;:!)'"\]]*$)/;
/** A Notion view or peeked page in the query: `v=`, `p=` or `pvs=` with 32 hex characters. */
const NOTION_QUERY_ID = /([?&](?:v|p|pvs)=)[0-9a-f]{32}(?=&|[.,;:!)'"\]]*$)/g;

/**
 * The text with the record ids of a few hosts blanked out, for the run checks only: Google Docs
 * and Drive ids on docs.google.com and drive.google.com, full commit SHAs in github.com and
 * gitlab.com links, and Notion page and view ids on notion.so and notion.site. Only a segment in
 * that place, on that host, is blanked, and the prefix, header and parameter checks still read
 * the text as it was.
 */
function withoutRecordIds(text: string): string {
  return text.replace(
    URL_PARTS,
    (all, scheme: string, authority: string, path: string, query: string | undefined) => {
      const host = authority.replace(/^.*@/, "").replace(/:\d*$/, "").toLowerCase();
      const google = host === "docs.google.com" || host === "drive.google.com";
      const code = host === "github.com" || host === "www.github.com" || host === "gitlab.com";
      const notion = /(?:^|\.)notion\.(?:so|site)$/.test(host);
      if (!google && !code && !notion) return all;
      const segments = path.split("/");
      const kept = segments.map((seg, i) => {
        const before = segments[i - 1] ?? "";
        if (google && ["d", "e", "folders"].includes(before) && GOOGLE_ID.test(seg)) return "-";
        if (code && ["commit", "commits", "blob", "tree"].includes(before) && COMMIT_SHA.test(seg))
          return "-";
        if (notion) return seg.replace(NOTION_ID, "$1-");
        return seg;
      });
      const q = notion && query ? query.replace(NOTION_QUERY_ID, "$1-") : (query ?? "");
      return `${scheme}${authority}${kept.join("/")}${q}`;
    },
  );
}

/**
 * Text that holds a key, a token or a signed parameter: a bearer header or any `Authorization:`
 * header, `X-Api-Key`, a well-known token prefix (TOKEN_PREFIX), a field such as `api_key=`,
 * `password:` or `DB_PASSWORD=`, a JWT, a query or fragment parameter named like a secret, a run
 * of 32 or more hex characters, or a run of 40 or more base64 or base64url characters that mixes
 * upper case, lower case and digits and does not read as words and identifiers (keyLikeRun). In a
 * URL's host and path each segment between slashes is a run of its own, so a link to a record
 * whose segments are short opaque ids (Airtable, Salesforce, Stripe) passes; elsewhere `/` joins
 * the run. In their own links, the ids of Google Docs and Drive, full commit SHAs on GitHub and
 * GitLab, and Notion page and view ids are not runs (withoutRecordIds). The user-and-password
 * shapes are looksLikeSecret's; a source_ref, always an http(s) link with its user info dropped,
 * takes only this check.
 */
function holdsKeyOrToken(text: string): boolean {
  if (BEARER.test(text)) return true;
  if (TOKEN_PREFIX.test(text) || TOKEN_PREFIX_ANY_CASE.test(text)) return true;
  if (CREDENTIAL_HEADER.test(text) || CREDENTIAL_FIELD.test(text)) return true;
  if (/eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\./.test(text)) return true;
  if (SECRET_PARAM.test(text)) return true;
  const runs = withoutRecordIds(text);
  if (HEX_RUN.test(runs)) return true;
  for (const url of runs.match(URL_UP_TO_QUERY) ?? []) {
    for (const run of url.match(PATH_RUN) ?? []) if (keyLikeRun(run)) return true;
  }
  for (const run of runs.replace(URL_UP_TO_QUERY, " ").match(TEXT_RUN) ?? []) {
    if (keyLikeRun(run)) return true;
  }
  return false;
}

/**
 * Text that looks like it holds a credential, as recipes, labels and connectors are checked: a
 * key, a token or a signed parameter (holdsKeyOrToken), any token of the form
 * `<non-space>:<non-space>@` (hasUserPasswordToken: every `user:password@host`, with a scheme or
 * without, whatever its password holds), Oracle's `user/password@host` (hasOraclePasswordToken),
 * or an Oracle login with its password (`sqlplus scott/tiger@orcl`, ORACLE_LOGIN). Recipes describe
 * queries and labels and connectors name things: none of them ever needs any of these.
 */
export function looksLikeSecret(text: string): boolean {
  if (holdsKeyOrToken(text)) return true;
  if (hasUserPasswordToken(text) || hasOraclePasswordToken(text)) return true;
  return ORACLE_LOGIN.some((re) => re.test(text));
}

const SECRET_MESSAGE =
  "looks like it holds a credential: never put tokens, keys or URLs with secrets in it";

/**
 * Why a (normalised) label or connector is refused, or null: empty, longer than
 * LIMITS.maxSourceLabelLength, control or invisible characters, or secret-looking text.
 */
export function sourceTextProblem(s: string, what: "label" | "connector"): string | null {
  if (s.length === 0) return `A source ${what} needs at least one character`;
  if (s.length > LIMITS.maxSourceLabelLength) {
    return `A source ${what} is at most ${LIMITS.maxSourceLabelLength} characters`;
  }
  if (REFUSED_CHARS.test(s))
    return `A source ${what} cannot contain control or invisible characters`;
  if (looksLikeSecret(s)) return `The source ${what} ${SECRET_MESSAGE}`;
  return null;
}

/**
 * Why a (normalised) recipe is refused, or null: empty, longer than LIMITS.maxSourceRecipeLength,
 * control, bidi or zero-width characters other than line breaks and tabs, or secret-looking text.
 */
export function recipeProblem(s: string): string | null {
  if (s.length === 0) return "A recipe needs at least one character";
  if (s.length > LIMITS.maxSourceRecipeLength) {
    return `A recipe is at most ${LIMITS.maxSourceRecipeLength} characters`;
  }
  if (REFUSED_CHARS.test(s.replace(/[\n\t]/g, " "))) {
    return "A recipe cannot contain control or invisible characters other than line breaks";
  }
  if (looksLikeSecret(s)) return `The recipe ${SECRET_MESSAGE}`;
  return null;
}

/**
 * A host with an optional port, as a source_ref keeps it: dot-separated labels of letters,
 * digits, `_` and `-` (any script), or an IPv6 address in brackets.
 */
const REF_HOST = /^(?:[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/u;

/**
 * A document's source_ref as stored, or why it is refused. Every reader of the page sees it,
 * anonymous link viewers included, so it is one absolute `http://` or `https://` link and nothing
 * else: no other scheme and no text without a scheme, so a bare `user:password@host` or a
 * `postgres://` connection string can never be stored. Trimmed; the user info, query and fragment
 * are dropped and only the scheme, host, port and path are kept (at most
 * LIMITS.maxSourceRefLength characters). A link in which an `@` follows the authority while the
 * text before that `@` holds a `:` or an `@` is refused, not stripped: a password with an
 * unencoded `/`, `?`, `#` or `@` (`https://admin:pa/ss@db`) runs past the host, and stripping would
 * keep part of it. Refused too with whitespace, control or invisible characters, or when what is
 * kept holds a key or a token (holdsKeyOrToken, path segment by path segment). Empty is null.
 * Parsed by hand: this package runs without the DOM's URL.
 */
export function sanitizeSourceRef(
  ref: string,
): { ok: true; ref: string | null } | { ok: false; problem: string } {
  const s = ref.trim();
  if (s.length === 0) return { ok: true, ref: null };
  if (REFUSED_CHARS.test(s)) {
    return { ok: false, problem: "source_ref cannot contain control or invisible characters" };
  }
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(s);
  if (!m || /\s/u.test(s)) {
    return {
      ok: false,
      problem:
        "source_ref must be one http:// or https:// link to the records, without credentials",
    };
  }
  const scheme = (m[1] ?? "").toLowerCase();
  const authority = m[2] ?? "";
  const path = m[3] || "/";
  // The user info runs to the last "@" of the authority; an "@" after the authority with a ":"
  // or an "@" before it means the password ran past the host. In an http(s) path after a plain
  // host an "@" is a handle or a package scope (`https://medium.com/@acme`) and passes.
  const rest = s.slice(scheme.length + 3);
  const at = rest.indexOf("@", authority.length);
  if (at >= 0 && /[:@]/.test(rest.slice(0, at))) {
    return { ok: false, problem: `source_ref ${SECRET_MESSAGE}` };
  }
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (!REF_HOST.test(host)) return { ok: false, problem: "source_ref is not a valid URL" };
  const kept = `${scheme}://${host.toLowerCase()}${path}`;
  if (kept.length > LIMITS.maxSourceRefLength) {
    return { ok: false, problem: `source_ref is at most ${LIMITS.maxSourceRefLength} characters` };
  }
  if (holdsKeyOrToken(kept)) return { ok: false, problem: `source_ref ${SECRET_MESSAGE}` };
  return { ok: true, ref: kept };
}

// ---------- the confirmed config ----------

/** Everything the owner's confirmation covers. A change to any field needs a new confirmation. */
export interface SourceConfig {
  label: string;
  connector: string;
  recipe: string;
  collection: string;
  every_minutes: number | null;
  requestable_by: RequestableBy;
  target_client_type: ClientType;
  target_connection: string | null;
}

/**
 * The canonical text the confirmation hash covers: a JSON array of the config's fields in a fixed
 * order, so the hash does not depend on how an object's keys were ordered.
 */
export function canonicalSourceConfig(c: SourceConfig): string {
  return JSON.stringify([
    c.label,
    c.connector,
    c.recipe,
    c.collection,
    c.every_minutes,
    c.requestable_by,
    c.target_client_type,
    c.target_connection,
  ]);
}

// ---------- inputs ----------

const sourceIdSchema = z
  .string()
  .regex(DATA_SOURCE_ID_RE, "Source id: lowercase letter, then up to 39 of a-z 0-9 _ -")
  .describe("A short id for the source, unique on this artifact (like a collection name)");

/** One data source as set_data_sources and PUT /artifacts/:ref/sources take it. */
export const dataSourceInputSchema = z.strictObject({
  id: sourceIdSchema,
  label: z
    .string()
    .max(LIMITS.maxSourceLabelLength * 2)
    .describe(
      `What the figures are ("Open issues"), at most ${LIMITS.maxSourceLabelLength} characters`,
    ),
  connector: z
    .string()
    .max(LIMITS.maxSourceLabelLength * 2)
    .describe(
      `The system they come from ("Linear"), at most ${LIMITS.maxSourceLabelLength} characters`,
    ),
  recipe: z
    .string()
    .max(LIMITS.maxSourceRecipeLength * 2)
    .describe(
      "The fetch as a read-only query: which system, which records, which fields, and how they " +
        `map to documents in collection. At most ${LIMITS.maxSourceRecipeLength} characters; ` +
        "never credentials, tokens or URLs with secrets. Only the owner reads it",
    ),
  collection: dataCollectionSchema.describe(
    "The shared-data collection the figures go to; a stamp with this source lands only there",
  ),
  client_type: z
    .enum(CLIENT_TYPES)
    .optional()
    .describe(
      "Whose agents the source belongs to: claude, codex or other. Defaults to your own client " +
        "type; required when the signed-in owner sets sources in the app",
    ),
  pin_connection: z
    .boolean()
    .optional()
    .describe(
      "Pin the source to this connection instead of any connection of its client type " +
        "(default false). Revoking the connection then makes the source wait for the owner again",
    ),
});
export type DataSourceInput = z.infer<typeof dataSourceInputSchema>;

/** set_data_sources and PUT /artifacts/:ref/sources: replace the artifact's list. */
export const setDataSourcesInput = z.object({
  id: artifactRefSchema,
  sources: z
    .array(dataSourceInputSchema)
    .max(LIMITS.maxDataSources)
    .refine((list) => new Set(list.map((s) => s.id)).size === list.length, {
      message: "Each source id may appear once",
    })
    .describe(
      `The whole list (0 to ${LIMITS.maxDataSources}): sources left out are removed, and the ` +
        "documents they stamped keep their stamps",
    ),
});
export type SetDataSourcesInput = z.infer<typeof setDataSourcesInput>;

/** POST /artifacts/:ref/sources/:source/confirm: the signed-in owner, in the app. */
export const confirmDataSourceInput = z.strictObject({
  config_hash: z
    .string()
    .regex(SOURCE_HASH_RE, "config_hash: 32 lowercase hex characters")
    .describe("The config_hash of the source as it was shown: a change since gives a conflict"),
});
export type ConfirmDataSourceInput = z.infer<typeof confirmDataSourceInput>;

// ---------- wire types ----------

/**
 * A data source as GET /artifacts/:ref/sources, get_artifact and set_data_sources return it. The
 * owner sees everything; an editor sees what the source is and its state, never the recipe, the
 * target or the hash. Label, connector and recipe are untrusted text for agents.
 */
export interface DataSourceInfo {
  id: string;
  label: string;
  connector: string;
  collection: string;
  status: SourceStatus;
  /** The newest fetched_at an owner's agent stamped with this source, or null. */
  last_fetched_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Owner only. Untrusted: possibly written by a session acting on injected text. */
  recipe?: string;
  /** Owner only: which agents the source belongs to. */
  target?: {
    client_type: ClientType;
    /** A pinned connection's id and label; null when any connection of the type counts. */
    connection_id: string | null;
    connection_label: string | null;
  };
  /** Owner only: when the pinned connection was revoked (the source then waits again), or null. */
  pin_lost_at?: string | null;
  /** Owner only: what the confirmation must name. */
  config_hash?: string;
}

/** set_data_sources and PUT /artifacts/:ref/sources. */
export interface SetDataSourcesResult {
  sources: DataSourceInfo[];
  /** Sources that do nothing until the owner confirms them in the app. */
  awaiting_confirmation: string[];
  /** Where the owner reviews them (the artifact with its sources review open), or null. */
  confirm_url: string | null;
  untrusted: string;
}

/** A source in list_artifact_data's summary: what it is and its state, never the recipe. */
export interface SummarySource {
  id: string;
  label: string;
  connector: string;
  collection: string;
  status: SourceStatus;
  last_fetched_at: string | null;
}

/**
 * A source as the viewer bar tells everyone who opens the page (ViewGate `sources`), computed by
 * the server from the stamps it stored, which page code cannot touch.
 */
export interface ViewSource {
  id: string;
  label: string;
  connector: string;
  collection: string;
  status: SourceStatus;
  /**
   * The newest fetched_at among the documents counted in `fetched`, read from their stamps (not
   * the source's own last_fetched_at, which a deleted or overwritten document cannot lower), or
   * null when none is stored.
   */
  last_fetched_at: string | null;
  /**
   * Documents in its collection stamped with this source under its current label and connector.
   * Each stamp carries the label and connector it was written with, so a document stamped before
   * the source was renamed is counted in `earlier`, with what its stamp says.
   */
  fetched: number;
  /**
   * Documents stamped with this source's id under an earlier label or connector, grouped by what
   * their stamps say, newest first. Absent when there are none.
   */
  earlier?: EarlierStamps[];
  /** Documents in its collection without a stamp, last changed from the page or the app. */
  by_person: number;
  /** Documents in its collection without a stamp, last changed by an agent. */
  by_agent: number;
}

/** Documents a source stamped under a label and connector it no longer has (ViewSource `earlier`). */
export interface EarlierStamps {
  label: string;
  connector: string;
  fetched: number;
  /** The newest fetched_at among those documents. */
  last_fetched_at: string | null;
}

/**
 * Documents stamped by a source this artifact no longer has in their collection (ViewGate
 * `removed_sources`): the stamps keep their label and connector, so readers still see where the
 * figures were said to come from, and that the source is gone.
 */
export interface RemovedSourceStamps {
  /** The source id the stamps carry. */
  id: string;
  label: string;
  connector: string;
  collection: string;
  fetched: number;
  /** The newest fetched_at among those documents. */
  last_fetched_at: string | null;
}
