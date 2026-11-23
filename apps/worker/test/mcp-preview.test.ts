// In-chat previews (MCP Apps): the UI resource and tool metadata, the app-only preview_artifact
// tool, and the read-only preview pass on the content host, which alone drops frame-ancestors
// (docs/security.md#in-chat-previews).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ARTIFACT_IFRAME_SANDBOX, ARTIFACT_IFRAME_SANDBOX_OPAQUE } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { issueEnterUrl, signContentCookie } from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import { PREVIEW_RESOURCE_URI } from "../src/mcp/preview.ts";
import {
  agent,
  CONTENT_HOST,
  call,
  config,
  contentOrigin,
  enterContent,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";

const PAGE = "<!doctype html><title>Numbers</title><h1>Private numbers</h1>";
const POLL = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data"><p>poll</p>`;

async function run(url: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    env as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const directives = (res: Response) =>
  new Map(
    (res.headers.get("content-security-policy") ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0])
      .map((p) => [p[0] as string, p.slice(1)]),
  );

/** Publish a private page over MCP and ask for its preview link, as the preview page does. */
async function publishAndPreview(html = PAGE) {
  const a = await agent();
  const client = await mcpClient(a.token);
  const published = await tool(client, "publish_artifact", { title: "Numbers", html });
  expect(published.isError).toBe(false);
  const link = await tool(client, "preview_artifact", { id: published.data.id });
  expect(link.isError).toBe(false);
  return { a, client, published: published.data, link: link.data };
}

/** Exchange a preview link for its cookie, as the framed browser does. */
async function enterPreview(previewUrl: string) {
  const res = await run(previewUrl, { headers: { "sec-fetch-dest": "iframe" } });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { res, setCookie, cookie: setCookie.split(";")[0] ?? "" };
}

describe("MCP Apps metadata", () => {
  it("points the publishing tools at the preview, and hides preview_artifact from the model", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const { tools } = await client.listTools();
    const meta = (name: string) =>
      tools.find((t) => t.name === name)?._meta as { ui?: Record<string, unknown> } | undefined;
    for (const name of ["publish_artifact", "update_artifact", "restore_version", "show_artifact"])
      expect(meta(name)?.ui).toEqual({ resourceUri: PREVIEW_RESOURCE_URI });
    expect(meta("preview_artifact")?.ui).toEqual({
      resourceUri: PREVIEW_RESOURCE_URI,
      visibility: ["app"],
    });
    expect(tools.find((t) => t.name === "preview_artifact")?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["get_artifact", "set_visibility", "start_upload"])
      expect(meta(name)).toBeUndefined();
  });

  it("serves the preview page as an MCP App that may frame artifact subdomains only", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const r = await client.readResource({ uri: PREVIEW_RESOURCE_URI });
    const c = r.contents[0] as unknown as {
      mimeType: string;
      text: string;
      _meta: { ui: { csp: Record<string, string[]>; prefersBorder: boolean } };
    };
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c._meta.ui.csp).toEqual({ frameDomains: [`http://*.${CONTENT_HOST}`] });
    expect(c._meta.ui.prefersBorder).toBe(true);
    // Plinth's own page: speaks MCP Apps, trusts only its parent, asks for a link per render.
    expect(c.text).toContain('"ui/initialize"');
    expect(c.text).toContain("event.source !== window.parent");
    expect(c.text).toContain('"preview_artifact"');
    // A host that leaves the content host out of the app's frame-src gets a message, not an
    // error page.
    expect(c.text).toContain('"securitypolicyviolation"');
    expect(c.text).not.toMatch(/https?:\/\/(?!\*)/);
  });

  it("offers full screen only where the host lists it, through ui/request-display-mode", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const r = await client.readResource({ uri: PREVIEW_RESOURCE_URI });
    const text = (r.contents[0] as unknown as { text: string }).text;
    expect(text).toContain('availableDisplayModes: ["inline", "fullscreen"]');
    expect(text).toContain('"ui/request-display-mode"');
    expect(text).toContain('c.availableDisplayModes.includes("fullscreen")');
    // The button starts hidden: a host that never offers full screen never shows it.
    expect(text).toMatch(/<button[^>]*id="full"[^>]*hidden>/);
    // ...and stays hidden: the icon button's own display rule must not override [hidden].
    expect(text).toContain("[hidden] { display: none !important; }");
  });
});

