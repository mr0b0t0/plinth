// Dictation run by the app (docs/spec.md "Voice: dictation and text to speech"): the switch and
// its effective state, the app's Permissions-Policy ceiling, the content host's policy that never
// changes, the declaration, the policy matrix, the gate's `voice` block, the runtime's
// plinth.dictation protocol, the publish warning for direct microphone APIs, the agent note, and
// a room that keeps its sockets when only `dictation` is added.
import { env } from "cloudflare:workers";
import {
  type Capabilities,
  type EffectiveRole,
  parseCapabilities,
  readStoredCapabilities,
  serializeCapabilities,
  VOICE_LIMITS,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { appPermissionsPolicy } from "../src/app/headers.ts";
import { dictationActive, parseConfig } from "../src/config.ts";
import { contentSources, PERMISSIONS_POLICY } from "../src/content/csp.ts";
import { runtimeScript } from "../src/content/runtime.ts";
import { DICTATION_PAGE_NOTE, dictationNote } from "../src/mcp/notes.ts";
import { dictationAccess } from "../src/policy.ts";
import { scanPublish } from "../src/services/publishCheck.ts";
import { contentTypeFor } from "../src/services/storage.ts";
import {
  agent,
  call,
  config,
  contentOrigin,
  json,
  mcpClient,
  publish,
  versionRow,
} from "./helpers.ts";
import { connect, info, person, roomPage, run, setup, within } from "./room-helpers.ts";

const ON = { ALLOW_DICTATION: "true" };
const OPAQUE_ON = { ...ON, CONTENT_ISOLATION: "opaque" };

const PAGE = `<!doctype html><title>Notes</title>
<meta name="plinth-capabilities" content="dictation">
<script src="/__plinth/runtime.js"></script><button>Speak</button>`;
const PLAIN = "<!doctype html><title>Plain</title><p>nothing declared</p>";

const base = {
  ENVIRONMENT: "production",
  APP_HOST: "plinth.aconite.io",
  CONTENT_HOST: "plinthusercontent.net",
  PUBLIC_SCHEME: "https",
  EMAIL_PROVIDER: "sendgrid",
  SENDGRID_API_KEY: "SG.x",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_SIGNING_KEY: "t".repeat(40),
};
const fallback = {
  ...base,
  ENVIRONMENT: "staging",
  APP_HOST: "plinth.example.workers.dev",
  STAGING_CONTENT_FALLBACK: "true",
};

async function gate(id: string, headers: Record<string, string> = {}, vars = {}, query = "") {
  return json(await run(`http://app.localhost:8787/api/v1/view/${id}${query}`, { headers }, vars));
}

describe("ALLOW_DICTATION", () => {
  it("is off by default and in the shipped wrangler.jsonc; a true value turns it on", () => {
    expect(parseConfig(base).allowDictation).toBe(false);
    expect((env as unknown as Record<string, unknown>).ALLOW_DICTATION).toBe("false");
    expect(config().allowDictation).toBe(false);
    for (const v of ["true", "1", "on", "TRUE"]) {
      expect(parseConfig({ ...base, ALLOW_DICTATION: v }).allowDictation, v).toBe(true);
    }
    for (const v of ["false", "", "no", "0", "maybe"]) {
      expect(parseConfig({ ...base, ALLOW_DICTATION: v }).allowDictation, v).toBe(false);
    }
  });

  it("is in effect only with origin isolation: never opaque, never the path fallback", () => {
    expect(dictationActive(parseConfig({ ...base, ...ON }))).toBe(true);
    expect(dictationActive(parseConfig(base))).toBe(false);
    const opaque = parseConfig({
      ...base,
      ...ON,
      CONTENT_HOST: "content.aconite.io",
      CONTENT_ISOLATION: "opaque",
    });
    expect(dictationActive(opaque)).toBe(false);
    const path = parseConfig({ ...fallback, ...ON });
    expect(path.contentIsolation).toBe("opaque");
    expect(dictationActive(path)).toBe(false);
  });
});

describe("the app's Permissions-Policy is the ceiling for every frame", () => {
  it("allows the microphone to the app's own origin only while dictation is active", () => {
    const on = appPermissionsPolicy(parseConfig({ ...base, ...ON }));
    expect(on).toBe("camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
    const off = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
    expect(appPermissionsPolicy(parseConfig(base))).toBe(off);
    expect(
      appPermissionsPolicy(
        parseConfig({
          ...base,
          ...ON,
          CONTENT_HOST: "content.aconite.io",
          CONTENT_ISOLATION: "opaque",
        }),
      ),
    ).toBe(off);
    expect(appPermissionsPolicy(parseConfig({ ...fallback, ...ON }))).toBe(off);
    // Never the content host, never a wildcard.
    for (const p of [on, off]) {
      expect(p).not.toContain("*");
      expect(p).not.toContain("plinthusercontent");
      expect(p).not.toMatch(/microphone=\([^)]*\b(https?:|")/);
    }
  });

  it("app responses send it; content responses keep every powerful feature off", async () => {
    const pp = (r: Response) => r.headers.get("permissions-policy");
    for (const path of ["/", "/api/v1/config"]) {
      expect(pp(await run(`http://app.localhost:8787${path}`, {}, ON))).toContain(
        "microphone=(self)",
      );
      expect(pp(await run(`http://app.localhost:8787${path}`))).toContain("microphone=()");
      expect(pp(await run(`http://app.localhost:8787${path}`, {}, OPAQUE_ON))).toContain(
        "microphone=()",
      );
    }
    const a = await agent();
    const { body } = await publish(a.auth, { html: PAGE });
    for (const vars of [{}, ON, OPAQUE_ON]) {
      const res = await run(`${contentOrigin(body.id)}/__plinth/runtime.js`, {}, vars);
      expect(pp(res)).toBe(PERMISSIONS_POLICY);
    }
    expect(PERMISSIONS_POLICY.split(", ")).toEqual(
      expect.arrayContaining(["microphone=()", "camera=()"]),
    );
  });

  it("GET /api/v1/config says whether dictation is offered", async () => {
    const cfg = async (vars = {}) =>
      (await json(await run("http://app.localhost:8787/api/v1/config", {}, vars))).dictation;
    expect(await cfg()).toBe(false);
    expect(await cfg(ON)).toBe(true);
    expect(await cfg(OPAQUE_ON)).toBe(false);
  });
});

describe("the dictation declaration", () => {
  it("declares on its own, with no store and no room, and is stored only when declared", () => {
    const c = parseCapabilities('<meta name="plinth-capabilities" content="dictation">');
    expect(c).toEqual({
      data: false,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      people: false,
      comments: false,
      dictation: true,
    });
    const stored = serializeCapabilities(c as Capabilities);
    expect(stored).toBe('{"data":false,"viewer":false,"shared":[],"dictation":true}');
    expect(readStoredCapabilities(stored)).toEqual(c);
    // Every other declaration is stored exactly as before, without the key.
    const data = parseCapabilities('<meta name="plinth-capabilities" content="data viewer">');
    expect(serializeCapabilities(data as Capabilities)).toBe(
      '{"data":true,"viewer":true,"shared":[]}',
    );
    expect(readStoredCapabilities('{"data":true,"viewer":true,"shared":[]}')?.dictation).toBe(
      false,
    );
    // `dictation: false` stored by hand still reads as no dictation.
    expect(
      readStoredCapabilities('{"data":true,"viewer":false,"dictation":false}')?.dictation,
    ).toBe(false);
    expect(readStoredCapabilities('{"data":false,"viewer":false,"dictation":"yes"}')).toBeNull();
  });

  it("a published dictation-only page has no shared data and no room", async () => {
    const { id, ownerP } = await setup(PAGE);
    expect((await versionRow(id, 1))?.capabilities).toBe(
      '{"data":false,"viewer":false,"shared":[],"dictation":true}',
    );
    const headers = {
      "x-plinth-data": "1",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      cookie: ownerP.cookie,
    };
    const session = await json(
      await run(`${contentOrigin(id)}/__plinth/api/v1/session`, { headers }, ON),
    );
    expect(session).toEqual({ available: false, reason: "not_declared" });
    const room = await json(await info(id, ownerP.cookie, { vars: ON }));
    expect(room).toMatchObject({ available: false, reason: "not_declared" });
    const g = await gate(id, ownerP.session.headers, ON);
    expect(g.data).toBeUndefined();
  });
});

describe("policy: dictationAccess", () => {
  const caps = (dictation: boolean): Capabilities => ({
    data: false,
    viewer: false,
    shared: [],
    room: false,
    roomOpen: [],
    people: false,
    comments: false,
    dictation,
  });
  const who = (role: EffectiveRole) => ({ email: `${role}@example.com`, role });
  const ctx = { active: true, isolation: "origin" as const, type: "html" as const };

  it("is the matrix, in rule order", () => {
    const no = (reason: string) => ({ available: false, reason });
    expect(dictationAccess(who("owner"), caps(true), { ...ctx, type: "doc" })).toEqual(
      no("not_declared"),
    );
    expect(dictationAccess(who("owner"), caps(false), ctx)).toEqual(no("not_declared"));
    expect(dictationAccess(who("owner"), null, ctx)).toEqual(no("not_declared"));
    expect(dictationAccess(who("owner"), caps(true), { ...ctx, isolation: "opaque" })).toEqual(
      no("opaque_isolation"),
    );
    // Opaque comes before the switch: a self-hoster learns the mode is the reason.
    expect(
      dictationAccess(who("owner"), caps(true), { ...ctx, isolation: "opaque", active: false }),
    ).toEqual(no("opaque_isolation"));
    expect(dictationAccess(who("owner"), caps(true), { ...ctx, active: false })).toEqual(
      no("disabled"),
    );
    expect(dictationAccess(null, caps(true), ctx)).toEqual(no("not_identified"));
    for (const role of ["owner", "editor", "commenter", "viewer"] as const) {
      expect(dictationAccess(who(role), caps(true), ctx), role).toEqual({
        available: true,
        reason: null,
      });
    }
  });
});

describe("the gate's voice block", () => {
  it("only when the current version of an HTML page declares dictation and the switch is on", async () => {
    const { id, ownerP } = await setup(PAGE, { visibility: "unlisted" });
    // Those who may dictate get the owner's email for the consent dialog; nobody else does.
    const yes = { dictation: { available: true, reason: null }, owner_email: ownerP.email };
    expect((await gate(id, ownerP.session.headers, ON)).voice).toEqual(yes);
    // Off: nothing read, nothing said (the app answers `disabled` from its config).
    expect((await gate(id, ownerP.session.headers)).voice).toBeUndefined();
    // Grant holders, signed in.
    for (const role of ["viewer", "commenter", "editor"] as const) {
      const p = await person(id, role);
      expect((await gate(id, p.session.headers, ON)).voice, role).toEqual(yes);
    }
    // An anonymous link viewer.
    expect((await gate(id, {}, ON)).voice).toEqual({
      dictation: { available: false, reason: "not_identified" },
    });
    // Opaque isolation.
    expect((await gate(id, ownerP.session.headers, OPAQUE_ON)).voice).toEqual({
      dictation: { available: false, reason: "opaque_isolation" },
    });
    // A page that declares nothing, and a doc.
    const plain = await setup(PLAIN);
    expect((await gate(plain.id, plain.ownerP.session.headers, ON)).voice).toBeUndefined();
    const a = await agent();
    const doc = await publish(a.auth, { html: undefined, type: "doc", content: "# Notes\n" });
    expect((await gate(doc.body.id, {}, ON)).voice).toBeUndefined();
  });

  it("the current version's declaration governs old version URLs", async () => {
    const { id, ownerP, owner } = await setup(PLAIN, { visibility: "unlisted" });
    const update = (html: string, v: number) =>
      call(`/api/v1/artifacts/${id}`, {
        method: "PUT",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html, base_version: v }),
      });
    expect((await update(PAGE, 1)).status).toBe(200);
    const h = ownerP.session.headers;
    expect((await gate(id, h, ON, "?version=1")).voice?.dictation.available).toBe(true);
    expect((await update(PLAIN, 2)).status).toBe(200);
    expect((await gate(id, h, ON, "?version=2")).voice).toBeUndefined();
  });
});

// ---------- plinth.dictation in /__plinth/runtime.js ----------

const APP_ORIGIN = config().appOrigin;

/** Run the served runtime in a fake page: framed or not, origin or opaque, with manual timers. */
function page(opts: { framed?: boolean; origin?: string } = {}) {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const posted: [any, string][] = [];
  const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
  const parent = {
    postMessage(msg: unknown, target: string) {
      posted.push([JSON.parse(JSON.stringify(msg)), target]);
    },
  };
  const win: Record<string, any> = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent: () => true,
  };
  win.parent = opts.framed === false ? win : parent;
  const doc = { visibilityState: "visible", addEventListener() {} };
  const setT = (fn: () => void, ms: number) => {
    const t = { fn, ms, id: timers.length + 1, cleared: false };
    timers.push(t);
    return t.id;
  };
  const clearT = (id: number) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    runtimeScript(config()),
  )(
    win,
    { origin: opts.origin ?? "http://abc.content.localhost:8787" },
    doc,
    () => Promise.reject(new Error("no fetch")),
    setT,
    clearT,
    class {},
  );
  const fromApp = (data: unknown, origin = APP_ORIGIN, source: unknown = parent) => {
    for (const fn of listeners.get("message") ?? []) fn({ source, origin, data });
  };
  const fire = (ms: number) => {
    for (const t of timers) {
      if (t.cleared || t.ms !== ms) continue;
      t.cleared = true;
      t.fn();
    }
  };
  return { win, dictation: win.plinth.dictation, posted, fromApp, fire };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const msg = (body: Record<string, unknown>) => ({ source: "plinth-voice", v: 1, ...body });

describe("plinth.dictation (runtime)", () => {
  it("posts nothing until the page uses it; ready asks the app once", async () => {
    const p = page();
    expect(p.posted).toEqual([]);
    const ready = p.dictation.ready;
    expect(p.dictation.ready).toBe(ready);
    expect(p.posted).toEqual([[msg({ type: "hello" }), APP_ORIGIN]]);
    // Only the app, from the parent, at its exact origin, counts.
    p.fromApp(msg({ type: "status", available: true, reason: null }), "https://evil.example");
    p.fromApp(msg({ type: "status", available: true, reason: null }), APP_ORIGIN, {});
    p.fromApp(msg({ type: "status", available: false, reason: "not_identified" }));
    expect(await ready).toEqual({ available: false, reason: "not_identified" });
  });

  it("no_host without an answer, unframed, or as a top-level page; opaque_isolation without a post", async () => {
    const silent = page();
    const r = silent.dictation.ready;
    silent.fire(3000);
    expect(await r).toEqual({ available: false, reason: "no_host" });

    const top = page({ framed: false });
    expect(await top.dictation.ready).toEqual({ available: false, reason: "no_host" });
    expect(top.posted).toEqual([]);

    const opaque = page({ origin: "null" });
    expect(await opaque.dictation.ready).toEqual({ available: false, reason: "opaque_isolation" });
    expect(opaque.posted).toEqual([]);
    await expect(opaque.dictation.start()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("start, words, state and stop follow the app's answers for the current session only", async () => {
    const p = page();
    const partials: string[] = [];
    const finals: string[] = [];
    const states: unknown[] = [];
    p.dictation.onPartial((e: { text: string }) => partials.push(e.text));
    p.dictation.onFinal((e: { text: string }) => finals.push(e.text));
    p.dictation.onState((e: unknown) => states.push(e));
    const started = p.dictation.start({ lang: "pt-PT", interim: false });
    const [start, target] = p.posted[1] ?? [];
    expect(target).toBe(APP_ORIGIN);
    expect(start).toMatchObject({ type: "start", lang: "pt-PT", interim: false });
    expect(start.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    // Busy while one is pending.
    await expect(p.dictation.start()).rejects.toMatchObject({ code: "busy" });
    p.fromApp(msg({ type: "state", id: start.id, state: "starting" }));
    p.fromApp(msg({ type: "started", id: start.id }));
    await started;
    p.fromApp(msg({ type: "state", id: start.id, state: "listening" }));
    p.fromApp(msg({ type: "partial", id: start.id, text: "hel" }));
    p.fromApp(msg({ type: "partial", id: "other", text: "spoofed" }));
    p.fromApp(msg({ type: "final", id: start.id, text: "hello" }), "https://evil.example");
    p.fromApp(msg({ type: "final", id: start.id, text: "hello" }));
    expect(partials).toEqual(["hel"]);
    expect(finals).toEqual(["hello"]);
    const stopped = p.dictation.stop();
    expect(p.posted.at(-1)).toEqual([msg({ type: "stop", id: start.id }), APP_ORIGIN]);
    p.fromApp(msg({ type: "state", id: start.id, state: "idle", reason: "stopped" }));
    await stopped;
    expect(states).toEqual([
      { state: "starting", reason: null },
      { state: "listening", reason: null },
      { state: "idle", reason: "stopped" },
    ]);
    // After idle, late words for that session are dropped.
    p.fromApp(msg({ type: "final", id: start.id, text: "late" }));
    expect(finals).toEqual(["hello"]);
  });

  it("rejects with the app's refusal, a bad lang, and stop resolves without an answer", async () => {
    const p = page();
    const a = p.dictation.start();
    const id = p.posted.at(-1)?.[0].id;
    p.fromApp(msg({ type: "refused", id, code: "no_activation" }));
    await expect(a).rejects.toMatchObject({ name: "PlinthError", code: "no_activation" });
    await expect(p.dictation.start({ lang: "en_US!" })).rejects.toMatchObject({ code: "invalid" });
    const states: unknown[] = [];
    p.dictation.onState((e: unknown) => states.push(e));
    const b = p.dictation.start();
    const id2 = p.posted.at(-1)?.[0].id;
    p.fromApp(msg({ type: "started", id: id2 }));
    await b;
    const s = p.dictation.stop();
    p.fire(2000);
    await s;
    // With no answer from the app, the page still hears idle, and late words are dropped.
    expect(states).toEqual([{ state: "idle", reason: "stopped" }]);
    p.fromApp(msg({ type: "final", id: id2, text: "late" }));
    p.fromApp(msg({ type: "state", id: id2, state: "idle", reason: "stopped" }));
    expect(states).toHaveLength(1);
    // Stopped before it started: the start rejects `dismissed`, and may be retried.
    const c = p.dictation.start();
    const id3 = p.posted.at(-1)?.[0].id;
    p.fromApp(msg({ type: "state", id: id3, state: "idle", reason: "stopped" }));
    await expect(c).rejects.toMatchObject({ code: "dismissed" });
    // Stopped before it started, and the app never answers: the start still settles.
    const d = p.dictation.start();
    const stopD = p.dictation.stop();
    p.fire(2000);
    await stopD;
    await expect(d).rejects.toMatchObject({ code: "dismissed" });
    await flush();
  });

  it("the app goes idle before the page's stop gives up waiting", () => {
    // The app waits for the recognizer's last results for less time than stop() waits for the
    // app, so the last words and idle reach the page while its session is still current.
    expect(VOICE_LIMITS.appStopWaitMs).toBeLessThan(VOICE_LIMITS.stopWaitMs);
    expect(runtimeScript(config())).toContain(`var VOICE_STOP_MS = ${VOICE_LIMITS.stopWaitMs};`);
  });

  it("a status that says unavailable rejects a start that was waiting", async () => {
    const p = page();
    const ready = p.dictation.ready;
    const s = p.dictation.start();
    p.fromApp(msg({ type: "status", available: false, reason: "disabled" }));
    await expect(s).rejects.toMatchObject({ code: "unavailable" });
    expect(await ready).toEqual({ available: false, reason: "disabled" });
    await expect(p.dictation.start()).rejects.toMatchObject({ code: "unavailable" });
  });
});

// ---------- publish warning, agent note, rooms ----------

describe("blocked_feature: direct microphone APIs", () => {
  const enc = new TextEncoder();
  const file = (path: string, text: string) => ({
    path,
    bytes: enc.encode(text),
    contentType: contentTypeFor(path),
  });
  const scan = (files: ReturnType<typeof file>[]) =>
    scanPublish({
      files,
      manifestPaths: new Set(files.map((f) => f.path)),
      sources: contentSources(config()),
      isolation: "origin",
    });

  it("is reported once per file with a count, in inline scripts and .js files", () => {
    const w = scan([
      file(
        "index.html",
        `<script>navigator.mediaDevices.getUserMedia({ audio: true });
const r = new webkitSpeechRecognition(); const R = window.SpeechRecognition;</script>`,
      ),
      file("app.js", "navigator.mediaDevices.getUserMedia({ audio: true });"),
    ]);
    const blocked = w.filter((x) => x.code === "blocked_feature");
    expect(blocked.map((x) => [x.file, x.count])).toEqual([
      ["index.html", 3],
      ["app.js", 1],
    ]);
    expect(blocked[0]?.message).toMatch(/never get the microphone/);
    expect(blocked[0]?.message).toMatch(/plinth\.dictation/);
  });

  it("is not reported for the words in comments or strings, outside scripts, or for speechSynthesis", () => {
    const w = scan([
      file(
        "index.html",
        `<p>getUserMedia SpeechRecognition</p><script>
// getUserMedia
/* new webkitSpeechRecognition() */
const s = "getUserMedia"; speechSynthesis.speak(new SpeechSynthesisUtterance("hi"));
</script>`,
      ),
      file("style.css", ".getUserMedia { color: red }"),
    ]);
    expect(w.filter((x) => x.code === "blocked_feature")).toEqual([]);
  });

  it("comes back from a publish and never blocks it", async () => {
    const a = await agent();
    const { res, body } = await publish(a.auth, {
      html: "<script>navigator.mediaDevices.getUserMedia({audio:true})</script>",
    });
    expect(res.status).toBe(201);
    expect(body.warnings).toEqual([expect.objectContaining({ code: "blocked_feature", count: 1 })]);
  });
});

describe("the agent note", () => {
  it("publish and update describe dictation only where it is in effect", async () => {
    expect(dictationNote({ allowDictation: true, contentIsolation: "origin" })).toBe(
      DICTATION_PAGE_NOTE,
    );
    expect(dictationNote({ allowDictation: false, contentIsolation: "origin" })).toBe("");
    expect(dictationNote({ allowDictation: true, contentIsolation: "opaque" })).toBe("");
    expect(DICTATION_PAGE_NOTE).toMatch(/untrusted/);
    const a = await agent();
    const described = async (vars?: Record<string, string>) => {
      const client = await mcpClient(a.token, vars);
      const { tools } = await client.listTools();
      await client.close();
      return Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    };
    const on = await described(ON);
    expect(on.publish_artifact).toContain(DICTATION_PAGE_NOTE);
    expect(on.update_artifact).toContain(DICTATION_PAGE_NOTE);
    const off = await described();
    expect(off.publish_artifact).not.toContain("dictation");
    expect(off.update_artifact).not.toContain("dictation");
  });
});

describe("rooms and dictation", () => {
  it("a version that only adds dictation keeps the room's sockets open", async () => {
    const { id, ownerP, owner } = await setup(roomPage());
    const a = await connect(id, ownerP.cookie);
    const html = roomPage().replace('content="viewer room"', 'content="viewer room dictation"');
    expect(html).toContain("dictation");
    const res = await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html, base_version: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await within(a.closed, 500)).toBe("timeout");
    a.send("ping");
    expect(await a.next()).toBe("pong");
  });
});
