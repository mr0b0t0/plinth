// The GitHub Action's pure parts (docs/ci.md): inputs, the version note, the CLI's argv, outputs,
// the job summary, and the escaping that keeps text from the server or the artifact (titles,
// warnings, error messages, file paths) from ever being read as a workflow command or as
// Markdown. main.mjs does the I/O.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { splitWarnings } from "../packages/cli/bin/client/publish.mjs";
import { LIMITS } from "../packages/cli/bin/client/vendor/constants.mjs";

/** The longest version note the server takes. */
export const MAX_NOTE_LENGTH = LIMITS.maxNoteLength;

/** A Plinth personal access token's characters; anything else is refused before it is printed. */
export const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/** packages/shared SLUG_RE: an artifact slug as the server makes them (a test keeps them equal). */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** packages/shared ARTIFACT_ID_RE: an artifact id as the server makes them (a test keeps them equal). */
export const ARTIFACT_ID_RE = /^[a-z0-9]{20}$/;

/** A usage problem with the step's inputs: the step fails with exit code 2. */
export class InputError extends Error {}

const BOOLEANS = ["link-run", "include-maps", "dry-run", "fail-on-warnings", "summary"];
const DEFAULTS = {
  id: "",
  url: "https://plinth.aconite.io",
  title: "",
  category: "",
  note: "",
  "link-run": "false",
  "base-version": "",
  editing: "code",
  "include-maps": "false",
  "dry-run": "false",
  "fail-on-warnings": "false",
  summary: "true",
};

/**
 * The step's inputs from INPUT_* (GitHub keeps hyphens and upper-cases the name). Booleans take
 * true or false only; a missing token or path is an InputError naming the input.
 */
export function readInputs(env) {
  const raw = (name) => {
    const v = env[`INPUT_${name.toUpperCase()}`];
    return (v === undefined || v === "" ? (DEFAULTS[name] ?? "") : v).trim();
  };
  const token = raw("token");
  if (!token)
    throw new InputError(
      "The token input is empty. Pass the PLINTH_TOKEN secret as the token input (and check the secret exists for this workflow).",
    );
  if (!TOKEN_RE.test(token))
    throw new InputError(
      "The token input is not a Plinth token (it has characters a token never has). Check the secret.",
    );
  const path = raw("path");
  if (!path) throw new InputError("The path input is empty: name the build folder or file.");
  const out = {
    token,
    path,
    id: raw("id"),
    url: raw("url"),
    title: raw("title"),
    category: raw("category"),
    note: raw("note"),
    baseVersion: raw("base-version"),
    editing: raw("editing").toLowerCase(),
  };
  for (const b of BOOLEANS) {
    const v = raw(b).toLowerCase();
    if (v !== "true" && v !== "false")
      throw new InputError(`The ${b} input must be true or false (it is "${escapeData(raw(b))}")`);
    out[b.replace(/-(.)/g, (_, c) => c.toUpperCase())] = v === "true";
  }
  if (out.baseVersion && !/^[1-9][0-9]*$/.test(out.baseVersion))
    throw new InputError("The base-version input must be a version number");
  if (out.editing !== "code" && out.editing !== "page")
    throw new InputError(
      `The editing input must be code or page (it is "${escapeData(raw("editing"))}")`,
    );
  return out;
}

/**
 * `s` cut to at most `max` UTF-16 code units, the length the server's note limit counts
 * (`z.string().max`), never inside a surrogate pair.
 */
