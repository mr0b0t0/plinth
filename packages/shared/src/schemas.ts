// Validation schemas for every MCP tool and REST body. The Worker validates all input with these;
// the web app may reuse them for client-side checks. Field names are snake_case on the wire.
import { z } from "zod";
import { ARTIFACT_TYPES } from "./artifactTypes.ts";
import { CATEGORY_ROLES } from "./categories.ts";
import {
  ASSET_PATH_RE,
  CLIENT_TYPES,
  COMMENT_STATUSES,
  LIMITS,
  MENTION_STATES,
  REPORT_STATES,
  ROLES,
  SCOPES,
  SHA256_RE,
  VISIBILITIES,
} from "./constants.ts";
import { displayNameProblem, normalizeDisplayName } from "./displayName.ts";
import {
  PAGE_ANCHOR_DATA_KEY_RE,
  PAGE_ANCHOR_KEY_RE,
  PAGE_ANCHOR_UNSAFE_RE,
  PAGE_COMMENT_LIMITS,
} from "./pageComments.ts";
import { SHEET_COLUMN_TYPES, SHEET_NUMBER_STYLES } from "./sheet/format.ts";
import { SHEET_CONTENT_FORMATS } from "./sheet/import.ts";
import { utf8Length } from "./utf8.ts";

/** Artifact ids are DNS labels: lowercase letters and digits, 20 characters. */
export const ARTIFACT_ID_RE = /^[a-z0-9]{20}$/;
/** Slugs: lowercase kebab title plus a random suffix. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export const visibilitySchema = z.enum(VISIBILITIES);
export const roleSchema = z.enum(ROLES);
export const clientTypeSchema = z.enum(CLIENT_TYPES);
export const mentionStateSchema = z.enum(MENTION_STATES);
export const commentStatusSchema = z.enum(COMMENT_STATUSES);
export const reportStateSchema = z.enum(REPORT_STATES);
export const scopeSchema = z.enum(SCOPES);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: "Enter a valid email address" }));

/** An artifact reference: its id or its slug. */
export const artifactRefSchema = z.string().trim().min(1).max(80).describe("Artifact id or slug");

export const versionNumberSchema = z.number().int().min(1);

export const titleSchema = z.string().trim().min(1).max(LIMITS.maxTitleLength);
/**
 * An artifact's category (docs/spec.md "Categories"). A plain length-limited string, like
 * titleSchema, so the JSON Schema stays plain: the Worker normalises it and refuses control,
 * format and separator characters (shared categories.ts).
 */
export const categorySchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.maxCategoryLength)
  .describe(
    "The project or client this artifact belongs to, usually the repo you are working in. Reuse a name " +
      "from list_artifacts' categories. Only the owner sees or sets it.",
  );
export const htmlSchema = z.string().min(1).describe("Complete HTML document");
/** The source of a typed artifact (Markdown for a doc). */
export const contentSchema = z
  .string()
  .min(1)
  .describe(
    'The source of a typed artifact: for type "doc", the Markdown document (stored as content.md); ' +
      'for type "slides", the deck\'s Markdown with a line --- between slides (stored as slides.md); ' +
      'for type "design_system", the design system JSON (stored as system.json); ' +
      'for type "design", shared <head> tags then artboards, each starting with a line ' +
      '<!-- artboard name="Home" size="iphone" --> (stored as design.html); ' +
      'for type "sheet", the sheet\'s JSON lines (stored as sheet.jsonl), or a CSV or a base64 ' +
      ".xlsx with content_format. Not for html artifacts, which send html.",
  );
/** What a sheet's content is: its own JSON lines (default), CSV, or an .xlsx file in base64. */
export const contentFormatSchema = z
  .enum(SHEET_CONTENT_FORMATS)
  .describe(
    'Type "sheet" only: "jsonl" (default) for the sheet\'s JSON lines; "csv" to import CSV text (the ' +
      'first row names the columns, types are inferred, = stays text); "xlsx" to import the first ' +
      "worksheet of an .xlsx file sent as base64 (at most 2 MB). The stored sheet is JSON lines either way.",
  );
