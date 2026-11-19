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
/** A header that carries a credential: `Authorization:` (Basic, Bearer or any) or `X-Api-Key`. */
const CREDENTIAL_HEADER =
  /\b(?:proxy-)?authorization\s*:|\bx-(?:api-key|api-token|auth-token|access-token)\b/i;
/** A credential written as a field: `api_key=…`, `client_secret: …`, `password=…`. */
const CREDENTIAL_FIELD =
  /\b(?:api[-_]?key|api[-_]?token|access[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|password|passwd)\s*[:=]\s*\S/i;
/**
 * A query or fragment parameter named like a secret, with or without a prefix: `?token=`,
 * `?client_secret=`, `#access_token=`, `&X-Amz-Signature=`. Each prefix piece ends with a
 * separator the piece cannot hold, so the match never backtracks.
 */
const SECRET_PARAM =
  /[?&;#](?:[A-Za-z0-9]+[_.-])*(?:token|key|secret|sig|signature|password|passwd|pwd|apikey|accesstoken|credential|auth)=/i;
/**
 * A URL whose user info holds a password: `postgres://admin:pw@host`, `redis://:pw@host`. The
 * password may hold an unencoded `/`, `?` or `#`, as pasted connection strings often do
 * (`postgres://admin:pa/ss@host`), so any `:` between the `://` and the first `@` counts. The user
 * part cannot hold `:`, so the match never backtracks. A port followed by an `@` in the path
 * (`https://host:8443/@handle`) is refused too: it reads the same as `admin:8443/x@host`.
 */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s@:]*:[^\s@]*@/i;
/**
 * A bare `user:password@host`, without a scheme. The user part cannot hold `:`, so the match
 * never backtracks; `mailto:person@host` is an address, not a password (looksLikeSecret).
 */
const BARE_PASSWORD = /(?:^|[\s"'(<[,;=])([^\s"'()<>[\],;=/@:]+):[^\s"'()<>[\]/@]+@[A-Za-z0-9-]/g;

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
 * Text that looks like it holds a credential: a bearer header or any `Authorization:` header,
 * `X-Api-Key`, a well-known token prefix (TOKEN_PREFIX), a field such as `api_key=` or
 * `password:`, a JWT, a query or fragment parameter named like a secret, a URL with a password
 * (any `:` between its `://` and its first `@`, URL_PASSWORD) or a bare `user:password@host`, a run of 32 or more hex characters, or a run of 40 or more
 * base64 or base64url characters that mixes upper case, lower case and digits and does not read
 * as words and identifiers (keyLikeRun). In a URL's host and path each segment between slashes is
 * a run of its own, so a link to a record whose segments are short opaque ids (Airtable,
 * Salesforce, Stripe) passes; elsewhere `/` joins the run. In their own links, the ids of Google
 * Docs and Drive, full commit SHAs on GitHub and GitLab, and Notion page and view ids are not runs
 * (withoutRecordIds). Recipes describe queries and labels and connectors name things: none of them
 * ever needs any of these.
 */
export function looksLikeSecret(text: string): boolean {
  if (/\bbearer\s+\S/i.test(text)) return true;
  if (TOKEN_PREFIX.test(text) || TOKEN_PREFIX_ANY_CASE.test(text)) return true;
  if (CREDENTIAL_HEADER.test(text) || CREDENTIAL_FIELD.test(text)) return true;
  if (/eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\./.test(text)) return true;
  if (SECRET_PARAM.test(text) || URL_PASSWORD.test(text)) return true;
  for (const m of text.matchAll(BARE_PASSWORD)) {
    if ((m[1] ?? "").toLowerCase() !== "mailto") return true;
  }
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
 * A document's source_ref as stored, or why it is refused. Trimmed; a URL of any scheme
 * (`https://`, `postgres://`, `mongodb+srv://`, `redis://`) keeps only its scheme, host and path
 * (user name, password, query and fragment are dropped); any other text is kept as it is, and a
 * bare `user:password@host` is refused (looksLikeSecret). A URL whose user info runs past the
 * host, because its password holds an unencoded `/`, `?`, `#` or `@`, is refused, not stripped. Empty is null. Refused past
 * LIMITS.maxSourceRefLength, with control or invisible characters, or when it looks like it holds
 * a credential. Every reader of the page may see it, anonymous link viewers included.
 */
export function sanitizeSourceRef(
  ref: string,
): { ok: true; ref: string | null } | { ok: false; problem: string } {
  let s = ref.trim();
  if (s.length === 0) return { ok: true, ref: null };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    // A password with an unencoded "/", "?", "#" or "@" runs past the authority, so the user
    // info cannot be told apart from the host and path: refuse it rather than strip a part. An
    // "@" after the authority is refused when the text before it holds a ":" or an "@", and for
    // any scheme but http(s); in an http(s) path after a plain host it is a handle or a package
    // scope (`https://medium.com/@acme`, `https://www.npmjs.com/package/@types/node`).
    const rest = s.slice(scheme[0].length);
    const authority = /^[^/?#]*/.exec(rest)?.[0] ?? "";
    const at = rest.indexOf("@", authority.length);
    if (at >= 0) {
      const before = rest.slice(0, at);
      if (!/^https?$/i.test(scheme[1] ?? "") || before.includes(":") || before.includes("@")) {
        return { ok: false, problem: `source_ref ${SECRET_MESSAGE}` };
      }
    }
    // Scheme, then user info (up to the last "@" before the path), host and path; the query and
    // the fragment are dropped. Parsed by hand: this package runs without the DOM's URL.
    const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/?#]*@)?([^/?#@]*)([^?#]*)/i.exec(s);
    if (!m || (!m[2] && !m[3])) return { ok: false, problem: "source_ref is not a valid URL" };
    s = `${(m[1] ?? "").toLowerCase()}://${(m[2] ?? "").toLowerCase()}${m[3] || "/"}`;
  }
  if (s.length > LIMITS.maxSourceRefLength) {
    return { ok: false, problem: `source_ref is at most ${LIMITS.maxSourceRefLength} characters` };
  }
  if (REFUSED_CHARS.test(s)) {
    return { ok: false, problem: "source_ref cannot contain control or invisible characters" };
  }
  if (looksLikeSecret(s)) return { ok: false, problem: `source_ref ${SECRET_MESSAGE}` };
  return { ok: true, ref: s };
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