export function cut(s, max) {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * The commit subject the run is about: the push's head commit, else the pull request's title, else
 * `gitSubject()` (git log in the checkout), else "<workflow> #<run number>".
 */
export function commitSubject(env, readEvent, gitSubject) {
  const firstLine = (s) => (typeof s === "string" ? s.split(/\r?\n/)[0].trim() : "");
  let event = null;
  try {
    event = readEvent();
  } catch {
    event = null;
  }
  const fromEvent = firstLine(event?.head_commit?.message) || firstLine(event?.pull_request?.title);
  if (fromEvent) return fromEvent;
  let fromGit = "";
  try {
    fromGit = firstLine(gitSubject());
  } catch {
    fromGit = "";
  }
  if (fromGit) return fromGit;
  const workflow = env.GITHUB_WORKFLOW || "CI";
  return env.GITHUB_RUN_NUMBER ? `${workflow} #${env.GITHUB_RUN_NUMBER}` : workflow;
}

/** This run's page on GitHub, or null outside Actions. */
export function runUrl(env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = env;
  if (!server || !repo || !run) return null;
  return `${server}/${repo}/actions/runs/${run}`;
}

/**
 * The version note: the input, or "<commit subject> (<short sha>)"; with link-run, this run's URL
 * after it. Cut to MAX_NOTE_LENGTH (UTF-16 code units, as the server counts), keeping the SHA and
 * the link. "-" sends none (null).
 */
export function defaultNote(inputs, env, readEvent, gitSubject) {
  if (inputs.note === "-") return null;
  const link = inputs.linkRun ? runUrl(env) : null;
  const tail = link ? ` ${link}` : "";
  if (inputs.note) return cut(inputs.note, MAX_NOTE_LENGTH - tail.length) + tail;
  const sha = (env.GITHUB_SHA ?? "").slice(0, 7);
  const suffix = `${sha ? ` (${sha})` : ""}${tail}`;
  const subject = commitSubject(env, readEvent, gitSubject);
  return cut(subject, MAX_NOTE_LENGTH - suffix.length) + suffix;
}

/** The refusal for base-version with nothing to update: a new artifact has no version to check. */
export const BASE_VERSION_NEEDS_ID =
  "The base-version input applies to an update: set the id input (or use a token limited to the artifact). Nothing was sent.";

/**
 * The CLI's arguments for this step. `id` is the artifact to update, or "" for a new one. The step
 * refuses base-version without an id before it gets here (BASE_VERSION_NEEDS_ID), so base-version
 * goes with an update only.
 */
export function buildArgv(inputs, id, note) {
  const argv = ["publish", inputs.path, "--json"];
  if (id) {
    argv.push("--id", id);
    if (note !== null) argv.push("--note", note);
    if (inputs.baseVersion) argv.push("--base-version", inputs.baseVersion);
  } else {
    if (inputs.title) argv.push("--title", inputs.title);
    if (inputs.category) argv.push("--category", inputs.category);
  }
  // The workflow publishes from the repository: people editing on the page are told (default code).
  if (inputs.editing) argv.push("--editing", inputs.editing);
  if (inputs.includeMaps) argv.push("--include-maps");
  if (inputs.dryRun) argv.push("--dry-run");
  return argv;
}

/**
 * What to do after an `unknown` outcome. Only a re-run with base-version is safe: it sends nothing
 * if this build landed, and stops with a conflict if someone else published first. A re-run
 * without it publishes the build again, or, with no id, creates a second artifact.
 */
export function unknownAdvice(json, baseStated) {
  const lost = "The answer was lost after the build was sent, so this run may have published it.";
  const base = Number.isInteger(json?.base_version) ? json.base_version : null;
  if (base !== null && baseStated)
    return `${lost} Re-run the job: with base-version set it sends nothing if v${base + 1} is this build, and stops with a conflict if someone else published first.`;
  if (base !== null)
    return `${lost} Set base-version to ${base} on this step, then re-run: it sends nothing if v${base + 1} is this build. A re-run without base-version publishes it again.`;
  return `${lost} Check the artifacts list before re-running: a re-run without id creates another new artifact if this one was created.`;
}

/**
 * The publish warnings that ask for a fix: the ones the annotations show, the `warnings` output
 * counts and fail-on-warnings fails on. not_scanned and live_draft are notes that need no action.
 */
export function actionableWarnings(json) {
  return splitWarnings(Array.isArray(json?.warnings) ? json.warnings : []).fix;
}

/**
 * What to do after a conflict. Without base-version the run read the version itself and someone
 * published while it was sending, so a re-run publishes this build on top. With base-version the
 * artifact is past the version the step names, and a re-run with the same base-version stops the
 * same way, so the step's base-version has to change.
 */
export function conflictAdvice(current, baseStated) {
  const now = current ? `v${current}` : "a newer version";
  if (baseStated)
    return `The artifact is at ${now}, past the base-version this step states, so nothing was published. Check what changed, then set base-version to ${current || "the current version"} (or remove it) and re-run: a re-run with the same base-version stops the same way.`;
  return `Someone published ${now} while this run was sending, so nothing was published. Re-run the job to publish this build as the next version.`;
}

/**
 * The outcome for a CLI exit code and its --json object. The CLI prints one object for every
 * outcome; an exit 0 without one this reads is `unknown` (it may have published), never a success.
 */
export function outcomeOf(code, json) {
  if (json?.published === "unknown") return "unknown";
  if (code === 0) {
    if (
      json?.outcome === "nothing_to_publish" ||
      json?.outcome === "already_published" ||
      json?.outcome === "dry_run"
    )
      return json.outcome;
    return json && typeof json.version === "number" ? "published" : "unknown";
  }
  if (code === 3 || json?.outcome === "conflict") return "conflict";
  return "error";
}

/**
 * The step's outputs as [name, value] pairs. URLs are built only from a slug that looks like one
 * the server makes, so artifact text never becomes part of a link.
 */
export function formatOutputs({ code, json, raw, origin }) {
  const outcome = outcomeOf(code, json);
  const pairs = [["outcome", outcome]];
  const ok = outcome !== "dry_run" && code === 0 && json && typeof json.version === "number";
  // Only an id the server could have made: it is printed into the summary as code.
  if (typeof json?.id === "string" && ARTIFACT_ID_RE.test(json.id)) pairs.push(["id", json.id]);
  const slug = typeof json?.slug === "string" && SLUG_RE.test(json.slug) ? json.slug : null;
  if (slug) pairs.push(["slug", slug]);
  if (ok) {
    const v = json.version;
    const page = slug ? `${origin}/a/${slug}` : "";
    // The comparison shows what this build changed: none when the current version was already
    // there before it (nothing_to_publish). already_published: an earlier run sent this build.
    const changedIt = outcome === "published" || outcome === "already_published";
    pairs.push(["version", String(v)]);
    pairs.push(["url", page]);
    pairs.push(["version-url", slug ? `${page}/v/${v}` : ""]);
    pairs.push([
      "compare-url",
      changedIt && slug && v > 1 ? `${page}/compare?from=${v - 1}&to=${v}&view=rendered` : "",
    ]);
    pairs.push(["verified", json.verified === true ? "true" : "false"]);
    pairs.push(["warnings", String(actionableWarnings(json).length)]);
  }
  if (Number.isInteger(json?.current_version))
    pairs.push(["current-version", String(json.current_version)]);
  pairs.push(["json", raw ?? ""]);
  return pairs;
}

/** A random token for ::stop-commands:: (never derived from input, never printed before use). */
export function stopToken() {
  return randomBytes(16).toString("hex");
}

/** A workflow command's message: one line, with % escaped first. */
export function escapeData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Text from the server or the artifact for the job summary: one line, with every character that
 * Markdown or HTML gives a meaning (links, images, tables, code, emphasis, tags, headings) made
 * literal.
 */
export function escapeMarkdown(s) {
  return String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}[\]()<>#+!|~]/g, (c) => `\\${c}`)
    .replace(/&/g, "&amp;");
}

