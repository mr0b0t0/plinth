#!/usr/bin/env node
// Staging smoke test (build prompt, "Staging smoke test"). Runs against a live deployment:
//   node e2e/staging/smoke.mjs --url https://plinth-staging.<sub>.workers.dev --token plinth_pat_...
// Checks: health; sign-in request accepted (if --email is given; the code itself arrives by email);
// OAuth discovery metadata; publish and update through /mcp with a personal access token using
// the official MCP client; the artifact fetched as an anonymous viewer (gate -> one-time token ->
// content); security headers on the artifact response.
// Exit code 0 when every check passes. Never prints the token.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--"))
      acc.push([a.slice(2), all[i + 1]?.startsWith("--") ? "true" : (all[i + 1] ?? "true")]);
    return acc;
  }, []),
);
const base = (args.url ?? process.env.PLINTH_SMOKE_URL ?? "").replace(/\/+$/, "");
const token = args.token ?? process.env.PLINTH_SMOKE_TOKEN ?? "";
if (!base || !token) {
  console.error(
    "usage: node e2e/staging/smoke.mjs --url <app origin> --token <plinth_pat_...> [--email <address>]",
  );
  process.exit(2);
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function csrfSession() {
  const r = await fetch(`${base}/api/v1/config`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return { cookie, token: cookie.split("=")[1] ?? "", config: await r.json() };
}

await check("health", async () => {
  const r = await fetch(`${base}/healthz`);
  const body = await r.json();
  assert(r.status === 200 && body.ok === true, `status ${r.status}`);
  return `environment=${body.environment}`;
});

if (args.email) {
  await check("sign-in request accepted", async () => {
    const s = await csrfSession();
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: s.cookie,
        "x-plinth-csrf": s.token,
        Origin: base,
      },
      body: JSON.stringify({ email: args.email }),
    });
    assert(r.status === 200, `status ${r.status} ${await r.text()}`);
    return `code sent to ${args.email} (check the inbox)`;
  });
}

await check("OAuth discovery metadata", async () => {
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert(as.issuer === base, `issuer ${as.issuer}`);
  assert(as.code_challenge_methods_supported?.includes("S256"), "no S256");
  assert(pr.resource === `${base}/mcp`, `resource ${pr.resource}`);
  const unauth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert(
    unauth.status === 401 &&
      /resource_metadata=/.test(unauth.headers.get("www-authenticate") ?? ""),
    "no 401 challenge",
  );
  return "authorization server, protected resource and 401 challenge";
});

let artifact = null;
await check("publish and update through /mcp (official MCP client)", async () => {
  const client = new Client({ name: "plinth-staging-smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name, a) => {
    const r = await client.callTool({ name, arguments: a });
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  const stamp = new Date().toISOString();
  const pub = await call("publish_artifact", {
    title: `Staging smoke ${stamp}`,
    html: `<!doctype html><title>smoke</title><h1>smoke v1 ${stamp}</h1>`,
  });
  const up = await call("update_artifact", {
    id: pub.id,
    html: `<!doctype html><title>smoke</title><h1>smoke v2 ${stamp}</h1>`,
    note: "staging smoke",
    base_version: 1,
  });
  assert(up.version === 2, `version ${up.version}`);
  await client.close();
  artifact = { ...pub, stamp };
  return `${pub.slug} v1 -> v2`;
});

await check("anonymous viewer fetch and security headers", async () => {
  assert(artifact, "no artifact from the previous step");
  const gate = await (await fetch(`${base}/api/v1/view/${artifact.slug}`)).json();
  assert(gate.status === "ok", `gate ${gate.status}`);
  const enter = await fetch(gate.enter_url, { redirect: "manual" });
  assert(enter.status === 302, `enter ${enter.status}`);
  const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0];
  const target = new URL(enter.headers.get("location"), gate.enter_url);
  const page = await fetch(target, { headers: { Cookie: cookie }, redirect: "manual" });
  const body = await page.text();
  assert(page.status === 200, `content ${page.status}`);
  assert(body.includes(`smoke v2 ${artifact.stamp}`), "content is not v2");
  const csp = page.headers.get("content-security-policy") ?? "";
  for (const d of ["default-src 'none'", "connect-src 'self'", "object-src 'none'"])
    assert(csp.includes(d), `CSP lacks ${d}`);
  assert(page.headers.get("x-content-type-options") === "nosniff", "no nosniff");
  assert(
    (page.headers.get("permissions-policy") ?? "").includes("camera=()"),
    "no Permissions-Policy",
  );
  const replay = await fetch(gate.enter_url, { redirect: "manual" });
  assert(replay.status === 403, `token replay ${replay.status}`);
  const host = new URL(gate.enter_url).host;
  return `served from ${host}${target.pathname}; CSP, nosniff, Permissions-Policy present; token single-use`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
