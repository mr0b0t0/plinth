// Publishing from CI (docs/ci.md): the GitHub Action's reference and the workflow step the app
// shows next to a token limited to one artifact. The Action lives at publish/ in this repository
// and is versioned by the release tags; `pnpm release` sets ACTION_REF to each release's version.
import { HOSTED_ORIGIN, REPO_URL } from "./harnesses.ts";
import { ARTIFACT_ID_RE } from "./schemas.ts";

/** The Action, pinned to a release tag (never a moving tag). */
export const ACTION_REF = "mr0b0t0/plinth/publish@v0.6.0";

/** The guide to publishing from CI. */
export const CI_DOCS_URL = `${REPO_URL}/blob/main/docs/ci.md`;

/** The CLI's npm version that ships the same client as ACTION_REF. */
export const CI_CLI_VERSION = ACTION_REF.slice(ACTION_REF.indexOf("@v") + 2);

/**
 * The GitHub Actions step that publishes `path` as the next version of artifact `id`, with the
 * token in the PLINTH_TOKEN secret. `url:` is added only for an instance other than the hosted
 * one. `id` must be a server artifact id (20 lowercase letters and digits), so it is safe in YAML.
 */
export function ciWorkflowSnippet(opts: { id: string; appOrigin: string; path?: string }): string {
  if (!ARTIFACT_ID_RE.test(opts.id)) throw new Error("Not an artifact id");
  const origin = opts.appOrigin.replace(/\/+$/, "");
  return [
    `- uses: ${ACTION_REF}`,
    "  with:",
    `    path: ${opts.path ?? "dist"}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax
    "    token: ${{ secrets.PLINTH_TOKEN }}",
    `    id: ${opts.id}`,
    ...(origin === HOSTED_ORIGIN ? [] : [`    url: ${origin}`]),
  ].join("\n");
}

/** The same publish from GitLab CI, a cron job or any shell, with PLINTH_TOKEN in the environment. */
export function ciShellCommand(opts: { id: string; appOrigin: string; path?: string }): string {
  if (!ARTIFACT_ID_RE.test(opts.id)) throw new Error("Not an artifact id");
  const origin = opts.appOrigin.replace(/\/+$/, "");
  const env = origin === HOSTED_ORIGIN ? "" : `PLINTH_URL=${origin} `;
  return `${env}npx --yes @mr0b0t0/plinth@${CI_CLI_VERSION} publish ${opts.path ?? "dist"} --id ${opts.id}`;
}
