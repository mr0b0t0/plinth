// The shared-data API's route table (content/data-api.ts DATA_API_ROUTES): every registered route,
// with every method it allows, is refused by each caller check the dispatcher runs before any
// handler. A route added to the table is covered here without a new test.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DATA_API_ROUTES } from "../src/content/data-api.ts";
import worker from "../src/index.ts";
import { agent, browserSession, contentOrigin, enterContent, publish } from "./helpers.ts";

const PAGE = `<!doctype html><title>Routes</title>
<meta name="plinth-capabilities" content="data viewer room">
<meta name="plinth-data-shared" content="tasks"><p>routes</p>`;

async function run(url: string, init: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    env as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const BODY_METHODS = new Set(["POST", "PUT"]);

/** A request the way the runtime makes it, with `over` replacing (or, with null, removing) headers. */
function request(
  id: string,
  cookie: string,
  path: string,
  method: string,
  over: Record<string, string | null> = {},
  body?: string,
) {
  const base: Record<string, string | null> = {
    "x-plinth-data": "1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    origin: contentOrigin(id),
    "content-type": BODY_METHODS.has(method) ? "application/json" : null,
    cookie,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) headers.set(k, v);
  const payload = BODY_METHODS.has(method)
    ? (body ?? JSON.stringify({ data: { n: 1 } }))
    : undefined;
  return run(`${contentOrigin(id)}/__plinth/api/v1/${path}`, { method, headers, body: payload });
}

async function setup() {
  const owner = await agent();
  const { body } = await publish(owner.auth, { html: PAGE, visibility: "allowlist" });
  const id = body.id as string;
  const s = await browserSession(owner.user.id);
  const { cookie } = await enterContent(id, { headers: s.headers });
  if (!cookie) throw new Error("no content cookie");
  return { id, cookie };
}

const noCors = (res: Response, label: string) => {
  for (const [k] of res.headers)
    expect(k.startsWith("access-control-"), `${label} ${k}`).toBe(false);
};

describe("data API route table", () => {
  it("has unique kinds, and each example matches its own route only", () => {
    const kinds = DATA_API_ROUTES.map((r) => r.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const r of DATA_API_ROUTES) {
      const seg = r.example.split("/");
      const hits = DATA_API_ROUTES.filter((o) => o.match(seg) !== null).map((o) => o.kind);
      expect(hits, r.kind).toEqual([r.kind]);
      expect(r.methods.length, r.kind).toBeGreaterThan(0);
      for (const m of r.methods) expect(["GET", "POST", "PUT", "DELETE"], r.kind).toContain(m);
    }
  });

  it("refuses every route and method without each caller check, before any handler", async () => {
    const { id, cookie } = await setup();
    const refusals: [string, Record<string, string | null>][] = [
      ["no x-plinth-data header", { "x-plinth-data": null }],
      ["a wrong x-plinth-data header", { "x-plinth-data": "yes" }],
      ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
      ["same-site fetch metadata", { "sec-fetch-site": "same-site" }],
      ["a non-fetch destination", { "sec-fetch-dest": "document" }],
      ["a navigation", { "sec-fetch-mode": "navigate" }],
      ["another artifact's Origin", { origin: contentOrigin("b".repeat(20)) }],
      ["an opaque Origin", { origin: "null" }],
    ];
    for (const route of DATA_API_ROUTES) {
      for (const method of route.methods) {
        for (const [what, over] of refusals) {
          const label = `${route.kind} ${method}: ${what}`;
          const res = await request(id, cookie, route.example, method, over);
          expect(res.status, label).toBe(403);
          expect(((await res.json()) as { error: { code: string } }).error.code, label).toBe(
            "forbidden",
          );
          noCors(res, label);
        }
        if (route.requireOrigin) {
          const res = await request(id, cookie, route.example, method, { origin: null });
          expect(res.status, `${route.kind} ${method}: no Origin`).toBe(403);
        }
        if (BODY_METHODS.has(method)) {
          for (const [what, over, body] of [
            ["a form body", { "content-type": "application/x-www-form-urlencoded" }, "data=1"],
            ["a text body", { "content-type": "text/plain" }, '{"data":{}}'],
            ["no content type", { "content-type": null }, '{"data":{}}'],
            ["invalid JSON", {}, "{"],
          ] as const) {
            const label = `${route.kind} ${method}: ${what}`;
            const res = await request(id, cookie, route.example, method, over, body);
            expect(res.status, label).toBe(400);
            noCors(res, label);
          }
        }
      }
      // Methods the route does not allow, and the ones no route allows: 405, no CORS.
      for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
        if (route.methods.includes(method)) continue;
        const label = `${route.kind} ${method}`;
        const res = await request(id, cookie, route.example, method);
        expect(res.status, label).toBe(405);
        noCors(res, label);
      }
    }
  });

  it("serves every route and method once every check passes", async () => {
    const { id, cookie } = await setup();
    for (const route of DATA_API_ROUTES) {
      for (const method of route.methods) {
        const res = await request(id, cookie, route.example, method);
        // Not refused by a caller check, the method or the body: the handler ran.
        expect([200, 201, 204, 404, 409], `${route.kind} ${method}`).toContain(res.status);
        noCors(res, `${route.kind} ${method}`);
      }
    }
  });
});