describe("show_artifact", () => {
  it("returns what the preview needs and the page to give the user, never HTML or a link", async () => {
    const { client, published } = await publishAndPreview();
    const shown = await tool(client, "show_artifact", { id: published.slug });
    expect(shown.isError).toBe(false);
    expect(shown.data).toEqual({
      id: published.id,
      title: "Numbers",
      version: 1,
      url: `http://app.localhost:8787/a/${published.slug}`,
    });
    expect(shown.text).not.toContain("Private numbers");
    expect(shown.text).not.toContain("/__plinth/");
    const updated = await tool(client, "update_artifact", {
      id: published.id,
      html: PAGE.replace("Private", "New"),
      base_version: 1,
    });
    expect(updated.isError).toBe(false);
    const old = await tool(client, "show_artifact", { id: published.id, version: 1 });
    expect(old.data).toMatchObject({
      version: 1,
      url: `http://app.localhost:8787/a/${published.slug}/v/1`,
    });
    expect((await tool(client, "show_artifact", { id: published.id })).data.version).toBe(2);
    expect((await tool(client, "show_artifact", { id: published.id, version: 9 })).isError).toBe(
      true,
    );
  });

  it("refuses an agent that cannot view the artifact, without saying it exists", async () => {
    const { published } = await publishAndPreview();
    const stranger = await agent();
    const r = await tool(await mcpClient(stranger.token), "show_artifact", { id: published.id });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("not_found");
  });

  it("still answers with the link where previews are off (staging path fallback)", async () => {
    const a = await agent();
    const client = await mcpClient(a.token, {
      STAGING_CONTENT_FALLBACK: "true",
      CONTENT_ISOLATION: "opaque",
    });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "show_artifact")?._meta).toBeUndefined();
    const published = await tool(client, "publish_artifact", { title: "Numbers", html: PAGE });
    const shown = await tool(client, "show_artifact", { id: published.data.id });
    expect(shown.isError).toBe(false);
    expect(shown.data.title).toBe("Numbers");
  });
});

describe("the preview frame", () => {
  it("takes the instance's sandbox flags: no allow-same-origin under opaque isolation", async () => {
    const a = await agent();
    const read = async (vars?: Record<string, string>) => {
      const client = await mcpClient(a.token, vars);
      const r = await client.readResource({ uri: PREVIEW_RESOURCE_URI });
      return (r.contents[0] as unknown as { text: string }).text;
    };
    expect(await read()).toContain(JSON.stringify(ARTIFACT_IFRAME_SANDBOX));
    const opaque = await read({ CONTENT_ISOLATION: "opaque" });
    expect(opaque).toContain(JSON.stringify(ARTIFACT_IFRAME_SANDBOX_OPAQUE));
    expect(opaque).not.toContain("allow-same-origin");
  });
});