/**
 * Append name/value pairs to a $GITHUB_OUTPUT (or $GITHUB_ENV) file, each value between a fresh
 * random heredoc delimiter that the value is checked not to contain.
 */
export function writeOutputFile(file, pairs) {
  let text = "";
  for (const [name, value] of pairs) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Bad output name ${name}`);
    const v = String(value);
    let delim;
    do delim = `plinth_${randomBytes(16).toString("hex")}`;
    while (v.includes(delim));
    text += `${name}<<${delim}\n${v}\n${delim}\n`;
  }
  appendFileSync(file, text, "utf8");
}

/** A size for the summary. */
function size(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a dry run would have sent, from the CLI's dry-run object (numbers only). */
function dryRunLine(json) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const files = n(json?.files);
  if (files === null) return "Checked the build; nothing was sent.";
  const what = `${files} files (${size(json.bytes)})`;
  const next = n(json.next_version);
  if (next !== null) {
    const changed = n(json.changed) ?? 0;
    const reused = n(json.reused) ?? 0;
    return `Checked the build; nothing was sent. It would publish v${next} from ${what}: ${changed} changed asset files, ${reused} reused.`;
  }
  return `Checked the build; nothing was sent. It would publish ${what} as a new private artifact.`;
}

/**
 * The job summary, in Markdown. Every string from the server or the artifact goes through
 * escapeMarkdown; URLs are only the ones formatOutputs built. No token, email or connection label
 * (anyone who can read the repository's Actions sees it).
 */
export function renderSummary({ code, json, outputs, created, message, baseStated = false }) {
  const out = Object.fromEntries(outputs);
  const lines = [];
  const outcome = out.outcome;
  if (outcome === "published") {
    const title = typeof json?.title === "string" ? ` of "${escapeMarkdown(json.title)}"` : "";
    lines.push(`### Plinth: published v${out.version}${title}`, "", "| | |", "| --- | --- |");
    if (out.url) lines.push(`| Page | ${out.url} |`);
    if (out["version-url"]) lines.push(`| This version | ${out["version-url"]} |`);
    if (out["compare-url"])
      lines.push(`| Compare with v${Number(out.version) - 1} | ${out["compare-url"]} |`);
    const s = json?.stored;
    if (s) {
      lines.push(
        `| Sent | ${size(s.bytes_written)} written, ${s.reused} files reused; ${json.verified ? "verified" : "not verified"} |`,
      );
    }
    const warnings = actionableWarnings(json);
    if (warnings.length) {
      const first = warnings
        .slice(0, 5)
        .map((w) => escapeMarkdown(`${w.code ?? ""} ${w.file ?? ""}`.trim()))
        .join("; ");
      lines.push(`| Warnings | ${warnings.length}: ${first}${warnings.length > 5 ? "; …" : ""} |`);
    }
    if (created && typeof out.id === "string" && ARTIFACT_ID_RE.test(out.id)) {
      lines.push(
        "",
        `This run created a new private artifact. Add \`id: ${out.id}\` to this step (or use a token limited to it) so later runs update it.`,
      );
    }
  } else if (outcome === "nothing_to_publish" || outcome === "already_published") {
    lines.push(
      `### Plinth: nothing to publish`,
      "",
      outcome === "already_published"
        ? `v${escapeMarkdown(json?.version ?? "")} already matches this build (an earlier run published it).`
        : `v${escapeMarkdown(json?.version ?? "")} already matches this build.`,
    );
  } else if (outcome === "dry_run") {
    lines.push("### Plinth: dry run", "", dryRunLine(json));
  } else if (outcome === "conflict") {
    lines.push("### Plinth: not published", "", conflictAdvice(out["current-version"], baseStated));
  } else if (outcome === "unknown") {
    lines.push("### Plinth: outcome unknown", "", escapeMarkdown(unknownAdvice(json, baseStated)));
  } else {
    lines.push(
      "### Plinth: not published",
      "",
      escapeMarkdown(message ?? `The publish failed (exit ${code}).`),
    );
  }
  return `${lines.join("\n")}\n`;
}
