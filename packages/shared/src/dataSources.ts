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

/** An http or https URL up to its query or fragment: scheme, host and path. */
const URL_UP_TO_QUERY = /\bhttps?:\/\/[^\s?#]*/gi;
/** In a URL's path `/` separates segments, so a run stops there: base64url and `+`, `=`. */
const PATH_RUN = /[A-Za-z0-9_+=-]{40,}/g;
/** Anywhere else `/` stays in the run, so a standard-base64 key with slashes is one run. */
const TEXT_RUN = /[A-Za-z0-9_+/=-]{40,}/g;

/**
 * Text that looks like it holds a credential: a bearer header, a well-known token prefix (OpenAI
 * and Anthropic `sk-`, GitHub `ghp_` and `gho_`, Slack `xox?-`, AWS `AKIA`, Plinth's own
 * `plinth_`), a JWT, a URL query parameter named like a secret, a run of 40 or more hex
 * characters (a SHA-1 or SHA-256, an API key), or a run of 40 or more base64 or base64url
 * characters that mixes upper case, lower case and digits and does not read as words and
 * identifiers (keyLikeRun). In a URL's host and path each segment between slashes is a run of its
 * own, so a link to a record whose segments are short opaque ids (Airtable, Salesforce, Stripe)
 * passes; elsewhere `/` joins the run. Recipes describe queries; they never need any of these.
 */
export function looksLikeSecret(text: string): boolean {
  if (/\bbearer\s+\S/i.test(text)) return true;
  if (/(?:^|[^A-Za-z0-9])(?:sk-|ghp_|gho_|xox[abp]-|AKIA|plinth_)/.test(text)) return true;
  if (/eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\./.test(text)) return true;
  if (/[?&;](?:token|key|secret|sig|signature|access_token|api_key|apikey|password)=/i.test(text))
    return true;
  if (/[0-9a-fA-F]{40,}/.test(text)) return true;
  for (const url of text.match(URL_UP_TO_QUERY) ?? []) {
    for (const run of url.match(PATH_RUN) ?? []) if (keyLikeRun(run)) return true;
  }
  for (const run of text.replace(URL_UP_TO_QUERY, " ").match(TEXT_RUN) ?? []) {
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
 * A document's source_ref as stored, or why it is refused. Trimmed; an http or https URL keeps
 * only its origin and path (query, fragment, user name and password are dropped); any other text
 * is kept as it is. Empty is null. Refused past LIMITS.maxSourceRefLength, with control or
 * invisible characters, or when it looks like it holds a credential. Every reader of the page may
 * see it, anonymous link viewers included.
 */
export function sanitizeSourceRef(
  ref: string,
): { ok: true; ref: string | null } | { ok: false; problem: string } {
  let s = ref.trim();
  if (s.length === 0) return { ok: true, ref: null };
  if (/^https?:\/\//i.test(s)) {
    // Scheme, then user info (up to the last "@" before the path), host and path; the query and
    // the fragment are dropped. Parsed by hand: this package runs without the DOM's URL.
    const m = /^(https?):\/\/(?:[^/?#]*@)?([^/?#@]+)([^?#]*)/i.exec(s);
    if (!m) return { ok: false, problem: "source_ref is not a valid URL" };
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
