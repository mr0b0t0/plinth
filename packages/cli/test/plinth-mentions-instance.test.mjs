// Which instance the mention watcher (integrations/watcher/plinth-mentions.mjs) uses: PLINTH_URL,
// else the Claude Code plugin's Plinth instance option, else the hosted instance. Claude Code gives
// the option to hooks only, so the SessionStart hook (`pending`) saves it in the plugin's data
// folder for the monitor (`watch`) and the watch-mentions skill's commands. Plain node:test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOSTED_ORIGIN,
  instanceFile,
  instanceProblem,
  origin,
  rememberInstance,
} from "../../../integrations/watcher/plinth-mentions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../../integrations/watcher/plinth-mentions.mjs");
const work = mkdtempSync(path.join(tmpdir(), "plinth-instance-"));
after(() => rmSync(work, { recursive: true, force: true }));
const dataDir = (name) => path.join(work, name);

describe("mention watcher instance", () => {
  it("defaults to the hosted instance", () => {
    assert.equal(origin({}), HOSTED_ORIGIN);
    assert.equal(origin({ CLAUDE_PLUGIN_DATA: dataDir("none") }), HOSTED_ORIGIN);
  });

  it("follows the plugin option, and PLINTH_URL wins over it", () => {
    const option = { CLAUDE_PLUGIN_OPTION_INSTANCE_URL: "https://plinth.example" };
    assert.equal(origin(option), "https://plinth.example");
    assert.equal(
      origin({ ...option, PLINTH_URL: "http://127.0.0.1:8788" }),
      "http://127.0.0.1:8788",
    );
  });

  it("saves the option in the hook for the monitor, and forgets it once it is the default", () => {
    const env = { CLAUDE_PLUGIN_DATA: dataDir("a") };
    assert.equal(
      rememberInstance({ ...env, CLAUDE_PLUGIN_OPTION_INSTANCE_URL: " https://plinth.example " }),
      null,
    );
    const file = instanceFile(env);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      instance_url: "https://plinth.example",
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // The monitor has CLAUDE_PLUGIN_DATA only, and reads the saved option.
    assert.equal(origin(env), "https://plinth.example");
    // Back to the default: Claude Code exports nothing, and the saved copy goes.
    assert.equal(rememberInstance(env), null);
    assert.equal(existsSync(file), false);
    assert.equal(origin(env), HOSTED_ORIGIN);
  });

  it("explains an option the plugin's server cannot use", () => {
    assert.equal(instanceProblem(""), null);
    assert.equal(instanceProblem("https://plinth.example"), null);
    assert.equal(instanceProblem("http://localhost:8788"), null);
    for (const bad of [
      "https://plinth.example/",
      "https://plinth.example/mcp",
      "https://x.example?a=1",
    ]) {
      assert.match(instanceProblem(bad), /has a path or a trailing slash/, bad);
      assert.match(instanceProblem(bad), /\/plugin configure plinth@plinth/, bad);
    }
    for (const bad of ["plinth.example", "http://plinth.example", "ftp://plinth.example"]) {
      assert.match(instanceProblem(bad), /is not an https origin/, bad);
    }
    // Shown quoted and cut short: it is the user's own setting, printed into the session.
    const long = `https://plinth.example/${"a".repeat(500)}`;
    assert.ok(instanceProblem(long).length < 600);
  });

  it("prints the problem from the SessionStart hook, without failing it", () => {
    const env = {
      ...process.env,
      PLINTH_URL: "",
      CLAUDECODE: "1",
      XDG_CONFIG_HOME: dataDir("cfg"),
      CLAUDE_PLUGIN_DATA: dataDir("b"),
      CLAUDE_PLUGIN_OPTION_INSTANCE_URL: "https://plinth.example/mcp",
    };
    const r = spawnSync(process.execPath, [SCRIPT, "pending"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /^Plinth: the Plinth plugin's instance option is "https:\/\/plinth\.example\/mcp"/,
    );
    // Saved as given, so `status` in the skill reports the same instance the server uses.
    assert.equal(
      JSON.parse(readFileSync(instanceFile(env), "utf8")).instance_url,
      "https://plinth.example/mcp",
    );
  });
});
