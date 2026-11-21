// The whole-draft review on the server (docs/spec.md "Editing"): a draft's files are its base
// version's, so every page Publish stages the source plus that version's files
// (files_from_version, never the current version's), and "Publish your changes" publishes the room's frozen
// draft with the files it was made with, never the files of the version it replaces. Also the
// doc's HTML-document rule on the socket, the files part of the conflict frame and its cap, the
// stager parity of the live rules, and AppConfig.inline_editing.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HTML_DOCUMENT_RE, liveRules, typeDef, updateArtifactInput } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { docHooks } from "../src/services/artifactTypes/doc.ts";
import { sheetHooks } from "../src/services/artifactTypes/sheet.ts";
import { parseManifest } from "../src/services/storage.ts";
import { APP, json, versionRow } from "./helpers.ts";
import {
  type Client,
  connectDoc,
  docBody,
  type Frame,
  person,
  run,
  setup,
} from "./room-helpers.ts";

const PNG_A = "iVBORw0KGgo=";
const PNG_B = "iVBORw0KGgoA";
const BASE = "# Plan\n\n![Chart](chart.png)\n\nFirst.\n\nSecond.\n";

function call(
  id: string,
  headers: Record<string, string>,
  path: string,
  init: { method?: string; body?: unknown; vars?: Record<string, string> } = {},
) {
  return run(
    `${APP}/api/v1/artifacts/${id}${path}`,
    {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...headers,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    init.vars,
  );
}

const png = (path: string, content = PNG_A) => ({ path, content, encoding: "base64" });

/** A doc whose v1 has chart.png (A) and old.png. */
async function docWithFiles() {
  return setup(undefined, {
    ...docBody(BASE),
    assets: [png("chart.png"), png("old.png")],
  });
}

async function editLines(
  c: Client & { welcome: Frame },
  start: number,
  end: number,
  text: string,
  rev = 0,
) {
  c.send({ t: "lease", rev, start, end });
  let lease = "";
  for (;;) {
    const f = await c.next();
    if (f.t === "lease_denied") throw new Error(`lease denied: ${f.reason}`);
    if (f.t === "leased" && f.holder === c.welcome.you.id) {
      lease = f.lease as string;
      break;
    }
  }
  c.send({ t: "edit", lease, seq: 1, text });
  for (;;) {
    const f = await c.next();
    if (f.t === "error") return f;
    if (f.t === "op" && f.by === c.welcome.you.id) break;
  }
  c.send({ t: "release", lease });
  await c.nextOf("flushed");
  return null;
}

async function files(id: string, n: number) {
  const v = await versionRow(id, n);
  return parseManifest(v?.manifest ?? "[]")
    .filter((e) => e.path !== "content.md" && e.path !== "index.html")
    .map((e) => ({ path: e.path, sha256: e.sha256, stored_at: e.stored_at }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

describe("Publish your changes stages the draft's files", () => {
  it("v3 holds v1's files (the draft's base), never v2's, and the conflict frame lists v2's", async () => {
    const { id, owner, ownerP } = await docWithFiles();
    const h = ownerP.session.headers;
    const a = await connectDoc(id, ownerP.cookie);
    expect(await editLines(a, 4, 5, "First, by a person.")).toBeNull();
    // The agent replaces chart.png, adds new.png, drops old.png, and changes the same paragraph.
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: {
        content: BASE.replace("First.", "First, by an agent."),
        base_version: 1,
        assets: [png("chart.png", PNG_B), png("new.png")],
      },
    });
    expect(put.status).toBe(200);
    const conflict = await a.nextOf("conflict");
    expect(conflict.version).toBe(2);
    expect(conflict.files).toMatchObject({
      added: [{ path: "new.png", kind: "added" }],
      removed: [{ path: "old.png", kind: "removed" }],
      replaced: [{ path: "chart.png", kind: "replaced" }],
      more: 0,
    });
    const v1 = await files(id, 1);
    const mine = await call(id, h, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save", conflict_version: 2 },
    });
    expect(mine.status).toBe(200);
    // v3's files are v1's: the same hashes, stored where v1 stored them, and nothing from v2.
    const v3 = await files(id, 3);
    expect(v3.map((f) => ({ path: f.path, sha256: f.sha256 }))).toEqual(
      v1.map((f) => ({ path: f.path, sha256: f.sha256 })),
    );
    for (const f of v3) expect(f.stored_at).toMatch(/^v1[./]/);
    expect(v3.some((f) => f.path === "new.png")).toBe(false);
    const detail = await json(await call(id, owner.auth, "/versions/3"));
    expect(detail.content).toBe(BASE.replace("First.", "First, by a person."));
    a.ws.close(1000);
  });

  it("an ordinary checkpoint keeps the current version's files, as before", async () => {
    const { id, ownerP } = await docWithFiles();
    const a = await connectDoc(id, ownerP.cookie);
    expect(await editLines(a, 4, 5, "First, edited.")).toBeNull();
    const res = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save" },
    });
    expect(await json(res)).toMatchObject({ saved: true, version: { version: 2 } });
    const v1 = await files(id, 1);
    const v2 = await files(id, 2);
    expect(v2.map((f) => [f.path, f.sha256])).toEqual(v1.map((f) => [f.path, f.sha256]));
    a.ws.close(1000);
  });
});