export const artifactTypeSchema = z
  .enum(ARTIFACT_TYPES)
  .describe(
    '"html" (default): a hand-written page sent as html. "doc": a Markdown document sent as ' +
      'content, which Plinth renders as a finished page. "slides": a Markdown deck sent as content, ' +
      "which Plinth renders as a presentation. " +
      '"design_system": design tokens, guidelines and components as JSON in content ' +
      "(format plinth.design-system/1), which Plinth renders as a reference site. " +
      '"design": artboards (app screens, posters, social posts, ads) as HTML in content, which ' +
      "Plinth renders on a canvas, each artboard alone at its exact size. " +
      '"sheet": a table as JSON lines in content, which Plinth renders as a spreadsheet with ' +
      "formulas, sort, filter and CSV and .xlsx downloads. Fixed at publish.",
  );
export const noteSchema = z.string().trim().max(LIMITS.maxNoteLength);
export const passwordSchema = z
  .string()
  .min(LIMITS.minPasswordLength)
  .max(LIMITS.maxPasswordLength);

export const assetInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(LIMITS.maxAssetPathLength)
    // Reserved paths (index.html, and content.md for a doc) depend on the artifact's type, so
    // the Worker refuses them with the type in the error (services/artifactTypes.ts checkAsset).
    .regex(ASSET_PATH_RE, "Relative path without '..', not under __plinth/"),
  // An asset needs content or sha256; the Worker's services enforce it (the schemas stay flat).
  content: z
    .string()
    .optional()
    .describe(
      "File content as text (utf8) or base64. Omit it and send sha256 to reuse a file the artifact's current version already has",
    ),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  sha256: z
    .string()
    .regex(SHA256_RE)
    .optional()
    .describe(
      "Lowercase hex SHA-256 of the bytes. Alone: reuse those bytes from the current version (get_artifact lists each asset's sha256). With content: checked against it",
    ),
  content_type: z.string().max(100).optional(),
});
export type AssetInput = z.input<typeof assetInputSchema>;

/** zod keeps only the ceiling; the instance's MAX_ASSETS_PER_VERSION is checked by the Worker. */
export const assetsSchema = z.array(assetInputSchema).max(LIMITS.maxAssetsCeiling);

// ---------- MCP tools (mirrored as REST) ----------

export const publishArtifactInput = z.object({
  title: titleSchema,
  type: artifactTypeSchema.default("html"),
  /** Required for type html. Cross-field rules live in the Worker's resolveSource. */
  html: htmlSchema.optional(),
  /** Required for a typed artifact (type doc). */
  content: contentSchema.optional(),
  /** Type sheet only: import CSV or an .xlsx instead of JSON lines. */
  content_format: contentFormatSchema.optional(),
  assets: assetsSchema.optional(),
  visibility: visibilitySchema.default("allowlist"),
  /** Needed when visibility is "password". */
  password: passwordSchema.optional(),
  /** Allowlisted viewer emails when visibility is "allowlist". */
  emails: z.array(emailSchema).max(LIMITS.maxAllowlistEmails).optional(),
  category: categorySchema.optional(),
});
export type PublishArtifactInput = z.input<typeof publishArtifactInput>;

export const updateArtifactInput = z.object({
  id: artifactRefSchema,
  /** The field matching the artifact's type: html for a page, content for a doc. No type: fixed. */
  html: htmlSchema.optional(),
  content: contentSchema.optional(),
  /** Type sheet only: import CSV or an .xlsx instead of JSON lines. */
  content_format: contentFormatSchema.optional(),
  assets: assetsSchema.optional(),
  note: noteSchema.optional(),
  /** If given and not the current version, the update is rejected with a conflict. */
  base_version: versionNumberSchema.optional(),
  /** Owner only (an editor's call that carries it is refused); omitted keeps the current one. */
  category: categorySchema.optional(),
});
export type UpdateArtifactInput = z.input<typeof updateArtifactInput>;

/**
 * start_upload and POST /uploads. Flat, like the other inputs; the service enforces the cross-field
 * rules: title and type only without id, base_version required with id (and refused without it),
 * note only with id; category in either mode, owner only with id.
 */
export const startUploadInput = z.object({
  /** Update this artifact; omit for a new one. */
  id: artifactRefSchema.optional(),
  /** New artifact only; default "html". */
  type: artifactTypeSchema.optional(),
  /** New artifact only; default: index.html's <title> (a doc: its first "# " line), else "Untitled". */
  title: titleSchema.optional(),
  /** Required with id: the version you read. */
  base_version: versionNumberSchema.optional(),
  /** Update only. */
  note: noteSchema.optional(),
  /** Either mode; with id, owner only. Applied when the ticket commits. */
  category: categorySchema.optional(),
});
export type StartUploadInput = z.input<typeof startUploadInput>;

