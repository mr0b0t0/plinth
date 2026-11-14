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
    expect(publish.required.sort()).toEqual(["html", "title"]);
    expect(publish.properties.visibility.enum).toEqual([
      "public",
      "unlisted",
      "password",
      "allowlist",
    ]);
    const update = doc.components.schemas.UpdateArtifactInput;
    expect(update.properties.id).toBeUndefined();
    expect(update.properties.base_version.type).toBe("integer");
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
      ["available", "can_write", "capabilities", "email", "identified"].sort(),
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
