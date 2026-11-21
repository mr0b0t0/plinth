// Design systems for agents (get_design_system, GET /api/v1/artifacts/:ref/design-system) and the
// reference an HTML page makes to one (`<meta name="plinth-design-system">`). Every cross-artifact
// read goes through policy.ts as the caller (requireArtifact and decideFor with `view`), and the
// type is checked after the access decision, so nobody learns whether an artifact they cannot
// view exists or what type it is.
import {
  type ArtifactSummary,
  DESIGN_SYSTEM_FORMAT,
  type DesignSystemRead,
  type DesignSystemReference,
  defaultDesignSystemInput,
  designSystemComponentCss,
  designSystemCss,
  designSystemFilePaths,
  designSystemFontLinks,
  designSystemInstall,
  type GetDesignSystemInput,
  type PublishWarning,
  parseDesignSystem,
  parseDesignSystemRef,
  TYPE_REGISTRY,
} from "@plinth/shared";
import { appUrl } from "../config.ts";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError, unauthorized } from "../lib/errors.ts";
import { mayChooseDefaultDesignSystem } from "../policy.ts";
import {
  decideFor,
  findArtifact,
  requireArtifact,
  requireVersion,
  summaryFor,
} from "./artifacts.ts";
import type { Ctx } from "./context.ts";
import { parseManifest, readText } from "./storage.ts";

const DEF = TYPE_REGISTRY.design_system;

/** Read a design system as the caller: tokens, compiled CSS, guidelines and components. */
export async function getDesignSystem(
  ctx: Ctx,
  input: GetDesignSystemInput,
): Promise<DesignSystemRead> {
  const { artifact } = await requireArtifact(ctx, input.id, "view");
  if (artifact.type !== DEF.id) {
    throw new ApiError("invalid_input", "This artifact is not a design system", {
      type: artifact.type,
      field: "id",
      next: "list_artifacts with type design_system lists the design systems you can use",
    });
  }
  const v = await requireVersion(ctx, artifact, input.version ?? artifact.currentVersion);
  const text = await readText(ctx.env.FILES, `${v.r2Prefix}${DEF.sourcePath}`);
  if (text === null) throw new ApiError("internal", `Stored ${DEF.sourceLabel} is missing`);
  const base = {
    id: artifact.id,
    slug: artifact.slug,
    title: artifact.title,
    url: appUrl(ctx.config, `/a/${artifact.slug}`),
    version: v.number,
    current_version: artifact.currentVersion,
    untrusted: true as const,
  };
  const parsed = parseDesignSystem(text);
  // A stored version that no longer parses (restored from before a rule, say) is still read: it
  // returns its problems and no compiled parts, so the agent can tell the person.
  if (!parsed.ok) {
    return {
      ...base,
      format: "unknown",
      name: null,
      description: null,
      prefix: null,
      problems: parsed.errors,
    };
  }
  const ds = parsed.value;
  const stored = parseManifest(v.manifest).map((e) => e.path);
  const ref = { id: artifact.id, version: v.number };
  const wants = (part: NonNullable<GetDesignSystemInput["include"]>[number]) =>
    !input.include || input.include.includes(part);
  const components = input.components
    ? ds.components.filter((c) => input.components?.includes(c.id))
    : ds.components;
  return {
    ...base,
    format: DESIGN_SYSTEM_FORMAT,
    name: ds.name,
    description: ds.description,
    prefix: ds.prefix,
    ...(wants("css")
      ? {
          css: designSystemCss(ds),
          font_links: designSystemFontLinks(ds),
          fonts: ds.fonts.map((f) => ({
            family: f.family,
            source: f.source,
            // A font stored as the design system's own file cannot load in another artifact.
            portable: f.source === "google",
          })),
        }
      : {}),
    ...(wants("tokens")
      ? {
          tokens: ds.tokens.map((t) => ({
            path: t.path,
            css_var: t.cssVar,
            type: t.type,
            value: t.value,
            dark: t.dark,
            alias_of: t.aliasOf,
            description: t.description,
            deprecated: t.deprecated,
          })),
        }
      : {}),
    ...(wants("guidelines") ? { guidelines: ds.guidelines } : {}),
    ...(wants("components")
      ? {
          component_css: designSystemComponentCss(ds, components),
          components: components.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            description: c.description,
            usage: c.usage,
            css: c.css,
            examples: c.examples.map((e) => ({ name: e.name, html: e.html, height: e.height })),
          })),
        }
      : {}),
    // What copy_files can take from this version, and the entries that install it.
    files: designSystemFilePaths(DEF.sourcePath, stored),
    install: designSystemInstall(ds, ref, new Set(stored)),
    problems: [],
  };
}

