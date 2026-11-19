// doc.source, plinth.freshness and plinth.cite in /__plinth/runtime.js, run: the real script
// against a fake window, document and fetch. A stamped document maps its source, an unstamped one
// has none; a badge is text only, idempotent, and marks an unstamped figure "not fetched"; cite
// works with no request at all (opaque isolation, inline data).
import { describe, expect, it } from "vitest";
import { runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

const RUNTIME_SCRIPT = runtimeScript(config());

type Json = Record<string, any>;

interface TextNode {
  nodeType: 3;
  nodeValue: string;
}

/** Just enough of an element for the runtime's cite code. */
class El {
  nodeType = 1;
  tagName: string;
  id = "";
  attrs = new Map<string, string>();
  childNodes: (El | TextNode)[] = [];
  parent: El | null = null;
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get children(): El[] {
    return this.childNodes.filter((n): n is El => n instanceof El);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  appendChild<T extends El | TextNode>(c: T): T {
    if (c instanceof El) c.parent = this;
    this.childNodes.push(c);
    return c;
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n instanceof El ? n.textContent : n.nodeValue)).join("");
  }
  set textContent(v: string) {
    this.childNodes = [{ nodeType: 3, nodeValue: v }];
  }
  get innerHTML(): string {
    throw new Error("the runtime must not read or write markup");
  }
  set innerHTML(_v: string) {
    throw new Error("the runtime must not read or write markup");
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string): El[] {
    if (sel === "[data-plinth-cite]")
      return this.all().filter((e) => e.attrs.has("data-plinth-cite"));
    if (sel === "body *")
      return this.all().filter((e) => e.tagName !== "BODY" && e.tagName !== "HEAD");
    throw new Error(`unsupported selector ${sel}`);
  }
}

function fakeDocument() {
  const root = new El("html");
  const head = root.appendChild(new El("head"));
  const body = root.appendChild(new El("body"));
  return {
    visibilityState: "visible",
    addEventListener() {},
    documentElement: root,
    head,
    body,
    createElement: (tag: string) => new El(tag),
    getElementById: (id: string) => root.all().find((e) => e.id === id) ?? null,
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
  };
}

function boot(opts: { origin?: string; fetch?: (url: string) => Json | null } = {}) {
  const win: Json = { addEventListener() {}, dispatchEvent: () => true };
  const doc = fakeDocument();
  const requests: string[] = [];
  const fetch = async (url: string) => {
    requests.push(url);
    const body = opts.fetch ? opts.fetch(url) : null;
    return {
      status: body ? 200 : 404,
      ok: !!body,
      headers: new Headers(),
      json: async () => JSON.parse(JSON.stringify(body)),
    };
  };
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    RUNTIME_SCRIPT,
  )(win, { origin: opts.origin ?? "null" }, doc, fetch, setTimeout, clearTimeout, class {});
  return { plinth: win.plinth, doc, requests };
}

const SESSION = {
  available: true,
  viewer: { id: "u_0123456789abcdef01234567", email: null, name: null, role: "commenter" },
  can_write: false,
  can_list_people: false,
  capabilities: ["data"],
  shared: [],
  limits: { max_doc_bytes: 16384, max_docs: 1000, max_bytes: 1048576 },
  usage: { docs: 2, bytes: 10 },
  seq: 1,
};
const FETCHED = new Date(Date.now() - 12 * 60_000).toISOString();
const STAMPED = {
  id: "open",
  data: { count: 7 },
  rev: 3,
  mine: false,
  personal: false,
  created_at: FETCHED,
  updated_at: FETCHED,
  source: {
    id: "linear",
    label: "Open issues",
    connector: "Linear",
    ref: "https://linear.app/acme",
    fetched_at: FETCHED,
  },
};
const UNSTAMPED = { ...STAMPED, id: "typed", source: undefined };

describe("doc.source", () => {
  it("maps a stamped document's source and leaves an unstamped one without", async () => {
    const { plinth } = boot({
      origin: "https://a.example",
      fetch: (url) =>
        url.endsWith("/session")
          ? SESSION
          : url.includes("/data/issues")
            ? { docs: [STAMPED, UNSTAMPED], next_cursor: null }
            : null,
    });
    const docs = await plinth.db.collection("issues").all();
    expect(docs[0].source).toEqual({
      id: "linear",
      label: "Open issues",
      connector: "Linear",
      ref: "https://linear.app/acme",
      fetchedAt: FETCHED,
    });
    expect(docs[1]).not.toHaveProperty("source");
    // With `viewer`, the server adds the connection's label.
    const withAgent = boot({
      origin: "https://a.example",
      fetch: (url) =>
        url.endsWith("/session")
          ? SESSION
          : { docs: [{ ...STAMPED, source: { ...STAMPED.source, agent: "laptop" } }] },
    });
    expect((await withAgent.plinth.db.collection("issues").all())[0].source.agent).toBe("laptop");
  });
});

