// The client commands: login, logout, whoami, publish and upload. bin/plinth.mjs dispatches them
// before it loads the runtime, so they need no build, no dependencies and no wrangler. They import
// only this folder and its committed vendor/ copies (scripts/integrations.mjs keeps them in sync).
//
// Exit codes: 0 ok, 1 error, 2 usage, 3 conflict (the artifact changed since the version read).
// With --json, publish prints one JSON object on stdout for every outcome: the result, the
// `published: "unknown"` object, or `{ ok: false, exit_code, outcome, message, current_version? }`.
import { readFileSync } from "node:fs";
import {
  ApiError,
  apiClient,
  CliError,
  describeApiError,
  EXIT,
  guardedFetch,
  printable,
} from "./http.mjs";
import { resolveOrigin } from "./origin.mjs";
import { isVersionConflict, publish, upload } from "./publish.mjs";
import { createOAuth } from "./vendor/plinth-oauth.mjs";

export const CLIENT_COMMANDS = ["login", "logout", "whoami", "publish", "upload"];
export const CLI_CLIENT_NAME = "Plinth CLI";
export const CLI_SCOPE = "artifacts:read artifacts:write";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
export const USER_AGENT = `plinth-cli/${pkg.version}`;

const COMMON = ["url", "name", "home"];
const SPEC = {
  login: { values: COMMON, flags: ["no-browser"], positionals: 0 },
  logout: { values: COMMON, flags: [], positionals: 0 },
  whoami: { values: COMMON, flags: [], positionals: 0 },
  publish: {
    values: [...COMMON, "id", "title", "category", "note", "base-version", "editing"],
    flags: ["include-maps", "dry-run", "json"],
    positionals: 1,
    what: "one build folder or file: plinth publish <dir|file.html|file.md|file.csv|file.xlsx>",
  },
  upload: { values: ["to"], flags: ["include-maps"], positionals: 1 },
};

/** The client commands' part of --help; `p` is how the command was run. */
export const clientUsage = (
  p = "plinth",
) => `Client commands (any instance; need no build and no wrangler):
  ${p} login  [--url O] [--no-browser]     sign in (opens the browser once)
  ${p} logout [--url O]                    revoke and forget the sign-in
  ${p} whoami [--url O]                    who you are signed in as
  ${p} publish <dir|file.html|file.md|file.csv|file.xlsx> [--id REF] [--title T] [--category C]
                 [--note N] [--base-version N] [--editing code|page] [--include-maps] [--dry-run]
                 [--json] [--url O]
      Publish a build folder (the one with index.html at its top), or one .html or .md file, as
      a new artifact, or as the next version of --id; a .csv or .xlsx file becomes a sheet (its
      first row names the columns). Unchanged files are reused, not sent
      again. --category files it under a project on your dashboard (reuse a name you already
      have; owner only on --id). A PLINTH_TOKEN limited to one artifact updates that artifact.
      A folder or file is marked as published from code (--editing code, the default): people
      editing it on its page are told the next publish won't include their changes. --editing page
      clears that; a .csv or .xlsx import leaves it as it is unless --editing is given.
  ${p} upload <dir> --to <upload_url>      send a folder with a start_upload ticket; the token
                                             comes from PLINTH_UPLOAD_TOKEN only
Instance: --url, else --name/--home, else PLINTH_URL, else the single local instance, else hosted.
PLINTH_TOKEN (a personal access token) is used only for PLINTH_URL's instance (or the hosted one).
Exit codes: 0 ok, 1 error, 2 usage, 3 the artifact changed since the version you read.`;

const ALL_VALUES = new Set(Object.values(SPEC).flatMap((s) => s.values));

/** The client command in argv (options may come first), or null. */
export function clientCommandOf(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      if (a.startsWith("--") && !a.includes("=") && ALL_VALUES.has(a.slice(2))) i++;
      continue;
    }
    return CLIENT_COMMANDS.includes(a) ? a : null;
  }
  return null;
}

