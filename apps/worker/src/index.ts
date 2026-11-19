// Cloudflare Worker entry: routes by hostname to the app host or an artifact's content host.
import { Hono, type MiddlewareHandler } from "hono";
import { type AppEnv, authenticate, base, serviceCtx } from "./api/context.ts";
import { api } from "./api/index.ts";
import { openApiDocument } from "./api/openapi.ts";
import { devSeed } from "./app/dev-seed.ts";
import {
  aiCatalog,
  discoveryJson,
  llmsTxt,
  publicHeaders,
  robotsTxt,
  serveOgImage,
  serverCard,
  serveSource,
} from "./app/discovery.ts";
import { applyAppHeaders } from "./app/headers.ts";
import { notFoundText, serveSpa } from "./app/spa.ts";
import { type Bindings, ConfigError, getConfig } from "./config.ts";
import { contentRoot, resolveHost, serveContent } from "./content/serve.ts";
import { ApiError } from "./lib/errors.ts";
import { handleMcp } from "./mcp/server.ts";
import { mcpResourceMetadataUrl, oauthRoutes } from "./oauth/routes.ts";
import { pruneUploadTickets, sweepStagingAttempts } from "./services/attempts.ts";
import { liveRetentionDays, pruneLiveDrafts } from "./services/live.ts";
import { foldOpens, viewRetentionDays } from "./services/views.ts";

// The live-room Durable Object class (binding ROOMS, wrangler.jsonc); see src/rooms/.
export { ArtifactRoom } from "./rooms/ArtifactRoom.ts";

export const app = new Hono<AppEnv>();

/** /mcp takes bearer tokens only (no cookies, so no CSRF surface). */
const bearerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.req.header("authorization")) {
    throw new ApiError("unauthorized", "MCP needs a bearer token (OAuth or personal access token)");
  }
  await next();
};

app.onError((err, c) => {
  if (err instanceof ApiError) {
    const res = c.json(err.toBody(), err.status as 400);
    if (err.code === "unauthorized" && c.req.path === "/mcp") {
      res.headers.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${mcpResourceMetadataUrl(c.get("config").appOrigin)}"`,
      );
    }
    if (err.code === "rate_limited") {
      const d = err.details as { retry_after?: number } | undefined;
      if (d?.retry_after) res.headers.set("Retry-After", String(d.retry_after));
    }
    return res;
  }
  console.error("unhandled error", err);
  return c.json(new ApiError("internal", "Internal error").toBody(), 500);
});

app.use("*", base);

app.get("/healthz", (c) => c.json({ ok: true, environment: c.get("config").environment }));

app.route("/", oauthRoutes);
app.route("/", devSeed);
app.route("/api/v1", api);

app.get("/openapi.json", (c) => c.json(openApiDocument(c.get("config"))));

// Agent discovery (docs/agents.md#agent-discovery). Public, read-only, no cookies read.
app.get("/llms.txt", (c) => {
  const config = c.get("config");
  return new Response(llmsTxt(config), {
    headers: publicHeaders(config, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    }),
  });
});
app.get("/robots.txt", (c) => {
  const config = c.get("config");
  return new Response(robotsTxt(config), {
    headers: publicHeaders(config, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    }),
  });
});
// The MCP Server Card at its reserved path, and the same card where earlier drafts put it.
for (const path of [
  "/mcp/server-card",
  "/.well-known/mcp.json",
  "/.well-known/mcp/server-card.json",
]) {
  app.get(path, (c) =>
    discoveryJson(c, serverCard(c.get("config")), "application/mcp-server-card+json"),
  );
}
app.get("/.well-known/ai-catalog.json", (c) =>
  discoveryJson(c, aiCatalog(c.get("config")), "application/ai-catalog+json"),
);
// OpenAI's plugin portal checks that this MCP server's domain is the submitter's: the token alone,
// as plain text. Only where the operator set it (OPENAI_APPS_CHALLENGE); 404 everywhere else.
app.get("/.well-known/openai-apps-challenge", (c) => {
  const token = c.get("config").openaiAppsChallenge;
  if (!token) return notFoundText(c);
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  applyAppHeaders(c.get("config"), headers);
  return new Response(token, { status: 200, headers });
});
for (const path of [
  "/mcp/server-card",
  "/.well-known/mcp.json",
  "/.well-known/mcp/server-card.json",
  "/.well-known/ai-catalog.json",
  "/llms.txt",
]) {
  app.options(path, (c) => {
    const headers = publicHeaders(c.get("config"), {
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
      "Access-Control-Max-Age": "86400",
    });
    return new Response(null, { status: 204, headers });
  });
}
// An artifact's main HTML as plain text, for link viewers' artifacts only. Never HTML here.
app.get("/a/:ref/source", (c) => serveSource(c));
app.get("/a/:ref/og.jpg", (c) => serveOgImage(c));

app.all("/mcp", bearerOnly, authenticate, async (c) => {
  const p = c.get("principal");
  if (p.kind !== "agent")
    throw new ApiError("unauthorized", "MCP needs a bearer token (OAuth or personal access token)");
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  return handleMcp(c.req.raw, serviceCtx(c), {
    token,
    clientId: p.connectionId ?? "admin",
    scopes: [...p.scopes],
  });
});

app.on(["GET", "HEAD"], "*", (c) => serveSpa(c));

app.all("*", (c) => c.json(new ApiError("not_found", "Not found").toBody(), 404));

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    let config: ReturnType<typeof getConfig>;
    try {
      config = getConfig(env as unknown as Record<string, unknown>);
    } catch (e) {
      // Refuse to run with an unsafe or incomplete configuration. Messages name variables only.
      const message = e instanceof ConfigError ? e.message : "Invalid configuration";
      console.error(`configuration error: ${message}`);
      return new Response(`Plinth is not configured correctly: ${message}\n`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const url = new URL(request.url);
    const route = resolveHost(config, url);
    switch (route.kind) {
      case "app": {
        const res = await app.fetch(request, env, ctx);
        if (!res.headers.has("Content-Security-Policy") && !url.pathname.startsWith("/mcp")) {
          const out = new Response(res.body, res);
          applyAppHeaders(config, out.headers);
          return out;
        }
        return res;
      }
      case "content":
        return serveContent(request, env, config, route, (p) => ctx.waitUntil(p));
      case "content-root":
        return contentRoot(config);
      default:
        return new Response("Unknown host\n", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
    }
  },

  /**
   * The hourly cron trigger (wrangler.jsonc `triggers`): remove what abandoned upload attempts
   * left, upload tickets past their status window (services/attempts.ts), and live doc drafts
   * nobody touched for LIVE_DRAFT_RETENTION_DAYS (services/live.ts). At 03 UTC, also fold opens
   * older than VIEW_LOG_RETENTION_DAYS into per-artifact counts and delete them (services/views.ts),
   * whether or not counting is on. Needs only the D1 and R2 bindings, not the host configuration.
   */
  async scheduled(
    controller: ScheduledController,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await sweepStagingAttempts(env, controller.scheduledTime);
    await pruneUploadTickets(env.DB, controller.scheduledTime);
    const keepDays = viewRetentionDays(env);
    if (new Date(controller.scheduledTime).getUTCHours() === 3 && keepDays !== null)
      await foldOpens(env.DB, keepDays, controller.scheduledTime);
    await pruneLiveDrafts(env.DB, liveRetentionDays(env), controller.scheduledTime);
  },
} satisfies ExportedHandler<Bindings>;