export const getArtifactInput = z.object({
  id: artifactRefSchema,
  version: versionNumberSchema.optional(),
});

/** preview_artifact: the in-chat preview asks for a fresh preview link (MCP Apps, app-only). */
export const previewArtifactInput = z.object({
  id: artifactRefSchema,
  version: versionNumberSchema.optional(),
});

export const listArtifactsInput = z.object({
  query: z.string().trim().max(200).optional(),
  /** Filters the caller's own artifacts by category (matched ignoring case, spaces, "-" and "_"). */
  category: z
    .string()
    .trim()
    .max(LIMITS.maxCategoryLength)
    .optional()
    .describe(
      "Only your own artifacts in this category (matched ignoring case, spaces, '-' and '_').",
    ),
  /** How many items to return (most recent first); 0 returns only `categories`. */
  limit: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe(
      "At most this many items, most recent first (default and maximum 500). 0 returns no items, only " +
        "categories: the cheap way to read your category names before you publish.",
    ),
  /** Only artifacts of this type (design_system lists the design systems the caller can use). */
  type: z
    .enum(ARTIFACT_TYPES)
    .optional()
    .describe(
      "Only artifacts of this type, e.g. design_system for the design systems you can use.",
    ),
});

/** get_design_system and GET /artifacts/:ref/design-system. */
export const DESIGN_SYSTEM_PARTS = ["tokens", "css", "guidelines", "components"] as const;
export type DesignSystemPart = (typeof DESIGN_SYSTEM_PARTS)[number];

export const getDesignSystemInput = z.object({
  id: artifactRefSchema,
  version: versionNumberSchema.optional(),
  include: z
    .array(z.enum(DESIGN_SYSTEM_PARTS))
    .min(1)
    .optional()
    .describe(
      "Only these parts (default all). css also returns font_links and fonts; components returns " +
        "component_css too.",
    ),
  components: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/))
    .max(50)
    .optional()
    .describe("Only these component ids (default all)."),
});
export type GetDesignSystemInput = z.input<typeof getDesignSystemInput>;

// ---------- sheets (read_sheet, edit_sheet) ----------

/** One cell as edit_sheet writes it: null, a number, a boolean or a string ("=..." a formula). */
export const sheetCellSchema = z.union([
  z.null(),
  z.number(),
  z.boolean(),
  z.string().max(LIMITS.maxSheetCellChars),
]);
const sheetRowsSchema = z.array(z.array(sheetCellSchema).max(LIMITS.maxSheetColumns));
const columnLetterSchema = z
  .string()
  .regex(/^[A-Za-z]{1,3}$/, "A column letter such as C")
  .describe("A column letter, e.g. C");
const sheetFormatSchema = z
  .object({
    style: z.enum(SHEET_NUMBER_STYLES),
    decimals: z.number().int().min(0).max(10).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    grouping: z.boolean().optional(),
  })
  .strict();
const sheetColumnInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    type: z.enum(SHEET_COLUMN_TYPES).optional(),
    width: z.number().int().min(40).max(800).optional(),
    format: sheetFormatSchema.optional(),
    options: z.array(z.string().min(1).max(100)).min(1).max(100).optional(),
  })
  .strict();
const rowNumberSchema = z
  .number()
  .int()
  .min(2)
  .max(LIMITS.maxSheetRows + 2);

/** One edit_sheet op. Rows are A1 row numbers: the header is row 1, data starts at row 2. */
export const sheetOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set"),
      at: z.string().max(10).describe('Top-left cell of the block, row 2 or below, e.g. "B2"'),
      values: sheetRowsSchema.describe("Rows of raw cells, written from at"),
    })
    .strict(),
  z.object({ op: z.literal("append_rows"), values: sheetRowsSchema }).strict(),
  z
    .object({
      op: z.literal("insert_rows"),
      before: rowNumberSchema.describe("The new rows take this row number; rows from it move down"),
      count: z.number().int().min(1).max(LIMITS.maxSheetRows).optional(),
      values: sheetRowsSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete_rows"),
      from: rowNumberSchema,
      count: z.number().int().min(1).max(LIMITS.maxSheetRows).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_column"),
      column: columnLetterSchema,
      name: z.string().min(1).max(100).optional(),
      type: z.enum(SHEET_COLUMN_TYPES).optional(),
      format: sheetFormatSchema.nullable().optional().describe("null clears it"),
      options: z.array(z.string().min(1).max(100)).min(1).max(100).nullable().optional(),
      width: z.number().int().min(40).max(800).nullable().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("insert_columns"),
      before: columnLetterSchema.describe(
        "The new columns take this letter; one past the last adds them at the end",
      ),
      columns: z.array(sheetColumnInputSchema).min(1).max(LIMITS.maxSheetColumns),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete_columns"),
      from: columnLetterSchema,
      count: z.number().int().min(1).max(LIMITS.maxSheetColumns).optional(),
    })
    .strict(),
]);