/** Parse argv for one client command. Unknown flags and missing values are usage errors. */
export function parseClientArgs(argv) {
  const command = clientCommandOf(argv);
  const spec = command ? SPEC[command] : { values: [], flags: [], positionals: 0 };
  const opts = {};
  const positionals = [];
  let seenCommand = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (spec.flags.includes(key)) {
        if (eq > 0) throw new CliError(`--${key} takes no value`, EXIT.usage);
        opts[key] = true;
      } else if (spec.values.includes(key)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined || (eq < 0 && v.startsWith("--")))
          throw new CliError(`--${key} needs a value`, EXIT.usage);
        opts[key] = v;
      } else {
        throw new CliError(
          `Unknown option --${key}${command ? ` for ${command}` : ""}. Run plinth --help`,
          EXIT.usage,
        );
      }
    } else if (a.startsWith("-") && a !== "-") {
      throw new CliError(`Unknown option ${a}. Run plinth --help`, EXIT.usage);
    } else if (!seenCommand && a === command) {
      seenCommand = true;
    } else positionals.push(a);
  }
  if (!command) throw new CliError("No client command given", EXIT.usage);
  if (!opts.help && positionals.length !== spec.positionals) {
    throw new CliError(
      spec.positionals
        ? `${command} takes ${spec.what ?? `one folder: plinth ${command} <dir>`}`
        : `${command} takes no arguments`,
      EXIT.usage,
    );
  }
  return { command, positionals, opts };
}

function oauthFor(ctx) {
  return createOAuth({
    clientName: CLI_CLIENT_NAME,
    scope: CLI_SCOPE,
    filePrefix: "cli-",
    userAgent: ctx.userAgent,
    env: ctx.env,
    fetch: guardedFetch(ctx.rawFetch),
    log: ctx.stderr,
    copy: {
      approve: "Approve the Plinth CLI in your browser.",
      doneTitle: "Plinth CLI signed in",
      doneText:
        "The plinth command is signed in. You can close this tab and go back to the terminal.",
      failText: "Plinth did not sign the plinth command in. You can close this tab.",
      lockName: "Plinth CLI sign-in",
    },
  });
}

const urlHint = (ctx) => (ctx.source === "--url" ? ` --url ${ctx.origin}` : "");

/** The User-Agent: plinth-cli/<version>, plus a caller's suffix such as `github-action`. */
export function userAgentFor(suffix) {
  if (suffix === undefined) return USER_AGENT;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(suffix)) throw new Error("Bad User-Agent suffix");
  return `${USER_AGENT} ${suffix}`;
}

/** The --json failure object's `outcome` for an exit code. */
const FAILURE_OUTCOME = { [EXIT.usage]: "usage", [EXIT.conflict]: "conflict" };

