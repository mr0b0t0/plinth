#!/usr/bin/env node
// Smoke test for the published CLI: `pnpm pack` the package, install the tarball into a throwaway
// prefix with npm (as `npx @mr0b0t0/plinth` would), check `deploy --dry-run` (no network), then
// init and start a localhost-only instance and use it the way an agent does: OAuth (dynamic
// registration, PKCE, consent), then MCP. Then the client commands, with no wrangler on PATH:
// publish a 300-file build, republish one change, a stale --id, and `upload` with a start_upload
// ticket. Needs `pnpm build` first. Exit code 0 when every check passes.
//
//   pnpm --filter @mr0b0t0/plinth test:smoke
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appClient, callTool, connectAgent, publishArtifact, signIn } from "./agent-flow.mjs";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PLINTH_CLI_SMOKE_PORT ?? 8796);
const APP = `http://127.0.0.1:${PORT}`;
const EMAIL = "me@example.com";
const work = mkdtempSync(path.join(os.tmpdir(), "plinth-cli-smoke-"));
const home = path.join(work, "home");
let server = null;

process.on("exit", () => {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  rmSync(work, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

if (!existsSync(path.join(pkgDir, "runtime", "worker", "index.js"))) {
  console.error("smoke: run `pnpm build` first (packages/cli/runtime is missing)");
  process.exit(2);
}

// ---------- install like a user ----------
const pack = spawnSync("pnpm", ["pack", "--pack-destination", work], {
  cwd: pkgDir,
  encoding: "utf8",
});
if (pack.status !== 0) throw new Error(`pnpm pack failed:\n${pack.stderr}`);
const tarball = path.join(
  work,
  readdirSync(work).find((f) => f.endsWith(".tgz")),
);
const prefix = path.join(work, "install");
const inst = spawnSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", tarball], {
  encoding: "utf8",
});
if (inst.status !== 0) throw new Error(`npm install failed:\n${inst.stderr}`);
const bin = path.join(prefix, "node_modules", ".bin", "plinth");
const plinth = (...args) =>
  spawnSync(bin, [...args, "--home", home], { encoding: "utf8", env: { ...process.env } });

await check("the tarball ships the runtime and nothing from the repo's sources", () => {
  const ls = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" }).stdout.split("\n");
  for (const f of [
    "package/bin/plinth.mjs",
    "package/bin/client/main.mjs",
    "package/bin/client/vendor/plinth-oauth.mjs",
    "package/bin/client/vendor/constants.mjs",
    "package/runtime/worker/index.js",
    "package/runtime/web/index.html",
  ])
    assert(ls.includes(f), `missing ${f}`);
  assert(
    ls.some((f) => f.startsWith("package/runtime/migrations/0001")),
    "no migrations",
  );
  assert(
    !ls.some((f) => /\.ts$|\.map$|\.dev\.vars/.test(f)),
    "TypeScript, source maps or secrets in the tarball",
  );
  assert(!ls.some((f) => f.startsWith("package/test/")), "tests in the tarball");
  return `${ls.filter(Boolean).length} files`;
});

await check("plinth --version prints the package version", () => {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  assert(r.status === 0 && /^\d+\.\d+\.\d+/.test(r.stdout), r.stdout + r.stderr);
  return r.stdout.trim();
});

await check("init without --email and without a terminal refuses", () => {
  const r = spawnSync(bin, ["init", "--home", home], { encoding: "utf8", input: "" });
  assert(r.status !== 0 && /--email/.test(r.stderr), `exit ${r.status}: ${r.stderr}`);
});

// ---------- deploy to Cloudflare: plan only, no network ----------
const deployFlags = [
  "--app-host",
  "plinth.example.com",
  "--content-host",
  "example-content.net",
  "--email-provider",
  "resend",
  "--admin-email",
  EMAIL,
];

await check("deploy --dry-run plans a Cloudflare deploy of the installed runtime", () => {
  const r = plinth("deploy", ...deployFlags, "--dry-run");
  assert(r.status === 0, r.stdout + r.stderr);
  const runtime = realpathSync(path.join(prefix, "node_modules", "@mr0b0t0", "plinth", "runtime"));
  for (const want of [
    `"main": "${path.join(runtime, "worker", "index.js")}"`,
    `"migrations_dir": "${path.join(runtime, "migrations")}"`,
    '"pattern": "*.example-content.net/*"',
    '"ENVIRONMENT": "production"',
    "$ wrangler d1 migrations apply DB --remote --config",
    "$ wrangler deploy --config",
    "Type A   Name *   IPv4 address 192.0.2.0   Proxy status: Proxied",
  ])
    assert(r.stdout.includes(want), `missing ${want}`);
  assert(!existsSync(path.join(home, "plinth", "cloudflare")), "a dry run wrote files");
  assert(!/ADMIN_TOKEN \(shown once/.test(r.stdout), "a dry run printed a token");
});

await check("deploy refuses unsafe or incomplete settings before touching Cloudflare", () => {
  const none = plinth("deploy", "--dry-run");
  assert(none.status !== 0 && /first deploy needs --app-host/.test(none.stderr), none.stderr);
  const consoleMail = plinth("deploy", ...deployFlags, "--email-provider", "console", "--dry-run");
  assert(consoleMail.status !== 0 && /--single-user/.test(consoleMail.stderr), consoleMail.stderr);
  const shared = plinth(
    "deploy",
    ...deployFlags,
    "--content-host",
    "usercontent.example.com",
    "--dry-run",
  );
  assert(shared.status !== 0 && /registrable domain/.test(shared.stderr), shared.stderr);
});

await check("hints name npx when run through npx", () => {
  const env = { ...process.env, npm_command: "exec" };
  const help = spawnSync(bin, ["--help"], { encoding: "utf8", env });
  assert(help.stdout.includes("npx @mr0b0t0/plinth deploy --app-host"), help.stdout);
  const missing = spawnSync(bin, ["connect", "--home", home], { encoding: "utf8", env });
  assert(missing.stderr.includes("npx @mr0b0t0/plinth init --email"), missing.stderr);
  const plain = spawnSync(bin, ["connect", "--home", home], {
    encoding: "utf8",
    env: { ...process.env, npm_command: "" },
  });
  assert(/Create one with: plinth init/.test(plain.stderr), plain.stderr);
});

await check("init creates a localhost-only instance", () => {
  const r = plinth("init", "--email", EMAIL, "--port", String(PORT));
  assert(r.status === 0, r.stdout + r.stderr);
  assert(r.stdout.includes(`then open ${APP}`), "no app URL in the output");
  assert(!/ADMIN_TOKEN/.test(r.stdout), "a localhost-only instance must not get an ADMIN_TOKEN");
});

await check("start refuses a --listen value that is not an IP address", () => {
  const r = plinth("start", "--listen", "everywhere");
  assert(r.status !== 0 && /--listen must be an IP address/.test(r.stderr), r.stdout + r.stderr);
});

// ---------- run it ----------
let log = "";
server = spawn(bin, ["start", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => {
  log += d;
});
server.stderr.on("data", (d) => {
  log += d;
});
let up = false;
for (let i = 0; i < 90 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  up = plinth("status").status === 0;
  if (server.exitCode !== null) break;
}

await check("start serves the instance and status says so", () => {
  assert(up, `not running:\n${log}`);
  const s = plinth("status");
  assert(s.stdout.includes(`running on 127.0.0.1:${PORT}`), s.stdout);
  assert(log.includes(`Starting the Worker on http://127.0.0.1:${PORT}`), "not on loopback");
});

await check("the app answers on 127.0.0.1 with artifacts on *.localhost", async () => {
  const h = await (await fetch(`${APP}/healthz`)).json();
  assert(h.ok === true, JSON.stringify(h));
  const c = await (await fetch(`${APP}/api/v1/config`)).json();
  assert(c.content_host === `localhost:${PORT}`, `content_host ${c.content_host}`);
  assert(c.content_isolation === "origin", `isolation ${c.content_isolation}`);
});

// ---------- sign in as the owner, then connect an agent with OAuth ----------
const app = appClient(APP);

await check("the owner signs in with the code printed in the terminal", async () => {
  await signIn(app, EMAIL, () => log);
});

let accessToken = null;
await check("an agent connects with OAuth: registration, PKCE, consent, token", async () => {
  accessToken = await connectAgent(app, APP, "CLI smoke");
});

let published = null;
await check("the agent publishes over /mcp with its OAuth access token", async () => {
  published = await publishArtifact(APP, accessToken, "CLI smoke");
  return published.slug;
});

// ---------- the client commands, with no wrangler on PATH ----------
const clientBin = realpathSync(
  path.join(prefix, "node_modules", "@mr0b0t0", "plinth", "bin", "plinth.mjs"),
);
const clientEnv = () => ({
  PATH: path.dirname(process.execPath),
  HOME: work,
  XDG_CONFIG_HOME: path.join(work, "xdg"),
  PLINTH_HOME: path.join(work, "no-instances"),
  PLINTH_URL: APP,
  PLINTH_TOKEN: accessToken ?? "",
});
const client = (args, extraEnv = {}) =>
  spawnSync(process.execPath, [clientBin, ...args], {
    encoding: "utf8",
    env: { ...clientEnv(), ...extraEnv },
  });
/** A Vite-like build: index.html plus `n - 1` asset files. */
function buildFolder(name, n) {
  const dir = path.join(work, name);
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><title>${name}</title><script type="module" src="./assets/chunk-0.js"></script>`,
  );
  for (let i = 0; i < n - 1; i++)
    writeFileSync(path.join(dir, "assets", `chunk-${i}.js`), `export const v${i} = ${i};\n`);
  return dir;
}
const json = (r) => {
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

await check("client commands run with no wrangler on PATH", () => {
  const which = spawnSync("/bin/sh", ["-c", "command -v wrangler"], { env: clientEnv() });
  assert(which.status !== 0, "wrangler is on the restricted PATH");
  const r = client(["whoami"]);
  assert(r.status === 0 && r.stdout.includes(EMAIL), r.stdout + r.stderr);
  assert(r.stderr.includes(`plinth: ${APP} (PLINTH_URL)`), r.stderr);
});

const site = buildFolder("site", 300);
let sitePublished = null;
await check("publish sends a 300-file build as one bundle and verifies it", () => {
  sitePublished = json(client(["publish", site, "--json"]));
  assert(sitePublished.version === 1, `version ${sitePublished.version}`);
  assert(sitePublished.stored.files === 300, JSON.stringify(sitePublished.stored));
  assert(sitePublished.verified === true, "not verified");
  return `${sitePublished.slug}, ${sitePublished.stored.written} written`;
});

await check("republishing one change writes 2 objects (the file and the source)", () => {
  writeFileSync(path.join(site, "assets", "chunk-7.js"), "export const v7 = 'changed';\n");
  const r = json(client(["publish", site, "--id", sitePublished.id, "--json"]));
  assert(r.version === 2, `version ${r.version}`);
  assert(r.stored.written === 2, JSON.stringify(r.stored));
  assert(r.stored.reused === 298, JSON.stringify(r.stored));
  assert(r.verified === true, "not verified");
});

await check("publish --id with a stale base exits 3 and writes nothing", () => {
  const chunk = path.join(site, "assets", "chunk-7.js");
  const v2 = readFileSync(chunk, "utf8");
  writeFileSync(chunk, "export const v7 = 'changed again';\n");
  const r = client(["publish", site, "--id", sitePublished.id, "--base-version", "1"]);
  writeFileSync(chunk, v2);
  assert(r.status === 3, `exit ${r.status}: ${r.stderr}`);
  assert(/changed since v1 \(now v2\)/.test(r.stderr), r.stderr);
});

await check("a stale-base rerun whose update already landed sends nothing (exit 0)", () => {
  const r = client(["publish", site, "--id", sitePublished.id, "--base-version", "1"]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(/already published as v2, which matches this folder/.test(r.stderr), r.stderr);
});

await check(
  "a rerun on the current base with the same folder has nothing to publish (exit 0)",
  () => {
    const r = json(
      client(["publish", site, "--id", sitePublished.id, "--base-version", "2", "--json"]),
    );
    assert(r.version === 2 && r.outcome === "nothing_to_publish", JSON.stringify(r));
  },
);

await check("upload sends a folder with a start_upload ticket", async () => {
  const ticket = await callTool(APP, accessToken, "start_upload", {});
  assert(ticket.upload_url && ticket.upload_token, JSON.stringify(ticket).slice(0, 300));
  const dir = buildFolder("uploaded", 5);
  const r = client(["upload", dir, "--to", ticket.upload_url], {
    PLINTH_TOKEN: "",
    PLINTH_UPLOAD_TOKEN: ticket.upload_token,
  });
  const out = json(r);
  assert(out.version === 1 && out.bundle?.entries === 5, r.stdout);
  // The artifact is private, so read it back through the API rather than the content host.
  const res = await fetch(`${APP}/api/v1/artifacts/${out.id}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const detail = await res.json();
  const paths = (detail.assets ?? []).map((a) => a.path).sort();
  assert(res.status === 200 && paths.length === 4, `assets ${res.status} ${paths}`);
  assert(
    detail.assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256 ?? "")),
    "assets without sha256",
  );
  return out.slug;
});

