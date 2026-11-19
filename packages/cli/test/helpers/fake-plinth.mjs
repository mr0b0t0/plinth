// A fake Plinth instance for the client tests: the OAuth endpoints (registration, PKCE authorize,
// token with refresh rotation, revocation), GET /config, GET /me, artifacts (GET, PUT with reuse by
// sha256 and base_version conflicts), POST /uploads and the bundle route, which reads the tar with
// the tests' own reader. It records every request (method, path, User-Agent, Authorization) so the
// tests can check what the client sent and where. A category given to POST /uploads or PUT is
// echoed in the result, as the real server echoes the name it stored, and kept on the artifact,
// which GET /artifacts/:ref returns. `state.boundArtifact` makes GET /me say the token is limited
// to one artifact ({id, slug, title}, or null for one it can no longer open); `state.putError`
// answers the next PUT with that error; `state.warnings` replaces the warnings of every publish.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readTar } from "./tar-reader.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const rid = (n = 20) =>
  [...randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

export const PAT = "plinth_pat_testtoken";

export async function startFakePlinth(options = {}) {
  const state = {
    requests: [],
    clients: new Map(), // client_id -> { redirect_uris, name }
    registrations: 0,
    refreshes: 0,
    codes: new Map(), // code -> { client_id, challenge, redirect_uri, scope }
    tokens: new Map(), // access -> { grant }
    grants: new Map(), // id -> { refresh, previous, revoked, client_id, scope }
    artifacts: new Map(), // id -> { id, slug, type, versions: [Map(path -> {bytes, sha256})] }
    tickets: new Map(), // id -> { token, mode, artifact_id, base_version, type, title, category, used }
    edgeBlock: false,
    redirectApi: false,
    refreshDelayMs: options.refreshDelayMs ?? 0,
    forgetOnce: false, // the next PUT reports every reused file as missing
    // A lost response: "after" commits (or refuses) and then drops the connection without an
    // answer; "before" reads the whole body and drops it without committing; "midway" (bundles
    // only) drops it after the first chunk; "late" (PUTs only) drops it, then commits 300 ms later. Applies to the next
    // bundle POST (dropBundle) or inline PUT (dropPut), then resets.
    dropBundle: null,
    dropPut: null,
    // dropBundle applies to every bundle POST until it is reset.
    dropBundleSticky: false,
    // GET /uploads/:id answers 503 text/plain this many more times (Infinity: always).
    statusFail: 0,
    // GET /uploads/:id says a request still holds the upload (state receiving).
    statusReceiving: false,
    // GET /uploads/:id answers this state (for example "taken_down") when set.
    statusState: null,
    // GET /artifacts/:ref answers 503 text/plain this many more times (Infinity: always).
    artifactReadFail: 0,
    // The caller is not the owner: an update (PUT or POST /uploads with an id) that carries a
    // category is refused 403 owner_only, as the real server does, before anything is written.
    notOwner: false,
    // GET /me's connection: undefined (an older server), or a token limited to this artifact.
    boundArtifact: undefined,
    // The next PUT /artifacts/:ref answers { status, code, message, details } instead.
    putError: null,
    warnings: null,
    limits: {
      max_html_bytes: 5 * 1024 * 1024,
      max_doc_bytes: 1024 * 1024,
      max_version_bytes: 50 * 1024 * 1024,
      max_assets_per_version: 511,
      max_asset_path_length: 200,
      max_request_bytes: 40 * 1024 * 1024,
      max_bundle_bytes: 58 * 1024 * 1024,
      max_bundle_file_bytes: 25 * 1024 * 1024,
      ...(options.limits ?? {}),
    },
  };
  let origin = "";

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const apiError = (res, status, code, message, details) =>
    send(res, status, { error: { code, message, ...(details ? { details } : {}) } });
  /** The real server's refusal of a category from someone who is not the owner (no stored name). */
  const ownerOnly = (res) =>
    apiError(res, 403, "forbidden", "Only the owner sets an artifact's category", {
      field: "category",
      reason: "owner_only",
      next: "Leave category out when you change an artifact you do not own",
    });

  function issue(grantId) {
    const g = state.grants.get(grantId);
    const access = `plinth_at_${rid(24)}`;
    const refresh = `plinth_rt_${rid(24)}`;
    g.previous = g.refresh;
    g.refresh = refresh;
    state.tokens.set(access, { grant: grantId });
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" };
  }

  function principal(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    if (m[1] === PAT) return { email: "owner@example.com", via: "pat" };
    const t = state.tokens.get(m[1]);
    if (!t || state.grants.get(t.grant)?.revoked) return null;
    return { email: "owner@example.com", via: "oauth" };
  }

  function detail(a, n) {
    const v = a.versions[n - 1];
    const sourcePath = a.type === "doc" ? "content.md" : "index.html";
    const assets = [...v]
      .filter(([p]) => p !== sourcePath)
      .map(([path, f]) => ({
        path,
        size_bytes: f.bytes.length,
        content_type: "x",
        sha256: f.sha256,
      }));
    // As the Worker's readText (R2 text()): UTF-8 decoding drops a leading BOM.
    let src = new TextDecoder().decode(v.get(sourcePath)?.bytes ?? new Uint8Array());
    if (state.tamperSource) src += "<!-- not what was sent -->";
    return {
      id: a.id,
      slug: a.slug,
      type: a.type,
      title: a.title ?? "t",
      version: n,
      source_path: sourcePath,
      category: a.category ?? null,
      assets,
      ...(a.type === "doc" ? { content: src } : { html: src }),
    };
  }

  /** Commit `files` (Map path -> bytes) as the next version; returns a PublishResult. */
  function commit(a, files, category) {
    const prev = a.versions.at(-1);
    const prevHashes = new Set(prev ? [...prev.values()].map((f) => f.sha256) : []);
    const sourcePath = a.type === "doc" ? "content.md" : "index.html";
    const next = new Map();
    let written = 0;
    let bytesWritten = 0;
    let bytes = 0;
    for (const [p, b] of files) {
      const h = sha(b);
      next.set(p, { bytes: b, sha256: h });
      bytes += b.length;
      if (p === sourcePath || !prevHashes.has(h)) {
        written++;
        bytesWritten += b.length;
      }
    }
    a.versions.push(next);
    if (category !== undefined) a.category = category;
    return {
      id: a.id,
      slug: a.slug,
      type: a.type,
      version: a.versions.length,
      url: `${origin}/a/${a.slug}`,
      content_url: `${origin.replace("127.0.0.1", `${a.id}.localhost`)}/`,
      visibility: "allowlist",
      warnings: state.warnings ?? options.warnings ?? [],
      stored: {
        files: files.size,
        written,
        reused: files.size - written,
        bytes,
        bytes_written: bytesWritten,
      },
      ...(category !== undefined ? { category } : {}),
    };
  }

  /** Drop the connection without an answer (the client sees a lost response). */
  const drop = (res) => res.socket.destroy();

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    state.requests.push({
      method: req.method,
      path: p,
      ua: req.headers["user-agent"],
      authorization: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
    });
    try {
      if (state.edgeBlock) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=UTF-8" });
        res.end("error code: 1010");
        return;
      }
      if (state.redirectApi && p.startsWith("/api/v1/")) {
        res.writeHead(302, { Location: "https://elsewhere.example/steal" }).end();
        return;
      }
      if (p === "/.well-known/oauth-authorization-server") {
        return send(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          revocation_endpoint: `${origin}/oauth/revoke`,
          ...(options.metadata ?? {}),
        });
      }
      if (p === "/oauth/register" && req.method === "POST") {
        const m = JSON.parse((await body(req)).toString());
        const id = `client_${rid(12)}`;
        state.registrations++;
        state.clients.set(id, { redirect_uris: m.redirect_uris, name: m.client_name });
        return send(res, 201, { client_id: id, client_name: m.client_name });
      }
      if (p === "/oauth/authorize") {
        const q = url.searchParams;
        const client = state.clients.get(q.get("client_id"));
        if (!client?.redirect_uris.includes(q.get("redirect_uri"))) {
          res.writeHead(400, { "Content-Type": "text/html" }).end("bad client");
          return;
        }
        if (q.get("resource") !== null && q.get("resource") !== `${origin}/mcp`) {
          res.writeHead(400).end("bad resource");
          return;
        }
        const code = `code_${rid(16)}`;
        state.codes.set(code, {
          client_id: q.get("client_id"),
          challenge: q.get("code_challenge"),
          redirect_uri: q.get("redirect_uri"),
          scope: q.get("scope"),
        });
        state.lastAuthorize = Object.fromEntries(q);
        const back = new URL(q.get("redirect_uri"));
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state"));
        back.searchParams.set("iss", origin);
        res.writeHead(302, { Location: back.toString() }).end();
        return;
      }
      if (p === "/oauth/token" && req.method === "POST") {
        const f = new URLSearchParams((await body(req)).toString());
        if (!state.clients.has(f.get("client_id")))
          return send(res, 401, { error: "invalid_client" });
        if (f.get("grant_type") === "authorization_code") {
          const c = state.codes.get(f.get("code"));
          state.codes.delete(f.get("code"));
          const verifier = f.get("code_verifier") ?? "";
          const ok =
            c &&
            c.client_id === f.get("client_id") &&
            c.redirect_uri === f.get("redirect_uri") &&
            createHash("sha256").update(verifier).digest("base64url") === c.challenge;
          if (!ok) return send(res, 400, { error: "invalid_grant" });
          const gid = rid(8);
          state.grants.set(gid, { refresh: null, client_id: c.client_id, scope: c.scope });
          return send(res, 200, issue(gid));
        }
        if (f.get("grant_type") === "refresh_token") {
          state.refreshes++;
          if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
          const rt = f.get("refresh_token");
          const hit = [...state.grants].find(([, g]) => g.refresh === rt && !g.revoked);
          if (!hit) {
            const reused = [...state.grants].find(([, g]) => g.previous === rt);
            if (reused) reused[1].revoked = true;
            return send(res, 400, { error: "invalid_grant" });
          }
          return send(res, 200, issue(hit[0]));
        }
        return send(res, 400, { error: "invalid_request" });
      }
      if (p === "/oauth/revoke" && req.method === "POST") {
        const f = new URLSearchParams((await body(req)).toString());
        for (const g of state.grants.values()) if (g.refresh === f.get("token")) g.revoked = true;
        res.writeHead(200).end();
        return;
      }
      if (p === "/api/v1/config") {
        return send(res, 200, {
          app_origin: origin,
          content_isolation: "origin",
          ...(options.noLimits ? {} : { limits: state.limits }),
        });
      }
      if (p === "/api/v1/mentions") {
        if (!principal(req)) return apiError(res, 401, "unauthorized", "no");
        return send(res, 200, { items: [] });
      }
      // GET /uploads/:id: the ticket's state, for a client whose bundle answer was lost.
      const status = /^\/api\/v1\/uploads\/([a-z0-9]{20})$/.exec(p);
      if (status && req.method === "GET") {
        const t = state.tickets.get(status[1]);
        const m = /^Bearer (plinth_up_\S+)$/.exec(req.headers.authorization ?? "");
        if (!m) return apiError(res, 401, "unauthorized", "Upload token only");
        if (!t || m[1] !== t.token) return apiError(res, 404, "not_found", "Not found");
        if (state.statusFail > 0) {
          state.statusFail -= 1;
          res.writeHead(503, { "Content-Type": "text/plain" });
          return res.end("upstream down");
        }
        const state_ = state.statusState
          ? state.statusState
          : state.statusReceiving
            ? "receiving"
            : t.used
              ? "used"
              : t.dead
                ? "dead"
                : "open";
        return send(res, 200, {
          upload_id: status[1],
          state: state_,
          mode: t.mode,
          id: t.mode === "update" ? t.artifact_id : t.reserved,
          version: t.used ? t.version : null,
          url: t.used ? t.url : null,
          expires_at: new Date(Date.now() + 1800_000).toISOString(),
          receiving_until: state.statusReceiving
            ? new Date(Date.now() + 600_000).toISOString()
            : null,
          next: "...",
        });
      }
      const bundle = /^\/api\/v1\/uploads\/([a-z0-9]{20})\/bundle$/.exec(p);
      if (bundle && req.method === "POST") {
        const t = state.tickets.get(bundle[1]);
        const m = /^Bearer (plinth_up_\S+)$/.exec(req.headers.authorization ?? "");
        if (!t || !m || m[1] !== t.token) return apiError(res, 404, "not_found", "Not found");
        if (t.used)
          return apiError(res, 409, "conflict", "Used", {
            reason: "upload_used",
            id: t.result_id,
            version: t.version,
            url: t.url,
          });
        if (t.dead) return apiError(res, 409, "conflict", "Dead", { reason: "upload_dead" });
        const dropping = state.dropBundle;
        if (!state.dropBundleSticky) state.dropBundle = null;
        if (dropping === "midway") {
          // The connection breaks while the bundle is still arriving.
          await new Promise((r) => req.once("data", r));
          return drop(res);
        }
        const raw = await body(req);
        if (dropping === "before") return drop(res);
        state.lastBundle = raw;
        const entries = readTar(raw);
        const files = new Map(entries.map((e) => [e.path, e.bytes]));
        let a;
        if (t.mode === "publish") {
          a = { id: t.reserved, slug: `page-${rid(6)}`, type: t.type, versions: [] };
          state.artifacts.set(a.id, a);
        } else {
          a = state.artifacts.get(t.artifact_id);
          if (state.bumpBeforeBundle) {
            const bump = state.bumpBeforeBundle;
            state.bumpBeforeBundle = null;
            bump();
          }
          // The body the real server sends (services/uploads.ts afterFailure): a version conflict
          // on a bundle carries reason "conflict" and a next step.
          if (a.versions.length !== t.base_version) {
            t.dead = true;
            if (dropping === "after") return drop(res);
            return apiError(res, 409, "conflict", "Not current", {
              current_version: a.versions.length,
              reason: "conflict",
              next: `v${a.versions.length} is current; check what changed (get_artifact), then start_upload again with base_version ${a.versions.length}`,
            });
          }
        }
        t.used = true;
        const result = commit(a, files, t.category);
        t.url = result.url;
        t.result_id = result.id;
        t.version = result.version;
        state.bundleCommits = (state.bundleCommits ?? 0) + 1;
        if (dropping === "after") return drop(res);
        return send(res, t.mode === "publish" ? 201 : 200, {
          ...result,
          bundle: { entries: entries.length, skipped: [], stripped_prefix: null },
        });
      }
      // Everything below needs a bearer.
      const who = principal(req);
      if (!who) return apiError(res, 401, "unauthorized", "Invalid, expired or revoked token");
      if (p === "/api/v1/me") {
        const b = state.boundArtifact;
        return send(res, 200, {
          id: "u1",
          email: who.email,
          ...(b === undefined
            ? {}
            : { connection: { id: "c1", label: "CI", bound: true, artifact: b ?? null } }),
        });
      }
      if (p === "/api/v1/uploads" && req.method === "POST") {
        const input = JSON.parse((await body(req)).toString() || "{}");
        const id = rid(20);
        const token = `plinth_up_${rid(30)}`;
        if (input.id) {
          const a = state.artifacts.get(input.id);
          if (!a) return apiError(res, 404, "not_found", "Not found");
          if (input.base_version === undefined)
            return apiError(res, 400, "invalid_input", "base_version is required");
          if (input.category !== undefined && state.notOwner) {
            state.lastUploadInput = input;
            return ownerOnly(res);
          }
          if (input.base_version !== a.versions.length)
            return apiError(res, 409, "conflict", "stale", { current_version: a.versions.length });
          state.tickets.set(id, {
            token,
            mode: "update",
            artifact_id: a.id,
            base_version: input.base_version,
            type: a.type,
            category: input.category,
          });
        } else {
          state.tickets.set(id, {
            token,
            mode: "publish",
            type: input.type ?? "html",
            title: input.title,
            category: input.category,
            reserved: rid(20),
          });
        }
        state.lastUploadInput = input;
        return send(res, 201, {
          upload_id: id,
          upload_token: token,
          expires_at: new Date(Date.now() + 1800_000).toISOString(),
          upload_url: options.uploadUrl ?? `${origin}/api/v1/uploads/${id}/bundle`,
          target: input.id
            ? { mode: "update", id: input.id, type: input.type ?? "html" }
            : { mode: "publish", id: state.tickets.get(id).reserved, type: input.type ?? "html" },
          limits: state.limits,
          content_isolation: "origin",
          commands: { curl: "..." },
          next: "...",
        });
      }
      const art = /^\/api\/v1\/artifacts\/([^/]+)$/.exec(p);
      if (art) {
        const ref = decodeURIComponent(art[1]);
        const a = [...state.artifacts.values()].find((x) => x.id === ref || x.slug === ref);
        if (!a) return apiError(res, 404, "not_found", "Not found");
        if (req.method === "GET") {
          if (state.artifactReadFail > 0) {
            state.artifactReadFail -= 1;
            res.writeHead(503, { "Content-Type": "text/plain" });
            return res.end("upstream down");
          }
          const n = Number(url.searchParams.get("version") ?? a.versions.length);
          return send(res, 200, detail(a, n));
        }
        if (req.method === "PUT") {
          const input = JSON.parse((await body(req)).toString());
          state.lastPut = input;
          if (state.putError) {
            const e = state.putError;
            state.putError = null;
            return apiError(res, e.status, e.code, e.message, e.details);
          }
          if (input.category !== undefined && state.notOwner) return ownerOnly(res);
          if (state.bumpBeforePut) {
            const bump = state.bumpBeforePut;
            state.bumpBeforePut = null;
            bump();
          }
          if (input.base_version !== undefined && input.base_version !== a.versions.length) {
            return apiError(res, 409, "conflict", "Version is not current", {
              current_version: a.versions.length,
            });
          }
          const cur = a.versions.at(-1);
          const byHash = new Map([...cur.values()].map((f) => [f.sha256, f.bytes]));
          const files = new Map();
          const src = a.type === "doc" ? input.content : input.html;
          files.set(a.type === "doc" ? "content.md" : "index.html", Buffer.from(src, "utf8"));
          const missing = [];
          for (const x of input.assets ?? []) {
            if (x.content !== undefined) {
              const b = Buffer.from(x.content, x.encoding === "base64" ? "base64" : "utf8");
              if (x.sha256 && sha(b) !== x.sha256)
                return apiError(res, 400, "invalid_input", "sha256 mismatch", { path: x.path });
              files.set(x.path, b);
            } else if (byHash.has(x.sha256) && !state.forgetOnce) {
              files.set(x.path, byHash.get(x.sha256));
            } else missing.push(x.path);
          }
          state.forgetOnce = false;
          if (missing.length)
            return apiError(res, 400, "invalid_input", "Files not found", {
              missing_paths: missing,
            });
          const dropping = state.dropPut;
          state.dropPut = null;
          if (dropping === "before") return drop(res);
          if (dropping === "late") {
            // The connection breaks first; the server finishes the PUT a moment later.
            drop(res);
            await new Promise((r) => setTimeout(r, 300));
            commit(a, files, input.category);
            state.putCommits = (state.putCommits ?? 0) + 1;
            return;
          }
          const committed = commit(a, files, input.category);
          state.putCommits = (state.putCommits ?? 0) + 1;
          if (dropping === "after") {
            // armReadFail: the network stays down, so every later GET of an artifact fails too.
            if (state.armReadFail) state.artifactReadFail = Number.POSITIVE_INFINITY;
            return drop(res);
          }
          return send(res, 200, committed);
        }
      }
      return apiError(res, 404, "not_found", `No route ${req.method} ${p}`);
    } catch (e) {
      return apiError(res, 500, "internal", e.message);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    /** Seed an artifact with one version of `files` ({path: string|Buffer}). */
    seed(files, type = "html", title = undefined) {
      const a = { id: rid(20), slug: `seeded-${rid(6)}`, type, title, versions: [] };
      state.artifacts.set(a.id, a);
      commit(a, new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));
      return a;
    },
    /** The next version with exactly `files` ({path: content}), as anyone could publish it. */
    commitFiles(a, files) {
      commit(a, new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));
    },
    /** A second version written by someone else (it adds a file of theirs). */
    bump(a) {
      const cur = a.versions.at(-1);
      const files = new Map([...cur].map(([k, f]) => [k, f.bytes]));
      files.set(`theirs-${a.versions.length}.txt`, Buffer.from("someone else"));
      commit(a, files);
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
