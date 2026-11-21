// On-page editing of a deck in the room (slides-text, docs/spec.md "Slides"): the same draft
// channel as docs and sheets, with the slides rules. A block lease and its edit; an edit that
// would change the deck's structure refused with `invalid` and not applied; the struct ops
// add_notes, remove_notes, set_deck and trim_start applied once and the same on every socket,
// refused only when they would touch a part someone else holds, while leases elsewhere move by the
// op's line map; a version published meanwhile never merged (the draft freezes); an empty deck
// draft never published; and the stager parity of the slides rules.
import { env } from "cloudflare:workers";
import { applySlidesStruct, liveRules, parseDeck, splitLines, typeDef } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { slidesHooks } from "../src/services/artifactTypes/slides.ts";
import { APP, json } from "./helpers.ts";
import { type Client, connectDoc, type Frame, person, run, setup } from "./room-helpers.ts";

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));
const peek = async (id: string) => (await stubFor(id).docPeek(id))?.text;

type Socket = Client & { welcome: Frame; text: string };

const deckSetup = (content: string) =>
  setup(undefined, { html: undefined, type: "slides", content });

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

function call(
  id: string,
  headers: Record<string, string>,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return run(`${APP}/api/v1/artifacts/${id}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...headers,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** The skill's own example deck (SKILL.md "Slides"). */
const SKILL = [
  "---",
  "aspect: 16:9",
  "footer: Q4 review",
  "---",
  "",
  "# Q4 review",
  "",
  "Revenue, hiring and what comes next",
  "",
  "Note: Welcome everyone.",
  "",
  "---",
  "",
  "## Revenue",
  "",
  "- Up 18% on Q3",
  "- Two new enterprise accounts",
  "",
  "Note: The September dip was a billing change.",
  "",
].join("\n");

describe("deck socket: text", () => {
  it("applies an edit inside one part, and keeps the notes marker", async () => {
    const { id, ownerP } = await deckSetup(SKILL);
    const a = await connectDoc(id, ownerP.cookie);
    expect(a.text).toBe(SKILL);
    const l = await lease(a, 15, 17);
    expect(l.t).toBe("leased");
    const ack = await edit(a, l.lease, "- Up 14% on Q3\n- Two new enterprise accounts");
    expect(ack).toMatchObject({ t: "op", rev: 1, start: 15, del: 2 });
    const notes = await lease(a, 9, 10, 1);
    expect(await edit(a, notes.lease, "Note: Welcome, everyone.", 2)).toMatchObject({ rev: 2 });
    const text = (await peek(id)) as string;
    expect(parseDeck(text).slides[0]?.notes).toBe("Welcome, everyone.");
    expect(parseDeck(text).settings.footer).toBe("Q4 review");
    a.ws.close(1000);
  });

  it("refuses an edit that would change the deck's structure, and applies nothing", async () => {
    const { id, ownerP } = await deckSetup(SKILL);
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 15, 16);
    for (const bad of ["---", "- x\n|||", "Note: x", "```"]) {
      expect(await edit(a, l.lease, bad), bad).toEqual({ t: "error", code: "invalid" });
    }
    // The notes without their marker, and the front matter.
    const notes = await lease(a, 9, 10);
    expect(await edit(a, notes.lease, "Welcome everyone.")).toEqual({
      t: "error",
      code: "invalid",
    });
    const fm = await lease(a, 1, 2);
    expect(await edit(a, fm.lease, "aspect: 4:3")).toEqual({ t: "error", code: "invalid" });
    expect(await peek(id)).toBe(SKILL);
    a.ws.close(1000);
  });

  it("takes the New deck's title emptied; such a draft is never published", async () => {
    const { id, ownerP } = await deckSetup("# Untitled deck\n");
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 0, 1);
    expect(await edit(a, l.lease, "")).toMatchObject({ t: "op", rev: 1 });
    a.send({ t: "release", lease: l.lease });
    await a.nextOf("flushed");
    const res = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save" },
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.details).toMatchObject({
      reason: "live_unpublishable",
      why: "empty",
    });
    // Typing a new title is an insert at line 0.
    const p = await lease(a, 0, 0, 1);
    expect(await edit(a, p.lease, "# Q1 plan", 2)).toMatchObject({ t: "op", rev: 2 });
    expect(await peek(id)).toBe("# Q1 plan\n");
    a.ws.close(1000);
  });
});