describe("preview_artifact", () => {
  it("gives the owner's agent a single-use link to the version, carrying no identity", async () => {
    const { published, link } = await publishAndPreview();
    expect(link.id).toBe(published.id);
    expect(link.version).toBe(1);
    expect(link.title).toBe("Numbers");
    expect(link.url).toBe(`http://app.localhost:8787/a/${published.slug}/v/1`);
    const u = new URL(link.preview_url);
    expect(u.origin).toBe(contentOrigin(published.id));
    expect(u.pathname).toBe("/__plinth/enter");
    expect(u.searchParams.get("next")).toBe("/__plinth/v/1/");

    const { res, setCookie, cookie } = await enterPreview(link.preview_url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/__plinth/v/1/");
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Partitioned/);
    expect(directives(res).has("frame-ancestors")).toBe(false);

    const page = await run(`${contentOrigin(published.id)}/__plinth/v/1/`, {
      headers: { cookie, "sec-fetch-dest": "iframe" },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Private numbers</h1>");
    const d = directives(page);
    expect(d.has("frame-ancestors")).toBe(false);
    // Everything else in the CSP stays: a preview is still an artifact response.
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(page.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("is single-use, and its refusals may show inside the host's frame", async () => {
    const { link } = await publishAndPreview();
    expect((await enterPreview(link.preview_url)).res.status).toBe(302);
    const again = await enterPreview(link.preview_url);
    expect(again.res.status).toBe(403);
    expect(again.setCookie).toBe("");
    expect(directives(again.res).has("frame-ancestors")).toBe(false);
  });

  it("keeps the app-only framing for every other pass", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: PAGE });
    const { cookie } = await enterContent(p.slug);
    const page = await run(`${contentOrigin(p.id)}/`, {
      headers: { cookie: cookie as string, "sec-fetch-dest": "iframe" },
    });
    expect(page.status).toBe(200);
    expect(directives(page).get("frame-ancestors")).toEqual([
      "'self'",
      "http://app.localhost:8787",
    ]);
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // No pass at all: still the app's framing.
    const none = await run(`${contentOrigin(p.id)}/`, { headers: { "sec-fetch-dest": "iframe" } });
    expect(none.status).toBe(401);
    expect(directives(none).get("frame-ancestors")).toEqual([
      "'self'",
      "http://app.localhost:8787",
    ]);
  });

  it("refuses an agent that cannot view the artifact, without saying it exists", async () => {
    const { published } = await publishAndPreview();
    const stranger = await agent();
    const r = await tool(await mcpClient(stranger.token), "preview_artifact", {
      id: published.id,
    });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("not_found");
  });

  it("needs the artifacts:read scope", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { html: PAGE });
    const mentionsOnly = await agent({ scopes: "mentions" });
    const r = await tool(await mcpClient(mentionsOnly.token), "preview_artifact", { id: p.id });
    expect(r.isError).toBe(true);
  });

  it("pins the version it was asked for", async () => {
    const { client, published } = await publishAndPreview();
    const updated = await tool(client, "update_artifact", {
      id: published.id,
      html: "<!doctype html><title>Numbers</title><h1>Version two</h1>",
      base_version: 1,
    });
    expect(updated.data.version).toBe(2);
    const old = await tool(client, "preview_artifact", { id: published.id, version: 1 });
    expect(new URL(old.data.preview_url).searchParams.get("next")).toBe("/__plinth/v/1/");
    const { cookie } = await enterPreview(old.data.preview_url);
    const page = await run(`${contentOrigin(published.id)}/__plinth/v/1/`, {
      headers: { cookie, "sec-fetch-dest": "iframe" },
    });
    expect(await page.text()).toContain("Private numbers");
    // The pass opens version 1 only: not version 2, and not the current path.
    for (const path of ["/__plinth/v/2/", "/", "/index.html"]) {
      const other = await run(`${contentOrigin(published.id)}${path}`, {
        headers: { cookie, "sec-fetch-dest": "iframe" },
      });
      expect(other.status).toBe(404);
    }
    const missing = await tool(client, "preview_artifact", { id: published.id, version: 9 });
    expect(missing.isError).toBe(true);
  });

  it("stops working when access changes", async () => {
    const { published, link } = await publishAndPreview();
    const { cookie } = await enterPreview(link.preview_url);
    await env.DB.prepare("UPDATE artifacts SET access_epoch = access_epoch + 1 WHERE id = ?1")
      .bind(published.id)
      .run();
    const page = await run(`${contentOrigin(published.id)}/__plinth/v/1/`, {
      headers: { cookie, "sec-fetch-dest": "iframe" },
    });
    expect(page.status).toBe(401);
  });

  it("is unavailable where artifacts would be served from the app's own origin", async () => {
    const a = await agent();
    const vars = { STAGING_CONTENT_FALLBACK: "true", CONTENT_ISOLATION: "opaque" };
    const client = await mcpClient(a.token, vars);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "publish_artifact")?._meta).toBeUndefined();
    const published = await tool(client, "publish_artifact", { title: "Numbers", html: PAGE });
    const r = await tool(client, "preview_artifact", { id: published.data.id });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("feature_disabled");
  });
});

