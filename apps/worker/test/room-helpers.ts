// Helpers for the live-room tests (room-guards.test.ts, room.test.ts): pages that declare `room`,
// people with content cookies minted through the real gate, handshakes the way a browser makes
// them, and a client socket whose frames and close can be awaited.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Role } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { contentCookieName } from "../src/content/serve.ts";
import { IDENTITY_CLAIM_INFO } from "../src/content/tokens.ts";
import { accessGrants, artifacts } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { sealJson, signToken } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import {
  agent,
  browserSession,
  config,
  contentOrigin,
  createUser,
  db,
  enterContent,
  publish,
} from "./helpers.ts";

export type Vars = Record<string, unknown>;

export const roomPage = (opts: { viewer?: boolean; open?: string; data?: boolean } = {}) => {
  const caps = [opts.data ? "data" : "", opts.viewer === false ? "" : "viewer", "room"]
    .filter(Boolean)
    .join(" ");
  return `<!doctype html><title>Board</title>
<meta name="plinth-capabilities" content="${caps}">
${opts.open !== undefined ? `<meta name="plinth-room-open" content="${opts.open}">` : ""}
<p>board</p>`;
};
export const PLAIN = "<!doctype html><title>Plain</title><p>nothing declared</p>";

/** The Worker's fetch handler with extra vars, waiting for its waitUntil work. */
export async function run(url: string, init: RequestInit = {}, vars: Vars = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

export async function cookieFor(id: string, headers?: Record<string, string>): Promise<string> {
  const { cookie, gate } = await enterContent(id, { headers });
  if (!cookie) throw new Error(`no content cookie (gate ${gate.status})`);
  return cookie;
}

export interface Person {
  email: string;
  userId: string;
  cookie: string;
  session: Awaited<ReturnType<typeof browserSession>>;
}

/** A published artifact and its signed-in owner with a content cookie. */
export async function setup(html = roomPage(), body: Record<string, unknown> = {}) {
  const owner = await agent();
  const { body: p } = await publish(owner.auth, { html, visibility: "allowlist", ...body });
  const id = p.id as string;
  const session = await browserSession(owner.user.id);
  const me: Person = {
    email: owner.user.email,
    userId: owner.user.id,
    cookie: await cookieFor(id, session.headers),
    session,
  };
  return { owner, id, slug: p.slug as string, ownerP: me };
}

/** A signed-in person with a grant, and their content cookie. */
export async function person(id: string, role: Role): Promise<Person> {
  const user = await createUser();
  await grant(id, user.email, role);
  const session = await browserSession(user.id);
  return {
    email: user.email,
    userId: user.id,
    cookie: await cookieFor(id, session.headers),
    session,
  };
}

/** A handshake as a browser makes it from the artifact's own page; `headers` override (null drops). */
export function upgrade(
  id: string,
  cookie: string | null,
  opts: {
    kind?: string;
    headers?: Record<string, string | null>;
    method?: string;
    vars?: Vars;
  } = {},
): Promise<Response> {
  const base: Record<string, string | null> = {
    upgrade: "websocket",
    origin: contentOrigin(id),
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "websocket",
    "sec-websocket-protocol": "plinth.room.v1",
    cookie,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...(opts.headers ?? {}) })) {
    if (v !== null) headers.set(k, v);
  }
  return run(
    `${contentOrigin(id)}/__plinth/room/v1/${opts.kind ?? "page"}`,
    { method: opts.method ?? "GET", headers },
    opts.vars,
  );
}

/** GET /__plinth/api/v1/room the way the runtime asks. */
export function info(
  id: string,
  cookie: string | null,
  opts: { headers?: Record<string, string | null>; vars?: Vars; method?: string } = {},
): Promise<Response> {
  const base: Record<string, string | null> = {
    "x-plinth-data": "1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...(opts.headers ?? {}) })) {
    if (v !== null) headers.set(k, v);
  }
  return run(
    `${contentOrigin(id)}/__plinth/api/v1/room`,
    { method: opts.method ?? "GET", headers },
    opts.vars,
  );
}

export type Frame = any;

