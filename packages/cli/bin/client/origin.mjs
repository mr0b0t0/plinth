// Which Plinth instance a client command talks to, and with what credential.
//
// Origin: --url, then the instance --name/--home pick (as `plinth status` does), then PLINTH_URL,
// then the single local instance, then the hosted instance. PLINTH_TOKEN (a personal access token)
// is bound to one origin: PLINTH_URL's, or the hosted one when PLINTH_URL is unset. It is never
// sent to any other origin, and never written to disk.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "./http.mjs";
import { normalizeOrigin } from "./vendor/plinth-oauth.mjs";

/** packages/shared/src/harnesses.ts HOSTED_ORIGIN (a test keeps them equal). */
export const HOSTED_ORIGIN = "https://plinth.aconite.io";

/** The Plinth home directory: --home, else PLINTH_HOME, else ~/.plinth (as instance.mjs). */
export function resolveHome(flag, env = process.env) {
  return path.resolve(flag ?? env.PLINTH_HOME ?? path.join(os.homedir(), ".plinth"));
}

/** Parse JSONC: strip comments outside strings and trailing commas (as instance.mjs). */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated comment");
      i = end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * The app origin of instance `name` in `home`: the local one (instance.json and wrangler.jsonc, as
 * readInstance), else its Cloudflare deployment (cloudflare/deploy.json, as readDeployment). Null
 * when there is neither.
 */
export function readInstanceOrigin(home, name) {
  const dir = path.join(home, name);
  const meta = path.join(dir, "instance.json");
  const wrangler = path.join(dir, "wrangler.jsonc");
  try {
    if (existsSync(meta) && existsSync(wrangler)) {
      const vars = parseJsonc(readFileSync(wrangler, "utf8")).vars ?? {};
      if (vars.APP_HOST) {
        const scheme = vars.PUBLIC_SCHEME === "http" ? "http" : "https";
        return { name, kind: "local", origin: `${scheme}://${vars.APP_HOST}` };
      }
    }
    const deploy = path.join(dir, "cloudflare", "deploy.json");
    if (existsSync(deploy)) {
      const s = JSON.parse(readFileSync(deploy, "utf8"));
      if (s.appHost) return { name, kind: "cloudflare", origin: `https://${s.appHost}` };
    }
  } catch {
    throw new CliError(`Could not read the instance "${name}" in ${home}`);
  }
  return null;
}

/** Names of the instances in `home` (folders holding a local instance or a deployment). */
export function listInstances(home) {
  let names = [];
  try {
    names = readdirSync(home, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.filter(
    (n) =>
      existsSync(path.join(home, n, "instance.json")) ||
      existsSync(path.join(home, n, "cloudflare", "deploy.json")),
  );
}

function originOrUsage(raw, label) {
  try {
    return normalizeOrigin(raw, label);
  } catch (e) {
    throw new CliError(e.message, EXIT.usage);
  }
}

/** The instance `name` in `home` as { origin, source }; exit 2 when there is none. */
function namedInstance(home, name) {
  const inst = readInstanceOrigin(home, name);
  if (!inst) {
    throw new CliError(`No instance "${name}" in ${home}. Pass --url for another one.`, EXIT.usage);
  }
  return {
    origin: originOrUsage(inst.origin, "instance"),
    source: `${inst.kind} instance "${name}"`,
  };
}

/**
 * The origin, in order: --url, then --name/--home (an explicit choice, like --url, so it wins over
 * PLINTH_URL), then PLINTH_URL, then the single local instance, then the hosted one.
 */
function pickOrigin(opts, env) {
  if (opts.url !== undefined) return { origin: originOrUsage(opts.url, "--url"), source: "--url" };
  const home = resolveHome(opts.home, env);
  if (opts.name !== undefined || opts.home !== undefined)
    return namedInstance(home, opts.name ?? "plinth");
  if (env.PLINTH_URL)
    return { origin: originOrUsage(env.PLINTH_URL, "PLINTH_URL"), source: "PLINTH_URL" };
  const names = listInstances(home);
  const pick = names.length === 1 ? names[0] : names.includes("plinth") ? "plinth" : null;
  if (pick) {
    const inst = readInstanceOrigin(home, pick);
    if (inst)
      return {
        origin: originOrUsage(inst.origin, "instance"),
        source: `${inst.kind} instance "${pick}"`,
      };
  }
  if (names.length > 1) {
    throw new CliError(
      `Several instances in ${home} (${names.join(", ")}): choose one with --name, or pass --url.`,
      EXIT.usage,
    );
  }
  return { origin: HOSTED_ORIGIN, source: "hosted" };
}

/**
 * Resolve { origin, source, envToken, note }. `envToken` is PLINTH_TOKEN when the origin is the one
 * it is bound to (PLINTH_URL's, else the hosted one), else null. An explicit --url, --name or --home
 * for another origin while PLINTH_TOKEN is set exits 2; an origin picked without a flag simply goes
 * without the token, and `note` says so.
 */
export function resolveOrigin(opts, env = process.env) {
  const token = env.PLINTH_TOKEN?.trim() || null;
  const bound = token
    ? originOrUsage(env.PLINTH_URL || HOSTED_ORIGIN, env.PLINTH_URL ? "PLINTH_URL" : "origin")
    : null;
  const picked = pickOrigin(opts, env);
  if (!token || picked.origin === bound) return { ...picked, envToken: token, note: null };
  const explicit = opts.url !== undefined || opts.name !== undefined || opts.home !== undefined;
  if (explicit) {
    const how = env.PLINTH_URL ? "" : " (PLINTH_URL is unset)";
    throw new CliError(
      `PLINTH_TOKEN belongs to ${bound}${how} and is never sent to ${picked.origin}. Unset it, or set PLINTH_URL to the instance it was made on.`,
      EXIT.usage,
    );
  }
  return {
    ...picked,
    envToken: null,
    note: `PLINTH_TOKEN belongs to ${bound}, so it is not used for ${picked.origin}. Pass --url ${bound} (or set PLINTH_URL) to use it.`,
  };
}
