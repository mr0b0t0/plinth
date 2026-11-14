#!/usr/bin/env node
// Smoke test for the published CLI: `pnpm pack` the package, install the tarball into a throwaway
// prefix with npm (as `npx @aconite/plinth` would), then init and start a localhost-only instance
// and use it the way an agent does: OAuth (dynamic registration, PKCE, consent), then MCP. Needs `pnpm build` first. Exit code 0 when every check passes.
//
//   pnpm --filter @aconite/plinth test:smoke
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
});

await check("the app answers on 127.0.0.1 with artifacts on *.localhost", async () => {
  const h = await (await fetch(`${APP}/healthz`)).json();
  assert(h.ok === true, JSON.stringify(h));
  const c = await (await fetch(`${APP}/api/v1/config`)).json();
  assert(c.content_host === `localhost:${PORT}`, `content_host ${c.content_host}`);
  assert(c.content_isolation === "origin", `isolation ${c.content_isolation}`);
});

// ---------- sign in as the owner, then connect an agent with OAuth ----------
const jar = new Map();
function keep(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return res;
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const csrfToken = () => [...jar].find(([k]) => /plinth_csrf$/.test(k))?.[1] ?? "";
async function app(pathname, init = {}) {
  const headers = { cookie: cookieHeader(), origin: APP, ...(init.headers ?? {}) };
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    headers["x-plinth-csrf"] = csrfToken();
  }
  return keep(
    await fetch(`${APP}${pathname}`, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers,
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
      redirect: "manual",
    }),
  );
}
async function codeFor(email, from) {
  for (let i = 0; i < 50; i++) {
    const text = log.slice(from);
    const at = text.lastIndexOf(`[email:console] to=${email}`);
    const code = at >= 0 ? /\b(\d{6})\b/.exec(text.slice(at))?.[1] : null;
    if (code) return code;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-in code for ${email} in the instance log`);
}

await check("the owner signs in with the code printed in the terminal", async () => {
  await (await app("/api/v1/config")).arrayBuffer();
  const mark = log.length;
  const r = await app("/api/v1/auth/login", { json: { email: EMAIL } });
  assert(r.status === 200, `login ${r.status}`);
  const code = await codeFor(EMAIL, mark);
  const v = await app("/api/v1/auth/verify-code", { json: { email: EMAIL, code } });
  assert(v.status === 200, `verify ${v.status} ${await v.text()}`);
});

let accessToken = null;
await check("an agent connects with OAuth: registration, PKCE, consent, token", async () => {
  const redirectUri = "http://127.0.0.1:9/callback";
  const reg = await (
    await fetch(`${APP}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "CLI smoke",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  ).json();
  assert(reg.client_id, `registration: ${JSON.stringify(reg)}`);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "smoke",
    scope: "artifacts:read artifacts:write mentions",
    resource: `${APP}/mcp`,
  });
  const auth = await app(`/oauth/authorize?${q}`);
  const consentUrl = new URL(auth.headers.get("location") ?? "", APP);
  const requestId = consentUrl.searchParams.get("request");
  assert(auth.status === 302 && requestId, `authorize ${auth.status} -> ${consentUrl}`);
  const consent = await app("/api/v1/oauth/consent", {
    json: { request_id: requestId, label: "CLI smoke", client_type: "other", approve: true },
  });
  const consentBody = await consent.text();
  assert(consent.status === 200, `consent ${consent.status} ${consentBody}`);
  const back = new URL(JSON.parse(consentBody).redirect_to);
  assert(back.searchParams.get("state") === "smoke", `state ${back}`);
  const tok = await fetch(`${APP}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: `${APP}/mcp`,
    }),
  });
  const t = await tok.json();
  assert(tok.status === 200 && t.access_token, `token ${tok.status} ${JSON.stringify(t)}`);
  accessToken = t.access_token;
});

async function mcp(method, params, id) {
  const r = await fetch(`${APP}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status} ${text.slice(0, 200)}`);
  const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "");
  return JSON.parse(json);
}

let published = null;
await check("the agent publishes over /mcp with its OAuth access token", async () => {
  const clientInfo = { name: "smoke", version: "1" };
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo }, 1);
  const args = { title: "CLI smoke", html: "<!doctype html><h1>Hello</h1>" };
  const res = await mcp("tools/call", { name: "publish_artifact", arguments: args }, 2);
  assert(!res.result?.isError, JSON.stringify(res));
  published = JSON.parse(res.result.content[0].text);
  assert(published.id && published.slug, JSON.stringify(published));
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
