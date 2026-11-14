// The shared OAuth client (integrations/watcher/plinth-oauth.mjs) against a fake instance: client
// reuse across logins, re-registration when the server forgot the client, one refresh across two
// processes, invalid_grant signing out, the User-Agent on every request, refused redirects, and
// the state file's permissions. Plain node:test (Node 18+).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOAuth } from "../../../integrations/watcher/plinth-oauth.mjs";
import { startFakePlinth } from "./helpers/fake-plinth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OAUTH = path.resolve(here, "../../../integrations/watcher/plinth-oauth.mjs");
const VENDORED = path.resolve(here, "../bin/client/vendor/plinth-oauth.mjs");
const UA = "plinth-test/1.2.3";

function client(env, extra = {}) {
  const logs = [];
  const oauth = createOAuth({
    clientName: "Test tool",
    scope: "artifacts:read",
    filePrefix: "test-",
    userAgent: UA,
    env,
    log: (m) => logs.push(m),
    ...extra,
  });
  return { oauth, logs };
}

/** Log in, acting as the browser: open the printed address and follow it to the callback. */
async function login(oauth, logs, base) {
  const seen = logs.length;
  const done = oauth.login(base, { noBrowser: true });
  done.catch(() => {});
  for (let i = 0; i < 200 && logs.length === seen; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(logs.length > seen, "login printed no address");
  const url = logs.at(-1).split("\n").at(-1);
  const res = await fetch(url);
  assert.equal(res.status, 200, await res.text());
  return done;
}

describe("plinth-oauth", () => {
  let fake;
  let config;
  let env;
  before(async () => {
    fake = await startFakePlinth();
  });
  after(async () => {
    await fake.close();
  });
  const fresh = () => {
    config = mkdtempSync(path.join(tmpdir(), "plinth-oauth-"));
    env = { XDG_CONFIG_HOME: config };
  };

  it("is the same file the CLI vendors", () => {
    assert.equal(readFileSync(VENDORED, "utf8"), readFileSync(OAUTH, "utf8"));
  });

  it("logs in with PKCE, sends resource, and saves the state 0600 in a 0700 folder", async () => {
    fresh();
    const { oauth, logs } = client(env);
    const s = await login(oauth, logs, fake.origin);
    assert.match(s.access_token, /^plinth_at_/);
    assert.equal(fake.state.lastAuthorize.resource, `${fake.origin}/mcp`);
    assert.equal(fake.state.lastAuthorize.scope, "artifacts:read");
    assert.equal(fake.state.lastAuthorize.code_challenge_method, "S256");
    const p = oauth.paths(fake.origin);
    assert.equal(path.basename(p.state), `test-127.0.0.1_${new URL(fake.origin).port}.json`);
    assert.equal(statSync(p.state).mode & 0o777, 0o600);
    assert.equal(statSync(p.dir).mode & 0o777, 0o700);
    assert.equal(await oauth.accessToken(fake.origin), s.access_token);
    rmSync(config, { recursive: true, force: true });
  });

  it("never hands one origin's token to another origin that shares its state file", async () => {
    fresh();
    const { oauth, logs } = client(env);
    const s = await login(oauth, logs, fake.origin);
    // http and https on one host:port map to the same file name.
    const twin = fake.origin.replace(/^http:/, "https:");
    assert.equal(oauth.paths(twin).state, oauth.paths(fake.origin).state);
    assert.equal(oauth.readState(twin), null);
    assert.equal(await oauth.accessToken(twin), null);
    assert.equal(await oauth.accessToken(twin, { force: true }), null);
    assert.equal(await oauth.logout(twin), false);
    // The real origin's sign-in is untouched.
    assert.equal(await oauth.accessToken(fake.origin), s.access_token);
    rmSync(config, { recursive: true, force: true });
  });

  it("reuses its client_id on the next login, and registers again when the server forgot it", async () => {
    fresh();
    const { oauth, logs } = client(env);
    const before = fake.state.registrations;
    const first = await login(oauth, logs, fake.origin);
    assert.equal(await oauth.logout(fake.origin), true);
    const second = await login(oauth, logs, fake.origin);
    assert.equal(second.client_id, first.client_id);
    assert.equal(fake.state.registrations, before + 1);

    fake.state.clients.delete(second.client_id);
    await oauth.logout(fake.origin);
    const third = await login(oauth, logs, fake.origin);
    assert.notEqual(third.client_id, first.client_id);
    assert.equal(fake.state.registrations, before + 2);
    rmSync(config, { recursive: true, force: true });
  });

  it("registers a new client when the saved loopback port is taken", async () => {
    fresh();
    const { oauth, logs } = client(env);
    const first = await login(oauth, logs, fake.origin);
    const saved = JSON.parse(readFileSync(oauth.paths(fake.origin).client, "utf8"));
    const blocker = createServer(() => {});
    await new Promise((r) =>
      blocker.listen(Number(new URL(saved.redirect_uri).port), "127.0.0.1", r),
    );
    try {
      const second = await login(oauth, logs, fake.origin);
      assert.notEqual(second.client_id, first.client_id);
    } finally {
      blocker.close();
      rmSync(config, { recursive: true, force: true });
    }
  });

  it("refreshes once when two processes find the token expired at the same time", async () => {
    fresh();
    const { oauth, logs } = client(env);
    await login(oauth, logs, fake.origin);
    const file = oauth.paths(fake.origin).state;
    const expired = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...expired, expires_at: 0 }), { mode: 0o600 });
    fake.state.refreshDelayMs = 400;
    const refreshesBefore = fake.state.refreshes;
    const script = `
      import { createOAuth } from ${JSON.stringify(pathToFileURL(OAUTH).href)};
      const o = createOAuth({ clientName: "Test tool", scope: "artifacts:read", filePrefix: "test-", userAgent: "x/1" });
      console.log(await o.accessToken(${JSON.stringify(fake.origin)}));`;
    const run = () =>
      new Promise((resolve, reject) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, ...env },
        });
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => {
          out += d;
        });
        c.stderr.on("data", (d) => {
          err += d;
        });
        c.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
      });
    const [a, b] = await Promise.all([run(), run()]);
    fake.state.refreshDelayMs = 0;
    assert.equal(fake.state.refreshes, refreshesBefore + 1);
    assert.equal(a, b);
    assert.notEqual(a, expired.access_token);
    const now = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(now.signed_out, false);
    assert.notEqual(now.refresh_token, expired.refresh_token);
    rmSync(config, { recursive: true, force: true });
  });

  it("signs out on invalid_grant (revoked) and returns no token", async () => {
    fresh();
    const { oauth, logs } = client(env);
    const s = await login(oauth, logs, fake.origin);
    for (const g of fake.state.grants.values()) if (g.refresh === s.refresh_token) g.revoked = true;
    const file = oauth.paths(fake.origin).state;
    writeFileSync(file, JSON.stringify({ ...s, expires_at: 0 }), { mode: 0o600 });
    assert.equal(await oauth.accessToken(fake.origin), null);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).signed_out, true);
    assert.equal(await oauth.accessToken(fake.origin), null);
    rmSync(config, { recursive: true, force: true });
  });

  it("names itself in the User-Agent on every request", async () => {
    fresh();
    const { oauth, logs } = client(env);
    const from = fake.state.requests.length;
    const s = await login(oauth, logs, fake.origin);
    writeFileSync(oauth.paths(fake.origin).state, JSON.stringify({ ...s, expires_at: 0 }));
    await oauth.accessToken(fake.origin);
    await oauth.logout(fake.origin);
    const mine = fake.state.requests.slice(from).filter((r) => r.path !== "/oauth/authorize");
    assert.ok(mine.length >= 6, `only ${mine.length} requests`);
    for (const r of mine) assert.equal(r.ua, UA, `${r.method} ${r.path}`);
    rmSync(config, { recursive: true, force: true });
  });

  it("refuses to follow a redirect, and refuses endpoints on another origin", async () => {
    fresh();
    const hop = createServer((_req, res) => {
      res.writeHead(302, { Location: `${fake.origin}/.well-known/oauth-authorization-server` });
      res.end();
    });
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopOrigin = `http://127.0.0.1:${hop.address().port}`;
    try {
      const { oauth } = client(env);
      await assert.rejects(oauth.login(hopOrigin, { noBrowser: true }), /fetch failed|redirect/i);
      const r = await oauth.request(`${fake.origin}/api/v1/config`);
      assert.equal(r.status, 200);
      const elsewhere = await startFakePlinth({
        metadata: { token_endpoint: "https://attacker.example/token" },
      });
      try {
        await assert.rejects(
          client(env).oauth.login(elsewhere.origin, { noBrowser: true }),
          /another origin/,
        );
      } finally {
        await elsewhere.close();
      }
    } finally {
      hop.close();
      rmSync(config, { recursive: true, force: true });
    }
  });
});