export const readSheetInput = z.object({
  id: artifactRefSchema,
  version: versionNumberSchema.optional(),
  range: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe(
      'A1 range, e.g. "A1:F200", "B:D" (whole columns) or "2:50" (rows); default the whole sheet',
    ),
  values: z
    .boolean()
    .default(true)
    .describe("Evaluate formulas (default true); false returns formulas without values"),
  limit_cells: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxSheetReadCells)
    .optional()
    .describe(
      `At most this many cells (default ${LIMITS.defaultSheetReadCells}); next_range continues`,
    ),
});
export type ReadSheetInput = z.input<typeof readSheetInput>;

export const editSheetInput = z.object({
  id: artifactRefSchema,
  base_version: versionNumberSchema.describe("The version you read; a stale one is a conflict"),
  ops: z.array(sheetOpSchema).min(1).max(LIMITS.maxSheetOps),
  note: noteSchema.optional(),
});
export type EditSheetInput = z.input<typeof editSheetInput>;

export const listVersionsInput = z.object({ id: artifactRefSchema });

export const restoreVersionInput = z.object({
  id: artifactRefSchema,
  version: versionNumberSchema,
  /** Optional optimistic check, like update_artifact. */
  base_version: versionNumberSchema.optional(),
});

/** Invitation emails (docs/spec.md "Invitation emails"): off unless the caller asks. */
const notifySchema = z
  .boolean()
  .default(false)
  .describe(
    "Email each person this adds a link to it, on the owner's behalf. Default false: set it only " +
      "when the user asked to notify them",
  );

export const setVisibilityInput = z.object({
  id: artifactRefSchema,
  visibility: visibilitySchema,
  /** Replaces the allowlist (viewer role) when given. Collaborator roles are kept. */
  emails: z.array(emailSchema).max(LIMITS.maxAllowlistEmails).optional(),
  password: passwordSchema.optional(),
  /** Email the people `emails` adds (docs/spec.md "Invitation emails"). */
  notify: notifySchema,
});
export type SetVisibilityInput = z.input<typeof setVisibilityInput>;

export const listMentionsInput = z.object({
  state: mentionStateSchema.optional(),
});

export const claimMentionInput = z.object({ task_id: z.string().min(1).max(64) });

export const listCommentsInput = z.object({ id: artifactRefSchema });

export const resolveCommentInput = z.object({
  comment_id: z.string().min(1).max(64),
  /** true resolves the thread, false reopens it. */
  resolved: z.boolean().default(true),
});

export const replyCommentInput = z.object({
  comment_id: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(LIMITS.maxCommentLength),
  /** The version the agent published for this request, if any. Marks the task done. */
  result_version: versionNumberSchema.optional(),
  /** Mark the claimed task failed instead of done (e.g. the request could not be fulfilled). */
  failed: z.boolean().optional(),
});

// ---------- App-only REST bodies ----------

