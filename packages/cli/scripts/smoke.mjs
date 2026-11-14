#!/usr/bin/env node
// Smoke test for the published CLI: `pnpm pack` the package, install the tarball into a throwaway
// prefix with npm (as `npx @mr0b0t0/plinth` would), then init and start a localhost-only instance
// and use it the way an agent does: OAuth (dynamic registration, PKCE, consent), then MCP. Needs `pnpm build` first. Exit code 0 when every check passes.
//
//   pnpm --filter @mr0b0t0/plinth test:smoke
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appClient, connectAgent, publishArtifact, signIn } from "./agent-flow.mjs";

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
});

server.kill("SIGTERM");
const code = await new Promise((r) => server.once("exit", (c) => r(c)));
await check("Ctrl-C stops the instance cleanly", () => {
  assert(code === 0, `exit ${code}`);
});

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
