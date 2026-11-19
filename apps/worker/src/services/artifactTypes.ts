// Which source field a publish or update must carry, by artifact type. One function for MCP and
// REST so both give identical fix-it errors (design: docs/superpowers/specs/
// 2026-11-14-typed-outputs-doc-design.md, "Service rules"). The type comes from the publish call
// (default html) or, on update, from the artifact, whose type never changes. Byte limits and
// asset rules are checked where the bytes are made (storage.ts prepareFiles, via checkAsset).
//
// Everything a type does differently on the Worker is one of its hooks (TypeHooks), in its own
// module under artifactTypes/<id>.ts: validating its source, the title and capabilities a version
// takes, the message for an asset it does not take, and what happens after a version commits
// (room notifications, per-type publish warnings). stage.ts and artifacts.ts call the hooks and
// never branch on a type id.
import {
  ARTIFACT_TYPES,
  type ArtifactDetailBase,
  type ArtifactType,
  type ArtifactTypeDef,
  type PublishResult,
  type PublishWarning,
  TYPE_REGISTRY,
  typeDef,
  type Visibility,
} from "@plinth/shared";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { designHooks } from "./artifactTypes/design.ts";
import { designSystemHooks } from "./artifactTypes/design_system.ts";
import { docHooks } from "./artifactTypes/doc.ts";
import { htmlHooks } from "./artifactTypes/html.ts";
import { sheetHooks } from "./artifactTypes/sheet.ts";
import { slidesHooks } from "./artifactTypes/slides.ts";
import { whiteboardHooks } from "./artifactTypes/whiteboard.ts";
import type { Ctx } from "./context.ts";

export interface SourceInput {
  type?: string;
  html?: string;
  content?: string;
  /** What content is, for a type that imports other formats (a sheet: jsonl, csv or xlsx). */
  content_format?: string;
}

/** A version that has just committed, as a type's afterCommit hook sees it. */
export interface CommittedVersion {
  def: ArtifactTypeDef;
  result: PublishResult;
  /** versions.capabilities as stored for this version. */
  capabilities: string | null;
  /** An update of an existing artifact (publish otherwise). */
  update: boolean;
  /** The stored source file's sha256, or null. */
  sourceSha256: string | null;
  /** A checkpoint of a live draft (services/live.ts). */
  liveCheckpoint: boolean;
  /** A restore of an older version. */
  restored: boolean;
}

/** What one type does differently on the Worker. Every type has an entry in TYPE_HOOKS. */
export interface TypeHooks {
  /** The title the source names for itself, or null (the version is then "Untitled"). */
  title(text: string): string | null;
  /** What the source declares, as versions.capabilities stores it, or null. */
  capabilities(text: string): string | null;
  /**
   * Refuse a source the type cannot hold, after the wire-field checks (throws invalid_input).
   * Runs for inline publishes and updates and for bundle uploads.
   */
  validate?(def: ArtifactTypeDef, text: string): void;
  /** Said to the agent when an asset is of a content type the type does not take. */
  assetRule?: string;
  /**
   * A more specific message than assetRule for an asset the type does not take (a design's font
   * files), or null for the general one. Called only for content types assetTypes refuses.
   */
  assetRefusal?(path: string, contentType: string): string | null;
  /**
   * Advisory publish warnings about the source itself, given every path of the version's final
   * manifest. Runs where the reference scan runs (never on a restore), and its warnings share the
   * scan's cap. Never throws for a source that validate accepted.
   */
  sourceWarnings?(
    def: ArtifactTypeDef,
    text: string,
    manifestPaths: ReadonlySet<string>,
  ): PublishWarning[];
  /**
   * After the commit, outside its error handling: never makes the commit look failed. Returns
   * the result, with any per-type publish warnings added.
   */
  afterCommit?(ctx: Ctx, v: CommittedVersion): Promise<PublishResult>;
  /**
   * Per-type publish warnings about the staged source, before the commit (never on a restore).
   * `paths` are every file of the version, the source included. Advisory: never blocks a publish.
   * Unlike sourceWarnings it may read other artifacts (a design system a page names); its warnings
   * come after the reference warnings, inside the same cap.
   */
  publishWarnings?(ctx: Ctx, v: StagedSource): Promise<PublishWarning[]>;
  /** Extra fields of get_artifact for a version of this type, read as the caller. */
  detail?(ctx: Ctx, text: string): Promise<Partial<ArtifactDetailBase>>;
  /**
   * The text a version stores for a source validate accepted, when the type stores one canonical
   * spelling (a sheet). Absent: the source is stored as sent.
   */
  canonical?(def: ArtifactTypeDef, text: string): string;
  /**
   * The type's own source format from content sent in another format (content_format: a sheet
   * imports csv and xlsx). Absent: content_format is refused for the type. Throws invalid_input.
   */
  importSource?(def: ArtifactTypeDef, text: string, format: string): string;
  /**
   * An inline publish or update's source, after the edit check and the wire-field checks and
   * before the publish rate and any R2 operation: the text to stage instead, and a step to run
   * once the version has committed (its result in, the result out). A whiteboard stores only its
   * settings and writes its starting board into shared data after the commit. Never on a restore.
   */
  prepare?(ctx: Ctx, p: PrepareInput): Promise<PreparedSource>;
}

/** What a type's prepare hook gets: the source as sent, and what the version will become. */
export interface PrepareInput {
  def: ArtifactTypeDef;
  text: string;
  target:
    | {
        mode: "publish";
        artifactId: string;
        ownerId: string;
        visibility: Visibility;
        hasPassword: boolean;
      }
    | { mode: "update"; artifact: ArtifactRow };
}

