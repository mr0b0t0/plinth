#!/usr/bin/env node
// Local hosting smoke test (docs/local-hosting.md). No tunnel and no Cloudflare credentials: it
// sets up throwaway instances with `setup.mjs --tunnel --no-cloudflare`, starts them with
// `local:start --no-tunnel`, and talks to 127.0.0.1 with the production Host headers, as
// cloudflared would. Single-user mode with the console email provider, so codes are read from the
// Worker log. Exit code 0 when every check passes.
//
//   pnpm test:local
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP = "plinth.example.com";
const CONTENT = "example-content.net";
const OWNER = "owner@example.com";
const VIEWER = "viewer@example.com";
const CLIENT_IP = "203.0.113.7";
const PORT = Number(process.env.PLINTH_LOCAL_SMOKE_PORT ?? 8791);
const MULTI_PORT = PORT + 1;
const appOrigin = `https://${APP}`;

const home = mkdtempSync(path.join(os.tmpdir(), "plinth-local-smoke-"));
const running = [];

function cleanup() {
  for (const c of running) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
}
process.on("exit", () => {
  cleanup();
  rmSync(home, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** fetch for https://<public host>/… that connects to the local Worker, like cloudflared does. */
function hostFetch(port) {
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
      headers.set("host", url.host);
      if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", CLIENT_IP);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: init.method ?? "GET",
          path: url.pathname + url.search,
          headers: Object.fromEntries(headers),
        },
        (res) => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) out.append(k, one);
          }
          const empty = res.statusCode === 204 || res.statusCode === 304 || init.method === "HEAD";
          resolve(
            new Response(empty ? null : Readable.toWeb(res), {
              status: res.statusCode,
              headers: out,
            }),
          );
        },
      );
      req.on("error", reject);
      init.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
      if (init.body !== undefined && init.body !== null) req.write(init.body);
      req.end();
    });
}

function setup(name, port, extra, env = {}) {
  const r = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/setup.mjs"),
      "--tunnel",
      "--no-cloudflare",
      "--name",
      name,
      "--home",
      home,
      "--port",
      String(port),
      "--app-host",
      APP,
      "--content-host",
      CONTENT,
      ...extra,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...env } },
  );
  if (r.status !== 0) throw new Error(`setup ${name} failed:\n${r.stdout}\n${r.stderr}`);
  const token = /ADMIN_TOKEN \(shown once[^\n]*\n\s+(\S+)/.exec(r.stdout)?.[1] ?? null;
  return { token };
}

/** Start local:start --no-tunnel; resolves when /healthz answers. `log()` returns all output. */
async function start(name, port) {
  let out = "";
  const child = spawn(
    process.execPath,
    [path.join(root, "scripts/local-start.mjs"), "--name", name, "--home", home, "--no-tunnel"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  running.push(child);
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    out += d;
  });
  const f = hostFetch(port);
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`local:start ${name} exited:\n${out}`);
    try {
      const r = await f(`${appOrigin}/healthz`);
      if (r.status === 200) return { child, log: () => out, fetch: f };
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`local:start ${name} did not answer on ${port}:\n${out}`);
}

/** Wait for a six-digit code in an `[email:console] to=<email>` log entry after `from`. */
async function codeFor(log, email, from) {
  for (let i = 0; i < 50; i++) {
    const text = log().slice(from);
    const at = text.lastIndexOf(`[email:console] to=${email}`);
    const code = at >= 0 ? /\b(\d{6})\b/.exec(text.slice(at))?.[1] : null;
    if (code) return code;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code for ${email} in the Worker log`);
}

async function csrf(f) {
  const r = await f(`${appOrigin}/api/v1/config`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  await r.arrayBuffer();
  return { cookie, token: cookie.split("=")[1] ?? "" };
}

async function postJson(f, url, body, s, extraCookie = "") {
  return f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: appOrigin,
      Cookie: [s.cookie, extraCookie].filter(Boolean).join("; "),
      "x-plinth-csrf": s.token,
    },
    body: JSON.stringify(body),
  });
}

// ---------- single-user instance ----------

const { token } = setup("single", PORT, [
  "--single-user",
  "--admin-email",
  OWNER,
  "--email-provider",
  "console",
]);
const inst = await start("single", PORT);
const f = inst.fetch;

await check("health reports production", async () => {
  const body = await (await f(`${appOrigin}/healthz`)).json();
  assert(body.ok === true && body.environment === "production", JSON.stringify(body));
});

await check("owner signs in with an emailed code; session cookie is Secure", async () => {
  const s = await csrf(f);
  const mark = inst.log().length;
  const r = await postJson(f, `${appOrigin}/api/v1/auth/login`, { email: OWNER }, s);
  assert(r.status === 200, `login ${r.status} ${await r.text()}`);
  const code = await codeFor(inst.log, OWNER, mark);
  const v = await postJson(f, `${appOrigin}/api/v1/auth/verify-code`, { email: OWNER, code }, s);
  assert(v.status === 200, `verify ${v.status} ${await v.text()}`);
  const cookies = v.headers.get("set-cookie") ?? "";
  assert(/;\s*Secure/i.test(cookies), "session cookie lacks Secure");
});

await check("a cross-site Origin is refused", async () => {
  const s = await csrf(f);
  const r = await f(`${appOrigin}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
      Cookie: s.cookie,
      "x-plinth-csrf": s.token,
    },
    body: JSON.stringify({ email: OWNER }),
  });
  assert(r.status === 403, `status ${r.status}`);
});

