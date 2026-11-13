// Route map by host. The Worker routes by hostname; nothing outside this map is served.
//
// APP_HOST (people, agents, API):
//   GET  /healthz                                   health check
//   *    /mcp                                       MCP (streamable HTTP), bearer token
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /oauth/register                            RFC 7591 dynamic client registration
//   GET  /oauth/authorize                           validates, then shows the SPA consent page
//   POST /oauth/token                               authorization_code (PKCE S256) and refresh_token
//   POST /oauth/revoke                              RFC 7009
//   *    /api/v1/...                                REST (see API below). Bearer token or session+CSRF
//   GET  /openapi.json                              OpenAPI document for /api/v1
//   GET  everything else                            SPA (static assets, index.html fallback)
//
// <artifact_id>.CONTENT_HOST (user HTML only, never app pages, never app cookies):
//   GET /__plinth/enter?t=<viewer token>&next=<path>  one-time token -> host-only cookie -> redirect
//   GET /__plinth/bridge.js                         comment-anchoring bridge (review mode only)
//   GET /__plinth/preview                           editor preview loader (HTML arrives by postMessage)
//   GET /__plinth/v/<n>/<path>                      file from version n
//   GET /<path>                                     file from the current version (index.html default)
// CONTENT_HOST itself (no artifact subdomain): 404.
// Path fallback (STAGING_CONTENT_FALLBACK=1, refused in production): APP_HOST/__content/<id>/<path>.

export const API_PREFIX = "/api/v1";

/** REST paths relative to API_PREFIX. `:ref` is an artifact id or slug. */
export const API = {
  config: "/config",
  me: "/me",
  // auth (people)
  loginRequest: "/auth/login",
  loginVerifyCode: "/auth/verify-code",
  loginVerifyLink: "/auth/verify-link",
  logout: "/auth/logout",
  /** Development only (ENVIRONMENT=development and DEV_OUTBOX=true): emails the console sent. */
  devOutbox: "/__dev/outbox",
  // tokens and connections
  connections: "/connections",
  connection: "/connections/:id",
  oauthRequest: "/oauth/requests/:id",
  oauthConsent: "/oauth/consent",
  // artifacts (mirror the MCP tools)
  artifacts: "/artifacts", // GET list_artifacts, POST publish_artifact
  artifact: "/artifacts/:ref", // GET get_artifact, PUT update_artifact, PATCH rename, DELETE delete
  versions: "/artifacts/:ref/versions", // GET list_versions
  version: "/artifacts/:ref/versions/:n", // GET get_artifact with version
  restore: "/artifacts/:ref/versions/:n/restore", // POST restore_version
  visibility: "/artifacts/:ref/visibility", // PUT set_visibility
  sharing: "/artifacts/:ref/sharing", // GET settings, PUT grants
  // viewing (gate, then a one-time token for the content host)
  view: "/view/:ref", // GET ViewGate, ?version=n&review=1&preview=1
  viewPassword: "/view/:ref/password",
  viewEmail: "/view/:ref/email",
  viewCode: "/view/:ref/code",
  // comments and mentions
  comments: "/artifacts/:ref/comments",
  comment: "/comments/:id",
  mentions: "/mentions", // GET list_mentions
  claimMention: "/mentions/:id/claim", // POST claim_mention
  replyComment: "/comments/:id/reply", // POST reply_comment
  // reports and admin
  report: "/artifacts/:ref/report",
  adminReports: "/admin/reports",
  adminReport: "/admin/reports/:id",
} as const;

/** SPA routes on APP_HOST. */
export const APP_ROUTES = {
  home: "/",
  login: "/login",
  magic: "/login/magic",
  dashboard: "/dashboard",
  connections: "/connections",
  consent: "/oauth/consent",
  artifact: "/a/:slug",
  artifactVersion: "/a/:slug/v/:n",
  history: "/a/:slug/history",
  compare: "/a/:slug/compare",
  editor: "/a/:slug/edit",
  settings: "/a/:slug/settings",
  open: "/open/:id",
  report: "/a/:slug/report",
  adminReports: "/admin/reports",
  design: "/design",
  terms: "/legal/terms",
  privacy: "/legal/privacy",
  acceptableUse: "/legal/acceptable-use",
} as const;

/** Fill `:params` in a route pattern. */
export function route(pattern: string, params: Record<string, string | number>): string {
  return pattern.replace(/:([a-z_]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing route param ${k}`);
    return encodeURIComponent(String(v));
  });
}