await check(
  "the literal commands.curl from start_upload publishes a folder (bash, tar, gzip, curl)",
  async () => {
    const dir = buildFolder("curl-site", 4);
    writeFileSync(path.join(dir, "assets", "chunk-0.js.map"), "{}");
    const run = async (rewrite) => {
      const ticket = await callTool(APP, accessToken, "start_upload", {});
      const cmd = rewrite(ticket.commands.curl.replace("<folder>", `'${dir}'`));
      return json(spawnSync("bash", ["-c", cmd], { encoding: "utf8" }));
    };
    // As given: the source map stays out.
    const out = await run((c) => c);
    assert(out.version === 1 && out.stored.files === 4, JSON.stringify(out.stored));
    // With `tar -czf - .` in its place, which macOS tar pads with NULs past the gzip member on a
    // pipe: the server accepts the padding.
    const padded = await run((c) =>
      c.replace(/COPYFILE_DISABLE=1 tar .*? \| gzip -c/, "tar -czf - ."),
    );
    assert(padded.version === 1 && padded.bundle?.entries === 5, JSON.stringify(padded.bundle));
    return `${out.slug}, ${padded.slug}`;
  },
);

await check("/mcp refuses requests without a token", async () => {
  const r = await fetch(`${APP}/mcp`, { method: "POST" });
  assert(r.status === 401, `status ${r.status}`);
});

