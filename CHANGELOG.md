# Changelog

Notable changes to Plinth, newest first. Version numbers follow the npm CLI
([`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth)) and the Docker image
(`ghcr.io/mr0b0t0/plinth`), which ship the same Worker. The hosted instance at
[plinth.aconite.io](https://plinth.aconite.io) runs `main`.

Add a line under **Unreleased** in the pull request that makes a change people will notice.
`pnpm release <version>` turns that section into the release notes ([docs/releasing.md](docs/releasing.md)).

## Unreleased

- **Dashboard previews in the list, and one card height.** Each row of the list view starts with a
  small preview of the page, its thumbnail, in place of the page glyph (the glyph stays until a
  thumbnail exists). A card shows its category as plain text on its info line instead of a chip on
  a line of its own, so every card in the grid has the same height; a long name ends in "…" and
  shows in full on hover. On phones the category moves from beside the title to a row's second
  line, and on a card it takes the place of "You".
- **Who is viewing: names and the people list.** Set your name from the account menu ("Your
  name…") and the sidebar shows it; pages that show who is viewing now show it beside your email,
  on `plinth.viewer`, on the entries you write and in live rooms. A page that declares `data viewer people` lets its
  owner and editors list everyone it is shared with (`plinth.people.list()`, with search), and the
  line under the bar tells every invited viewer. On such a page their agents get the same list in
  `list_artifact_data` and `GET /api/v1/artifacts/:ref/people`; agents see authors' names on any
  page. The list and the owner's sharing settings name a person once they have commented, entered
  something or published a version there, so adding an address never reveals whether it has an
  account. Names are display text: no `@`, no invisible characters, never a role. Plugin 0.22.0.
- **Download a deck as .pptx.** **Download .pptx** in a deck's menu saves it as an editable
  PowerPoint file (Keynote and Google Slides open it too): one slide per slide with its text,
  lists, tables, images, links, footer, slide numbers and speaker notes, in the colours on screen.
  The file is built in the viewer's browser from the slides as shown; nothing goes to the server.
  On instances with opaque content isolation the file leaves out the deck's image files, and says
  so. Plugin 0.23.0.
- **Designs.** Agents can publish visual designs at fixed sizes (`type: "design"`): app screens,
  posters, social posts, ads and banners as artboards in one HTML file, each starting with a line
  `<!-- artboard name="Home" size="iphone" -->`, with presets for phones, desktops, social posts,
  IAB ads, print and slides. Plinth lays the boards out on a canvas you pan and zoom, in rows
  packed to fill the screen (Fit, 100%, a board's name zooms to it), renders each one alone at its
  exact size in its own frame with an opaque origin, so its scripts, styles and images run without
  reaching the page or each other, lets you interact with one board, pins comments to boards, and
  prints or saves the design as PDF one board per page. People see the design, never its source:
  agents change it, and History compares its versions as rendered pages. The Plinth CLI publishes
  a folder with `design.html` at its top as a design. Thumbnails show each board
  with its own images and styles. Update the plugin for the agent's design rules. Plugin 0.24.0.
- **Sheets.** Agents can publish a table people sort, filter, calculate with or download (`type:
  "sheet"`): JSON lines with typed columns (text, number with currency or percent formats, date,
  checkbox, select, link) and Excel formulas (SUM, IF, VLOOKUP, XLOOKUP and 67 more) that Plinth
  computes itself. The page has a frozen header, sort, a filter, a formula bar, print, light and
  dark, and phone width, and anyone who can view it downloads it as CSV or Excel (.xlsx) built in
  the browser. Agents read computed values with `read_sheet` and change cells, rows and columns
  with `edit_sheet`, one version per call. A CSV or .xlsx file can be published as a sheet
  (`content_format` or `plinth publish data.csv`).
  `SHEET_EVAL_BUDGET` sets how much formula work one `read_sheet` may do. Plugin 0.25.0.
- **Open pages follow new versions at once.** An artifact page that is open picks up a version an
  agent or editor publishes within seconds, without waiting for its 15 s check (one "Updated to
  vN" notice at a time, however many versions arrive in a row), and pages that keep
  shared data (`onSnapshot`) see other people's changes within about a second. The app holds one
  WebSocket on its own host that carries only version numbers and "data changed" signals; nothing
  about the page or its data travels over it. On by default wherever the `ROOMS` binding is
  configured (also under opaque isolation, for versions); `ALLOW_LIVE_VIEWS=false` turns it off and
  pages poll as before. `LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT` (1000) caps the open views that get
  pushes, half for the people an artifact is shared with and half for everyone else, so a link
  viewer can never tell from the socket whether the owner or a collaborator has the page open. A
  reverse proxy must pass WebSocket upgrades on the app host too. Plugin 0.27.0: the agent's rule
  never to tell people to reload.
- **Your own categories for artifacts shared with you, and sharing a whole category.** On the
  dashboard, "Move to category…" now files an artifact someone shared with you under a category of
  your own, which only you see; the Category menu covers yours under Shared (#42). Owners can share
  one of their categories with people (viewer or commenter) under a name they choose: the people
  get one page, `/p/<id>`, listing the artifacts the owner ticked, and confirm their email there
  once. Filing an artifact under a shared category never shares it: it waits for the owner's review
  (one "to review" line on the dashboard), and the owner's agent is told so
  (`category_share.state: "pending"` with a review link). Un-ticking an artifact takes it away from
  the category's people even when a new version was published while the dialog was open, and a
  taken-down artifact never waits for review. On by default; `ALLOW_CATEGORY_SHARING` turns it
  off. A token limited to one artifact never sees or manages category sharing: it holds no role
  through a category grant, and the share, portal and personal-category routes answer it 403
  `token_bound`. Migration `0013_category_sharing.sql`. Plugin 0.28.0.
- **People you share with get an account.** Confirming the emailed code at an artifact's gate or
  a shared collection now signs the person in to Plinth with that address, creating their account
  the first time, as the owner's own code already did. What is shared with them then shows under
  Shared on their dashboard, they can come back without a new code, and an editor can edit a doc
  on its page. The gate, the email and the privacy notice say so, and the gate and the shared
  collection tell someone already signed in that confirming another address switches them to it.
  The code's email is now a sign-in email ("Your Plinth sign-in code"), warning never to give the
  code to anyone before it shows the title the sharer wrote (on one line, so a title cannot add
  lines of its own), and wrong guesses at it count against the same per-address limit as the
  sign-in code. On a single-user instance, where only the admin may sign in, the code still starts
  a viewer session without an account, and viewer sessions started earlier keep working until
  they expire. Plugin 0.29.0.

## 0.6.0 (2026-11-20)

- **Thumbnails picture the version they are of.** The capture of a version is served that
  version on every path, so a page that loads `/assets/index.js`, frames `/chart.html` or
  redirects to `/docs/` shows its own files, not the current version's, and an older version's
  thumbnail never runs a newer version's code. The thumbnail browser also no longer opens another
  version or a Plinth helper path as a page.
- **Publish from CI.** A GitHub Action, `mr0b0t0/plinth/publish@v0.6.0`, publishes a build folder
  or one HTML or Markdown file as the next version of an artifact on every run, with the commit in
  the version note and the links in the job summary. A token can now be limited to one artifact
  (**Limit to one artifact** in the New token dialog): it reads that artifact and publishes new versions
  of it, nothing else (not even the owner's or other people's email addresses, nor an enter URL
  or a thumbnail, which would show the page's shared data), and deleting the
  artifact revokes it. Thumbnails of the versions such a token publishes are taken without the
  page's shared data, and the thumbnail browser now aborts anything a page loads or opens off its
  own artifact and the CDN allowlist. `plinth publish` takes a single
  `.html` or `.md` file, uses a token's artifact when `--id` is left out, and with `--json` prints
  a JSON object on failure and for `--dry-run` too, and prints `live_draft` as a note that needs no
  action. GitLab CI and cron: `docs/ci.md` (#51). **Deploying:** release v0.6.0 first, right
  after merging (`pnpm release 0.6.0 --push`), then apply migration `0012_bound_tokens.sql` and
  deploy. The New token dialog, the README and `docs/ci.md` pin `mr0b0t0/plinth/publish@v0.6.0`
  and `@mr0b0t0/plinth@0.6.0`, which exist only once that release is out. Plugin 0.21.0.
- **Comments from the page.** A page that declares `comments` can open the comment composer on a
  spot of its own (a point on a canvas, a slide, a node in a diagram) with `plinth.comments`, draw
  its own markers for the threads and tell Plinth where to put its pins. The person still writes
  and posts every comment, and the page never sees comment text. Opening comments on such a page no
  longer reloads it. Agents see these anchors as `kind: "page"` in `list_comments` and mention
  tasks. Example: `docs/examples/canvas-comments.html`. Plugin 0.20.0. A declaring page connects as
  soon as it loads, so its pins show even before its code calls `plinth.comments`, and they follow
  the layout as images load or the page resizes. Whether the page anchors its own comments follows
  the version being viewed, so an older version without the declaration keeps "Pin to an element".
- **Comment pins stay on their spot when selected.** A selected or hovered pin was drawn a little
  off its anchor; it now grows in place.
- **Slides.** Agents can publish a presentation as Markdown (`type: "slides"`): a line `---`
  between slides, speaker notes after `Note:`, columns with `|||`. Plinth renders fixed 16:9 or 4:3
  slides with automatic layouts and text that shrinks to fit. Page through with the keyboard,
  clicks or swipes, link to a slide (`#slide=4`), see every slide in a thumbnail grid, and from
  Present in the bar go full screen or open a presenter view with the notes, the next slide and a
  timer (and an audience window that follows it with nothing but the slide). Print or save as PDF
  with or without the notes. Update the plugin for the agent's slides rules. The Plinth CLI
  publishes a folder with `slides.md` at its top as a deck (`plinth publish`, `plinth upload`).
  Plugin 0.19.0.
- **Design systems.** Publish tokens, guidelines and components as a design system (`type:
  "design_system"`, JSON in `system.json`): Plinth shows it as a reference site with color, type,
  spacing and shadow samples and live component previews in light and dark. Agents read one with
  the new `get_design_system` tool (or `GET /api/v1/artifacts/:ref/design-system`), copy its CSS
  into the pages they build, and get a `design_system_outdated` warning when a page was built on
  an older version. `list_artifacts` takes `type` to find them. The editor checks the JSON as you
  type. CSS blocks may not hold escapes or `url()`s to other hosts, and a `url()` to a file the
  design system lacks is a `missing_file` warning. Plugin 0.18.0.
- **Artifact stats: see who opened your artifacts.** Each artifact's Stats page (`/a/<slug>/stats`,
  linked from its menu and the Share dialog) shows opens and viewers over 7, 30, 90 or 365 days,
  the people who opened it (name and email for people signed in and allowlisted viewers, with the
  version they last saw), opens per version and an approximate count of anonymous visitors. Agents read the same with the `get_artifact_stats` MCP
  tool, `GET /api/v1/artifacts/:ref/stats` and `GET /api/v1/stats/artifacts` (owner only). This
  replaces the open counts in the Share dialog and `GET /api/v1/artifacts/:ref/views`, which is
  gone. Opens are kept with who made them for `VIEW_LOG_RETENTION_DAYS` (default 365), then only
  counted; `VIEW_COUNTS=off` still stops recording. Apply migration `0020_artifact_opens.sql`
  before deploying: it keeps the existing daily counts as opens with no viewer. Plugin 0.17.0.
- **A Cursor plugin.** `integrations/plugin-cursor` packages the Plinth server and skill in Cursor's
  plugin layout, for the Cursor Marketplace and cursor.directory.
- **A build for OpenAI's plugin directory.** `integrations/plugin-openai` is the folder to ZIP for
  ChatGPT and Codex: the portable manifest with its listing block, the hosted server, the icon and
  the skill, with no hooks and no Claude Code passages.
- **The plugin directory build connects to the hosted instance again.** Anthropic's plugin directory
  refused the 0.15.0 build because its server URL used the Plinth instance option, so the directory
  build has a fixed `https://plinth.aconite.io/mcp` server and no option. With that build, add a
  self-hosted instance as its own server, or install the full plugin from this repository's
  marketplace, which keeps the option. Plugin 0.16.0.
- **OpenAI domain verification.** Set `OPENAI_APPS_CHALLENGE` to the token OpenAI's plugin portal
  shows, and the instance serves it at `/.well-known/openai-apps-challenge`. Unset, the path stays
  404.
- **The Claude Code plugin remembers your instance.** It asks which Plinth instance to use when you
  enable it (the hosted one by default), keeps the answer, and its mention watcher follows it, so a
  self-hosted or local instance no longer needs `PLINTH_URL` exported every time Claude Code starts.
  From a terminal: `claude plugin install plinth@plinth --config instance_url=<origin>`; later,
  `/plugin configure plinth@plinth`. `PLINTH_URL` still works and wins. The Connect panel, `/llms.txt`
  and `plinth connect` print the right command for each instance. Plugin 0.15.0.
- **Review account sign-in.** An operator can give one ordinary account a password, for a
  directory's reviewers who cannot receive sign-in emails: set `REVIEW_LOGIN_EMAIL` and the secret
  `REVIEW_LOGIN_PASSWORD_HASH` (from `apps/worker/scripts/review-login-hash.mjs`). It signs in at
  `/login/review`, linked from the sign-in page, and locks after repeated wrong passwords. Off
  unless both are set; never an admin account ([security.md](docs/security.md#review-account-sign-in)).
- **Plinth shows up properly in Codex.** The plugin now carries Codex's listing block (name,
  short description, icon, starter prompts, links), so Codex and Codex plugin directories show it
  with its own icon and description. Plugin 0.13.0.
- **Live rooms.** Pages can show who is here and share moments live with `plinth.room`, and
  owners and editors can edit a doc together right on its page, saved as versions on Save or after
  a pause (#36).
- **MCP tool annotations.** Every tool now says whether it only reads, whether it can remove
  data, and whether repeating it is safe, so clients can ask before the right calls and directories
  (Anthropic's connector directory requires them) can list Plinth.
- **Admin stats and view counts.** Instance admins get a Stats page (people, artifacts,
  publishes, storage, shared data, agent connections, open reports and opens, with 7/30/90-day
  trends), and owners see how often other people opened a page in its Share dialog. Opens are
  kept as a daily number per page, never who opened it; `VIEW_COUNTS=off` turns counting off.
  Apply migration `0010_view_counts.sql` before deploying.
- **Artifact categories: agents file artifacts under the project they work in; owners filter,
  move and rename them.** Each artifact can carry one category, usually the repo or client it
  belongs to. Agents set it when they publish (`category` on `publish_artifact` and
  `start_upload`, `plinth publish --category`) and reuse the names `list_artifacts` returns; the
  server matches case, spaces, `-` and `_` onto your existing spelling. The dashboard filters by
  category, Settings moves an artifact, and the dashboard renames or merges a category. Only you
  see your categories, never the people you share with. Update the plugin (0.12.0) for the agent
  rules. Self-hosters: apply migration `0009_categories` before deploying
  ([deploy checklist](docs/deploy-checklist.md#6-upgrading-and-rolling-back)).
- **The plugin's Plinth server loads in Codex and GitHub Copilot CLI.** Plugin 0.10.0 put a field
  in its `mcp.json` server entry that the Agent Plugins schema doesn't allow, so Codex and Copilot
  CLI installed the skill but skipped the server (Copilot logs `field "extensions" is not
  permitted`). Plugin 0.11.0 drops it; both find Plinth's OAuth sign-in on their own. Update the
  plugin to get it. The mention watcher skill now says it works only in Claude Code.

## 0.5.0 (2026-11-16)

- **Previews in the agent's thread.** In apps that support MCP Apps (T3 Code with Claude or
  Codex, and others), the page an agent just published, updated or restored shows right under
  the call, with **Open on Plinth** next to it. The preview is read-only: it shows that one
  version as a signed-out viewer would, without shared data (pages see `reason: "preview"`).
  Where an app does not allow the page to be framed (claude.ai, for a custom connector), the
  preview says so and keeps **Open on Plinth**. Nothing to set up; other clients are unchanged.
  How it is isolated: [docs/security.md](docs/security.md#in-chat-previews).
- **Plinth is where pages go.** With the plugin installed, a page or document you want to keep,
  send or show someone now goes to Plinth even when you don't say "Plinth"; before, Claude Code's
  own artifacts won almost every time. In Claude Code the plugin adds a short note at session
  start (`PLINTH_SESSION_NOTE=0` turns it off); in Claude Code and Codex the skill's description
  says the same. A chart or mockup to look at in the conversation still stays in the built-in
  viewer.
- **T3 Code.** T3 Code gets its own tab in **Connect an agent** and in `plinth connect`. It runs
  your Claude Code and Codex with their own settings, so installing the Plinth plugin there
  covers T3 Code threads too.
- **Agent plugin 0.10.0** carries the last two (the skill, the session note, and the `preview`
  reason for shared data). Installed plugins update from the marketplace.
- **Connect an agent** keeps space between each client's steps and how it learns Plinth's rules.

## 0.4.2 (2026-11-16)

- **Owners at their own email gate.** On a private (allowlist) artifact, the owner's own address
  now gets a code too, and confirming it signs the owner in and opens the artifact. Before, the
  gate said a code was sent and sent nothing, because the owner is not on the artifact's list.
  The answer is still the same for every address, so the list cannot be probed.

## 0.4.1 (2026-11-15)

- **Thumbnails and link previews.** Each version gets a screenshot, taken by Cloudflare Browser
  Rendering after it is published. Dashboard cards show it in place of the initials, and links to
  artifacts anyone with the link can open now unfurl in Slack, iMessage, X and LinkedIn with their
  title and the screenshot. Private and password artifacts unfurl as a generic "Plinth artifact"
  card with no title or image. Older versions get their thumbnail the first time someone asks.
  Turn it on by adding `"browser": { "binding": "BROWSER" }` to your wrangler config; set
  `THUMBNAILS=false` to turn it off. Applies migration `0008_thumbnails.sql`.

## 0.4.0 (2026-11-15)

- **Big builds.** Agents can publish a built site, such as a Vite `dist/` folder with hundreds of
  files, in one step. The new MCP tool `start_upload` (and `POST /api/v1/uploads`) returns a
  single-use, 30-minute upload ticket. One `curl` of a gzipped tar to its `upload_url` publishes the
  folder or updates the artifact.
- **Smaller updates.** An asset can be sent as `{path, sha256}` to reuse a file from the current
  version, so an update sends and stores only what changed. `get_artifact` lists each asset's
  `sha256`, and the storage quota counts each stored file once.
- **Safe retries.** `GET /api/v1/uploads/:id` tells an agent whether an upload whose response was
  lost was published. A retry never creates a duplicate version or artifact.
- **CLI.** `plinth login`, `logout`, `whoami`, `publish <dir>` and `upload <dir>` publish a build
  folder from any machine, with no checkout or wrangler. `publish --id` sends only the files that
  changed and exits 3 on a conflict.
- **Publish warnings.** Publish results list `warnings`: missing files, root-absolute URLs, hosts
  outside the CDN allowlist and `http:` URLs.
- **Higher limits, now settings.** `MAX_VERSION_BYTES` defaults to 50 MB (from 25 MB) and
  `MAX_ASSETS_PER_VERSION` to 511 files (from 200). `GET /api/v1/config` returns the instance's
  limits and CDN allowlist.
- **Faster repeat views.** Artifact files get ETags and 304 responses, and files under versioned
  URLs are cached privately as immutable.
- **More reliable publishing.** Files are stored before the version is committed, so an
  interrupted publish no longer leaves a broken version. An hourly cleanup removes what
  interrupted uploads leave behind. Instances without cron (local, tunnel, Docker) clean up when
  the next upload starts.
- **Source link.** The banner under every artifact links to Plinth's source code. Set
  `SHOW_SOURCE_LINK=false` to remove the link.
- **CLI behaviour change.** `plinth publish --id --base-version N` now exits 0 only when the
  current version (N or N+1) already matches the folder. Any later version, even with the same
  files, exits 3 as a conflict.
- **Admin.** `sweep-orphans` requires `--older-than-minutes` of at least 45. `erase-artifact` also
  deletes the upload ticket that published the artifact.
- **Agent plugin 0.6.0.** The skill covers built sites, reuse by hash and instance limits. Claude
  Code install guidance lists the plugin first.

### Upgrading

- Apply migrations `0006_stored_bytes.sql` and `0007_upload_tickets.sql` before deploying the
  Worker. `plinth deploy` does this for you.
- **Storage is forward-only.** Once this release has written versions, don't roll the Worker back:
  an older Worker answers 404 for reused files and cannot update or restore those artifacts. Fix
  forward instead.
- If you maintain your own wrangler config, add the `enable_request_signal` compatibility flag and
  the hourly cron trigger `"triggers": { "crons": ["0 * * * *"] }`. `plinth deploy`, `plinth
  start` and the Docker image add both for you. From a checkout, deploy with
  `pnpm --filter @plinth/worker run deploy:production`, which refuses a config that lacks them. On
  Workers Free, the cron counts toward the account's 5 Cron Triggers.
- Details: [docs/deploy-checklist.md](docs/deploy-checklist.md#6-upgrading-and-rolling-back).

## 0.3.0 (2026-11-14)

- **Shared data**: a page that declares `<meta name="plinth-capabilities" content="data viewer">`
  can keep JSON documents shared by everyone who opens it (polls, sign-up sheets, trackers) through
  `window.plinth` from `/__plinth/runtime.js`, and learn who is viewing. Only the owner and people
  the artifact is shared with can write; link viewers read. Agents read and write the data with the
  new MCP tools `list_artifact_data` and `write_artifact_data`. Off with `ALLOW_SHARED_DATA=false`,
  and always off under `CONTENT_ISOLATION=opaque`. Applies migration `0005_shared_state.sql`.
- The content cookie on artifact subdomains is now `__Host-plinth_content`: open artifact frames
  reload through the gate once after upgrading.
- The privacy notice covers what people enter on shared pages and how long it is kept.
- Agent plugin 0.5.0: the skill explains shared data.

## 0.2.0 (2026-11-14)

- A new artifact type, **doc**: agents publish Markdown (`publish_artifact` with `type: "doc"`)
  and Plinth renders it as a readable document with headings, tables, code, images, light and dark
  themes and a print stylesheet ("Print or save as PDF"). Edit, compare and restore work as for
  pages. Applies migration `0004_typed_artifacts.sql`.
- Agent plugin 0.4.0: the skill explains when to publish a doc instead of an HTML page.
- Agents that fetch a Plinth link now learn what it is: every app page carries a short note for
  agents (the MCP server, how to read the artifact, install commands, docs). Artifacts anyone with
  the link may open add their title, version and a plain-text source at `/a/<slug>/source`. New
  `/llms.txt`, MCP server card (`/mcp/server-card`, `/.well-known/mcp.json`) and `/robots.txt`;
  unknown `/.well-known/` paths and missing files now answer 404 instead of the app.

## 0.1.1 (2026-11-14)

- `npx @mr0b0t0/plinth deploy` deploys Plinth to your own Cloudflare account in one command
  (database, bucket, secrets, migrations, the Worker); rerun it to redeploy or upgrade.
- A Docker image, `ghcr.io/mr0b0t0/plinth` (linux/amd64 and linux/arm64): localhost only, behind
  your own reverse proxy, or through a Cloudflare Tunnel, with data in a `/data` volume.
- The terms of use, privacy notice and acceptable use policy are final, plain-language pages built
  from the new `OPERATOR_*` settings. Admin commands `erase-user` and `erase-artifact` erase data
  on request.
- The artifact page follows new versions live, without reloading when comments open.
- The agent plugin can watch for new @mentions and bring them into Claude Code sessions.
- Hints printed by the CLI say `npx @mr0b0t0/plinth …` when it runs through npx.

## 0.1.0 (2026-11-14)

- First release of the npm CLI: `npx @mr0b0t0/plinth init` runs a localhost-only instance on your
  computer (agents connect with OAuth), and `init --tunnel` makes it reachable through a Cloudflare
  Tunnel.