describe("files_from_version on PUT", () => {
  it("carries that version's files under the new source; refused with assets, and for a version that is not there", async () => {
    const { id, owner, ownerP } = await docWithFiles();
    // The app's page Publish: the signed-in owner.
    const app = ownerP.session.headers;
    const v2 = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: BASE, base_version: 1, assets: [png("chart.png", PNG_B)] },
    });
    expect(v2.status).toBe(200);
    const v3 = await call(id, app, "", {
      method: "PUT",
      body: { content: `${BASE}\nMore.\n`, base_version: 2, files_from_version: 1 },
    });
    expect(v3.status).toBe(200);
    expect((await files(id, 3)).map((f) => [f.path, f.sha256])).toEqual(
      (await files(id, 1)).map((f) => [f.path, f.sha256]),
    );
    const both = await call(id, app, "", {
      method: "PUT",
      body: { content: BASE, base_version: 3, files_from_version: 1, assets: [] },
    });
    expect(both.status).toBe(400);
    expect((await json(both)).error.details.reason).toBe("files_from_with_assets");
    for (const n of [4, 99]) {
      const missing = await call(id, app, "", {
        method: "PUT",
        body: { content: BASE, base_version: 3, files_from_version: n },
      });
      expect(missing.status, String(n)).toBe(404);
    }
    expect(await versionRow(id, 4)).toBeNull();
  });

  it("is checked after the edit policy, and MCP's update_artifact does not take it", async () => {
    const { id } = await docWithFiles();
    const commenter = await person(id, "commenter");
    const res = await call(id, commenter.session.headers, "", {
      method: "PUT",
      body: { content: BASE, base_version: 1, files_from_version: 1, assets: [] },
    });
    expect(res.status).toBe(403);
    expect(Object.keys(updateArtifactInput.shape)).not.toContain("files_from_version");
  });

  it("is the app's only: the owner's own agent token is refused with app_only, and nothing is written", async () => {
    const { id, owner } = await docWithFiles();
    const v2 = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: BASE, base_version: 1, assets: [png("chart.png", PNG_B)] },
    });
    expect(v2.status).toBe(200);
    const res = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: `${BASE}\nMore.\n`, base_version: 2, files_from_version: 1 },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.details.reason).toBe("app_only");
    expect(await versionRow(id, 3)).toBeNull();
  });
});

