// Provenance on shared data (docs/spec.md "Live data from the owner's agents"): an owner's agent
// write with `source` stamps the document; every other write clears the stamp and still goes
// through (the owner and editors change and delete anything, from every channel); commenter- and
// viewer-role writers are refused in a collection the page declares sourced; the stamp's checks;
// and how pages and agents see it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD,
  dashboard,
  json,
  LINEAR,
  pageApi,
  rest,
  setSources,
  stampRow,
  writeOne,
} from "./data-sources-helpers.ts";
import { enterContent } from "./helpers.ts";

const now = () => new Date().toISOString();

async function stamped() {
  const d = await dashboard();
  expect((await setSources(d.id, d.owner.auth, [LINEAR])).status).toBe(200);
  const at = now();
  const r = await writeOne(d.id, d.owner.auth, {
    doc_id: "open",
    data: { count: 7 },
    source: { id: "linear", ref: "https://u:p@linear.app/acme/view?token=1#x", fetched_at: at },
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return { ...d, at, rev: r.rev as number };
}

describe("stamping", () => {
  it("an owner's agent write with source stamps all six columns and raises last_fetched_at", async () => {
    const d = await stamped();
    const row = await stampRow(d.id, "issues", "open");
    expect(row).toMatchObject({
      source_id: "linear",
      source_label: "Open issues",
      source_connector: "Linear",
      source_ref: "https://linear.app/acme/view",
      fetched_at: new Date(d.at).toISOString(),
      source_connection: d.owner.connectionId,
    });
    const src = await env.DB.prepare(
      "SELECT last_fetched_at FROM data_sources WHERE artifact_id = ?1 AND source_id = 'linear'",
    )
      .bind(d.id)
      .first<{ last_fetched_at: string }>();
    expect(src?.last_fetched_at).toBe(new Date(d.at).toISOString());
    // Provenance counts in neither size_bytes nor the quota.
    const usage = await env.DB.prepare(
      "SELECT bytes FROM artifact_data_usage WHERE artifact_id = ?1",
    )
      .bind(d.id)
      .first<{ bytes: number }>();
    expect(usage?.bytes).toBe(
      "issues".length + "open".length + JSON.stringify({ count: 7 }).length,
    );
  });

  it("a later write by the owner's page, an editor's app or an editor's agent succeeds and clears the stamp", async () => {
    const d = await stamped();
    const editor = await d.as("editor");
    // The owner from the page.
    const res = await pageApi(d.id, "/data/issues/open", {
      cookie: await d.owner.cookie(),
      body: { data: { count: 8 }, if_rev: d.rev },
    });
    expect(res.status).toBe(200);
    let row = await stampRow(d.id, "issues", "open");
    expect(row?.source_id).toBeNull();
    expect(row?.fetched_at).toBeNull();
    expect(row?.source_connection).toBeNull();
    // Stamp again, then an editor in the app.
    const again = async () => {
      const cur = await stampRow(d.id, "issues", "open");
      const r = await writeOne(d.id, d.owner.auth, {
        doc_id: "open",
        data: { count: 9 },
        if_rev: cur?.rev,
        source: { id: "linear", fetched_at: now() },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return r.rev as number;
    };
    let rev = await again();
    let w = await writeOne(d.id, editor.session, {
      doc_id: "open",
      data: { count: 10 },
      if_rev: rev,
    });
    expect(w.ok, JSON.stringify(w)).toBe(true);
    row = await stampRow(d.id, "issues", "open");
    expect(row?.source_id).toBeNull();
    // And an editor's agent without source.
    rev = await again();
    w = await writeOne(d.id, editor.auth, { doc_id: "open", data: { count: 11 }, if_rev: rev });
    expect(w.ok, JSON.stringify(w)).toBe(true);
    row = await stampRow(d.id, "issues", "open");
    expect(row?.source_id).toBeNull();
  });

  it("owners and editors delete in a sourced collection from the page, the app and an agent", async () => {
    const d = await stamped();
    const editor = await d.as("editor");
    const make = async (docId: string) => {
      const r = await writeOne(d.id, d.owner.auth, {
        doc_id: docId,
        data: { n: 1 },
        source: { id: "linear", fetched_at: now() },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return r.rev as number;
    };
    let rev = await make("p");
    let res = await pageApi(d.id, `/data/issues/p?if_rev=${rev}`, {
      method: "DELETE",
      cookie: await editor.cookie(),
    });
    expect(res.status).toBe(204);
    rev = await make("q");
    let r = await rest(`/artifacts/${d.id}/data`, editor.session, "POST", {
      ops: [{ op: "delete", collection: "issues", doc_id: "q", if_rev: rev }],
    });
    expect(r.body.results[0].ok).toBe(true);
    rev = await make("r");
    r = await rest(`/artifacts/${d.id}/data`, editor.auth, "POST", {
      ops: [{ op: "delete", collection: "issues", doc_id: "r", if_rev: rev }],
    });
    expect(r.body.results[0].ok).toBe(true);
    rev = await make("s");
    res = await pageApi(d.id, `/data/issues/s?if_rev=${rev}`, {
      method: "DELETE",
      cookie: await d.owner.cookie(),
    });
    expect(res.status).toBe(204);
  });

  it("refuses commenter and viewer page writes in a sourced collection: create, update and delete", async () => {
    const d = await stamped();
    for (const role of ["commenter", "viewer"] as const) {
      const p = await d.as(role);
      const cookie = await p.cookie();
      const create = await pageApi(d.id, "/data/issues", {
        method: "POST",
        cookie,
        body: { data: { count: 1 } },
      });
      expect(create.status, role).toBe(403);
      expect((await json(create)).error.details.reason).toBe("sourced");
      const update = await pageApi(d.id, "/data/issues/open", {
        cookie,
        body: { data: { count: 0 } },
      });
      expect(update.status, role).toBe(403);
      const del = await pageApi(d.id, "/data/issues/open", { method: "DELETE", cookie });
      expect(del.status, role).toBe(403);
      // The same person still writes a collection that is not sourced, as canModifyDoc allows.
      const other = await pageApi(d.id, "/data/notes", {
        method: "POST",
        cookie,
        body: { data: { text: "hi" } },
      });
      expect(other.status, role).toBe(201);
    }
    expect((await stampRow(d.id, "issues", "open"))?.source_id).toBe("linear");
  });

  it("sourced wins over shared: a collection in both refuses commenters' updates and deletes as sourced", async () => {
    const both = DASHBOARD.replace(
      "<p>dashboard</p>",
      '<meta name="plinth-data-shared" content="issues"><p>dashboard</p>',
    );
    const d = await dashboard(both);
    await setSources(d.id, d.owner.auth, [LINEAR]);
    const w = await writeOne(d.id, d.owner.auth, { doc_id: "open", data: { count: 1 } });
    expect(w.ok).toBe(true);
    const cookie = await (await d.as("commenter")).cookie();
    const update = await pageApi(d.id, "/data/issues/open", {
      cookie,
      body: { data: { count: 0 }, if_rev: w.rev },
    });
    expect(update.status).toBe(403);
    expect((await json(update)).error.details.reason).toBe("sourced");
    const del = await pageApi(d.id, "/data/issues/open", { method: "DELETE", cookie });
    expect(del.status).toBe(403);
    expect((await json(del)).error.details.reason).toBe("sourced");
  });

  it("refuses a source from anyone but the owner's agent, an unknown source, another collection, and bad times", async () => {
    const d = await stamped();
    const editor = await d.as("editor");
    const source = { id: "linear", fetched_at: now() };
    let r = await writeOne(d.id, editor.auth, { doc_id: "e1", data: { n: 1 }, source });
    expect(r.ok).toBe(false);
    expect(r.error.details.reason).toBe("source_owner_only");
    // The owner in the app cannot stamp either.
    r = await writeOne(d.id, d.owner.session, { doc_id: "e2", data: { n: 1 }, source });
    expect(r.error.details.reason).toBe("source_owner_only");
    r = await writeOne(d.id, d.owner.auth, {
      doc_id: "e3",
      data: { n: 1 },
      source: { id: "stripe", fetched_at: now() },
    });
    expect(r.error.code).toBe("invalid_input");
    r = await writeOne(d.id, d.owner.auth, {
      collection: "notes",
      doc_id: "e4",
      data: { n: 1 },
      source,
    });
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.message).toMatch(/stamps collection issues only/);
    const ahead = new Date(Date.now() + 6 * 60_000).toISOString();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    for (const fetched_at of [ahead, old]) {
      r = await writeOne(d.id, d.owner.auth, {
        doc_id: "e5",
        data: { n: 1 },
        source: { id: "linear", fetched_at },
      });
      expect(r.error.code, fetched_at).toBe("invalid_input");
    }
    for (const ref of [
      `${"gh"}p_0123456789abcdef`,
      "eyJa.eyJb.c",
      "0123456789abcdef0123456789abcdef01234567",
    ]) {
      r = await writeOne(d.id, d.owner.auth, {
        doc_id: "e6",
        data: { n: 1 },
        source: { id: "linear", ref, fetched_at: now() },
      });
      expect(r.error?.code, ref).toBe("invalid_input");
    }
  });

  it("a ref may point at the record in the tracker: long paths and page ids are not credentials", async () => {
    const d = await dashboard();
    await setSources(d.id, d.owner.auth, [LINEAR]);
    for (const [i, ref] of [
      "https://linear.app/acme/issue/ENG-123/fix-the-login-redirect-on-mobile",
      "https://acme.atlassian.net/jira/software/projects/ENG/boards/12",
      "https://www.notion.so/acme/Q4-Roadmap-2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    ].entries()) {
      const r = await writeOne(d.id, d.owner.auth, {
        doc_id: `r${i}`,
        data: { n: i },
        source: { id: "linear", ref, fetched_at: now() },
      });
      expect(r.ok, `${ref}: ${JSON.stringify(r)}`).toBe(true);
      expect((await stampRow(d.id, "issues", `r${i}`))?.source_ref).toBe(ref);
    }
  });
});

describe("how readers see it", () => {
  it("pages see source on stamped documents only, anonymous readers included; agent only with viewer", async () => {
    const d = await stamped();
    const plain = await writeOne(d.id, d.owner.auth, { doc_id: "plain", data: { n: 1 } });
    expect(plain.ok).toBe(true);
    const res = await pageApi(d.id, "/data/issues", { cookie: await d.owner.cookie() });
    const docs = (await json(res)).docs as Record<string, unknown>[];
    const open = docs.find((x) => x.id === "open") as Record<string, any>;
    const other = docs.find((x) => x.id === "plain") as Record<string, any>;
    expect(open.source).toEqual({
      id: "linear",
      label: "Open issues",
      connector: "Linear",
      ref: "https://linear.app/acme/view",
      fetched_at: new Date(d.at).toISOString(),
      agent: "laptop",
    });
    expect(other).not.toHaveProperty("source");

    // An anonymous link viewer of an unlisted page: provenance without the connection's label.
    await rest(`/artifacts/${d.id}/visibility`, d.owner.auth, "PUT", { visibility: "unlisted" });
    const { cookie } = await enterContent(d.id);
    const anon = (await json(await pageApi(d.id, "/data/issues", { cookie }))).docs as any[];
    const a = anon.find((x) => x.id === "open");
    expect(a.source).toEqual({
      id: "linear",
      label: "Open issues",
      connector: "Linear",
      ref: "https://linear.app/acme/view",
      fetched_at: new Date(d.at).toISOString(),
    });
    expect(a).not.toHaveProperty("created_by");
  });

  it("a page without viewer shows no connection label", async () => {
    const d = await dashboard(DASHBOARD.replace("data viewer", "data"));
    await setSources(d.id, d.owner.auth, [LINEAR]);
    await writeOne(d.id, d.owner.auth, {
      doc_id: "open",
      data: { count: 1 },
      source: { id: "linear", fetched_at: now() },
    });
    const docs = (
      await json(await pageApi(d.id, "/data/issues", { cookie: await d.owner.cookie() }))
    ).docs as any[];
    expect(docs[0].source).not.toHaveProperty("agent");
  });

  it("agents see source with the connection label; the summary lists sources without recipes", async () => {
    const d = await stamped();
    const r = await rest(`/artifacts/${d.id}/data/issues/open`, d.owner.auth);
    expect(r.body.doc.source).toEqual({
      id: "linear",
      label: "Open issues",
      connector: "Linear",
      ref: "https://linear.app/acme/view",
      fetched_at: new Date(d.at).toISOString(),
      connection_label: "laptop",
    });
    const s = await rest(`/artifacts/${d.id}/data`, d.owner.auth);
    expect(s.body.sources).toEqual([
      {
        id: "linear",
        label: "Open issues",
        connector: "Linear",
        collection: "issues",
        status: "awaiting_confirmation",
        last_fetched_at: new Date(d.at).toISOString(),
      },
    ]);
    expect(JSON.stringify(s.body)).not.toContain("recipe");
  });

  it("an artifact without sources answers list_artifact_data and get_artifact as before", async () => {
    const d = await dashboard();
    const s = await rest(`/artifacts/${d.id}/data`, d.owner.auth);
    expect(s.body).not.toHaveProperty("sources");
    const g = await rest(`/artifacts/${d.id}`, d.owner.auth);
    expect(g.body).not.toHaveProperty("data_sources");
  });

  it("deleting the artifact wipes stamped documents and refresh tasks, and keeps the source row", async () => {
    const d = await stamped();
    await env.DB.prepare(
      `INSERT INTO data_refresh_tasks (id, artifact_id, source_id, config_hash, reason, requested_via, created_at, expires_at)
       VALUES (?3, ?1, 'linear', 'h', 'schedule', 'schedule', ?2, ?2)`,
    )
      .bind(d.id, now(), `t-${d.id}`)
      .run();
    expect((await rest(`/artifacts/${d.id}`, d.owner.auth, "DELETE")).status).toBe(204);
    const count = async (table: string) =>
      (
        await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE artifact_id = ?1`)
          .bind(d.id)
          .first<{ n: number }>()
      )?.n;
    expect(await count("artifact_docs")).toBe(0);
    expect(await count("data_refresh_tasks")).toBe(0);
    expect(await count("data_sources")).toBe(1);
  });

  it("a stamped write is refused once the artifact is taken down, and brings nothing back", async () => {
    const d = await stamped();
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(now(), d.id)
      .run();
    const r = await writeOne(d.id, d.owner.auth, {
      doc_id: "late",
      data: { n: 1 },
      source: { id: "linear", fetched_at: now() },
    });
    expect(r.ok).not.toBe(true);
    expect(await stampRow(d.id, "issues", "late")).toBeNull();
  });
});