/**
 * Make one of the signed-in person's own design systems their default, or stop it being the default
 * (docs/spec.md "Design systems", The default design system). One column per person, so choosing
 * one replaces any other. People only, in the app (policy.ts mayChooseDefaultDesignSystem); the
 * design system must be theirs (`manage`), live and of the type, checked after the access decision.
 */
export async function setDefaultDesignSystem(
  ctx: Ctx,
  ref: string,
  body: unknown,
): Promise<ArtifactSummary> {
  const p = ctx.principal;
  if (!mayChooseDefaultDesignSystem(p)) {
    if (p.kind === "agent") {
      throw new ApiError("forbidden", "The default design system is chosen in the app", {
        reason: "app_only",
        next: "Ask the person to choose it in the app (the design system's menu on the dashboard)",
      });
    }
    throw unauthorized("Sign in to do this");
  }
  const { artifact, role } = await requireArtifact(ctx, ref, "manage");
  const input = defaultDesignSystemInput.safeParse(body);
  if (!input.success) {
    throw new ApiError("invalid_input", "Invalid input", { issues: input.error.issues });
  }
  const on = input.data.default;
  if (artifact.type !== DEF.id) {
    throw new ApiError("invalid_input", "Only a design system can be the default", {
      type: artifact.type,
      reason: "not_design_system",
    });
  }
  if (on && artifact.takenDownAt) {
    throw new ApiError("forbidden", "This artifact was taken down", { reason: "taken_down" });
  }
  await ctx.env.DB.prepare(
    on
      ? "UPDATE users SET default_design_system = ?2 WHERE id = ?1"
      : "UPDATE users SET default_design_system = NULL WHERE id = ?1 AND default_design_system = ?2",
  )
    .bind(p.userId, artifact.id)
    .run();
  return summaryFor(ctx, artifact, role);
}

/**
 * The design system a page names, when the caller may view it and it is one. Null for every
 * other case (missing, deleted, not viewable, taken down, another type), alike.
 */
async function viewableDesignSystem(ctx: Ctx, id: string): Promise<ArtifactRow | null> {
  const row = await findArtifact(ctx, id);
  if (!row) return null;
  const d = await decideFor(ctx, row, "view");
  if (!d.allow || row.type !== DEF.id) return null;
  return row;
}

/** get_artifact's design_system field for an HTML page, or {} when the page names none. */
export async function designSystemReference(
  ctx: Ctx,
  html: string,
): Promise<{ design_system?: DesignSystemReference | null }> {
  const ref = parseDesignSystemRef(html);
  if (!ref) return {};
  const row = await viewableDesignSystem(ctx, ref.id);
  return {
    design_system: row
      ? { id: row.id, title: row.title, version: ref.version, current_version: row.currentVersion }
      : null,
  };
}

/** One message for every unavailable case, so a warning never tells whether an artifact exists. */
export const DESIGN_SYSTEM_UNAVAILABLE =
  "This page names a design system you cannot open (or one that is not a design system). " +
  'Check the id in <meta name="plinth-design-system">, or remove the tag.';

/** Publish warnings for a page that names a design system: unavailable, or built on an old version. */
export async function designSystemRefWarnings(
  ctx: Ctx,
  html: string,
  file: string,
): Promise<PublishWarning[]> {
  const ref = parseDesignSystemRef(html);
  if (!ref) return [];
  const shown = ref.version === null ? ref.id : `${ref.id}@${ref.version}`;
  const row = await viewableDesignSystem(ctx, ref.id);
  if (!row) {
    return [
      { code: "design_system_unavailable", file, ref: shown, message: DESIGN_SYSTEM_UNAVAILABLE },
    ];
  }
  if (ref.version !== null && row.currentVersion > ref.version) {
    return [
      {
        code: "design_system_outdated",
        file,
        ref: shown,
        message:
          `Built on v${ref.version}; v${row.currentVersion} is current. Read it with ` +
          "get_design_system and update if the person wants the newer tokens.",
      },
    ];
  }
  return [];
}