describe("the doc's HTML-document rule on the draft socket", () => {
  it("refuses an edit that would make the doc start like an HTML page; the escaped text publishes", async () => {
    const { id, ownerP } = await setup(undefined, docBody("# Intro\n\nText.\n"));
    const a = await connectDoc(id, ownerP.cookie);
    for (const head of ["<html> basics", "<!DOCTYPE html>", "  <html>"]) {
      expect(await editLines(a, 0, 1, head), head).toEqual({ t: "error", code: "invalid" });
    }
    expect(await editLines(a, 0, 1, "\\<html> basics")).toBeNull();
    const res = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save" },
    });
    expect(await json(res)).toMatchObject({ saved: true, version: { version: 2 } });
    a.ws.close(1000);
  });

  it("a merge whose result would start like an HTML page freezes instead of rebasing", async () => {
    const { id, owner, ownerP } = await setup(undefined, docBody("Intro\n\nText.\n"));
    const a = await connectDoc(id, ownerP.cookie);
    // The page deletes the first paragraph; the agent changes the second to start like HTML.
    expect(await editLines(a, 0, 2, "")).toBeNull();
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: "Intro\n\n<html> basics\n", base_version: 1 },
    });
    expect(put.status).toBe(200);
    expect(await a.nextOf("conflict")).toMatchObject({ version: 2 });
    a.ws.close(1000);
  });
});

describe("stager parity", () => {
  it("every text the live rules accept passes the type's publish hook", () => {
    const doc = liveRules("doc");
    const sheet = liveRules("sheet");
    if (!doc || !sheet) throw new Error("no rules");
    const parts = ["", " ", "\n", "<html>", "<!doctype html>", "<HTML ", "# A", "x", "\\<html>"];
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const docDef = typeDef("doc");
    const sheetDef = typeDef("sheet");
    if (!docDef || !sheetDef) throw new Error("no types");
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: 1 + rand(6) }, () => parts[rand(parts.length)]).join("");
      if (doc.valid(text)) expect(() => docHooks.validate?.(docDef, text), text).not.toThrow();
      else expect(HTML_DOCUMENT_RE.test(text)).toBe(true);
    }
    const header =
      '{"plinth":"sheet","v":1,"columns":[{"name":"A","type":"text"},{"name":"B","type":"number"}]}';
    for (const rows of [[], ['["x",1]'], ['["<html>",2]', "[]"], ['["=B2*2"]']]) {
      const text = [header, ...rows].join("\n");
      if (sheet.valid(text)) expect(() => sheetHooks.validate?.(sheetDef, text)).not.toThrow();
    }
  });
});

describe("the files part of the conflict frame", () => {
  it("lists at most 50 paths a kind, and the frame stays small whatever the paths hold", async () => {
    const { id, owner, ownerP } = await setup(undefined, docBody("# Plan\n\nFirst.\n"));
    const a = await connectDoc(id, ownerP.cookie);
    expect(await editLines(a, 2, 3, "First, by a person.")).toBeNull();
    const long = (i: number) => `img/${"x".repeat(180)}-${i}.png`;
    const assets = Array.from({ length: 300 }, (_, i) => png(long(i)));
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: "# Plan\n\nFirst, by an agent.\n", base_version: 1, assets },
    });
    expect(put.status).toBe(200);
    const f = await a.nextOf("conflict");
    expect(f.files.added.length).toBeLessThanOrEqual(50);
    expect(f.files.added.length + f.files.more).toBe(300);
    expect(new TextEncoder().encode(JSON.stringify(f)).byteLength).toBeLessThan(16 * 1024);
    a.ws.close(1000);
  });
});