export const requestLoginInput = z.object({ email: emailSchema });
export const verifyLoginCodeInput = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, "Six digits"),
});
export const verifyMagicLinkInput = z.object({ token: z.string().min(10).max(200) });
export const reviewLoginInput = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export const updateProfileInput = z.object({
  // No "@": a display name must not look like an email address (or an agent mention) to agents
  // reading comment authors. No control, bidi or zero-width characters either (displayName.ts);
  // the check is a refinement, so the JSON Schema stays a plain length-limited string.
  name: z
    .string()
    .trim()
    .max(LIMITS.maxDisplayNameLength)
    .superRefine((n, ctx) => {
      const problem = displayNameProblem(normalizeDisplayName(n));
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
});

export const createTokenInput = z.object({
  label: z.string().trim().min(1).max(LIMITS.maxLabelLength),
  client_type: clientTypeSchema.default("other"),
  scopes: z.array(scopeSchema).min(1).optional(),
  /** Limit the token to one artifact (id or slug) that the person owns or edits. */
  artifact: z.string().trim().min(1).max(200).optional(),
});
export const renameConnectionInput = z.object({
  label: z.string().trim().min(1).max(LIMITS.maxLabelLength),
});

export const oauthConsentInput = z.object({
  request_id: z.string().min(1).max(200),
  label: z.string().trim().min(1).max(LIMITS.maxLabelLength),
  client_type: clientTypeSchema.default("other"),
  approve: z.boolean(),
});

export const grantInput = z.object({ email: emailSchema, role: roleSchema });
export const grantsReplaceInput = z.object({
  grants: z.array(grantInput).max(LIMITS.maxAllowlistEmails),
  notify: notifySchema,
});

/**
 * PATCH /artifacts/:ref (owner only): a new title, a category, or both. `category: null` clears it.
 * A body with neither is refused by the route, so the JSON Schema stays a plain object.
 */
export const renameArtifactInput = z.object({
  title: titleSchema.optional(),
  category: categorySchema.nullable().optional(),
});

/**
 * POST /categories/rename (the signed-in owner only): every live artifact whose category matches
 * `from` (by key) moves to `to`, which snaps onto an existing spelling (a merge); `to: null` clears.
 */
export const renameCategoryInput = z.object({
  from: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.maxCategoryLength)
    .describe("The category to rename, matched ignoring case, spaces, '-' and '_'"),
  to: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.maxCategoryLength)
    .nullable()
    .describe("The new name (an existing one merges into it), or null to clear the category"),
  /**
   * true: rename, merge or clear one of the caller's own categories for artifacts shared with them
   * (docs/spec.md "Category sharing and personal categories") instead of an owner category.
   */
  personal: z.boolean().optional(),
});

// ---------- category sharing and personal categories ----------

export const categoryRoleSchema = z.enum(CATEGORY_ROLES);

/** One person a category is shared with: viewer or commenter, never editor. */
export const categoryPersonInput = z.object({ email: emailSchema, role: categoryRoleSchema });

/** Review items in one request, at most; the Worker also caps them at the owner's artifact limit. */
export const MAX_REVIEW_ITEMS = 10_000;

/**
 * One decision of the owner's review: the artifact, and the version and category_rev the owner was
 * shown. A concurrent change to either skips the item.
 */
export const reviewItemInput = z.object({
  id: z.string().regex(ARTIFACT_ID_RE),
  version: z.number().int().min(0),
  category_rev: z.number().int().min(0),
  decision: z.enum(["shared", "private"]),
});

/** POST /category-shares (the signed-in owner only). */
export const createCategoryShareInput = z.object({
  category: categorySchema,
  title: titleSchema.optional(),
  people: z.array(categoryPersonInput).max(LIMITS.maxAllowlistEmails),
  review: z.array(reviewItemInput).max(MAX_REVIEW_ITEMS),
  notify: notifySchema,
});

/**
 * PATCH /category-shares/:id: a new title, new people, or both. `review` is required with
 * `people` (the route refuses it otherwise): changing who sees a category re-confirms what they see.
 */
export const updateCategoryShareInput = z.object({
  title: titleSchema.optional(),
  people: z.array(categoryPersonInput).max(LIMITS.maxAllowlistEmails).optional(),
  review: z.array(reviewItemInput).max(MAX_REVIEW_ITEMS).optional(),
  notify: notifySchema,
});

/** POST /category-shares/:id/review. */
export const categoryReviewInput = z.object({
  items: z.array(reviewItemInput).min(1).max(MAX_REVIEW_ITEMS),
});

/** PUT /artifacts/:ref/my-category: the caller's own category for an artifact shared with them. */
export const myCategoryInput = z.object({ category: categorySchema.nullable() });

export const viewerPasswordInput = z.object({
  password: z.string().min(1).max(LIMITS.maxPasswordLength),
});
export const viewerEmailInput = z.object({ email: emailSchema });
export const viewerCodeInput = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, "Six digits"),
});

/** A comment pinned to an element: what the review-mode bridge picks. Stored without a `kind`. */
const UNSAFE_ALL = new RegExp(PAGE_ANCHOR_UNSAFE_RE.source, "gu");

export const elementAnchorSchema = z.object({
  selector: z.string().max(1000),
  /**
   * The element's text, for the label. It comes from the page's DOM, where soft hyphens and emoji
   * joiners are common, so control and format characters are removed rather than refused (stored
   * anchors read back the same way).
   */
  text: z
    .string()
    .max(500)
    .transform((t) => t.replace(UNSAFE_ALL, ""))
    .optional(),
  /** Position inside the element, 0..1 of its box, so a pin lands where it was dropped. */
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  /** Never set: a `kind` means a page anchor, which must then be valid as one. */
  kind: z.never().optional(),
});