await check("the client IP from the edge reaches rate limiting", async () => {
  const r = spawnSync(
    path.join(root, "apps/worker/node_modules/.bin/wrangler"),
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--json",
      "--config",
      path.join(home, "single/wrangler.jsonc"),
      "--persist-to",
      path.join(home, "single/state"),
      "--command",
      "SELECT key FROM rate_limits",
    ],
    {
      cwd: path.join(root, "apps/worker"),
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  assert(r.status === 0, `wrangler d1 execute: ${r.stderr}`);
  assert(r.stdout.includes(`login:ip:${CLIENT_IP}`), "no per-IP key for the sent cf-connecting-ip");
});

let artifact = null;
await check("publish over /mcp with the admin token", async () => {
  assert(token, "setup did not print an ADMIN_TOKEN");
  const client = new Client({ name: "plinth-local-smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${appOrigin}/mcp`), {
      fetch: f,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const r = await client.callTool({
    name: "publish_artifact",
    arguments: {
      title: "Local smoke",
      html: "<!doctype html><title>s</title><h1>local smoke</h1>",
      visibility: "unlisted",
    },
  });
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  assert(!r.isError, text);
  artifact = JSON.parse(text);
  await client.close();
  return artifact.slug;
});

await check(
  "an allowlisted viewer confirms a code and sees the artifact on its subdomain",
  async () => {
    assert(artifact, "no artifact from the previous step");
    const vis = await f(`${appOrigin}/api/v1/artifacts/${artifact.slug}/visibility`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ visibility: "allowlist", emails: [VIEWER] }),
    });
    assert(vis.status === 200, `visibility ${vis.status} ${await vis.text()}`);
    const s = await csrf(f);
    const mark = inst.log().length;
    const ask = await postJson(
      f,
      `${appOrigin}/api/v1/view/${artifact.slug}/email`,
      { email: VIEWER },
      s,
    );
    assert(ask.status === 200, `email ${ask.status} ${await ask.text()}`);
    const code = await codeFor(inst.log, VIEWER, mark);
    const gate = await postJson(
      f,
      `${appOrigin}/api/v1/view/${artifact.slug}/code`,
      { email: VIEWER, code },
      s,
    );
    const g = await gate.json();
    assert(g.status === "ok" && g.enter_url, `gate ${JSON.stringify(g)}`);
    const enterHost = new URL(g.enter_url).host;
    assert(enterHost.endsWith(`.${CONTENT}`), `enter_url host ${enterHost}`);
    const enter = await f(g.enter_url);
    assert(enter.status === 302, `enter ${enter.status}`);
    const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0];
    const page = await f(new URL(enter.headers.get("location"), g.enter_url), {
      headers: { Cookie: cookie },
    });
    const body = await page.text();
    assert(page.status === 200 && body.includes("local smoke"), `content ${page.status}`);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert(csp.includes("default-src 'none'"), "no CSP on the artifact");
    return `served from ${enterHost}`;
  },
);

await check("wrangler's local explorer is off, even for loopback", async () => {
  for (const h of [APP, `x1.${CONTENT}`, `127.0.0.1:${PORT}`]) {
    const r = await f(`http://${h}/cdn-cgi/local/explorer/api/d1/database`);
    await r.arrayBuffer();
    // Public hosts were already refused (403); the flags must also close it to loopback (404).
    const okStatus = h.startsWith("127.0.0.1") ? [404] : [403, 404];
    assert(okStatus.includes(r.status), `${h}: ${r.status}`);
  }
});

await check("wrangler logs go to the instance directory, not the global one", async () => {
  const dir = path.join(home, "single/logs");
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".log")) : [];
  assert(files.length > 0, `no wrangler log in ${dir}`);
  const mode = statSync(dir).mode & 0o777;
  assert(mode === 0o700, `logs dir mode ${mode.toString(8)}`);
});

await check("the Worker listens on 127.0.0.1 only", async () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  if (!lan) return "skipped: no LAN address";
  const refused = await new Promise((resolve) => {
    const sock = net.connect({ host: lan, port: PORT });
    sock.once("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(true));
  });
  assert(refused, `${lan}:${PORT} accepted a connection`);
  return `${lan}:${PORT} refused`;
});

await check("a second start on a busy port exits non-zero", async () => {
  const code = await new Promise((resolve) => {
    const c = spawn(
      process.execPath,
      [
        path.join(root, "scripts/local-start.mjs"),
        "--name",
        "single",
        "--home",
        home,
        "--no-tunnel",
      ],
      { cwd: root, stdio: "ignore" },
    );
    running.push(c);
    const t = setTimeout(() => {
      c.kill("SIGTERM");
      resolve("timeout");
    }, 30000);
    c.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  assert(code !== 0 && code !== "timeout", `exit ${code}`);
  return `exit ${code}`;
});

// ---------- multi-user boot ----------

await check("a multi-user instance boots and serves the app", async () => {
  setup("multi", MULTI_PORT, ["--email-provider", "resend"], { RESEND_API_KEY: "re_dummy" });
  const m = await start("multi", MULTI_PORT);
  const h = await (await m.fetch(`${appOrigin}/healthz`)).json();
  assert(h.environment === "production", JSON.stringify(h));
  const page = await m.fetch(`${appOrigin}/`);
  await page.arrayBuffer();
  assert(page.status === 200, `GET / ${page.status}`);
  assert((page.headers.get("content-type") ?? "").includes("text/html"), "not HTML");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
