# Changelog

Notable changes to Plinth, newest first. Version numbers follow the npm CLI
([`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth)) and the Docker image
(`ghcr.io/mr0b0t0/plinth`), which ship the same Worker. The hosted instance at
[plinth.aconite.io](https://plinth.aconite.io) runs `main`.

Add a line under **Unreleased** in the pull request that makes a change people will notice.
`pnpm release <version>` turns that section into the release notes ([docs/releasing.md](docs/releasing.md)).

## Unreleased

## 0.8.0 (2026-11-23)

- **Show an artifact in the conversation.** Ask your agent to show, open or bring back a page
  that is already on Plinth, and the new `show_artifact` tool puts it under the call as a
  read-only preview, as a publish does. Works in apps that render MCP Apps (T3 Code, ChatGPT,
  VS Code and others; claude.ai shows the title and Open on Plinth); elsewhere the agent gives
  you its link. Plugin 0.30.0.
- **Full screen previews.** Where the app offers it, the in-chat preview has a full screen button
  that fills the window with the page, and returns it to the thread.

## 0.7.0 (2026-11-23)

### Editing on the page, the way Claude does it

- **Pages are editable when they open.** Owners and editors of a doc, a deck, a sheet or a design
  system edit right on the page, with no Edit button or Done. Changes publish on their own, after
  a quiet spell or when you leave the page, also on instances without live rooms. A quiet status
  beside the version says "Saving…", "Draft saved" or "Published as v7", and the ⋯ menu has
  Publish changes (Cmd/Ctrl+S) and Discard. Nothing typed is lost: undoing back to the text you
  opened, a failed autosave, leaving for another page in the app and a copy kept from before a
  reload are all handled.
- **Docs as formatted text.** A block opens as formatted text with a format bar (bold, italic,
  code, strikethrough, link, nested in any order) and a block menu (Turn into, Insert below, Move,
  Delete). No Markdown is shown, untouched blocks keep their bytes, and undo, redo and paste work
  per block.
- **Decks on the page.** Slide text, speaker notes and Slide setup (aspect, theme, page numbers,
  footer) are edited in place. Typed text never changes a deck's structure. Present, Print and
  Download .pptx work while a deck is edited, and presenting shows the published deck.
- **Sheets on the page.** Cells, rows and columns are edited in the grid, live with other editors:
  paste from a spreadsheet, move rows, freeze and resize columns, column types and formats, and
  select options. Formulas keep pointing at the right cells when rows move. On a phone, a cell
  opens in an editor docked at the bottom.
- **Design systems on the page.** Token values in light and dark, descriptions, adding and
  removing tokens, the name, guidelines and component text are edited in place, never as JSON.
  Renames, component code, fonts and settings stay with agents.
- **A newer version is reviewed, never merged.** When a version is published while people have
  unpublished changes, Review changes shows both side by side with what each changed, and offers
  Publish your changes or Discard your changes. Exactly one choice takes effect when two editors
  choose at once.
- **New and Import.** New on the dashboard starts a blank doc, sheet or deck, ready to edit, or
  imports an .xlsx, .csv or .tsv file as a sheet. Replace with a file… makes a sheet's next version
  from a file. Both say what a file loses (other sheets, formulas, long column names, encoding).
- **Compare says what changed, in words.** History lists changes the way the page shows them
  ("Under “Pricing”: paragraph changed", "Slide 4 moved to 2", "B7 changed: 12 → 14"), with the
  two versions rendered side by side.
- **No source editor.** People never see source code. The source editor and its Edit entries are
  gone, and old `/a/…/edit` links open the artifact. HTML pages and designs are changed by asking
  an agent.

### Asking agents

- **Ask an agent in a comment.** Mention it, the way you ask Claude: `@claude make the heading
  red`, `@codex`, or `@agent:other` for the owner's other agents (ChatGPT, Cursor, Gemini). The
  comment box suggests them. A block's, image's, token's or component's Comment pins the comment
  to that place while you keep editing. The bar holds only History, Comments, Share and ⋯, plus
  Present on a deck. `request_to` on `POST /api/v1/artifacts/:ref/comments` still works.
- **A mention skips connections that cannot answer it**, and the rename, new-token and consent
  dialogs show the handle a name is mentioned by as you type. A comment that mentions
  `@constructor` or `@toString` no longer reads a built-in property as an agent name.
- **Craft guides for agents.** The plinth-artifacts skill teaches how to make each type read and
  look finished: pages and dashboards, docs, decks, sheets, designs, design systems and
  whiteboards.
- **Project files for a page.** Agents have a recipe for pages that show files the user chose
  (log viewers, CSV explorers, code tours). Only the user in the session chooses the files, never a
  mention. Files Plinth would run are sent as plain text.
- **`sensitive_file` warning.** A publish that sends a file whose name usually holds secrets
  (`.env`, `*.pem`, `id_rsa`, `credentials.json`, `.envrc`, `*.tfvars` and more) lists
  `sensitive_file` first, so the agent stops and asks.
- **Published from code.** `editing: "code"` marks an artifact whose source lives in a
  repository. `plinth publish` and the GitHub Action set it, and people editing it on the page are
  told the next publish from code won't include their changes.
- **Shorter MCP tool descriptions**, by about 950 tokens.

### New artifact types and formats

- **Sheets** (`type: "sheet"`): typed columns, more than 70 Excel functions computed by Plinth,
  sort, filter, a formula bar and CSV or .xlsx download. Agents use `read_sheet` and `edit_sheet`,
  and a CSV or .xlsx file publishes as a sheet.
- **Designs** (`type: "design"`): artboards at fixed sizes (phones, desktops, social posts, ads,
  print) on a canvas you pan and zoom. Each board renders alone with an opaque origin. Boards can
  be fluid, placed with `x` and `y`, annotated with stickies and titles, and linked for clickable
  prototypes. On instances with Browser Rendering, Download .png and .pdf are rendered by the
  server.
- **Whiteboards** (`type: "whiteboard"`): notes, text, shapes, sections, tables and routed arrows
  that people edit together with live cursors, matching what Claude's boards draw. They download
  as PNG or SVG and have a Settings dialog for the background and who may edit.
- **HTML decks in Claude's slide format**: `deck.json`, `deck.css` and `slides/<id>.html`, checked
  against Claude's element list. They support fragments, transitions, presenter view, Lead
  viewers, print and an editable .pptx, beside Markdown decks.
- **Design systems other artifacts use.** Set one as your default and agents build with it.
  `copy_files` and `get_design_system`'s install list copy its tokens, fonts and components into a
  page, deck or design on the server.
- **Download a deck as .pptx**, built in the browser, with text, tables, images and speaker notes
  kept editable.

### Sharing and viewing

- **People you share with get an account** when they confirm the emailed code, so what's shared
  with them shows on their dashboard.
- **Email people when you share with them**, with daily limits and a one-click opt-out.
- **Share a whole category** with people, and file artifacts shared with you under categories of
  your own. Filing never shares: the owner reviews each artifact first.
- **Names and the people list.** Set your name, and pages that show who is viewing use it. An
  owner's comments and versions carry an "Owner" mark.
- **Open pages follow new versions within seconds**, over one WebSocket that carries only version
  numbers and change signals. Docs update in place and keep your place, and a page can hold an
  update while you use it.
- **Follow the presenter.** Lead viewers keeps everyone a deck is shared with on the presenter's
  slide.
- **Dashboard**: thumbnails in the list view, cards of one height, and card menus that stay on
  screen.

### Fixes

- Design export works in Browser Rendering again.
- More cases where typing on a doc or deck could be lost now keep the text, with Copy and Dismiss.
- A page that declares `hold` stays held after you switch apps.
- Notifications no longer cover a dialog's buttons.
- No `root_absolute` warning for pages that load `/__plinth/runtime.js`.
- Thumbnail capture failures are logged without URLs.

### For self-hosters

- **Migrations**: `0013_category_sharing.sql`, `0021_invitation_opt_outs.sql`,
  `0022_design_system_reuse.sql` and `0023_artifact_editing.sql`. Apply them before deploying the
  Worker.
- **New settings**: `ALLOW_LIVE_VIEWS`, `LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT`,
  `ALLOW_SLIDES_FOLLOW`, `ALLOW_CATEGORY_SHARING`, `INVITATION_EMAILS_PER_OWNER_PER_DAY`,
  `INVITATION_EMAILS_PER_DAY`, `SHEET_EVAL_BUDGET`, `DESIGN_EXPORT`, `DESIGN_EXPORTS_PER_HOUR`,
  `DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR`, `DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR`,
  `DATA_BOARD_MAX_DOCS`, `DATA_BOARD_MAX_BYTES` and `DATA_BOARD_MAX_DOC_BYTES`.
- A reverse proxy must pass WebSocket upgrades on the app host as well as the content host.
- Whiteboards need shared data and origin isolation. Design export needs a Browser Rendering
  binding; without one, Print or save as PDF stays.
- The source editor and its `monaco-editor` dependency are gone, and the app's CSP no longer
  allows `blob:` workers.
- API: `GET /api/v1/artifacts/:ref/live/draft` is removed. `GET /api/v1/config` adds
  `inline_editing` and `artifact_types`.
- Update the agent plugin to 0.29.0 for the agents' rules on every new type.

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