describe("the files part after a late save", () => {
  it("a version that freezes the draft while a save's finish reads files keeps its own files list", async () => {
    const { id, owner, ownerP } = await docWithFiles();
    const a = await connectDoc(id, ownerP.cookie);
    expect(await editLines(a, 4, 5, "First, by a person.")).toBeNull();
    const ns = env.ROOMS;
    if (!ns) throw new Error("no ROOMS binding");
    const stub = ns.get(ns.idFromName(id));
    type Doc = {
      loaded: unknown;
      version: (...args: unknown[]) => Promise<void>;
      outside: (d: unknown, n: number, h: string | null) => Promise<void>;
      filesBetween: (d: unknown, a: number, b: number) => Promise<unknown>;
    };
    const docOf = (room: unknown) => (room as { doc: Doc }).doc;
    // Version notifies are held back, so the test delivers each one when the race needs it.
    await runInDurableObject(stub, async (room) => {
      docOf(room).version = async () => undefined;
    });
    // A page Publish snapshots the draft; the page edits the same line again meanwhile.
    const snap = await stub.docSnapshot(id);
    expect(await editLines(a, 4, 5, "First, by a person, twice.", 1)).toBeNull();
    const put = (body: Record<string, unknown>) =>
      call(id, owner.auth, "", { method: "PUT", body });
    // v2 is that Publish (its finish has not reached the room yet), as the signed-in person.
    const publish = await call(id, ownerP.session.headers, "", {
      method: "PUT",
      body: { content: snap.text, base_version: 1, files_from_version: 1 },
    });
    expect(publish.status).toBe(200);
    // v3, by an agent, replaces chart.png and changes the same line: the draft freezes against it.
    const v3 = { content: BASE.replace("First.", "First, by an agent."), base_version: 2 };
    expect((await put({ ...v3, assets: [png("chart.png", PNG_B), png("old.png")] })).status).toBe(
      200,
    );
    await runInDurableObject(stub, async (room) => {
      const doc = docOf(room);
      await doc.outside(doc.loaded, 3, null);
    });
    expect(await a.nextOf("conflict")).toMatchObject({ version: 3 });
    // v4 also drops old.png and adds new.png; its notify lands while v2's finish reads v2 to v3.
    const v4 = { content: BASE.replace("First.", "First, by an agent, again."), base_version: 3 };
    expect((await put({ ...v4, assets: [png("chart.png", PNG_B), png("new.png")] })).status).toBe(
      200,
    );
    await runInDurableObject(stub, async (room) => {
      const doc = docOf(room);
      const between = doc.filesBetween.bind(doc);
      let once = true;
      doc.filesBetween = async (d, x, y) => {
        const out = await between(d, x, y);
        if (once) {
          once = false;
          await doc.outside(doc.loaded, 4, null);
        }
        return out;
      };
    });
    await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch);
    // The review lists what v4 changed in v2's files, not what v3 did.
    const files = { added: [{ path: "new.png" }], removed: [{ path: "old.png" }] };
    expect(await a.nextOf("conflict")).toMatchObject({ version: 4, files });
    const b = await connectDoc(id, ownerP.cookie);
    expect(b.welcome).toMatchObject({
      base_version: 2,
      conflict_version: 4,
      files: { ...files, replaced: [{ path: "chart.png" }] },
    });
    // No later frame re-sends the review with another version's list.
    for (const f of a.pending().filter((x) => x.t === "conflict")) {
      expect(f).toMatchObject({ version: 4, files });
    }
    a.ws.close(1000);
    b.ws.close(1000);
  });
});

describe("AppConfig.inline_editing", () => {
  it("follows the instance's live editing mode", async () => {
    const get = async (vars: Record<string, string> = {}) =>
      (await json(await run(`${APP}/api/v1/config`, {}, vars))).inline_editing;
    expect(await get()).toBe("room");
    expect(await get({ ALLOW_ROOMS: "false" })).toBe("solo");
    expect(await get({ ALLOW_LIVE_EDITING: "false" })).toBeNull();
    expect(await get({ CONTENT_ISOLATION: "opaque" })).toBeNull();
  });
});

describe("the review's text never leaves the socket", () => {
  it("a frozen draft's welcome carries base, frozen version and files; GET live/draft is gone", async () => {
    const { id, owner, ownerP } = await docWithFiles();
    const a = await connectDoc(id, ownerP.cookie);
    expect(await editLines(a, 4, 5, "First, by a person.")).toBeNull();
    await call(id, owner.auth, "", {
      method: "PUT",
      body: {
        content: BASE.replace("First.", "First, by an agent."),
        base_version: 1,
        assets: [png("chart.png", PNG_B), png("old.png")],
      },
    });
    await a.nextOf("conflict");
    const b = await connectDoc(id, ownerP.cookie);
    expect(b.welcome).toMatchObject({
      base_version: 1,
      conflict_version: 2,
      files: { replaced: [{ path: "chart.png" }], added: [], removed: [] },
    });
    expect(b.text).toBe(BASE.replace("First.", "First, by a person."));
    expect((await call(id, ownerP.session.headers, "/live/draft")).status).toBe(404);
    a.ws.close(1000);
    b.ws.close(1000);
  });
});