/** Plain text the page chose: no control or format characters (bidi overrides, zero-width). */
const pageText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((t) => !PAGE_ANCHOR_UNSAFE_RE.test(t), {
      message: "No control or format characters (bidi, zero-width)",
    });

const anchorDataValue = z.union([
  pageText(PAGE_COMMENT_LIMITS.maxDataString),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const pageCoord = z
  .number()
  .finite()
  .min(-PAGE_COMMENT_LIMITS.maxPageCoord)
  .max(PAGE_COMMENT_LIMITS.maxPageCoord);

/**
 * A spot the page's own code placed (`plinth.comments.compose`): a point on a canvas, a slide, a
 * node in a diagram. Written by page code and commenters, so untrusted like the comment text.
 */
export const pageAnchorSchema = z
  .object({
    kind: z.literal("page"),
    /** What the page anchors to, in its own terms: "canvas", "slide-3", "node:42". */
    key: z
      .string()
      .regex(
        PAGE_ANCHOR_KEY_RE,
        `Key: a letter or digit, then up to ${PAGE_COMMENT_LIMITS.maxKey - 1} of A-Z a-z 0-9 _ . : / -`,
      ),
    /** A point in the page's own coordinates (canvas pixels, diagram units). */
    x: pageCoord.optional(),
    y: pageCoord.optional(),
    /** A short label for the anchor chip ("Slide 3, top left"). Plain text. */
    text: pageText(PAGE_COMMENT_LIMITS.maxText).optional(),
    /** Extra page-defined fields (zoom, layer): flat, at most 16 keys and 1 KiB as JSON. */
    data: z
      .record(z.string().regex(PAGE_ANCHOR_DATA_KEY_RE), anchorDataValue)
      .refine((d) => Object.keys(d).length <= PAGE_COMMENT_LIMITS.maxDataKeys, {
        message: `At most ${PAGE_COMMENT_LIMITS.maxDataKeys} data keys`,
      })
      .refine((d) => utf8Length(JSON.stringify(d)) <= PAGE_COMMENT_LIMITS.maxDataBytes, {
        message: `Data is over ${PAGE_COMMENT_LIMITS.maxDataBytes} bytes`,
      })
      // The key count is a refinement, which JSON Schema cannot express; say it for OpenAPI.
      .meta({ maxProperties: PAGE_COMMENT_LIMITS.maxDataKeys })
      .optional(),
  })
  .strict();

/**
 * A comment's anchor: a page anchor (`kind: "page"`) or an element. The page schema comes first
 * and is strict, and an element anchor refuses `kind`, so anything that says it is a page anchor
 * is a valid one or is refused.
 */
export const anchorSchema = z.union([pageAnchorSchema, elementAnchorSchema]);
export type ElementAnchor = Omit<z.infer<typeof elementAnchorSchema>, "kind">;
export type PageAnchor = z.infer<typeof pageAnchorSchema>;
export type Anchor = ElementAnchor | PageAnchor;

export function isPageAnchor(a: Anchor | null | undefined): a is PageAnchor {
  return !!a && (a as { kind?: unknown }).kind === "page";
}

export const createCommentInput = z.object({
  body: z.string().trim().min(1).max(LIMITS.maxCommentLength),
  parent_id: z.string().min(1).max(64).optional(),
  version_number: versionNumberSchema.optional(),
  anchor: anchorSchema.optional(),
});
export const updateCommentInput = z.object({ status: commentStatusSchema });

export const reportInput = z.object({
  reason: z.string().trim().min(1).max(LIMITS.maxReportReasonLength),
  reporter_email: emailSchema.optional(),
});
export const reportDecisionInput = z.object({
  state: z.enum(["actioned", "dismissed"]),
});
/** GET /api/v1/admin/stats?days=: the trend window in UTC days. */
export const adminStatsQuerySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30"),
});
/** GET /api/v1/artifacts/:ref/stats?days=: the owner's window in UTC days. */
export const artifactStatsQuerySchema = z.object({
  days: z.enum(["7", "30", "90", "365"]).default("30"),
});
/** get_artifact_stats: one artifact's stats with an id, the caller's summary without. */
export const getArtifactStatsInput = z.object({
  id: artifactRefSchema.optional(),
  days: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]).optional(),
});
