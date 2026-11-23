// Publishing from CI (docs/ci.md): the GitHub Action's reference and the workflow step the app
// shows next to a token limited to one artifact. The Action lives at publish/ in this repository
// and is versioned by the release tags; `pnpm release` sets ACTION_REF to each release's version.
import type { ArtifactType } from "./artifactTypes.ts";
import { HOSTED_ORIGIN, REPO_URL } from "./harnesses.ts";
import { ARTIFACT_ID_RE } from "./schemas.ts";

/** The Action, pinned to a release tag (never a moving tag). */
export const ACTION_REF = "mr0b0t0/plinth/publish@v0.7.0";

/** The guide to publishing from CI. */
export const CI_DOCS_URL = `${REPO_URL}/blob/main/docs/ci.md`;

/** The guide's section for someone with no artifact to limit a token to yet. */
export const CI_NO_ARTIFACT_URL = `${CI_DOCS_URL}#no-artifact-yet`;

/** The CLI's npm version that ships the same client as ACTION_REF. */
export const CI_CLI_VERSION = ACTION_REF.slice(ACTION_REF.indexOf("@v") + 2);

/**
 * The step's `path:` for each type: what the Action publishes as that type's next version. A doc
 * can be one Markdown file; a deck and a design system are folders with their source at the top
 * (`slides.md`, `system.json`; the CI guide says so, and no comment lengthens the line). A type
 * without an entry gets a build folder.
 */
const CI_PATHS: Partial<Record<ArtifactType, string>> = {
  html: "dist",
  doc: "content.md",
  slides: "slides",
  design_system: "design-system",
};

/**
 * The GitHub Actions step that publishes the next version of artifact `id` (of `type`), with the
 * token in the PLINTH_TOKEN secret. `url:` is added only for an instance other than the hosted
 * one. `id` must be a server artifact id (20 lowercase letters and digits), so it is safe in YAML.
 */
export function ciWorkflowSnippet(opts: {
  id: string;
  appOrigin: string;
  type?: ArtifactType;
}): string {
  if (!ARTIFACT_ID_RE.test(opts.id)) throw new Error("Not an artifact id");
  const origin = opts.appOrigin.replace(/\/+$/, "");
  return [
    `- uses: ${ACTION_REF}`,
    "  with:",
    `    path: ${(opts.type && CI_PATHS[opts.type]) || "dist"}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax
    "    token: ${{ secrets.PLINTH_TOKEN }}",
    `    id: ${opts.id}`,
    ...(origin === HOSTED_ORIGIN ? [] : [`    url: ${origin}`]),
  ].join("\n");
}
