// Smoke test: the Worker is up, both hosts answer with their own security headers, and the
// agent entry points (REST with a token, MCP) work end to end.
import { expect, test } from "@playwright/test";
import {
  APP_ORIGIN,
  apiGet,
  CONTENT_HOST,
  contentOrigin,
  publishArtifact,
  uniqueEmail,
} from "../support/api.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

test("GET /healthz reports ok in development", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, environment: "development" });
});

test("the SPA shell loads on / with the app CSP", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain(`frame-src http://*.${CONTENT_HOST}`);
  expect(res?.headers()["x-frame-options"]).toBe("DENY");
  await expect(page).toHaveTitle(/Plinth/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
});

test("GET /api/v1/config sets the CSRF cookie", async ({ request }) => {
  const res = await apiGet(request, "/config");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ app_origin: APP_ORIGIN, environment: "development" });
  const cookies = (await request.storageState()).cookies;
  expect(cookies.find((c) => c.name === "plinth_csrf")?.domain).toBe("app.localhost");
});

test("a content subdomain without a cookie redirects to the app gate", async ({ request }) => {
  const { token } = await seedToken(uniqueEmail("smoke"));
  const published = await publishArtifact(request, token, { title: "Smoke" });
  expect(published.content_url).toBe(`${contentOrigin(published.id)}/`);

  const res = await request.get(published.content_url, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe(`${APP_ORIGIN}/open/${published.id}?next=%2F`);
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(res.headers()["set-cookie"]).toBeUndefined();
});

test("/mcp without a token is 401 with resource metadata", async ({ request }) => {
  const res = await request.post("/mcp", {
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toContain(
    `resource_metadata="${APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  );
});

test("an agent publishes and reads back over MCP with a personal access token", async () => {
  const { token } = await seedToken(uniqueEmail("mcp"), { clientType: "claude" });
  const client = await mcpClient(token);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["publish_artifact", "update_artifact", "list_mentions"]),
    );
    const published = await tool<{ id: string; version: number }>(client, "publish_artifact", {
      title: "From MCP",
      html: "<!doctype html><p>mcp</p>",
    });
    expect(published.isError).toBe(false);
    expect(published.data.version).toBe(1);
    const got = await tool<{ html: string }>(client, "get_artifact", { id: published.data.id });
    expect(got.data.html).toContain("<p>mcp</p>");
  } finally {
    await client.close();
  }
});
