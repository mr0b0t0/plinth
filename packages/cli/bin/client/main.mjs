// The client commands: login, logout, whoami, publish and upload. bin/plinth.mjs dispatches them
// before it loads the runtime, so they need no build, no dependencies and no wrangler. They import
// only this folder and its committed vendor/ copies (scripts/integrations.mjs keeps them in sync).
//
// Exit codes: 0 ok, 1 error, 2 usage, 3 conflict (the artifact changed since the version read).
import { readFileSync } from "node:fs";
import { ApiError, apiClient, CliError, describeApiError, EXIT, guardedFetch } from "./http.mjs";
import { resolveOrigin } from "./origin.mjs";
import { publish, upload } from "./publish.mjs";
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
    values: [...COMMON, "id", "title", "note", "base-version"],
    flags: ["include-maps", "dry-run", "json"],
    positionals: 1,
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
  ${p} publish <dir> [--id REF] [--title T] [--note N] [--base-version N]
                 [--include-maps] [--dry-run] [--json] [--url O]
      Publish a build folder (the one with index.html at its top) as a new artifact, or as the
      next version of --id. Unchanged files are reused, not sent again.
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
        ? `${command} takes one folder: plinth ${command} <dir>`
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
    userAgent: USER_AGENT,
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

/**
 * Run one client command. `io` holds env, stdout/stderr writers and fetch, so tests can drive it;
 * bin/plinth.mjs passes the real ones. Resolves with the exit code.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = io.stderr ?? ((s) => process.stderr.write(`${s}\n`));
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
      userAgent: USER_AGENT,
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
      apiClient({ origin: resolved.origin, userAgent: USER_AGENT, auth, fetch: ctx.rawFetch });
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
        userAgent: USER_AGENT,
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
      stdout(
        `${me.email} on ${resolved.origin} (${resolved.envToken ? "PLINTH_TOKEN" : `signed in as ${CLI_CLIENT_NAME}`})`,
      );
      return EXIT.ok;
    }
    if (command === "publish") return await publish(positionals[0], opts, ctx);
    throw new CliError(`Unknown command "${command}"`, EXIT.usage);
  } catch (e) {
    if (e instanceof CliError) {
      stderr(`plinth: ${e.message}`);
      return e.exitCode;
    }
    if (e instanceof ApiError) {
      stderr(`plinth: ${describeApiError(e)}`);
      return e.code === "conflict" && !e.details?.reason ? EXIT.conflict : EXIT.error;
    }
    stderr(`plinth: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.error;
  }
}