/** A client socket: frames in order, and its close. */
export interface Client {
  ws: WebSocket;
  send(frame: unknown): void;
  /** The next frame (JSON, or the literal "pong"). */
  next(ms?: number): Promise<Frame>;
  /** Skip frames until one with this `t`. */
  nextOf(t: string, ms?: number): Promise<Frame>;
  /** Resolves with the close code and reason. */
  closed: Promise<{ code: number; reason: string }>;
  /** Frames received and not yet taken. */
  pending(): Frame[];
}

export function client(ws: WebSocket): Client {
  const queue: Frame[] = [];
  const waiters: ((f: Frame) => void)[] = [];
  let onClose!: (c: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => {
    onClose = r;
  });
  ws.addEventListener("message", (e) => {
    const raw = typeof e.data === "string" ? e.data : "";
    const f = raw === "pong" ? "pong" : JSON.parse(raw);
    const w = waiters.shift();
    if (w) w(f);
    else queue.push(f);
  });
  ws.addEventListener("close", (e) => onClose({ code: e.code, reason: e.reason }));
  const next = (ms = 3000) =>
    new Promise<Frame>((resolve, reject) => {
      const f = queue.shift();
      if (f !== undefined) return resolve(f);
      const t = setTimeout(() => reject(new Error("no frame in time")), ms);
      waiters.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
  return {
    ws,
    send: (frame) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
    next,
    async nextOf(t, ms) {
      for (;;) {
        const f = await next(ms);
        if (f?.t === t) return f;
      }
    },
    closed,
    pending: () => [...queue],
  };
}

/** Open a room socket and take its welcome. */
export async function connect(
  id: string,
  cookie: string,
  opts: Parameters<typeof upgrade>[2] = {},
): Promise<Client & { welcome: Frame }> {
  const res = await upgrade(id, cookie, opts);
  if (res.status !== 101) throw new Error(`handshake ${res.status}: ${await res.text()}`);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const c = client(ws);
  const welcome = await c.next();
  if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);
  return { ...c, welcome };
}

/** A promise that settles within `ms`, or "timeout". */
export function within<T>(p: Promise<T>, ms = 3000): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

// ---------- live doc editing (live-doc.test.ts, live-api.test.ts) ----------

export const docBody = (content: string) => ({ html: undefined, type: "doc", content });

/** A doc artifact and its signed-in owner with a content cookie. */
export function docSetup(content = "# Plan\n\nFirst.\n\nSecond.\n") {
  return setup(undefined, docBody(content));
}

/**
 * A content cookie for an identity sealed by hand: `account: false` is an editor confirmed by
 * code (no account), as the gate seals it for a viewer principal.
 */
export async function sealedCookie(
  id: string,
  email: string,
  role: Role,
  account: boolean,
): Promise<string> {
  const cfg = config();
  const row = await db().select().from(artifacts).where(eq(artifacts.id, id)).get();
  const x = await sealJson(cfg.tokenSigningKey, IDENTITY_CLAIM_INFO, id, {
    m: email,
    r: role,
    ...(account ? { a: 1 } : {}),
  });
  const value = await signToken(cfg.tokenSigningKey, {
    k: "content",
    a: id,
    e: row?.accessEpoch ?? 1,
    exp: Date.now() + 3600_000,
    x,
  });
  return `${contentCookieName(cfg, new URL(contentOrigin(id)))}=${value}`;
}

/** Open a doc socket and take its welcome and text frames; `text` is the draft it was sent. */
export async function connectDoc(
  id: string,
  cookie: string,
): Promise<Client & { welcome: Frame; text: string }> {
  const c = await connect(id, cookie, { kind: "doc" });
  const text = await readText(c, c.welcome.gen);
  return { ...c, text };
}

/** The `text` frames that follow a welcome, reset or rebased, joined. */
export async function readText(c: Client, gen: string): Promise<string> {
  const parts: string[] = [];
  for (;;) {
    const f = await c.nextOf("text");
    if (f.gen !== gen) throw new Error("text frame of another gen");
    parts[f.part] = f.chunk;
    if (parts.filter((p) => p !== undefined).length === f.of) return parts.join("");
  }
}
