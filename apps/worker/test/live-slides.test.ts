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
import { HTML_DECK_LIVE_DRAFT } from "../src/services/artifactTypes/live.ts";
import { slidesHooks } from "../src/services/artifactTypes/slides.ts";
import { APP, contentOrigin, json } from "./helpers.ts";
import { type Client, connectDoc, type Frame, person, run, setup, within } from "./room-helpers.ts";

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

describe("an HTML deck is never edited on its page", () => {
  const INDEX = JSON.stringify({ title: "Launch", order: ["cover"], cover: "cover" });
  const htmlDeck = {
    html: undefined,
    type: "slides",
    content: INDEX,
    assets: [
      { path: "slides/cover.html", content: '<section id="cover"><h1>Launch</h1></section>' },
    ],
  };
  const gateOf = async (
    id: string,
    headers: Record<string, string>,
    vars?: Record<string, string>,
  ) => json(await run(`${APP}/api/v1/view/${id}`, { headers }, vars));
  const shellPayload = async (id: string, cookie: string) => {
    const res = await run(`${contentOrigin(id)}/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(
      await res.text(),
    );
    return JSON.parse(m?.[1] ?? "null");
  };

  it("gives its owner and editors no live room, no live_off, no live shell and no draft", async () => {
    const { id, ownerP } = await setup(undefined, htmlDeck);
    const ed = await person(id, "editor");
    for (const p of [ownerP, ed]) {
      const gate = await gateOf(id, p.session.headers);
      expect(gate).toMatchObject({ status: "ok", no_editor: true });
      expect(gate.live).toBeUndefined();
      // Editing on the page off here says nothing either: an HTML deck is not edited on its page.
      const off = await gateOf(id, p.session.headers, { ALLOW_LIVE_EDITING: "false" });
      expect(off.live_off).toBeUndefined();
      const payload = await shellPayload(id, p.cookie);
      expect(payload).toMatchObject({ type: "slides", path: "deck.json" });
      expect(payload.live).toBeUndefined();
    }
    // The room opens no draft on it, even for a socket that asks.
    expect(
      await within(
        connectDoc(id, ownerP.cookie).catch(() => "refused"),
        3000,
      ),
    ).not.toEqual(expect.objectContaining({ welcome: expect.anything() }));
    expect(await peek(id)).toBeUndefined();
  });

  it("a Markdown deck has them, and loses them once an HTML deck is its current version", async () => {
    const { id, ownerP, owner } = await deckSetup("# Talk\n");
    expect((await gateOf(id, ownerP.session.headers)).live).toBeDefined();
    expect((await shellPayload(id, ownerP.cookie)).live).toBe("room");
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: INDEX, assets: htmlDeck.assets, base_version: 1 },
    });
    expect(put.status).toBe(200);
    expect((await gateOf(id, ownerP.session.headers)).live).toBeUndefined();
    expect((await shellPayload(id, ownerP.cookie)).live).toBeUndefined();
  });
});

describe("an HTML deck published while a Markdown deck's room is open", () => {
  const INDEX = JSON.stringify({ title: "Launch", order: ["cover"], cover: "cover" });
  const ASSETS = [
    { path: "slides/cover.html", content: '<section id="cover"><h1>Launch</h1></section>' },
  ];
  const draftRow = (id: string) =>
    env.DB.prepare("SELECT conflict_version FROM live_drafts WHERE artifact_id = ?1")
      .bind(id)
      .first<{ conflict_version: number | null }>();

  /** A deck with page edits in its room, then an agent's HTML deck as v2. */
  async function editedThenHtml() {
    const s = await deckSetup("# Talk\n\nBody\n");
    const a = await connectDoc(s.id, s.ownerP.cookie);
    const l = await lease(a, 0, 1);
    expect(await edit(a, l.lease, "# Talk 2")).toMatchObject({ t: "op" });
    a.send({ t: "release", lease: l.lease });
    await a.nextOf("flushed");
    const put = await call(s.id, s.owner.auth, "", {
      method: "PUT",
      body: { content: INDEX, assets: ASSETS, base_version: 1 },
    });
    expect(put.status).toBe(200);
    return { ...s, a, put: await json(put) };
  }

  it("freezes the draft for its own review: no lease or edit on any socket, honest answers", async () => {
    const { id, ownerP, a, put } = await editedThenHtml();
    // The agent is told the edits are neither merged nor shown beside an HTML deck.
    expect(put.warnings).toContainEqual(
      expect.objectContaining({
        code: "live_draft",
        file: "deck.json",
        message: HTML_DECK_LIVE_DRAFT,
      }),
    );
    expect(await a.nextOf("conflict")).toMatchObject({ t: "conflict", version: 2 });
    expect(await stubFor(id).docPeek(id)).toMatchObject({
      text: "# Talk 2\n\nBody\n",
      base_version: 1,
      conflict_version: 2,
    });
    expect(await draftRow(id)).toEqual({ conflict_version: 2 });
    expect(await lease(a, 0, 1, 1)).toMatchObject({ t: "lease_denied", reason: "frozen" });
    // A socket that joins later (a reload, for the review) finds it frozen too.
    const b = await connectDoc(id, ownerP.cookie);
    expect(b.welcome).toMatchObject({ conflict_version: 2 });
    expect(await lease(b, 0, 1, 1)).toMatchObject({ t: "lease_denied", reason: "frozen" });
    b.ws.close(1000);
    // Publish outside the review says what happened, never "publish again".
    const cp = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save" },
    });
    expect(cp.status).toBe(409);
    expect((await json(cp)).error.message).toContain("v2 is an HTML deck");
    a.ws.close(1000);
  });

  it("its frozen answers carry the frame's id as re; the freeze itself answers nothing", async () => {
    const { a } = await editedThenHtml();
    expect(await a.nextOf("conflict")).not.toHaveProperty("re");
    a.send({ t: "lease", rev: 1, start: 0, end: 1, id: 71 });
    expect(await a.nextOf("lease_denied")).toEqual({
      t: "lease_denied",
      reason: "frozen",
      re: 71,
    });
    a.send({ t: "edit", lease: "l_gone", seq: 9, text: "# X", id: 72 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "not_held", re: 72 });
    a.send({ t: "struct", rev: 1, op: { op: "trim_start" }, id: 73 });
    expect(await a.nextOf("struct_denied")).toEqual({
      t: "struct_denied",
      reason: "frozen",
      re: 73,
    });
    a.ws.close(1000);
  });

  it("its review publishes the person's deck as the next version, keeping the HTML deck in History", async () => {
    const { id, ownerP, owner, a } = await editedThenHtml();
    await a.nextOf("conflict");
    const cp = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save", conflict_version: 2 },
    });
    expect(cp.status, JSON.stringify(await cp.clone().json())).toBe(200);
    expect(await json(cp)).toMatchObject({ saved: true, version: { version: 3 } });
    const cur = await json(await call(id, owner.auth, ""));
    expect(cur.content).toBe("# Talk 2\n\nBody\n");
    a.ws.close(1000);
  });

  it("its review's Discard ends the draft: there is no Markdown to go back to", async () => {
    const { id, ownerP, owner, a } = await editedThenHtml();
    await a.nextOf("conflict");
    const res = await run(`${APP}/api/v1/artifacts/${id}/live/draft?rev=1&conflict_version=2`, {
      method: "DELETE",
      headers: ownerP.session.headers,
    });
    expect(res.status).toBe(204);
    expect(await a.nextOf("reset")).toMatchObject({ version: 2, why: "discarded" });
    expect(await draftRow(id)).toBeNull();
    expect(String((await json(await call(id, owner.auth, ""))).content)).toBe(INDEX);
  });

  it("a draft with no changes ends: its row and its sockets go, so it never counts as a draft", async () => {
    const { id, ownerP, owner } = await deckSetup("# Talk\n");
    const a = await connectDoc(id, ownerP.cookie);
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: INDEX, assets: ASSETS, base_version: 1 },
    });
    expect(put.status).toBe(200);
    expect((await json(put)).warnings).not.toContainEqual(
      expect.objectContaining({ code: "live_draft" }),
    );
    // Its socket closes: nobody edits a deck that is not Markdown any more.
    expect(await within(a.closed, 3000)).toMatchObject({ code: 4404 });
    expect(await draftRow(id)).toBeNull();
    expect(await peek(id)).toBeUndefined();
  });
});

describe("a Markdown deck's changes frozen against an HTML deck, after a reload", () => {
  const INDEX = JSON.stringify({ title: "Launch", order: ["cover"], cover: "cover" });
  const ASSETS = [
    { path: "slides/cover.html", content: '<section id="cover"><h1>Launch</h1></section>' },
  ];
  const gateOf = async (id: string, headers: Record<string, string>) =>
    json(await run(`${APP}/api/v1/view/${id}`, { headers }));
  const shellLive = async (id: string, cookie: string) => {
    const res = await run(`${contentOrigin(id)}/`, { headers: { Cookie: cookie } });
    const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(
      await res.text(),
    );
    return JSON.parse(m?.[1] ?? "null") as { path: string; live?: string };
  };

  /**
   * A deck typed in by an editor whose page then closed (the room unloads), and an agent's HTML
   * deck as v2 published while nobody had the page open.
   */
  async function typedThenHtmlWhileAway() {
    const s = await deckSetup("# Talk\n\nBody\n");
    const ed = await person(s.id, "editor");
    const a = await connectDoc(s.id, ed.cookie);
    const l = await lease(a, 0, 1);
    expect(await edit(a, l.lease, "# Talk, typed")).toMatchObject({ t: "op" });
    a.send({ t: "release", lease: l.lease });
    await a.nextOf("flushed");
    a.ws.close(1000);
    await a.closed;
    const put = await call(s.id, s.owner.auth, "", {
      method: "PUT",
      body: { content: INDEX, assets: ASSETS, base_version: 1 },
    });
    expect(put.status).toBe(200);
    return { ...s, ed };
  }

  /** The editor reloads: the gate and the shell offer the room, and the socket gets the review. */
  async function reload(id: string, ed: Awaited<ReturnType<typeof person>>) {
    const gate = await gateOf(id, ed.session.headers);
    expect(gate).toMatchObject({ status: "ok", no_editor: true });
    expect(gate.live).toBeDefined();
    expect(gate.live.draft).toMatchObject({ base_version: 1 });
    expect(await shellLive(id, ed.cookie)).toMatchObject({ path: "deck.json", live: "room" });
    const b = await connectDoc(id, ed.cookie);
    expect(b.welcome).toMatchObject({ conflict_version: 2, base_version: 1 });
    expect(b.text).toBe("# Talk, typed\n\nBody\n");
    // Frozen: nothing is typed into it.
    expect(await lease(b, 0, 1, b.welcome.rev as number)).toMatchObject({
      t: "lease_denied",
      reason: "frozen",
    });
    return b;
  }

  it("offers its review after a reload; Publish your changes makes the deck the next version", async () => {
    const { id, ed, owner } = await typedThenHtmlWhileAway();
    const b = await reload(id, ed);
    const cp = await call(id, ed.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: b.welcome.rev, reason: "save", conflict_version: 2 },
    });
    expect(cp.status, JSON.stringify(await cp.clone().json())).toBe(200);
    expect(await json(cp)).toMatchObject({ saved: true, version: { version: 3 } });
    expect((await json(await call(id, owner.auth, ""))).content).toBe("# Talk, typed\n\nBody\n");
    b.ws.close(1000);
    // A Markdown deck again: edited on its page as before.
    expect((await gateOf(id, ed.session.headers)).live).toBeDefined();
  });

  it("offers its review after a reload; Discard ends the draft and the page is the HTML deck", async () => {
    const { id, ed, owner } = await typedThenHtmlWhileAway();
    const b = await reload(id, ed);
    const res = await run(
      `${APP}/api/v1/artifacts/${id}/live/draft?rev=${b.welcome.rev}&conflict_version=2`,
      { method: "DELETE", headers: ed.session.headers },
    );
    expect(res.status).toBe(204);
    expect(await b.nextOf("reset")).toMatchObject({ version: 2, why: "discarded" });
    expect(String((await json(await call(id, owner.auth, ""))).content)).toBe(INDEX);
    const gate = await gateOf(id, ed.session.headers);
    expect(gate.live).toBeUndefined();
    expect((await shellLive(id, ed.cookie)).live).toBeUndefined();
  });
});

describe("an HTML deck over an open room with a lease held", () => {
  const INDEX = JSON.stringify({ title: "Launch", order: ["cover"], cover: "cover" });
  const ASSETS = [
    { path: "slides/cover.html", content: '<section id="cover"><h1>Launch</h1></section>' },
  ];

  it("ends nothing it may hold typing for: a socket's lease freezes the draft instead", async () => {
    const { id, ownerP, owner } = await deckSetup("# Talk\n\nBody\n");
    const a = await connectDoc(id, ownerP.cookie);
    // A lease held with nothing written yet: its typing may be in the debounce.
    expect(await lease(a, 0, 1)).toMatchObject({ t: "leased" });
    const put = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: INDEX, assets: ASSETS, base_version: 1 },
    });
    expect(put.status).toBe(200);
    expect(await a.nextOf("conflict")).toMatchObject({ version: 2 });
    expect(await stubFor(id).docPeek(id)).toMatchObject({ base_version: 1, conflict_version: 2 });
    a.ws.close(1000);
  });

  it("Publish your changes against an older HTML version is refused; the current one publishes", async () => {
    const { id, ownerP, owner } = await deckSetup("# Talk\n\nBody\n");
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 0, 1);
    expect(await edit(a, l.lease, "# Talk 2")).toMatchObject({ t: "op" });
    const p2 = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: INDEX, assets: ASSETS, base_version: 1 },
    });
    expect(p2.status).toBe(200);
    expect(await a.nextOf("conflict")).toMatchObject({ version: 2 });
    // Every socket: no lease, no edit.
    const l2 = await lease(a, 2, 3, 99);
    a.send({ t: "edit", lease: l.lease, seq: 2, text: "# Talk 3" });
    const index3 = JSON.stringify({ title: "Launch 2", order: ["cover"], cover: "cover" });
    const p3 = await call(id, owner.auth, "", {
      method: "PUT",
      body: { content: index3, base_version: 2 },
    });
    expect(p3.status).toBe(200);
    await a.nextOf("conflict");
    const stale = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save", conflict_version: 2 },
    });
    expect(stale.status).toBe(409);
    expect(String((await json(await call(id, owner.auth, ""))).content)).toBe(index3);
    const ok = await call(id, ownerP.session.headers, "/live/checkpoint", {
      body: { base_version: 1, rev: 1, reason: "save", conflict_version: 3 },
    });
    expect(ok.status).toBe(200);
    expect(l2.t).toBe("lease_denied");
    expect(String((await json(await call(id, owner.auth, ""))).content)).toBe("# Talk 2\n\nBody\n");
    a.ws.close(1000);
  });
});
