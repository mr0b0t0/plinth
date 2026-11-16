// Validation schemas for every MCP tool and REST body. The Worker validates all input with these;
// the web app may reuse them for client-side checks. Field names are snake_case on the wire.
import { z } from "zod";
import { ARTIFACT_TYPES } from "./artifactTypes.ts";
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
export const htmlSchema = z.string().min(1).describe("Complete HTML document");
/** The source of a typed artifact (Markdown for a doc). */
export const contentSchema = z
  .string()
  .min(1)
  .describe(
    'The source of a typed artifact: for type "doc", the Markdown document (stored as content.md). ' +
      "Not for html artifacts, which send html.",
  );
export const artifactTypeSchema = z
  .enum(ARTIFACT_TYPES)
  .describe(
    '"html" (default): a hand-written page sent as html. "doc": a Markdown document sent as ' +
      "content, which Plinth renders as a finished page. Fixed at publish.",
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
  assets: assetsSchema.optional(),
  visibility: visibilitySchema.default("allowlist"),
  /** Needed when visibility is "password". */
  password: passwordSchema.optional(),
  /** Allowlisted viewer emails when visibility is "allowlist". */
  emails: z.array(emailSchema).max(LIMITS.maxAllowlistEmails).optional(),
});
export type PublishArtifactInput = z.input<typeof publishArtifactInput>;

export const updateArtifactInput = z.object({
  id: artifactRefSchema,
  /** The field matching the artifact's type: html for a page, content for a doc. No type: fixed. */
  html: htmlSchema.optional(),
  content: contentSchema.optional(),
  assets: assetsSchema.optional(),
  note: noteSchema.optional(),
  /** If given and not the current version, the update is rejected with a conflict. */
  base_version: versionNumberSchema.optional(),
});
export type UpdateArtifactInput = z.input<typeof updateArtifactInput>;

/**
 * start_upload and POST /uploads. Flat, like the other inputs; the service enforces the cross-field
 * rules: title and type only without id, base_version required with id (and refused without it),
 * note only with id.
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
});

export const listVersionsInput = z.object({ id: artifactRefSchema });

export const restoreVersionInput = z.object({
  id: artifactRefSchema,
  version: versionNumberSchema,
  /** Optional optimistic check, like update_artifact. */
  base_version: versionNumberSchema.optional(),
});

export const setVisibilityInput = z.object({
  id: artifactRefSchema,
  visibility: visibilitySchema,
  /** Replaces the allowlist (viewer role) when given. Collaborator roles are kept. */
  emails: z.array(emailSchema).max(LIMITS.maxAllowlistEmails).optional(),
  password: passwordSchema.optional(),
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
export const updateProfileInput = z.object({
  // No "@": a display name must not look like an email address (or an agent mention) to agents
  // reading comment authors.
  name: z
    .string()
    .trim()
    .max(100)
    .refine((n) => !n.includes("@"), "A name cannot contain @"),
});

export const createTokenInput = z.object({
  label: z.string().trim().min(1).max(LIMITS.maxLabelLength),
  client_type: clientTypeSchema.default("other"),
  scopes: z.array(scopeSchema).min(1).optional(),
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
});

export const renameArtifactInput = z.object({ title: titleSchema });

export const viewerPasswordInput = z.object({
  password: z.string().min(1).max(LIMITS.maxPasswordLength),
});
export const viewerEmailInput = z.object({ email: emailSchema });
export const viewerCodeInput = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, "Six digits"),
});

export const anchorSchema = z.object({
  selector: z.string().max(1000),
  text: z.string().max(500).optional(),
  /** Position inside the element, 0..1 of its box, so a pin lands where it was dropped. */
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});
export type Anchor = z.infer<typeof anchorSchema>;

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
