// On-page editing of a design system in the room (#36, docs/spec.md "Design systems"): the draft
// is a line projection of system.json (designSystemLive.ts). A value lease and its canonical edit;
// an edit the publish grammar refuses, or not written canonically, refused with `invalid` and not
// applied; struct frames (dark values, optional texts, tokens) refused while a lease overlaps what
// they change and otherwise applied, the other leases moving with their lines; a Publish storing
// Plinth's storage form (2-space, or compact past the limit) while an agent's publish keeps its
// bytes; a version that only spells the same JSON another way needs no review, and one that
// changes a value freezes the draft for review, never merged.
import { env } from "cloudflare:workers";
import {
  applyDesignSystemStruct,
  designSystemToLive,
  dsNodeAtPath,
  dsNodeLines,
  joinLines,
  splitLines,
  utf8Length,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import acme from "./fixtures/design-systems/acme.json";
import { APP, json, versionRow } from "./helpers.ts";
import { type Client, connectDoc, type Frame, person, run, setup } from "./room-helpers.ts";

const ACME = JSON.stringify(acme, null, 2);
const LIVE = designSystemToLive(ACME);
const LINES = splitLines(LIVE);

type Socket = Client & { welcome: Frame; text: string };

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const peek = async (id: string) =>
  (await rooms().get(rooms().idFromName(id)).docPeek(id))?.text as string | undefined;

function dsSetup(content = ACME) {
  return setup(undefined, { html: undefined, type: "design_system", content });
}

const call = (
  id: string,
  headers: Record<string, string>,
  path: string,
  init: { method?: string; body?: unknown } = {},
) =>
  run(`${APP}/api/v1/artifacts/${id}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...headers,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

const content = async (id: string, auth: Record<string, string>, n: number) =>
  (await json(await call(id, auth, `/versions/${n}`))).content as string;

async function lease(c: Socket, start: number, end: number, rev = 0) {
  c.send({ t: "lease", rev, start, end });
  for (;;) {
    const f = await c.next();
    if (f.t === "lease_denied") return f;
    if (f.t === "leased" && f.holder === c.welcome.you.id) return f;
  }
}

async function edit(c: Socket, leaseId: string, text: string, seq = 1) {
  c.send({ t: "edit", lease: leaseId, seq, text });
  for (;;) {
    const f = await c.next();
    if (f.t === "error") return f;
    if (f.t === "op" && f.by === c.welcome.you.id) return f;
  }
}

async function struct(c: Socket, op: Record<string, unknown>, rev: number) {
  c.send({ t: "struct", rev, op });
  for (;;) {
    const f = await c.next();
    if (f.t === "error" || f.t === "struct_denied") return f;
    if (f.t === "struct" && f.by === c.welcome.you.id) return f;
  }
}

/** The lines of the value at `path` in `lines`, with `value`. */
function valueEdit(lines: readonly string[], path: (string | number)[], value: unknown) {
  const n = dsNodeAtPath(lines, path);
  if (!n) throw new Error(path.join("."));
  return { start: n.start, end: n.end, text: dsNodeLines(n, value).join("\n") };
}

/** Lease the value at `path`, write `value`, release; the new rev. */
async function setValue(
  id: string,
  c: Socket,
  path: (string | number)[],
  value: unknown,
  rev: number,
) {
  const text = await peek(id);
  if (text === undefined) throw new Error("no draft");
  const lines = splitLines(text);
  const e = valueEdit(lines, path, value);
  const l = await lease(c, e.start, e.end, rev);
  if (l.t !== "leased") throw new Error(`lease ${l.t}`);
  const ack = await edit(c, l.lease, e.text);
  if (ack.t !== "op") throw new Error(`edit ${ack.code}`);
  c.send({ t: "release", lease: l.lease });
  await c.nextOf("flushed");
  return ack.rev as number;
}

describe("design system socket: values", () => {
  it("sends the projection; a value lease and a canonical edit are applied and broadcast", async () => {
    const { id, ownerP } = await dsSetup();
    const a = await connectDoc(id, ownerP.cookie);
    expect(a.text).toBe(LIVE);
    const e = valueEdit(LINES, ["tokens", "color", "brand", "500", "$value"], "#2f4ac0");
    const l = await lease(a, e.start, e.end);
    expect(l.t).toBe("leased");
    const ack = await edit(a, l.lease, e.text);
    expect(ack).toMatchObject({ t: "op", start: e.start, del: 1 });
    expect(await peek(id)).toContain('"$value": "#2f4ac0"');
    // An object colour in place of the string: the value's lines grow, the lease follows them.
    const obj = { colorSpace: "oklch", components: [0.52, 0.19, 268] };
    const grown = dsNodeLines(
      dsNodeAtPath(splitLines((await peek(id)) as string), [
        "tokens",
        "color",
        "brand",
        "500",
        "$value",
      ]) as never,
      obj,
    );
    const ack2 = await edit(a, l.lease, grown.join("\n"), 2);
    expect(ack2).toMatchObject({ t: "op", del: 1 });
    expect(splitLines(ack2.ins)).toHaveLength(grown.length);
    a.ws.close(1000);
  });

  it("refuses a value the publish rules refuse, or one not written canonically, and applies nothing", async () => {
    const { id, ownerP } = await dsSetup();
    const a = await connectDoc(id, ownerP.cookie);
    const path = ["tokens", "color", "brand", "500", "$value"];
    const e = valueEdit(LINES, path, "#000000");
    const l = await lease(a, e.start, e.end);
    for (const text of [
      valueEdit(LINES, path, "red;}body{x:y").text,
      valueEdit(LINES, path, "{space.1}").text,
      valueEdit(LINES, path, "{color.accent}").text,
      e.text.replace(": ", ":"),
      `${e.text}\n          "$type": "color",`,
      e.text.replace('"$value"', '"$type"'),
    ]) {
      expect(await edit(a, l.lease, text), text).toEqual({ t: "error", code: "invalid" });
    }
    // A lease on what is not an editable value: a $type, a component's CSS, the root braces.
    for (const p of [["tokens", "color", "$type"], ["components", 0, "css"], ["prefix"]]) {
      const n = dsNodeAtPath(LINES, p);
      if (!n) throw new Error(p.join("."));
      const ln = await lease(a, n.start, n.end);
      expect(ln.t).toBe("leased");
      expect(await edit(a, ln.lease, LINES.slice(n.start, n.end).join("\n"))).toEqual({
        t: "error",
        code: "invalid",
      });
    }
    expect(await peek(id)).toBe(LIVE);
    a.ws.close(1000);
  });
});

describe("design system socket: keys (struct)", () => {
  it("is refused while a lease overlaps what it changes, and moves the leases it does not", async () => {
    const { id, ownerP } = await dsSetup();
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    // b holds color.bg's value: a description for color.bg adds a comma to that line.
    const bg = valueEdit(LINES, ["tokens", "color", "bg", "$value"], "#ffffff");
    const held = await lease(b, bg.start, bg.end);
    expect(held.t).toBe("leased");
    const desc = { op: "set_text", path: "tokens.color.bg.$description", value: "Page ground" };
    expect(await struct(a, desc, 0)).toEqual({ t: "struct_denied", reason: "held", by: ed.email });
    // b holds the guidelines' first line instead: the op is applied, and b's lease moves down.
    b.send({ t: "release", lease: held.lease });
    await a.nextOf("released");
    const end = LINES.indexOf("}");
    const g = await lease(b, end + 1, end + 2);
    expect(g.t).toBe("leased");
    const done = await struct(a, desc, 0);
    expect(done).toMatchObject({ t: "struct", rev: 1, op: desc });
    const expected = applyDesignSystemStruct(LINES, desc as never);
    if (typeof expected === "string") throw new Error(expected);
    expect(await peek(id)).toBe(joinLines(expected.lines));
    // b's lease is now one line lower, on the same guidelines line: its edit lands there.
    const moved = await edit(b, g.lease, "# Using Acme UI, edited");
    expect(moved).toMatchObject({ t: "op", start: end + 2 });
    expect(await peek(id)).toContain("\n# Using Acme UI, edited\n");
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("adds and removes tokens and dark values, and refuses removing a token in use", async () => {
    const { id, ownerP } = await dsSetup();
    const a = await connectDoc(id, ownerP.cookie);
    let rev = 0;
    for (const op of [
      { op: "add_token", group: "color", name: "line", value: "#d0d7de" },
      { op: "set_dark", token: "color.line", value: "#30363d" },
      { op: "clear_dark", token: "color.line" },
      { op: "remove_token", path: "color.line" },
    ]) {
      const f = await struct(a, op, rev);
      expect(f, op.op).toMatchObject({ t: "struct" });
      rev = f.rev;
    }
    expect(await peek(id)).toBe(LIVE);
    // color.accent is the Button's CSS variable; color.brand.500 is color.accent's alias target.
    for (const path of ["color.accent", "color.brand.500"]) {
      expect(await struct(a, { op: "remove_token", path }, rev)).toEqual({
        t: "error",
        code: "invalid",
      });
    }
    // An op of another type's kind is refused.
    expect(await struct(a, { op: "insert_rows", before: 2, count: 1 }, rev)).toEqual({
      t: "error",
      code: "invalid",
    });
    a.ws.close(1000);
  });
});

describe("design system: publishing from the page", () => {
  it("a Publish stores 2-space JSON with the change, and the system stays valid", async () => {
    const { id, ownerP, owner } = await dsSetup(JSON.stringify(acme));
    const a = await connectDoc(id, ownerP.cookie);
    const rev = await setValue(id, a, ["tokens", "color", "brand", "500", "$value"], "#2f4ac0", 0);
    const res = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev, reason: "save" },
    });
    expect(await json(res)).toMatchObject({ saved: true, version: { version: 2 } });
    const v2 = await content(id, owner.auth, 2);
    const want = JSON.parse(ACME);
    want.tokens.color.brand["500"].$value = "#2f4ac0";
    expect(v2).toBe(JSON.stringify(want, null, 2));
    expect((await versionRow(id, 2))?.note).toBe("Edited on the page");
    a.ws.close(1000);
  });

  it("an agent's compact system of about 900 KB keeps its bytes; a Publish from the page stores it compact", async () => {
    const big = JSON.parse(ACME);
    big.components = Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      examples: Array.from({ length: 20 }, (_, j) => ({
        name: `E${j}`,
        html: `<div>${"y".repeat(180)}</div>`,
        height: 80,
      })),
    }));
    const compact = JSON.stringify(big);
    expect(utf8Length(compact)).toBeGreaterThan(850_000);
    expect(utf8Length(JSON.stringify(big, null, 2))).toBeGreaterThan(1024 * 1024);
    const { id, ownerP, owner } = await dsSetup(compact);
    expect(await content(id, owner.auth, 1)).toBe(compact);
    // An agent's update and a restore keep the bytes they send.
    const v2 = compact.replace('"#3355ff"', '"#3355fe"');
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: v2, base_version: 1 },
    });
    expect(put.status).toBe(200);
    expect(await content(id, owner.auth, 2)).toBe(v2);
    const restored = await call(id, owner.auth, "/versions/1/restore", { body: {} });
    expect(restored.status).toBe(201);
    expect(await content(id, owner.auth, 3)).toBe(compact);
    const a = await connectDoc(id, ownerP.cookie);
    const rev = await setValue(id, a, ["tokens", "color", "bg", "$value"], "#fafafa", 0);
    const res = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 3, rev, reason: "save" },
    });
    expect(await json(res)).toMatchObject({ saved: true, version: { version: 4 } });
    const v4 = await content(id, owner.auth, 4);
    big.tokens.color.bg.$value = "#fafafa";
    expect(v4).toBe(JSON.stringify(big));
    a.ws.close(1000);
  });
});

describe("design system: versions published meanwhile", () => {
  it("a version that only spells the same JSON another way needs no review", async () => {
    const { id, ownerP, owner } = await dsSetup();
    const a = await connectDoc(id, ownerP.cookie);
    await setValue(id, a, ["tokens", "color", "bg", "$value"], "#fafafa", 0);
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: JSON.stringify(acme), base_version: 1 },
    });
    expect(put.status).toBe(200);
    const f = await a.nextOf("rebased");
    expect(f).toMatchObject({ version: 2 });
    expect(await peek(id)).toContain('"$value": "#fafafa"');
    a.ws.close(1000);
  });

  it("a version that changes a value freezes the draft for review, and nothing is merged", async () => {
    const { id, ownerP, owner } = await dsSetup();
    const a = await connectDoc(id, ownerP.cookie);
    await setValue(id, a, ["tokens", "color", "bg", "$value"], "#fafafa", 0);
    const draft = await peek(id);
    const v2 = JSON.parse(ACME);
    v2.tokens.color.fg.$value = "#000000";
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: JSON.stringify(v2), base_version: 1 },
    });
    expect(put.status).toBe(200);
    const body = await json(put);
    expect(body.warnings).toContainEqual(
      expect.objectContaining({
        code: "live_draft",
        message: expect.stringContaining("People are editing this design system on its page."),
      }),
    );
    expect(await a.nextOf("conflict")).toMatchObject({ t: "conflict", version: 2 });
    expect(await peek(id)).toBe(draft);
    // Publish your changes: the room's draft becomes v3 over v2, with v1's files.
    const res = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save", conflict_version: 2 },
    });
    expect(await json(res)).toMatchObject({ saved: true, version: { version: 3 } });
    expect((await versionRow(id, 3))?.note).toBe("Edited on the page. Replaces the changes in v2.");
    const v3 = JSON.parse(await content(id, owner.auth, 3));
    expect(v3.tokens.color.bg.$value).toBe("#fafafa");
    expect(v3.tokens.color.fg.$value).toBe("#1f2328");
    a.ws.close(1000);
  });
});