/**
 * Run one client command. `io` holds env, stdout/stderr writers and fetch, so tests can drive it;
 * bin/plinth.mjs passes the real ones; `io.userAgentSuffix` names a caller (the GitHub Action).
 * Resolves with the exit code.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const rawStdout = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  let printed = false;
  const stdout = (s) => {
    printed = true;
    rawStdout(s);
  };
  const stderr = io.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const userAgent = userAgentFor(io.userAgentSuffix);
  // publish --json answers on stdout whatever happens (parsed from argv, which may be malformed).
  const jsonFailure = clientCommandOf(argv) === "publish" && argv.includes("--json");
  const fail = (code, message, details) => {
    stderr(`plinth: ${message}`);
    if (jsonFailure && !printed) {
      const current = details?.current_version;
      rawStdout(
        JSON.stringify(
          {
            ok: false,
            exit_code: code,
            outcome: FAILURE_OUTCOME[code] ?? "error",
            message: printable(message),
            ...(Number.isInteger(current) ? { current_version: current } : {}),
          },
          null,
          2,
        ),
      );
    }
    return code;
  };
  try {
    const { command, positionals, opts } = parseClientArgs(argv);
    if (opts.help) {
      stdout(clientUsage(io.prog));
      return EXIT.ok;
    }
    const ctx = {
      env,
      stdout,
      stderr,
      rawFetch: io.fetch ?? globalThis.fetch,
      userAgent,
    };
    ctx.fetch = ctx.rawFetch;
    if (command === "upload") return await upload(positionals[0], opts, ctx);

    const resolved = resolveOrigin(opts, env);
    Object.assign(ctx, resolved);
    stderr(`plinth: ${resolved.origin} (${resolved.source})`);
    if (resolved.note) stderr(`plinth: ${resolved.note}`);
    const oauth = oauthFor(ctx);
    const signedOut = () => {
      const s = oauth.readState(resolved.origin);
      return new CliError(
        `${s?.signed_out ? "The sign-in was revoked or expired" : "Not signed in"} on ${resolved.origin}. Run: plinth login${urlHint(ctx)}`,
      );
    };
    const auth = resolved.envToken
      ? { token: async () => resolved.envToken, refresh: null }
      : {
          token: () => oauth.accessToken(resolved.origin),
          refresh: () => oauth.accessToken(resolved.origin, { force: true }),
          signedOut,
        };
    ctx.api = () =>
      apiClient({ origin: resolved.origin, userAgent: ctx.userAgent, auth, fetch: ctx.rawFetch });
    ctx.requireAuth = async () => {
      if (await auth.token()) return;
      throw signedOut();
    };

    if (command === "login") {
      if (resolved.envToken)
        stderr("PLINTH_TOKEN is set: commands use it instead of this sign-in while it is.");
      await oauth.login(resolved.origin, { noBrowser: opts["no-browser"] === true });
      const me = await apiClient({
        origin: resolved.origin,
        userAgent: ctx.userAgent,
        auth: { token: () => oauth.accessToken(resolved.origin), refresh: null },
        fetch: ctx.rawFetch,
      }).get("/me");
      stdout(
        `Signed in to ${resolved.origin} as ${me.email} (connection "${CLI_CLIENT_NAME}"). Revoke it any time on the Connections page.`,
      );
      return EXIT.ok;
    }
    if (command === "logout") {
      if (await oauth.logout(resolved.origin)) stdout(`Signed out of ${resolved.origin}.`);
      else stdout(`Not signed in on ${resolved.origin}.`);
      if (resolved.envToken) stderr("PLINTH_TOKEN is still set in this environment.");
      return EXIT.ok;
    }
    if (command === "whoami") {
      await ctx.requireAuth();
      const me = await ctx.api().get("/me");
      const c = me.connection;
      // A token limited to one artifact says which (the slug and title are text from the server).
      const limit = c?.bound
        ? c.artifact
          ? `, limited to ${c.artifact.slug} ("${c.artifact.title}")`
          : ", limited to an artifact it can no longer open"
        : "";
      // A bound token's /me carries no account fields (no email): name the token instead.
      const who = typeof me.email === "string" ? me.email : "A token";
      stdout(
        printable(
          `${who} on ${resolved.origin} (${resolved.envToken ? "PLINTH_TOKEN" : `signed in as ${CLI_CLIENT_NAME}`})${limit}`,
        ),
      );
      return EXIT.ok;
    }
    if (command === "publish") return await publish(positionals[0], opts, ctx);
    throw new CliError(`Unknown command "${command}"`, EXIT.usage);
  } catch (e) {
    if (e instanceof CliError) return fail(e.exitCode, e.message, e.details);
    if (e instanceof ApiError) {
      return fail(
        isVersionConflict(e) ? EXIT.conflict : EXIT.error,
        describeApiError(e),
        isVersionConflict(e) ? e.details : undefined,
      );
    }
    return fail(EXIT.error, e instanceof Error ? e.message : String(e));
  }
}
