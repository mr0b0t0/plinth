// New, Import and Replace with a file (docs/spec.md "New and Import"): the app creates artifacts
// over the ordinary REST publish with the signed-in session, and nothing else. Checked here: each
// registry `create` row publishes as a private placeholder v1 with the note "Created in the app";
// an imported CSV or .xlsx is converted on the server with its note; the note is REST only (MCP's
// publish_artifact stores none); a token limited to one artifact still cannot create one; and a
// sheet's "Replace with a file…" is a PUT with content_format and base_version that keeps the
// artifact, and is refused with 409 against a stale version.
import { creatableTypes, TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  agent,
  browserSession,
  call,
  createToken,
  createUser,
  json,
  mcpClient,
  storedFile,
  tool,
} from "./helpers.ts";

async function session() {
  const user = await createUser();
  const s = await browserSession(user.id);
  return { user, headers: s.headers };
}

async function req(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await call(`/api/v1${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await json(res) };
}

const CSV = "Item,Qty\nApples,3\nPears,5\n";
const CSV_SHEET =
  '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"}]}\n["Apples",3]\n["Pears",5]';

describe("New: a blank artifact from a create row", () => {
  it("publishes each row as a private v1 with the note, stored exactly as the row", async () => {
    const { headers } = await session();
    for (const def of creatableTypes()) {
      const r = await req("POST", "/artifacts", headers, {
        title: def.create.title,
        type: def.id,
        content: def.create.content,
        note: "Created in the app",
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ type: def.id, version: 1, visibility: "allowlist" });
      expect(r.body.warnings).toEqual([]);
      const file = await (await storedFile(r.body.id, 1, def.sourcePath))?.text();
      expect(file, def.id).toBe(def.create.content);
      const versions = await req("GET", `/artifacts/${r.body.id}/versions`, headers);
      expect(versions.body.items).toHaveLength(1);
      expect(versions.body.items[0]).toMatchObject({
        number: 1,
        note: "Created in the app",
        author: { kind: "user" },
      });
      const detail = await req("GET", `/artifacts/${r.body.id}`, headers);
      expect(detail.body.title).toBe(def.create.title);
    }
  });

  it("trims the note, stores none for an empty one, and refuses one past the limit", async () => {
    const { headers } = await session();
    const doc = TYPE_REGISTRY.doc.create;
    if (!doc) throw new Error("doc has a create row");
    const make = (note: string) =>
      req("POST", "/artifacts", headers, {
        title: doc.title,
        type: "doc",
        content: doc.content,
        note,
      });
    const trimmed = await make("  Created in the app  ");
    const versions = await req("GET", `/artifacts/${trimmed.body.id}/versions`, headers);
    expect(versions.body.items[0].note).toBe("Created in the app");
    const empty = await make("   ");
    expect(empty.status).toBe(201);
    const none = await req("GET", `/artifacts/${empty.body.id}/versions`, headers);
    expect(none.body.items[0].note).toBeNull();
    const long = await make("x".repeat(501));
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe("invalid_input");
  });

  it("is REST only: publish_artifact over MCP stores no note on v1", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const r = await tool(client, "publish_artifact", {
      title: "Agent doc",
      type: "doc",
      content: "# Agent doc\n",
      note: "Not a field of this tool",
    });
    expect(r.isError, r.text).toBe(false);
    const versions = await req("GET", `/artifacts/${r.data.id}/versions`, a.auth);
    expect(versions.body.items[0].note).toBeNull();
    await client.close();
  });

  it("is refused for a token limited to one artifact, as every create is", async () => {
    const a = await agent();
    const first = await req("POST", "/artifacts", a.auth, {
      title: "Report",
      html: "<!doctype html><p>x</p>",
    });
    const bound = await createToken(a.user.id, { artifactId: first.body.id });
    const r = await req(
      "POST",
      "/artifacts",
      { Authorization: `Bearer ${bound.token}` },
      {
        title: "Untitled sheet",
        type: "sheet",
        content: TYPE_REGISTRY.sheet.create?.content,
        note: "Created in the app",
      },
    );
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe("token_bound");
  });

  it("needs a session or a token: a signed-out request is refused and creates nothing", async () => {
    const r = await req(
      "POST",
      "/artifacts",
      { Origin: "http://app.localhost:8787" },
      { title: "Untitled document", type: "doc", content: "# x\n", note: "Created in the app" },
    );
    expect([401, 403]).toContain(r.status);
    expect(r.body.id).toBeUndefined();
  });
});

describe("Import: a spreadsheet converted on the server", () => {
  it("imports a CSV as a new sheet with its note", async () => {
    const { headers } = await session();
    const r = await req("POST", "/artifacts", headers, {
      title: "fruit",
      type: "sheet",
      content_format: "csv",
      content: CSV,
      note: "Imported from fruit.csv",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await (await storedFile(r.body.id, 1, "sheet.jsonl"))?.text()).toBe(CSV_SHEET);
    const versions = await req("GET", `/artifacts/${r.body.id}/versions`, headers);
    expect(versions.body.items[0].note).toBe("Imported from fruit.csv");
  });

  it("refuses a file it cannot read, saying why, and creates nothing", async () => {
    const { user, headers } = await session();
    const before = await req("GET", "/artifacts", headers);
    const r = await req("POST", "/artifacts", headers, {
      title: "book",
      type: "sheet",
      content_format: "xlsx",
      content: btoa("not a zip"),
      note: "Imported from book.xlsx",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_input");
    expect(r.body.error.message).toMatch(/^The xlsx file could not be imported: /);
    expect(r.body.error.details).toMatchObject({ type: "sheet", content_format: "xlsx" });
    const after = await req("GET", "/artifacts", headers);
    expect(after.body.items.length).toBe(before.body.items.length);
    expect(user.id).toBeTruthy();
  });
});

describe("Replace with a file", () => {
  async function sheet() {
    const s = await session();
    const row = TYPE_REGISTRY.sheet.create;
    const r = await req("POST", "/artifacts", s.headers, {
      title: row?.title,
      type: "sheet",
      content: row?.content,
      note: "Created in the app",
    });
    expect(r.status).toBe(201);
    return { ...s, id: r.body.id as string, slug: r.body.slug as string };
  }

  it("makes the next version from the file, on the same artifact, with the note", async () => {
    const s = await sheet();
    const shared = await req("PUT", `/artifacts/${s.id}/sharing`, s.headers, {
      grants: [{ email: "ana@example.org", role: "editor" }],
    });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const r = await req("PUT", `/artifacts/${s.id}`, s.headers, {
      content_format: "csv",
      content: CSV,
      base_version: 1,
      note: "Replaced from fruit.csv",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: s.id, slug: s.slug, version: 2 });
    expect(await (await storedFile(s.id, 2, "sheet.jsonl"))?.text()).toBe(CSV_SHEET);
    const versions = await req("GET", `/artifacts/${s.id}/versions`, s.headers);
    expect(versions.body.items.map((v: { note: string }) => v.note)).toEqual([
      "Replaced from fruit.csv",
      "Created in the app",
    ]);
    // Sharing stays with the artifact.
    const grants = await req("GET", `/artifacts/${s.id}/sharing`, s.headers);
    expect(JSON.stringify(grants.body)).toContain("ana@example.org");
  });

  it("is refused with 409 naming the current version when another version came first", async () => {
    const s = await sheet();
    const first = await req("PUT", `/artifacts/${s.id}`, s.headers, {
      content_format: "csv",
      content: "A\n1\n",
      base_version: 1,
    });
    expect(first.status).toBe(200);
    const stale = await req("PUT", `/artifacts/${s.id}`, s.headers, {
      content_format: "csv",
      content: CSV,
      base_version: 1,
      note: "Replaced from fruit.csv",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
    expect(stale.body.error.details.current_version).toBe(2);
    // Confirmed again against v2, it lands as v3.
    const again = await req("PUT", `/artifacts/${s.id}`, s.headers, {
      content_format: "csv",
      content: CSV,
      base_version: 2,
      note: "Replaced from fruit.csv",
    });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(3);
  });
});
