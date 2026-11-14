# Agent discovery: what an agent learns from a Plinth link

Date: 2026-11-14. Status: approved (approach A).

## Intent

People hand agents Plinth links (`https://<app-host>/a/<slug>`). An agent that fetches one gets
the app's empty single-page shell (`<title>Plinth</title>` and `<div id="root"></div>`) and learns
nothing: not what Plinth is, not that it has an MCP server, not how to read the artifact, not where
the code and the plugin live. Well-known agent paths (`/llms.txt`, `/robots.txt`, `/AGENTS.md`,
`/.well-known/mcp.json`) fall through to the same shell with status 200, which looks like content
and is not.

## Goals

1. **The shell explains itself.** Every app page carries a short plain-text note for agents inside
   `<div id="root">`, which React replaces on mount. On `/a/<slug>` (and the other `/a/...` pages
   and `/open/<id>`) the note says this is a Plinth artifact and how to read it: the MCP endpoint,
   OAuth discovery, `get_artifact` with that id, `/llms.txt`, the docs, the plugin and the repo.
2. **Link viewers' artifacts are readable without MCP.** When an anonymous viewer could open the
   artifact (unlisted, or public on an instance that allows public visibility), the note adds the
   title (marked as untrusted text), the current version and a link to `/a/<slug>/source`, which
   returns the main HTML document as `text/plain`.
3. **Nothing leaks.** Access is decided by `policy.ts` for an anonymous principal, never from the
   request's cookies. Private, password, missing, deleted and taken-down artifacts get the same
   generic note, byte for byte, so the page is not an existence oracle.
4. **Real files at agent paths.** `/llms.txt`, `/robots.txt` and an MCP Server Card are real
   responses built from config. Unknown `/.well-known/*` paths and other file-like paths that are
   not assets return 404 instead of the shell.

## Non-goals

- Server-side rendering of the artifact on the app host. User HTML never runs there; the source
  endpoint is plain text that browsers do not execute.
- Reading private or password artifacts without signing in. Those stay MCP (or the API) only,
  with the access of the signed-in user.
- Listing tools, resources or prompts in the server card (the card format leaves them out on
  purpose: they depend on who is signed in).

## Approaches considered

- **A. A static agent note in the shell, plus plain-text source and discovery files (chosen).**
  Works with every fetcher, because it is in the HTML an agent already receives.
- **B. Content negotiation (`Accept: text/markdown` gets a Markdown description).** Rejected: most
  agent fetchers send `Accept: text/html` like a browser, so the HTML page has to carry the note
  anyway, and a second representation of the same URL would only add a code path to keep in step.
- **C. Let non-browser clients fetch the content host without the enter token.** Rejected: it
  loosens content isolation (the content host would decide access by guessing what the client is),
  and the security rules keep access checks on the app host with a short-lived signed token.

## Notable calls

- **Hiding the note.** A `<style>` element in the head hides `.plinth-agent-note` before first
  paint; no JavaScript is involved and nothing flashes. The note avoids the `hidden` attribute,
  inline `display:none` and `aria-hidden`, which text extractors such as Readability treat as "not
  content" and drop. React's `createRoot` clears the container on its first commit.
- **Anonymous only.** The shell never resolves the session cookie, even for the owner. A signed-in
  owner's browser gets the same note as a stranger; the app itself then shows them everything.
- **Robots.** `/a/...` shells send `X-Robots-Tag: noindex, nofollow` and a matching meta tag,
  except `/a/<slug>` and `/a/<slug>/v/<n>` of a public artifact on an instance with public
  visibility on, mirroring the content host. `robots.txt` still disallows `/a/` for crawlers, which
  is the conservative choice for unlisted links.
- **`/a/<slug>/source` lives outside `/api/v1`.** It is a plain-text alternate of an app page
  (linked with `rel="alternate"`), it must ignore cookies (the API resolves them), and it is not
  JSON. So it is not in the OpenAPI document. It is rate-limited per IP, sends `no-store` (a
  visibility change takes effect on the next request), `nosniff`, `Content-Security-Policy:
  sandbox; default-src 'none'` and `noindex`.
- **Server card path.** The current MCP Server Card extension (SEP-2127, specified in
  `modelcontextprotocol/experimental-ext-server-card`) reserves `<streamable-http-url>/server-card`
  and puts domain-level discovery in an AI Catalog at `/.well-known/ai-catalog.json`. Plinth serves
  the card at `/mcp/server-card`, lists it in the catalog, and also answers `/.well-known/mcp.json`
  and `/.well-known/mcp/server-card.json` (paths used by earlier drafts and existing scanners) with
  the same document. OAuth is not part of the card schema, so the protected-resource metadata URL
  goes under a namespaced `_meta` key.
- **Tool list without drift.** `llms.txt` lists the MCP tools from a summary table in
  `mcp/server.ts` that the tool registration is typed against, and a test compares it with the live
  `tools/list`.
- **`rel="help"`** points at `/llms.txt`. There is no registered link relation for llms.txt;
  `help` is a registered HTML link type for exactly this kind of page.