describe("deck socket: notes and settings (struct)", () => {
  it("adds notes while someone else types on another slide, and moves their lease", async () => {
    const { id, ownerP } = await deckSetup("# A\n\nalpha\n\n---\n\n# B\n\nbeta\n");
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    // Ben holds slide 2's paragraph (line 8); Ana adds notes to slide 1.
    const held = await lease(b, 8, 9);
    expect(held.t).toBe("leased");
    await a.nextOf("leased");
    const op = { op: "add_notes", n: 1 };
    expect(await struct(a, op, 0)).toMatchObject({ t: "struct", rev: 1, op });
    const seen = await b.nextOf("struct");
    expect(seen.op).toEqual(op);
    const expected = applySlidesStruct(splitLines("# A\n\nalpha\n\n---\n\n# B\n\nbeta\n"), {
      op: "add_notes",
      n: 1,
    });
    expect(await peek(id)).toBe(expected?.lines.join("\n"));
    // Ben's lease moved by two lines with the slide: his edit lands where he typed.
    expect(await edit(b, held.lease, "beta, edited")).toMatchObject({ t: "op", start: 10 });
    expect(parseDeck((await peek(id)) as string).slides[1]?.head).toContain("beta, edited");
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("is held while it would touch a part someone else holds; refused when it does not apply", async () => {
    const { id, ownerP } = await deckSetup("# A\n\nalpha\n\n---\n\n# B\n");
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    expect((await lease(b, 2, 3)).t).toBe("leased");
    await a.nextOf("leased");
    expect(await struct(a, { op: "add_notes", n: 1 }, 0)).toEqual({
      t: "struct_denied",
      reason: "held",
      by: ed.email,
    });
    expect(await struct(a, { op: "add_notes", n: 1 }, 5)).toEqual({
      t: "struct_denied",
      reason: "stale",
    });
    expect(await struct(a, { op: "remove_notes", n: 2 }, 0)).toEqual({
      t: "error",
      code: "invalid",
    });
    // A sheet's op on a deck is refused.
    expect(await struct(a, { op: "insert_rows", before: 2, count: 1 }, 0)).toEqual({
      t: "error",
      code: "invalid",
    });
    // Slide 2 is free.
    expect(await struct(a, { op: "add_notes", n: 2 }, 0)).toMatchObject({ t: "struct", rev: 1 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("writes the deck settings and keeps the slides; trims a bare opening ---", async () => {
    const { id, ownerP } = await deckSetup("---\n\n# Intro\n\n---\n\n# Next\n");
    const a = await connectDoc(id, ownerP.cookie);
    expect(await struct(a, { op: "trim_start" }, 0)).toMatchObject({ t: "struct", rev: 1 });
    expect(await peek(id)).toBe("\n# Intro\n\n---\n\n# Next\n");
    const set = { op: "set_deck", aspect: "4:3", theme: "dark", paginate: false, footer: "Q1" };
    expect(await struct(a, set, 1)).toMatchObject({ t: "struct", rev: 2 });
    const text = (await peek(id)) as string;
    expect(parseDeck(text).settings).toEqual({
      aspect: "4:3",
      theme: "dark",
      paginate: false,
      footer: "Q1",
    });
    expect(parseDeck(text).slides).toHaveLength(2);
    // A footer on two lines is refused with the frame.
    expect(await struct(a, { ...set, footer: "a\nb" }, 2)).toEqual({
      t: "error",
      code: "invalid",
    });
    a.ws.close(1000);
  });
});

describe("deck socket: versions published from outside", () => {
  it("an agent's version during a live edit freezes the draft; nothing is merged", async () => {
    const { id, ownerP, owner } = await deckSetup(SKILL);
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 15, 16);
    await edit(a, l.lease, "- Up 14% on Q3");
    a.send({ t: "release", lease: l.lease });
    await a.nextOf("flushed");
    const v2 = SKILL.replace("## Revenue", "## Revenue and costs");
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: v2, base_version: 1 },
    });
    expect(put.status).toBe(200);
    expect((await json(put)).warnings).toContainEqual(
      expect.objectContaining({
        code: "live_draft",
        message: expect.stringContaining("People are editing this deck on its page."),
      }),
    );
    expect(await a.nextOf("conflict")).toMatchObject({ t: "conflict", version: 2 });
    expect(await stubFor(id).docPeek(id)).toMatchObject({
      base_version: 1,
      conflict_version: 2,
      text: SKILL.replace("Up 18%", "Up 14%"),
    });
    a.ws.close(1000);
  });
});

describe("stager parity", () => {
  it("every deck the live rules accept, and can publish, passes the deck's publish hook", () => {
    const rules = liveRules("slides");
    const def = typeDef("slides");
    if (!rules || !def) throw new Error("no slides");
    const parts = ["", " ", "\n", "---\n", "<html>", "<!doctype html>", "# A", "x", "\\<html>"];
    let seed = 17;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 600; i++) {
      const text = Array.from({ length: 1 + rand(6) }, () => parts[rand(parts.length)]).join("");
      if (rules.valid(text) && rules.unpublishable(text) === null) {
        expect(() => slidesHooks.validate?.(def, text), JSON.stringify(text)).not.toThrow();
      }
    }
  });
});