describe("plinth.freshness", () => {
  it("gives the age of a stamped figure, stale past a threshold, and null without a stamp", () => {
    const { plinth } = boot();
    const f = plinth.freshness({ source: { fetchedAt: FETCHED } }, { staleAfterMinutes: 10 });
    expect(f.fetchedAt).toBe(FETCHED);
    expect(f.text).toBe("12 min ago");
    expect(f.stale).toBe(true);
    expect(
      plinth.freshness({ source: { fetched_at: FETCHED } }, { staleAfterMinutes: 60 }).stale,
    ).toBe(false);
    expect(plinth.freshness({ data: {} })).toBeNull();
    expect(plinth.freshness(null)).toBeNull();
    expect(plinth.freshness({ source: { fetchedAt: "not a date" } })).toBeNull();
  });
});

describe("plinth.cite", () => {
  it("appends one badge with the connector and age, as text, and never makes a request", () => {
    const { plinth, doc, requests } = boot();
    const el = doc.body.appendChild(new El("strong"));
    el.textContent = "7";
    const badge = plinth.cite(el, { source: STAMPED.source });
    expect(badge.tagName).toBe("SUP");
    expect(badge.getAttribute("class")).toBe("plinth-cite");
    expect(badge.getAttribute("role")).toBe("note");
    expect(badge.getAttribute("tabindex")).toBe("0");
    expect(badge.textContent).toBe("Linear \u00b7 12 min ago");
    expect(badge.getAttribute("aria-label")).toMatch(
      /^Open issues, from Linear, fetched \d{4}-\d\d-\d\d \d\d:\d\d UTC by an agent of the owner$/,
    );
    expect(doc.getElementById("plinth-cite-style")).not.toBeNull();
    // Idempotent: a second call replaces its own badge.
    plinth.cite(el, { source: STAMPED.source }, { field: "count" });
    expect(el.children.filter((c) => c.tagName === "SUP")).toHaveLength(1);
    expect(el.children[0]?.getAttribute("aria-label")).toMatch(
      /^Open issues \(count\), from Linear/,
    );
    expect(requests).toEqual([]);
  });

  it("shows a label with markup as text and adds no element", () => {
    const { plinth, doc } = boot();
    const el = doc.body.appendChild(new El("span"));
    const evil = '<img src=x onerror="alert(1)">';
    const badge = plinth.cite(el, { source: { ...STAMPED.source, connector: evil, label: evil } });
    expect(badge.textContent).toBe(`${evil} \u00b7 12 min ago`);
    expect(badge.children).toEqual([]);
    expect(el.children).toHaveLength(1);
  });

  it('marks a figure without a stamp "not fetched", and stale ones', () => {
    const { plinth, doc } = boot();
    const el = doc.body.appendChild(new El("span"));
    const badge = plinth.cite(el, { data: { count: 2 } });
    expect(badge.textContent).toBe("not fetched");
    expect(badge.getAttribute("class")).toBe("plinth-cite plinth-cite--none");
    expect(badge.getAttribute("aria-label")).toMatch(/not fetched from a data source/);
    const stale = plinth.cite(
      doc.body.appendChild(new El("span")),
      { source: STAMPED.source },
      {
        staleAfterMinutes: 5,
      },
    );
    expect(stale.getAttribute("class")).toBe("plinth-cite plinth-cite--stale");
    expect(stale.getAttribute("aria-label")).toMatch(/older than 5 min$/);
    expect(() => plinth.cite(null, STAMPED)).toThrow(/cite needs an element/);
  });

  it("scan fills every data-plinth-cite element from the documents, and missing lists the rest", () => {
    const { plinth, doc } = boot();
    const a = doc.body.appendChild(new El("strong"));
    a.setAttribute("data-plinth-cite", "issues/open#count");
    a.textContent = "7";
    const b = doc.body.appendChild(new El("strong"));
    b.setAttribute("data-plinth-cite", "issues/typed");
    b.textContent = "3";
    const c = doc.body.appendChild(new El("p"));
    c.textContent = "Revenue 1200";
    const mapped = [
      { id: "open", source: { ...STAMPED.source, fetchedAt: FETCHED } },
      { id: "typed" },
    ];
    expect(plinth.cite.scan(doc, { issues: mapped })).toBe(2);
    expect(a.children[0]?.textContent).toBe("Linear \u00b7 12 min ago");
    expect(b.children[0]?.textContent).toBe("not fetched");
    expect(plinth.cite.missing(doc)).toEqual([c]);
    // Scanning again replaces the badges instead of adding more.
    plinth.cite.scan(doc, { issues: mapped });
    expect(a.children).toHaveLength(1);
  });
});