await check("the artifact's own *.localhost origin answers with the content CSP", async () => {
  const r = await fetch(`http://${published.id}.localhost:${PORT}/`, { redirect: "manual" });
  assert(r.status !== 404, "artifact host not routed");
  const csp = r.headers.get("content-security-policy") ?? "";
  assert(csp.includes("default-src 'none'"), `CSP: ${csp}`);
  return `HTTP ${r.status}`;
});

await check("connect prints the OAuth commands for the local endpoint", () => {
  const r = plinth("connect");
  assert(r.status === 0, r.stderr);
  const add = `claude mcp add --transport http --scope user plinth ${APP}/mcp`;
  assert(r.stdout.includes(add) && r.stdout.includes("codex mcp login plinth"), r.stdout);
  assert(!/token/i.test(r.stdout), "connect still mentions a token");
  // A local instance is not the hosted one: its own server first, then the plugin with PLINTH_URL.
  const exportLine = `export PLINTH_URL=${APP}`;
  const plugin = "claude plugin install plinth@plinth";
  assert(r.stdout.indexOf(add) < r.stdout.indexOf(exportLine), "bare server is not first");
  assert(
    r.stdout.indexOf(exportLine) < r.stdout.indexOf(plugin),
    "PLINTH_URL is not before the plugin",
  );
});

server.kill("SIGTERM");
const code = await new Promise((r) => server.once("exit", (c) => r(c)));
await check("Ctrl-C stops the instance cleanly", () => {
  assert(code === 0, `exit ${code}`);
});

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
