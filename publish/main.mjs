// The GitHub Action "Publish to Plinth" (action.yml, docs/ci.md). It runs the CLI client from this
// same commit (packages/cli/bin/client, no dependencies and no build), so a tag or SHA pin pins
// everything and nothing is downloaded at run time.
//
// Everything the client prints (server messages, warnings, titles, file paths) is printed between
// ::stop-commands::<random> and ::<random>::, so the runner never reads any of it as a workflow
// command. The step's own commands (the mask, outputs, annotations) are printed outside it, with
// their text escaped. The token goes to the client in its environment only, never in argv.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError, apiClient, CliError, EXIT } from "../packages/cli/bin/client/http.mjs";
import { main as clientMain, userAgentFor } from "../packages/cli/bin/client/main.mjs";
import { resolveOrigin } from "../packages/cli/bin/client/origin.mjs";
import { bindingOf } from "../packages/cli/bin/client/publish.mjs";
import {
  BASE_VERSION_NEEDS_ID,
  buildArgv,
  defaultNote,
  escapeData,
  formatOutputs,
  InputError,
  readInputs,
  renderSummary,
  stopToken,
  unknownAdvice,
  writeOutputFile,
} from "./lib.mjs";

export const USER_AGENT_SUFFIX = "github-action";

/** The runner's environment: inputs, the GITHUB_* files and the workflow's own variables. */
const ENV = process.env;

const line = (s) => process.stdout.write(`${s}\n`);
const errorAnnotation = (message) => line(`::error title=Plinth::${escapeData(message)}`);

function readEvent() {
  const p = ENV.GITHUB_EVENT_PATH;
  return p ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** The checkout's last commit subject, without a shell; "" when there is no checkout. */
function gitSubject() {
  const ws = ENV.GITHUB_WORKSPACE;
  if (!ws || !existsSync(path.join(ws, ".git"))) return "";
  return execFileSync("git", ["-C", ws, "log", "-1", "--format=%s"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
}

/**
 * Resolve the artifact and run the client. Returns { code, json, raw, origin, created, message }.
 * Runs while workflow commands are stopped: it may print anything.
 */
async function publishStep(inputs) {
  // A home with no instances in it: the client never picks a local instance over PLINTH_URL.
  const home = mkdtempSync(path.join(os.tmpdir(), "plinth-action-"));
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("INPUT_")),
    );
    Object.assign(env, { PLINTH_TOKEN: inputs.token, PLINTH_URL: inputs.url, PLINTH_HOME: home });
    let origin;
    try {
      ({ origin } = resolveOrigin({}, env));
    } catch (e) {
      if (e instanceof CliError) return { code: e.exitCode, message: `url: ${e.message}` };
      throw e;
    }
    // Preflight: who the token is, and whether it is limited to one artifact.
    const api = apiClient({
      origin,
      userAgent: userAgentFor(USER_AGENT_SUFFIX),
      auth: { token: async () => inputs.token, refresh: null },
    });
    let binding;
    try {
      binding = bindingOf(await api.get("/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        return {
          code: EXIT.error,
          origin,
          message: `The token was rejected by ${origin} (revoked, or made on another instance)`,
        };
      return { code: EXIT.error, origin, message: e instanceof Error ? e.message : String(e) };
    }
    let id = inputs.id;
    if (binding) {
      if (id && id !== binding.id && id.toLowerCase() !== binding.slug)
        return {
          code: EXIT.usage,
          origin,
          message: `This token is limited to ${binding.slug}; the id input names another artifact`,
        };
      id = binding.id;
      console.log(`PLINTH_TOKEN is limited to ${binding.slug}: publishing its next version.`);
      if (inputs.title || inputs.category)
        console.log("The title and category inputs are ignored: they apply to a new artifact.");
    }
    if (!id && inputs.baseVersion)
      return { code: EXIT.usage, origin, message: BASE_VERSION_NEEDS_ID };
    const note = id ? defaultNote(inputs, process.env, readEvent, gitSubject) : null;
    let stdout = "";
    const code = await clientMain(buildArgv(inputs, id, note), {
      env,
      stdout: (s) => {
        stdout += `${s}\n`;
      },
      stderr: (s) => line(s),
      userAgentSuffix: USER_AGENT_SUFFIX,
    });
    const raw = stdout.trim();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    const message =
      typeof json?.message === "string"
        ? json.message
        : json?.published === "unknown"
          ? unknownAdvice(json, Boolean(inputs.baseVersion))
          : code === 0
            ? null
            : `The publish failed (exit ${code})`;
    return { code, json, raw, origin, created: !id && code === 0 && !inputs.dryRun, message };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function run() {
  if (process.platform === "win32") {
    errorAnnotation("Publish to Plinth runs on Linux and macOS runners");
    return EXIT.error;
  }
  let inputs;
  try {
    inputs = readInputs(process.env);
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    errorAnnotation(e.message);
    return EXIT.usage;
  }
  // In case the token was not passed as a secret. TOKEN_RE was checked: it is one line.
  line(`::add-mask::${inputs.token}`);

  const stop = stopToken();
  let resumed = false;
  const resume = () => {
    if (resumed) return;
    resumed = true;
    line(`::${stop}::`);
  };
  const crash = (e) => {
    resume();
    errorAnnotation(`The Plinth action failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT.error);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  line(`::stop-commands::${stop}`);
  let result;
  try {
    result = await publishStep(inputs);
  } finally {
    resume();
  }

  // Workflow commands work again from here; every value in them is escaped.
  const origin = result.origin ?? inputs.url.replace(/\/+$/, "");
  const outputs = formatOutputs({ code: result.code, json: result.json, raw: result.raw, origin });
  if (ENV.GITHUB_OUTPUT) writeOutputFile(ENV.GITHUB_OUTPUT, outputs);
  const warnings = Array.isArray(result.json?.warnings) ? result.json.warnings : [];
  for (const w of warnings) {
    if (w?.code === "not_scanned") continue;
    line(`::warning title=Plinth::${escapeData(`${w?.code} ${w?.file}: ${w?.message}`)}`);
  }
  let code = result.code;
  if (code !== 0) errorAnnotation(result.message ?? `The publish failed (exit ${code})`);
  const counted = warnings.filter((w) => w?.code !== "not_scanned").length;
  if (code === 0 && inputs.failOnWarnings && counted > 0) {
    errorAnnotation(`Published, with ${counted} warnings (fail-on-warnings is on)`);
    code = EXIT.error;
  }
  if (inputs.summary && ENV.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      ENV.GITHUB_STEP_SUMMARY,
      renderSummary({
        code: result.code,
        json: result.json,
        outputs,
        created: result.created,
        message: result.message,
        baseStated: Boolean(inputs.baseVersion),
      }),
    );
  }
  return code;
}

run().then(
  (code) => process.exit(code),
  (e) => {
    errorAnnotation(`The Plinth action failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT.error);
  },
);