describe("the preview pass", () => {
  it("never carries an identity, and is never a capture", async () => {
    const c = config();
    const artifact = { id: "aaaaaaaaaaaaaaaaaaaa", accessEpoch: 1 };
    await expect(
      issueEnterUrl(
        c,
        artifact,
        "/",
        { email: "ada@example.org", role: "owner" },
        { previewVersion: 1 },
      ),
    ).rejects.toThrow();
    await expect(
      issueEnterUrl(c, artifact, "/", undefined, { previewVersion: 1, capture: true }),
    ).rejects.toThrow();
    await expect(signContentCookie(c, artifact.id, 1, "sealed", "preview", 1)).rejects.toThrow();
    // A preview always names its one version, and nothing else does.
    await expect(signContentCookie(c, artifact.id, 1, undefined, "preview")).rejects.toThrow();
    await expect(signContentCookie(c, artifact.id, 1, undefined, "view", 1)).rejects.toThrow();
    await expect(
      issueEnterUrl(c, artifact, "/", undefined, { previewVersion: 0 }),
    ).rejects.toThrow();
  });

  it("cannot read or write shared data", async () => {
    const { published, link } = await publishAndPreview(POLL);
    const { cookie } = await enterPreview(link.preview_url);
    const headers = {
      "x-plinth-data": "1",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      cookie,
    };
    const session = await run(`${contentOrigin(published.id)}/__plinth/api/v1/session`, {
      headers,
    });
    expect(session.status).toBe(200);
    expect(await json(session)).toMatchObject({ available: false, reason: "preview" });
    const write = await run(`${contentOrigin(published.id)}/__plinth/api/v1/data/votes/a1`, {
      method: "PUT",
      headers: {
        ...headers,
        origin: contentOrigin(published.id),
        "content-type": "application/json",
      },
      body: JSON.stringify({ data: { choice: "a" } }),
    });
    expect(write.status).toBeGreaterThanOrEqual(400);
    expect(await write.text()).toContain("preview");
  });

  it("lets a previewed doc load its renderer, and keeps artifact files behind the cookie", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const doc = await tool(client, "publish_artifact", {
      title: "Notes",
      type: "doc",
      content: "# Notes\n\nSecret plan.",
    });
    const link = await tool(client, "preview_artifact", { id: doc.data.id });
    const { cookie } = await enterPreview(link.data.preview_url);
    const shell = await run(`${contentOrigin(doc.data.id)}/__plinth/v/1/`, {
      headers: { cookie, "sec-fetch-dest": "iframe" },
    });
    expect(shell.status).toBe(200);
    expect(directives(shell).has("frame-ancestors")).toBe(false);
    for (const file of ["doc.js", "doc.css"]) {
      const res = await run(`${contentOrigin(doc.data.id)}/__plinth/types/doc/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    }
    const runtime = await run(`${contentOrigin(doc.data.id)}/__plinth/runtime.js`);
    expect(runtime.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    // The Markdown itself is the artifact's: no cookie, no file.
    const md = await run(`${contentOrigin(doc.data.id)}/__plinth/v/1/content.md`, {
      headers: { "sec-fetch-dest": "empty" },
    });
    expect(md.status).not.toBe(200);
  });

  it("does not combine with another pass for the same artifact", async () => {
    const { a, published, link } = await publishAndPreview();
    const { cookie: preview } = await enterPreview(link.preview_url);
    // The owner's own app view of the same artifact, in the same cookie jar.
    const gate = await json(
      await call(`/api/v1/view/${published.id}`, { headers: a.auth as Record<string, string> }),
    );
    expect(gate.status).toBe("ok");
    const { cookie: view } = await enterPreview(gate.enter_url);
    const both = await run(`${contentOrigin(published.id)}/__plinth/v/1/`, {
      headers: { cookie: `${preview}; ${view}`, "sec-fetch-dest": "iframe" },
    });
    expect(both.status).toBe(401);
  });
});
