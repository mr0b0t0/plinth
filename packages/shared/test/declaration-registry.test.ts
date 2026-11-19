// The declaration registry (CAPABILITY_TOKENS, DECLARATION_FIELDS): what pages declare and how a
// version stores it. The registry replaced hand-written parse, serialize and read code without a
// behaviour change, so the old code is kept here as the reference and compared on a corpus.
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TOKENS,
  type Capabilities,
  DATA_CAPABILITIES,
  DECLARATION_FIELDS,
  LIMITS,
  parseCapabilities,
  ROOM_LIMITS,
  ROOM_OPEN_ALL,
  ROOM_TOPIC_RE,
  readStoredCapabilities,
  serializeCapabilities,
} from "../src/index.ts";

// ---------- the code before the registry, verbatim in behaviour ----------

const META_TAG_RE = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const COLLECTION_RE = /^[a-z][a-z0-9_-]{0,39}$/;

function legacyAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(ATTR_RE)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const legacyTokens = (c: string) =>
  c
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);

function legacyParse(html: string): Capabilities | null {
  if (!/plinth-/i.test(html)) return null;
  const text = html.replace(COMMENT_RE, "");
  let declared: string[] | null = null;
  let sharedNames: string[] | null = null;
  let openTopics: string[] | null = null;
  for (const m of text.matchAll(META_TAG_RE)) {
    const attrs = legacyAttrs(m[1] ?? "");
    const name = attrs.get("name")?.trim().toLowerCase();
    if (name === "plinth-capabilities" && declared === null) {
      declared = legacyTokens(attrs.get("content") ?? "");
    } else if (name === "plinth-data-shared" && sharedNames === null) {
      sharedNames = legacyTokens(attrs.get("content") ?? "");
    } else if (name === "plinth-room-open" && openTopics === null) {
      openTopics = legacyTokens(attrs.get("content") ?? "");
    }
    if (declared !== null && sharedNames !== null && openTopics !== null) break;
  }
  const known = new Set((declared ?? []).filter((t) => ["data", "viewer", "room"].includes(t)));
  const data = known.has("data");
  const room = known.has("room");
  if (!data && !room) return null;
  const shared: string[] = [];
  for (const n of data ? (sharedNames ?? []) : []) {
    if (shared.length >= LIMITS.maxDataShared) break;
    if (COLLECTION_RE.test(n) && !shared.includes(n)) shared.push(n);
  }
  const roomOpen: string[] = [];
  for (const t of room ? (openTopics ?? []) : []) {
    if (roomOpen.length >= ROOM_LIMITS.maxOpenTopics) break;
    if ((t === ROOM_OPEN_ALL || ROOM_TOPIC_RE.test(t)) && !roomOpen.includes(t)) roomOpen.push(t);
  }
  return { data, viewer: known.has("viewer"), shared, room, roomOpen };
}

function legacySerialize(c: Capabilities): string {
  const { data, viewer, shared, room, roomOpen } = c;
  return JSON.stringify(room ? { data, viewer, shared, room, roomOpen } : { data, viewer, shared });
}

function legacyRead(json: string): Capabilities | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { data, viewer, shared, room, roomOpen } = v as Record<string, unknown>;
  if (typeof data !== "boolean" || typeof viewer !== "boolean") return null;
  const hasRoom = room === true;
  if (!data && !hasRoom) return null;
  const names = Array.isArray(shared) ? shared.filter((n) => typeof n === "string") : [];
  const topics =
    hasRoom && Array.isArray(roomOpen)
      ? roomOpen.filter(
          (t): t is string =>
            typeof t === "string" && (t === ROOM_OPEN_ALL || ROOM_TOPIC_RE.test(t)),
        )
      : [];
  return { data, viewer, shared: names, room: hasRoom, roomOpen: topics };
}

// ---------- a corpus of declarations ----------

const meta = (name: string, content: string) => `<meta name="${name}" content="${content}">`;
const CAPS = ["", "data", "viewer", "room", "data viewer", "room viewer", "data room", "x data"];
const SHARED = [
  null,
  "",
  "tasks notes",
  "Bad! tasks tasks",
  Array.from({ length: 30 }, (_, i) => `c${i}`).join(" "),
];
const OPEN = [
  null,
  "",
  "cursor *",
  "Bad! cursor cursor",
  Array.from({ length: 30 }, (_, i) => `t${i}`).join(","),
];

function corpus(): string[] {
  const out: string[] = ["", "<h1>plinth-nothing</h1>", meta("description", "data viewer")];
  for (const c of CAPS) {
    for (const s of SHARED) {
      for (const o of OPEN) {
        const parts = [
          meta("plinth-capabilities", c),
          s === null ? "" : meta("plinth-data-shared", s),
          o === null ? "" : meta("plinth-room-open", o),
        ];
        out.push(parts.join(""));
        out.push([...parts].reverse().join("\n"));
        // Later duplicates never win, and commented-out tags never count.
        out.push(`${parts.join("")}${meta("plinth-capabilities", "data room viewer")}`);
        out.push(`<!-- ${meta("plinth-capabilities", "data room")} -->${parts.join("")}`);
        out.push(parts.join("").replaceAll('"', "'").replaceAll("plinth-", "PLINTH-"));
      }
    }
  }
  return out;
}

