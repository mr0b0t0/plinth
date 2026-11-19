# Changelog

Notable changes to Plinth, newest first. Version numbers follow the npm CLI
([`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth)) and the Docker image
(`ghcr.io/mr0b0t0/plinth`), which ship the same Worker. The hosted instance at
[plinth.aconite.io](https://plinth.aconite.io) runs `main`.

Add a line under **Unreleased** in the pull request that makes a change people will notice.
`pnpm release <version>` turns that section into the release notes ([docs/releasing.md](docs/releasing.md)).

## Unreleased

- **Download a deck as .pptx.** **Download .pptx** in a deck's menu saves it as an editable
  PowerPoint file (Keynote and Google Slides open it too): one slide per slide with its text,
  lists, tables, images, links, footer, slide numbers and speaker notes, in the colours on screen.
  The file is built in the viewer's browser from the slides as shown; nothing goes to the server.
  On instances with opaque content isolation the file leaves out the deck's image files, and says
  so. Update the plugin for the agent's note on it.

- **Dictation, run by Plinth, for pages that ask for it.** A page that declares `dictation` can
  take the words a viewer speaks (`plinth.dictation`): Plinth's app runs the browser's speech
  recognizer after the viewer's click and consent, shows "Listening" with a Stop the page cannot
  hide, and passes the page only words. Artifact frames still never get the microphone. Off unless
  an operator sets `ALLOW_DICTATION=true`; origin isolation only, and only for people the page is
  shared with. Text to speech (`speechSynthesis`) works in every page as before, now documented,
  and a page that calls `getUserMedia` or `SpeechRecognition` itself gets a `blocked_feature`
  publish warning.

- **Publish from CI.** A GitHub Action, `mr0b0t0/plinth/publish@v0.6.0`, publishes a build folder
  or one HTML or Markdown file as the next version of an artifact on every run, with the commit in
  the version note and the links in the job summary. A token can now be limited to one artifact
  (the artifact's Settings, **Publish from CI**): it reads that artifact and publishes new versions
  of it, nothing else (not even the owner's or other people's email addresses), and deleting the
  artifact revokes it. `plinth publish` takes a single
  `.html` or `.md` file, uses a token's artifact when `--id` is left out, and with `--json` prints
  a JSON object on failure too, and prints `live_draft` as a note that needs no action. GitLab CI
  and cron: `docs/ci.md` (#51).

- **Slides.** Agents can publish a presentation as Markdown (`type: "slides"`): a line `---`
  between slides, speaker notes after `Note:`, columns with `|||`. Plinth renders fixed 16:9 or 4:3
  slides with automatic layouts and text that shrinks to fit. Page through with the keyboard,
  clicks or swipes, link to a slide (`#slide=4`), present full screen, open a presenter view with
  the notes, the next slide and a timer (and an audience window that follows it), and print or save
  as PDF with or without the notes. Update the plugin for the agent's slides rules. The Plinth CLI
  publishes a folder with `slides.md` at its top as a deck (`plinth publish`, `plinth upload`).

- **Design systems.** Publish tokens, guidelines and components as a design system (`type:
  "design_system"`, JSON in `system.json`): Plinth shows it as a reference site with color, type,
  spacing and shadow samples and live component previews in light and dark. Agents read one with
  the new `get_design_system` tool (or `GET /api/v1/artifacts/:ref/design-system`), copy its CSS
  into the pages they build, and get a `design_system_outdated` warning when a page was built on
  an older version. `list_artifacts` takes `type` to find them. The editor checks the JSON as you
  type.

- **Comments from the page.** A page that declares `comments` can open the comment composer on a
  spot of its own (a point on a canvas, a slide, a node in a diagram) with `plinth.comments`, draw
  its own markers for the threads and tell Plinth where to put its pins. The person still writes
  and posts every comment, and the page never sees comment text. Opening comments on such a page no
  longer reloads it. Agents see these anchors as `kind: "page"` in `list_comments` and mention
  tasks. Example: `docs/examples/canvas-comments.html`.

- **Comment pins stay on their spot when selected.** A selected or hovered pin was drawn a little
  off its anchor; it now grows in place.

- **Who is viewing: names and the people list.** Set your name from the account menu ("Your
  name…"); pages that show who is viewing now show it beside your email, on `plinth.viewer`, on
  the entries you write and in live rooms. A page that declares `data viewer people` lets its
  owner and editors list everyone it is shared with (`plinth.people.list()`, with search), and the
  line under the bar tells every invited viewer. On such a page their agents get the same list in
  `list_artifact_data` and `GET /api/v1/artifacts/:ref/people`; agents see authors' names on any
  page. The list and the owner's sharing settings name a person once they have commented, entered
  something or published a version there, so adding an address never reveals whether it has an
  account. Names are display text: no `@`, no invisible characters, never a role.

- **The Claude Code plugin remembers your instance.** It asks which Plinth instance to use when you
  enable it (the hosted one by default), keeps the answer, and its mention watcher follows it, so a
  self-hosted or local instance no longer needs `PLINTH_URL` exported every time Claude Code starts.
  From a terminal: `claude plugin install plinth@plinth --config instance_url=<origin>`; later,
  `/plugin configure plinth@plinth`. `PLINTH_URL` still works and wins. The directory build has the
  option too, and the Connect panel, `/llms.txt` and `plinth connect` print the right command for
  each instance. Plugin 0.15.0.

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
