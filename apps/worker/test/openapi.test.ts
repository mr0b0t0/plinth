import { API } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import committed from "../../../docs/openapi.json";
import { openApiDocument, toOpenApiPath } from "../src/api/openapi.ts";
import { call, config, json } from "./helpers.ts";

type Json = Record<string, any>;

const METHODS = ["get", "post", "put", "patch", "delete"];

/** Collect every "$ref" string in a document. */
function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) refs(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

function operations(doc: Json): [string, string, Json][] {
  const ops: [string, string, Json][] = [];
  for (const [path, item] of Object.entries(doc.paths as Json)) {
    for (const m of METHODS) if (item[m]) ops.push([path, m, item[m]]);
  }
  return ops;
}

describe("OpenAPI document", () => {
  const doc = openApiDocument(config()) as Json;

  it("is OpenAPI 3.1 with info, a server under /api/v1 and security schemes", () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(doc.info.title).toBe("Plinth API");
    expect(doc.info.version).toBeTypeOf("string");
    expect(doc.servers[0].url).toBe("http://app.localhost:8787/api/v1");
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.components.securitySchemes.sessionCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "__Host-plinth_session",
    });
    expect(doc.components.securitySchemes.csrfHeader).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-plinth-csrf",
    });
  });

  it("documents exactly the routes the Worker serves under /api/v1", async () => {
    const { app } = await import("../src/index.ts");
    const doc = openApiDocument(config()) as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const m of Object.keys(ops))
        documented.add(`${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ":$1")}`);
    }
    const served = new Set<string>();
    for (const r of app.routes) {
      if (r.path.startsWith("/api/v1/") && r.method !== "ALL")
        served.add(`${r.method} ${r.path.slice(7)}`);
    }
    expect([...served].filter((x) => !documented.has(x)).sort()).toEqual([]);
    expect([...documented].filter((x) => !served.has(x)).sort()).toEqual([]);
  });

  it("has a path for every entry in the shared API map", () => {
    const paths = Object.keys(doc.paths);
    for (const [key, path] of Object.entries(API)) {
      expect(paths, `API.${key}`).toContain(toOpenApiPath(path));
    }
  });

  it("gives every operation a unique id, responses, security and declared path params", () => {
    const ids = new Set<string>();
    for (const [path, method, op] of operations(doc)) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.operationId, where).toBeTypeOf("string");
      expect(ids.has(op.operationId), `duplicate ${op.operationId}`).toBe(false);
      ids.add(op.operationId);
      expect(Object.keys(op.responses).length, where).toBeGreaterThan(0);
      expect(Array.isArray(op.security), where).toBe(true);
      const declared = (op.parameters ?? [])
        .filter((p: Json) => p.in === "path")
        .map((p: Json) => p.name);
      const inPath = [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
      expect(declared.sort(), where).toEqual(inPath.sort());
    }
  });

  it("mirrors every MCP tool with the same auth (bearer token)", () => {
    const tools = new Set(
      operations(doc)
        .filter(([, , op]) => op["x-mcp-tool"])
        .map(([, , op]) => {
          expect(op.security.some((s: Json) => "bearerAuth" in s)).toBe(true);
          return op["x-mcp-tool"] as string;
        }),
    );
    expect([...tools].sort()).toEqual(
      [
        "claim_mention",
        "get_artifact",
        "list_artifact_data",
        "list_artifacts",
        "list_mentions",
        "list_versions",
        "publish_artifact",
        "reply_comment",
        "restore_version",
        "set_visibility",
        "update_artifact",
        "write_artifact_data",
      ].sort(),
    );
  });

  it("generates request bodies from the shared zod schemas", () => {
    const publish = doc.components.schemas.PublishArtifactInput;
    expect(publish.type).toBe("object");
    // html is required for type html only (the Worker's resolveSource), so only title is.
    expect(publish.required.sort()).toEqual(["title"]);
    expect(publish.properties.type.enum).toEqual(["html", "doc", "slides"]);
    expect(publish.properties.content.type).toBe("string");
    expect(publish.properties.visibility.enum).toEqual([
      "public",
      "unlisted",
      "password",
      "allowlist",
    ]);
    const update = doc.components.schemas.UpdateArtifactInput;
    expect(update.properties.id).toBeUndefined();
    expect(update.properties.base_version.type).toBe("integer");
    expect(update.properties.type).toBeUndefined();
    expect(update.properties.content.type).toBe("string");
  });

  it("describes categories: on the inputs, the list result and the list filter", () => {
    const schemas = doc.components.schemas;
    for (const name of ["PublishArtifactInput", "UpdateArtifactInput", "StartUploadInput"]) {
      const c = schemas[name].properties.category;
      expect(c, name).toMatchObject({ type: "string", minLength: 1, maxLength: 60 });
      expect(c, name).not.toHaveProperty("pattern");
      expect(schemas[name].required ?? [], name).not.toContain("category");
    }
    expect(schemas.ArtifactList.required.sort()).toEqual(["categories", "items"]);
    expect(schemas.ArtifactList.properties.categories.items).toEqual({
      $ref: "#/components/schemas/CategoryCount",
    });
    // Echoed only when the call set one.
    expect(schemas.PublishResult.properties.category.type).toBe("string");
    expect(schemas.PublishResult.required).not.toContain("category");
    expect(schemas.BundleResult.required).not.toContain("category");
    const list = doc.paths["/artifacts"].get;
    expect(list.parameters.map((p: Json) => p.name)).toEqual(["query", "category", "limit"]);
    expect(doc.info.description).toContain("titles, categories, comments");
  });

  it("documents the owner's category edits: PATCH, the list and the session-only rename", () => {
    const schemas = doc.components.schemas;
    const patch = doc.paths["/artifacts/{ref}"].patch;
    expect(patch.operationId).toBe("renameArtifact");
    expect(patch.summary).toBe("Rename or set the category (owner)");
    const body = schemas.RenameArtifactInput;
    expect(body.required ?? []).toEqual([]);
    expect(body.properties.title.type).toBe("string");
    expect(body.properties.category.anyOf).toEqual([
      expect.objectContaining({ type: "string", minLength: 1, maxLength: 60 }),
      { type: "null" },
    ]);
    const list = doc.paths["/categories"].get;
    expect(list.operationId).toBe("listCategories");
    expect(list.security).toEqual([{ bearerAuth: ["artifacts:read"] }, { sessionCookie: [] }]);
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CategoryList",
    });
    const rename = doc.paths["/categories/rename"].post;
    expect(rename.operationId).toBe("renameCategory");
    // The signed-in owner only: no bearer scheme, so no agent or token can call it.
    expect(rename.security).toEqual([{ sessionCookie: [], csrfHeader: [] }]);
    expect(schemas.RenameCategoryInput.required.sort()).toEqual(["from", "to"]);
    expect(schemas.CategoryRenameResult.required.sort()).toEqual(["category", "updated"]);
    for (const op of [patch, list, rename]) expect(op["x-mcp-tool"]).toBeUndefined();
  });

  it("describes ArtifactDetail per type, with html required for an HTML page", () => {
    const schemas = doc.components.schemas;
    const detail = schemas.ArtifactDetail;
    expect(detail.oneOf).toEqual([
      { $ref: "#/components/schemas/HtmlArtifactDetail" },
      { $ref: "#/components/schemas/DocArtifactDetail" },
      { $ref: "#/components/schemas/SlidesArtifactDetail" },
    ]);
    expect(detail.discriminator).toEqual({
      propertyName: "type",
      mapping: {
        html: "#/components/schemas/HtmlArtifactDetail",
        doc: "#/components/schemas/DocArtifactDetail",
        slides: "#/components/schemas/SlidesArtifactDetail",
      },
    });
    const deck = schemas.SlidesArtifactDetail;
    expect(deck.required).toContain("content");
    expect(deck.properties.type.enum).toEqual(["slides"]);
    expect(deck.properties.source_path.enum).toEqual(["slides.md"]);
    expect(deck.properties.html).toBeUndefined();
    expect(deck.properties.live_draft).toBeUndefined();
    expect(schemas.ArtifactType.description).toBe(
      '"html": a hand-written page (source index.html). "doc": a Markdown document (source content.md) that Plinth renders. "slides": a Markdown deck (source slides.md) that Plinth renders. Fixed at publish.',
    );
    const page = schemas.HtmlArtifactDetail;
    // Existing clients keep a required html field, as before typed artifacts.
    expect(page.required).toContain("html");
    expect(page.required).toContain("type");
    expect(page.required).toContain("source_path");
    expect(page.properties.type.enum).toEqual(["html"]);
    expect(page.properties.source_path.enum).toEqual(["index.html"]);
    expect(page.properties.content).toBeUndefined();
    expect(page.properties.html.description).toMatch(/UNTRUSTED/);
    const d = schemas.DocArtifactDetail;
    expect(d.required).toContain("content");
    expect(d.properties.type.enum).toEqual(["doc"]);
    expect(d.properties.source_path.enum).toEqual(["content.md"]);
    expect(d.properties.html).toBeUndefined();
    expect(d.properties.content.description).toMatch(/UNTRUSTED Markdown/);
    // Apart from the source field (and a doc's optional live_draft), both carry the same properties.
    const rest = (o: Json, f: string) =>
      Object.keys(o.properties).filter((k) => k !== f && k !== "live_draft");
    expect(rest(page, "html")).toEqual(rest(d, "content"));
    expect(page.properties.live_draft).toBeUndefined();
    expect(d.properties.live_draft.oneOf).toEqual([
      { $ref: "#/components/schemas/LiveDraftMeta" },
      { type: "null" },
    ]);
    expect(d.required).not.toContain("live_draft");
    expect([...page.required].filter((k: string) => k !== "html")).toEqual(
      [...d.required].filter((k: string) => k !== "content"),
    );
  });

  it("documents the four live editing operations as session-only (never bearer, never MCP)", () => {
    const live = [
      ["/artifacts/{ref}/live", "get"],
      ["/artifacts/{ref}/live/draft", "get"],
      ["/artifacts/{ref}/live/checkpoint", "post"],
      ["/artifacts/{ref}/live/draft", "delete"],
    ] as const;
    for (const [path, method] of live) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method} ${path}`).toBeDefined();
      expect(op.tags).toEqual(["Live editing"]);
      expect(JSON.stringify(op.security)).not.toContain("bearerAuth");
      expect(op["x-mcp-tool"]).toBeUndefined();
    }
    expect(
      doc.paths["/artifacts/{ref}/live/checkpoint"].post.requestBody.content["application/json"]
        .schema,
    ).toEqual({
      $ref: "#/components/schemas/LiveCheckpointInput",
    });
    expect(doc.components.schemas.PublishWarning.properties.code.enum).toContain("live_draft");
  });

  it("resolves every $ref", () => {
    for (const r of refs(doc)) {
      const [, section, name] = /^#\/components\/(\w+)\/(\w+)$/.exec(r) ?? [];
      expect(section && name ? doc.components[section]?.[name] : undefined, r).toBeDefined();
    }
  });

  it("is served at /openapi.json", async () => {
    const res = await call("/openapi.json");
    expect(res.status).toBe(200);
    const served = await json(res);
    expect(Object.keys(served.paths)).toEqual(Object.keys(doc.paths));
  });

  it("documents the shared data endpoints and marks the data untrusted", () => {
    const data = doc.paths["/artifacts/{ref}/data"];
    expect(Object.keys(data).sort()).toEqual(["delete", "get", "post"]);
    expect(data.get["x-mcp-tool"]).toBe("list_artifact_data");
    expect(data.post["x-mcp-tool"]).toBe("write_artifact_data");
    expect(data.post.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/WriteArtifactDataInput",
    });
    expect(data.delete["x-mcp-tool"]).toBeUndefined();
    expect(data.delete.security).toEqual([{ sessionCookie: [], csrfHeader: [] }]);
    const page = doc.paths["/artifacts/{ref}/data/{collection}"];
    expect(page.get["x-mcp-tool"]).toBe("list_artifact_data");
    expect(page.get.parameters.map((p: Json) => p.name).sort()).toEqual(
      ["collection", "cursor", "limit", "ref"].sort(),
    );
    const one = doc.paths["/artifacts/{ref}/data/{collection}/{doc}"];
    expect(one.get["x-mcp-tool"]).toBe("list_artifact_data");
    const write = doc.components.schemas.WriteArtifactDataInput;
    expect(write.properties.id).toBeUndefined();
    expect(write.required).toEqual(["ops"]);
    for (const name of ["DataSummary", "DataPage", "DataDoc", "AgentDoc"]) {
      expect(JSON.stringify(doc.components.schemas[name]), name).toMatch(/UNTRUSTED/);
    }
  });

  it("documents the view gate's optional shared-data block", () => {
    const ok = doc.components.schemas.ViewGate.oneOf.find(
      (b: Json) => b.properties.status.const === "ok",
    );
    expect(ok.properties.data).toEqual({ $ref: "#/components/schemas/ViewGateData" });
    expect(ok.required).not.toContain("data");
    const data = doc.components.schemas.ViewGateData;
    expect(Object.keys(data.properties).sort()).toEqual(
      ["available", "can_write", "capabilities", "email", "identified", "room_email"].sort(),
    );
    expect(data.required.sort()).toEqual(
      ["available", "can_write", "capabilities", "identified"].sort(),
    );
  });

  it("matches the committed docs/openapi.json (run `pnpm openapi` after a change)", () => {
    const fresh = JSON.parse(
      JSON.stringify(openApiDocument({ appOrigin: "https://plinth.aconite.io" })),
    );
    expect(committed).toEqual(fresh);
  });
});