/** What a type's prepare hook returns. */
export interface PreparedSource {
  /** The source to stage. */
  text: string;
  /** Run after the commit, outside its error handling: it never makes the commit look failed. */
  afterCommit?(result: PublishResult): Promise<PublishResult>;
}

/** A version's source as publishWarnings sees it, before the commit. */
export interface StagedSource {
  def: ArtifactTypeDef;
  text: string;
  paths: ReadonlySet<string>;
}

/** Every type's hooks, keyed by its id. One type per line, in ARTIFACT_TYPES order. */
const TYPE_HOOKS: { readonly [K in ArtifactType]: TypeHooks } = {
  html: htmlHooks,
  doc: docHooks,
  slides: slidesHooks,
  design_system: designSystemHooks,
  design: designHooks,
  sheet: sheetHooks,
  whiteboard: whiteboardHooks,
};

/** The Worker hooks of a registry row. */
export function typeHooks(def: ArtifactTypeDef): TypeHooks {
  return TYPE_HOOKS[def.id];
}

/** `pass type "doc", "slides", "design_system" or "design"`: every type that takes content, from the registry. */
const TYPED_CHOICES = ARTIFACT_TYPES.filter((t) => TYPE_REGISTRY[t].sourceField === "content")
  .map((t) => `"${t}"`)
  .join(", ")
  .replace(/, ([^,]*)$/, " or $1");

function refuse(def: ArtifactTypeDef, field: string, message: string): ApiError {
  return new ApiError("invalid_input", message, { type: def.id, field });
}

/**
 * The registry row for a stored artifact's type. A row written by a newer Plinth (a type this
 * instance does not know) is refused rather than read as HTML.
 */
export function requireTypeDef(type: string): ArtifactTypeDef {
  const def = typeDef(type);
  if (!def) {
    throw new ApiError(
      "feature_disabled",
      "This artifact's type is not supported by this instance",
      { type },
    );
  }
  return def;
}

/**
 * The type and source text for a new version. `currentType` is null for a publish (the type comes
 * from the input) and the artifact's type for an update (the input carries no type).
 */
export function resolveSource(
  input: SourceInput,
  currentType: ArtifactType | null,
): { def: ArtifactTypeDef; text: string } {
  const publishing = currentType === null;
  const requested = publishing ? (input.type ?? "html") : currentType;
  const def = typeDef(requested);
  if (!def) {
    throw new ApiError("invalid_input", `Unknown artifact type: ${requested}`, {
      type: requested,
      field: "type",
    });
  }

  const hooks = typeHooks(def);
  if (input.content_format !== undefined && !hooks.importSource) {
    throw refuse(
      def,
      "content_format",
      `content_format is for type sheet; a ${def.id} sends its ${def.sourceLabel} as ${def.sourceField}`,
    );
  }

  if (def.sourceField === "html") {
    if (input.content !== undefined) {
      throw refuse(
        def,
        "content",
        publishing
          ? `content is for typed artifacts: pass type ${TYPED_CHOICES}, or send html`
          : "This artifact is an HTML page: send html. The type cannot change.",
      );
    }
    if (input.html === undefined) {
      throw refuse(def, "html", 'html is required (or pass type "doc" with content)');
    }
    typeHooks(def).validate?.(def, input.html);
    return { def, text: input.html };
  }

  const wantsContent = publishing
    ? `type ${def.id} needs its ${def.sourceLabel} in content`
    : `This artifact is a ${def.id}: send its ${def.sourceLabel} as content.`;
  if (input.html !== undefined) {
    throw refuse(
      def,
      "html",
      publishing
        ? `type ${def.id} takes ${def.sourceLabel} in content, not html`
        : `${wantsContent} The type cannot change.`,
    );
  }
  if (input.content === undefined) throw refuse(def, "content", wantsContent);
  const text =
    input.content_format !== undefined && hooks.importSource
      ? hooks.importSource(def, input.content, input.content_format)
      : input.content;
  hooks.validate?.(def, text);
  return { def, text: hooks.canonical?.(def, text) ?? text };
}

/** A type that takes no files besides its source (registry `assets: false`) refuses every asset. */
export function noAssetsError(def: ArtifactTypeDef, path?: string): ApiError {
  return new ApiError(
    "invalid_input",
    `A ${def.id} has no files besides ${def.sourcePath}: send no assets`,
    { type: def.id, field: "assets", ...(path !== undefined ? { path } : {}) },
  );
}

/** Refuse an asset at one of the type's reserved paths or of a content type it does not take. */
export function checkAsset(def: ArtifactTypeDef, path: string, contentType: string): void {
  if (def.reservedPaths.includes(path)) {
    const others = def.reservedPaths.filter((p) => p !== def.sourcePath);
    throw new ApiError(
      "invalid_input",
      others.length === 0
        ? `${path} is the ${def.sourceField} field, not an asset`
        : `${[def.sourcePath, ...others].join(" and ")} belong to the ${def.id}, not its assets`,
      { type: def.id, field: "assets", path },
    );
  }
  if (def.assets === false) throw noAssetsError(def, path);
  if (def.assetTypes && !def.assetTypes.test(contentType)) {
    const hooks = typeHooks(def);
    throw new ApiError(
      "invalid_input",
      hooks.assetRefusal?.(path, contentType) ??
        hooks.assetRule ??
        `Asset ${path} is not a file type a ${def.id} takes`,
      { type: def.id, field: "assets", path, content_type: contentType },
    );
  }
}