describe("the declaration registry", () => {
  it("derives DATA_CAPABILITIES from the token table, in order", () => {
    expect(DATA_CAPABILITIES).toEqual(CAPABILITY_TOKENS.map((t) => t.token));
    expect(DATA_CAPABILITIES).toEqual(["data", "viewer", "room"]);
  });

  it("places every token once, and lists name known tokens and unique metas", () => {
    const tokens = DECLARATION_FIELDS.filter((f) => f.kind === "token").map((f) => f.key);
    expect([...tokens].sort()).toEqual([...DATA_CAPABILITIES].sort());
    const keys = DECLARATION_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const metas = DECLARATION_FIELDS.flatMap((f) => (f.kind === "list" ? [f.meta] : []));
    expect(new Set(metas).size).toBe(metas.length);
    expect(metas).not.toContain("plinth-capabilities");
    for (const f of DECLARATION_FIELDS) {
      if (f.kind !== "list") continue;
      expect(DATA_CAPABILITIES).toContain(f.needs);
      if (f.stored !== "always") expect(DATA_CAPABILITIES).toContain(f.stored);
    }
    for (const t of CAPABILITY_TOKENS) {
      for (const n of t.needs as readonly string[]) expect(DATA_CAPABILITIES).toContain(n);
    }
    // At least one token declares on its own, or nothing could ever be declared.
    expect(CAPABILITY_TOKENS.some((t) => t.declares)).toBe(true);
  });

  it("stores the three shapes on main byte for byte", () => {
    const shapes: [string, string][] = [
      // Shared data, without a room: no room fields, as before rooms existed.
      [
        meta("plinth-capabilities", "data viewer") + meta("plinth-data-shared", "tasks"),
        '{"data":true,"viewer":true,"shared":["tasks"]}',
      ],
      // A room alone.
      [
        meta("plinth-capabilities", "room viewer") + meta("plinth-room-open", "cursor *"),
        '{"data":false,"viewer":true,"shared":[],"room":true,"roomOpen":["cursor","*"]}',
      ],
      // Both.
      [
        meta("plinth-capabilities", "data room"),
        '{"data":true,"viewer":false,"shared":[],"room":true,"roomOpen":[]}',
      ],
    ];
    for (const [html, stored] of shapes) {
      const c = parseCapabilities(html);
      expect(c).not.toBeNull();
      expect(serializeCapabilities(c as Capabilities)).toBe(stored);
      // A stored row reads back to the same declaration and stores the same bytes again.
      expect(readStoredCapabilities(stored)).toEqual(c);
      expect(serializeCapabilities(readStoredCapabilities(stored) as Capabilities)).toBe(stored);
    }
  });

  it("parses and stores every declaration in the corpus as the code before it did", () => {
    const inputs = corpus();
    expect(inputs.length).toBeGreaterThan(1000);
    for (const html of inputs) {
      const before = legacyParse(html);
      const now = parseCapabilities(html);
      expect(now, html).toEqual(before);
      if (before && now) expect(serializeCapabilities(now), html).toBe(legacySerialize(before));
    }
  });

  it("reads stored rows, including malformed ones, as the code before it did", () => {
    const rows = [
      "",
      "not json",
      "null",
      "7",
      "[]",
      '"data"',
      "{}",
      '{"data":"yes"}',
      '{"data":true}',
      '{"data":false,"viewer":true}',
      '{"data":true,"viewer":false}',
      '{"data":true,"viewer":1}',
      '{"data":true,"viewer":false,"shared":"tasks"}',
      '{"data":true,"viewer":false,"shared":["tasks",7,"Bad!",null]}',
      '{"data":false,"viewer":false,"shared":["tasks"],"room":true}',
      '{"data":false,"viewer":true,"shared":[],"room":true,"roomOpen":["cursor","*","Bad!",7]}',
      '{"data":false,"viewer":false,"room":"yes"}',
      '{"data":false,"viewer":false,"room":true,"roomOpen":"cursor"}',
      '{"data":true,"viewer":false,"shared":[],"roomOpen":["cursor"]}',
      '{"data":true,"viewer":true,"shared":[],"room":false,"roomOpen":["cursor"]}',
      '{"data":true,"viewer":true,"shared":[],"extra":true}',
    ];
    for (const r of rows) expect(readStoredCapabilities(r), r).toEqual(legacyRead(r));
    for (const html of corpus()) {
      const c = legacyParse(html);
      if (!c) continue;
      const stored = legacySerialize(c);
      expect(readStoredCapabilities(stored), stored).toEqual(legacyRead(stored));
    }
  });

  it("reads a list meta that comes after every other meta", () => {
    const filler = Array.from({ length: 50 }, (_, i) => meta(`other-${i}`, "x")).join("");
    const html = `${meta("plinth-capabilities", "data room")}${meta("plinth-room-open", "cursor")}${filler}${meta("plinth-data-shared", "tasks")}`;
    expect(parseCapabilities(html)).toMatchObject({ shared: ["tasks"], roomOpen: ["cursor"] });
  });
});
