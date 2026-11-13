// OAuth 2.1 authorization server for /mcp (workstream: OAuth). Discovery metadata, dynamic client
// registration, authorize (PKCE S256) with a consent screen, token and revoke endpoints.
import { Hono } from "hono";
import type { AppEnv } from "../api/context.ts";

export const oauthRoutes = new Hono<AppEnv>();

/** RFC 9728 protected resource metadata for /mcp. */
oauthRoutes.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  protectedResource(c.get("config").appOrigin),
);
oauthRoutes.get("/.well-known/oauth-protected-resource", (c) =>
  protectedResource(c.get("config").appOrigin),
);

function protectedResource(origin: string): Response {
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["artifacts:read", "artifacts:write", "mentions"],
    bearer_methods_supported: ["header"],
    resource_name: "Plinth MCP",
  });
}

export function mcpResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}
