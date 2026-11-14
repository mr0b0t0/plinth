// Which source field a publish or update must carry, by artifact type. One function for MCP and
// REST so both give identical fix-it errors (design: docs/superpowers/specs/
// 2026-11-14-typed-outputs-doc-design.md, "Service rules"). The type comes from the publish call
// (default html) or, on update, from the artifact, whose type never changes. Byte limits and
// asset rules are checked where the bytes are made (storage.ts prepareFiles, via checkAsset).
import { type ArtifactType, type ArtifactTypeDef, typeDef } from "@plinth/shared";
import { ApiError } from "../lib/errors.ts";

export interface SourceInput {
  type?: string;
  html?: string;
  content?: string;
}

/** A whole HTML document sent where Markdown (or another typed format) belongs. */
const HTML_DOCUMENT_RE = /^\s*(<!doctype html|<html[\s>])/i;

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

  if (def.sourceField === "html") {
    if (input.content !== undefined) {
      throw refuse(
        def,
        "content",
        publishing
          ? 'content is for typed artifacts: pass type "doc", or send html'
          : "This artifact is an HTML page: send html. The type cannot change.",
      );
    }
    if (input.html === undefined) {
      throw refuse(def, "html", 'html is required (or pass type "doc" with content)');
    }
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
  if (HTML_DOCUMENT_RE.test(input.content)) {
    throw refuse(
      def,
      "content",
      `content for type ${def.id} is ${def.sourceLabel}. To publish HTML, use type "html" and the html field.`,
    );
  }
  return { def, text: input.content };
}

/** What a type allows as assets, said to the agent when it sends something else. */
const ASSET_RULE: Partial<Record<ArtifactType, string>> = {
  doc: "A doc's assets are images (png, jpg, gif, webp, avif, svg)",
};

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
  if (def.assetTypes && !def.assetTypes.test(contentType)) {
    throw new ApiError(
      "invalid_input",
      ASSET_RULE[def.id] ?? `Asset ${path} is not a file type a ${def.id} takes`,
      { type: def.id, field: "assets", path, content_type: contentType },
    );
  }
}
