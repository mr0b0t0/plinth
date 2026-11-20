# Changelog

Notable changes to Plinth, newest first. Version numbers follow the npm CLI
([`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth)) and the Docker image
(`ghcr.io/mr0b0t0/plinth`), which ship the same Worker. The hosted instance at
[plinth.aconite.io](https://plinth.aconite.io) runs `main`.

Add a line under **Unreleased** in the pull request that makes a change people will notice.
`pnpm release <version>` turns that section into the release notes ([docs/releasing.md](docs/releasing.md)).

## Unreleased

- **Review a newer version in the page itself.** When a version is published while people have
  unpublished changes on a doc or a sheet that are not combined with it, **Review changes** opens
  the review inside the page: their changes and the new version (or every version since, named as
  "v6 to v7") side by side, each with its own images, with what each changed, files included, and
  two choices. Each side marks the blocks or cells it changed and opens at its first change, and
  its list names each change once ("Paragraph changed", "Qty, row 3") with only the words or
  values that changed, as the page shows them. **Publish your changes** publishes them as they are,
  with the files they were made with, as the next version (the other stays in History); **Discard
  your changes** asks first, in the app's own confirmation; **Back** leaves the review. It looks like the rest of the app. The
  strip offers only **Review changes** and **Done** while a version waits (and only its status
  while the review is open, without an "Updated to" notification beside it), and the line shown
  to people who are not editing no longer repeats the Edit toggle. Both choices are safe against
  another editor choosing at the same moment: exactly one takes effect, and every other open
  review closes saying what happened. No source is shown. Changes
  the tab kept from before a reload are reviewed the same way when a newer version is current.
- **Publish on the page.** The edit strip says **Publish**, **Publish with a note…** and
  **Discard unpublished changes**, and its status says "Draft saved", "Publishing…" and "Published
  as v7". It shows how many others are editing, with who and where in a tooltip. On a phone a
  doc shows only the "+" above the block being edited and the one at the end, clear of the text.
  A page Publish keeps the files of the version the changes were made from
  (`files_from_version` on `PUT /api/v1/artifacts/:ref`). `GET /api/v1/artifacts/:ref/live/draft`
  is removed, and `GET /api/v1/config` says whether editing on the page is on (`inline_editing`).
- **A doc never starts like a web page by accident.** Typing `<html>` at the start of a block is
  kept as text, so the doc can still be published.
- Notifications no longer cover a dialog's buttons, and a pointer resting on one no longer keeps
  it on screen for good.
- **The CLI publishes design systems.** `plinth publish <dir>` publishes a folder with
  `system.json` at its top (and its images and fonts) as a design system, `--id` updates one with
  only the changed files, and `plinth upload` sends one for a `start_upload` ticket. `system.json`
  is checked against the 1 MB limit before anything is sent. A folder with `index.html` at its top
  is still a page.
- **Download a design as PNG or PDF.** On instances with a Browser Rendering binding, a design's
  artifact menu has **Download PNG or PDF…**: a PNG of one artboard at 1x or 2x (transparent where
  the board is), or a PDF with every board, or one, each on a page of its own size, rendered by
  the server from the version on screen. Anyone who may view the design can export it, up to 30
  times an hour per person (`DESIGN_EXPORTS_PER_HOUR`; signed out, per network), and at most two
  render at once across the instance; `DESIGN_EXPORT=false` turns it off.
  Scripts and agents use `GET /api/v1/artifacts/<id>/export?format=png&board=<id>` or
  `?format=pdf`, with `/export/options` listing the boards. Without the binding nothing changes:
  Print or save as PDF stays.
- **Where a dashboard's figures come from.** The owner's agent fetches figures with its own
  connectors, writes them to the page's shared data with a `source` stamp (`write_artifact_data`),
  and describes each fetch as a data source with `set_data_sources` (label, connector, a read-only
  recipe and the collection it fills). Plinth never fetches and holds no connector credentials. A
  source an agent sets or changes waits until the owner reads its recipe and confirms it in the
  Share dialog (agents cannot confirm); revoking a connection a source was pinned to makes it wait
  again. Every reader sees each stamped figure's source and age (`doc.source`, and the runtime's
  `plinth.cite` badges), and one line under the bar, counted by the server from the stamps each
  document carries, says which figures were fetched by an agent of the owner, from which system
  and how long ago, and how many were last changed by a person. A page can declare
  `plinth-data-sourced` collections that only the owner and editors write. Credential-like text is
  refused in recipes and stamps; links to records (a Linear issue, a Jira board, a Notion page, an
  Airtable view, a Salesforce or Stripe record) pass. Works with no page declaration and under opaque isolation (figures
  inline). Migration `0015_data_sources.sql`.
- **Pages that hand work to the owner's agent.** A page that declares `requests`
  (`<meta name="plinth-capabilities" content="requests">`, with
  `<meta name="plinth-requests-to" content="claude">`) lets the people who may comment on it send
  a request to the owner's agent from the page (`plinth.requests.file`). It lands in the agent's
  mention queue with `source: "page"`, and the page shows each person their own requests, their
  state and the agent's answers, never anyone's name or address. Only the owner, editors and the
  requester see a request in Comments, where the owner and editors dismiss it and the requester
  withdraws it. `reply_comment` gains `done: true` for an answer without a new version. Off by
  default: `ALLOW_PAGE_REQUESTS` turns it on (origin isolation only), with
  `PAGE_REQUESTS_*` limits; turning it on seals the viewer identity claim for identified viewers
  even where shared data and rooms are off. Migration `0016_page_requests.sql`.
- **Mentions of names such as `@constructor` work.** A comment that mentioned `@constructor`,
  `@tostring` or another name JavaScript objects carry by default failed with an internal error.
  Such a name is now an ordinary handle: it reaches the owner's connection whose label normalizes
  to it, and a page request sent to it without such a connection is refused as `unknown_agent`.
- **People you share with get an account.** Confirming the emailed code at an artifact's gate or
  a shared collection now signs the person in to Plinth with that address, creating their account
  the first time, as the owner's own code already did. What is shared with them then shows under
  Shared on their dashboard, they can come back without a new code, and an editor can edit a doc
  on its page. The gate, the email and the privacy notice say so, and the gate and the shared
  collection tell someone already signed in that confirming another address switches them to it.
  The code's email is now a sign-in email ("Your Plinth sign-in code"), warning never to give the
  code to anyone before it shows the title the sharer wrote, and wrong guesses at it count
  against the same per-address limit as the sign-in code. On a single-user instance, where only
  the admin may sign in, the code still starts a viewer session without an account, and viewer
  sessions started earlier keep working until they expire.
- **Email people when you share with them.** Adding someone to an artifact's People, or to a
  shared category, with **Notify people** ticked (the default) emails them that you shared it with
  them, with the title, their role and the link. Only people the change adds are emailed, at most once a
  day per artifact, within daily limits per owner (100), per owner and recipient (3) and per
  recipient (10), and only from a verified account. `PUT /api/v1/artifacts/:ref/sharing`, `set_visibility` and the category share
  endpoints take `notify` (default `false`): agents email people only when asked, and the result's
  `invitations` says who was emailed and who was not, and why.
- **Edit a sheet on its page, live with other editors.** Owners and editors turn on Edit on a
  sheet and change cells right in the grid: Enter, a double-click or typing opens a cell, Enter and
  Tab move on, Escape puts it back, a checkbox toggles with Space, and pasting cells from a
  spreadsheet fills the rows they cover. A strip inserts and deletes rows and columns and changes a
  column's name, type and format. The others editing see each change as it is typed, and rows
  someone holds show their email. Save version (or a pause) makes the next version, as for docs.
  A version published meanwhile (by an agent, the CLI, REST or a restore) is never merged into the
  page edits: editing pauses, and the editors review both sheets side by side, with what each
  changed, and choose **Publish mine** (the page edits become the next version, and the other stays
  in the history) or **Discard mine** (after a confirmation that lists what will be lost). When two
  people change rows at once, each change lands on the row it was made on, or is dropped with a
  note when that row is gone. While one editor publishes or discards, a second choice or a Discard
  from someone else waits with a note instead of undoing it, for docs too. Numbers are typed in
  your locale. Follows `ALLOW_LIVE_EDITING`.
- **Compare says what changed, in words.** History's Compare page no longer shows a source diff.
  It lists what changed between the two versions the way the page shows it: "Under “Pricing”:
  paragraph changed" with the text before and after, "Slide 4 moved to 2", "B7 changed: 12 → 14",
  "color.brand.500 changed", boards added or resized, a page's title, text, links and images, and
  the files added, removed or replaced. The two versions are still rendered side by side below the
  list, one at a time with a Before and After switch on a phone. Older links with `view=source`
  open the same page. Agents still read and write source as before.
- **Board settings for whiteboards.** Owners and editors change a board's background (dots, grid
  or plain) and who can change it (commenters and editors, or editors only) from **Board settings**
  in the board's ⋯ menu, in a small dialog with two choices. Each save is a new version; if someone
  published a newer one meanwhile, the dialog shows its settings instead of overwriting them. It
  replaces "Edit settings", which opened the board's JSON in the source editor.
- **Follow the presenter in a deck.** An owner or editor can turn on **Lead viewers** in a deck's
  controls or presenter view, and the people the deck is shared with who have it open follow their
  slide, with a "Following the presenter" note; paging by hand pauses it until they choose "Back to
  the presenter". Someone who opens the deck mid-talk lands on the presenter's slide. Only slide
  numbers travel, over the deck's live room; nobody sees who else is watching. It needs live rooms
  (origin isolation and the `ROOMS` binding) and is on by default; `ALLOW_SLIDES_FOLLOW=false`
  turns it off. Link viewers without an identity do not follow.
- **Open pages keep their place when a new version arrives.** A doc updates in place: the frame is
  not reloaded and the heading you were reading stays where it was. A page that loads
  `/__plinth/runtime.js` keeps its scroll position and where it was inside the artifact (a
  sub-page the new version no longer has opens at its root instead), and can hand state to the
  next version with `plinth.onVersion` (read back as `plinth.carried`). A page that declares `hold`
  (`<meta name="plinth-capabilities" content="hold">`) is not replaced while you are using it: the
  bar says "v5 is available · Update" instead. Every other page is replaced at once, as before.
  Follows `ALLOW_LIVE_VIEWS`; off, every update reloads the frame as before.
- **Files people add to a page.** A page that declares `files` lets the people it is shared with
  add images, PDFs, video and audio (`plinth.files.upload`), which everyone who can open the page
  sees; the owner and editors can delete any of them, and the owner can delete them all from the
  Share dialog, also after a version stops declaring `files`. Files are proven by their first bytes
  (never SVG, HTML or text), served from the artifact's own origin with `script-src 'none'` and a
  bare `sandbox`, never from the app and never into thumbnails or link previews. People who may add
  a file are told that the details saved inside it go with it.
  Agents list and delete them with `list_artifact_files` and `delete_artifact_file`, without the
  bytes. Off by default: `ALLOW_FILES` turns it on (origin isolation only), with `FILES_*` limits
  apart from the owners' storage quota. Migration `0014_artifact_files.sql`.
- **Whiteboards.** Agents can publish a board of notes, text, boxes, ellipses and arrows that
  people edit together (`type: "whiteboard"`). The board lives in the artifact's shared data, so
  everyone it lets edit (commenters by default, or editors only) moves, resizes, writes on,
  colours, connects and deletes blocks on the page, with live cursors and drags; viewers follow
  read-only. When two people (or a person and an agent) change one block at once, each keeps the
  fields they changed; where both changed the same one, the first save stands and the other person
  is told (for text, with a button to put theirs back). Pan and zoom with the mouse, a trackpad, touch or the keyboard, and export the board
  as PNG or SVG. A version holds only the board's settings (`board.json`), and a new board can
  start with a list of blocks and arrows, written once into its shared data. Agents read the board
  with `list_artifact_data` and add or move blocks with `write_artifact_data`. Needs shared data
  and origin isolation; `GET /api/v1/config` lists which types an instance publishes
  (`artifact_types`).
- **Your own categories for artifacts shared with you, and sharing a whole category.** On the
  dashboard, "Move to category…" now files an artifact someone shared with you under a category of
  your own, which only you see; the Category menu covers yours under Shared (#42). Owners can share
  one of their categories with people (viewer or commenter) under a name they choose: the people
  get one page, `/p/<id>`, listing the artifacts the owner ticked, and confirm their email there
  once. Filing an artifact under a shared category never shares it: it waits for the owner's review
  (a banner on the dashboard, "Waiting for review" on the row), and the owner's agent is told so
  (`category_share.state: "pending"` with a review link). Un-ticking an artifact takes it away from
  the category's people even when a new version was published while the dialog was open, and a
  taken-down artifact never waits for review. On by default; `ALLOW_CATEGORY_SHARING` turns it
  off. Migration `0013_category_sharing.sql`.
- **Open pages follow new versions at once.** An artifact page that is open picks up a version an
  agent or editor publishes within seconds, without waiting for its 15 s check, and pages that keep
  shared data (`onSnapshot`) see other people's changes within about a second. The app holds one
  WebSocket on its own host that carries only version numbers and "data changed" signals; nothing
  about the page or its data travels over it. On by default wherever the `ROOMS` binding is
  configured (also under opaque isolation, for versions); `ALLOW_LIVE_VIEWS=false` turns it off and
  pages poll as before. `LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT` (1000) caps the open views that get
  pushes, half for the people an artifact is shared with and half for everyone else, so a link
  viewer can never tell from the socket whether the owner or a collaborator has the page open. Update the plugin for the agent's rule never to tell people to reload. A reverse proxy
  must pass WebSocket upgrades on the app host too.
- **Designs.** Agents can publish visual designs at fixed sizes (`type: "design"`): app screens,
  posters, social posts, ads and banners as artboards in one HTML file, each starting with a line
  `<!-- artboard name="Home" size="iphone" -->`, with presets for phones, desktops, social posts,
  IAB ads, print and slides. Plinth lays the boards out on a canvas you pan and zoom (Fit, 100%, a
  Boards list), renders each one alone at its exact size in its own frame with an opaque origin, so
  its scripts, styles and images run without reaching the page or each other, lets you interact
  with one board, pins comments to boards, and prints or saves the design as PDF one board per
  page. The editor previews the boards as you type and shows each problem with its line. The Plinth
  CLI publishes a folder with `design.html` at its top as a design. Thumbnails show each board
  with its own images and styles. Update the plugin for the agent's design rules.
- **Download a deck as .pptx.** **Download .pptx** in a deck's menu saves it as an editable
  PowerPoint file (Keynote and Google Slides open it too): one slide per slide with its text,
  lists, tables, images, links, footer, slide numbers and speaker notes, in the colours on screen.
  The file is built in the viewer's browser from the slides as shown; nothing goes to the server.
  On instances with opaque content isolation the file leaves out the deck's image files, and says
  so. Update the plugin for the agent's note on it.
- **Project files for a page.** Agents now have a recipe for pages that show files from a project
  (a log viewer, a CSV explorer, a code tour): publish copies of the files the user chose under
  `files/` and read them by relative URL; a refresh is a new version. Only the user in the session
  chooses the files: a mention, even from the owner, never makes the agent read one, and agents can
  remember the user's choice in a local `.plinth-files.json` that is never published or committed.
  Project files that Plinth would serve as a page or code (`.html`, `.svg`, `.js`, `.css`…) go up
  with `.txt` added, so opening one never runs it, or are embedded in the page as JSON with every
  `<` escaped, so a `</script>` in the file cannot end the block. A big refresh through an upload
  or the CLI holds the page and every file it keeps. Update the plugin for the agent's project files rules.

- **A `sensitive_file` publish warning.** A publish, update or upload that sends a file whose name
  usually holds secrets (`.env`, `*.pem`, `id_rsa`, `credentials.json`), or a `.plinth-files.json`
  record, lists `sensitive_file` first, so the agent stops and asks before handing over the link.
  It checks names only, never blocks, and is not reported for files carried forward, reused by
  hash or restored.
- **Pages for clients and approvers, and several agents on one artifact.** Three finished example
  pages for people outside your team, who confirm their email by code with no account: an approval
  sign-off, a client intake form and a client checklist (`docs/examples/`). What your side decides
  stays in the page's versions; what they contribute is shared data stamped with who wrote it, and
  the pages count only what those stamps vouch for. A new guide covers Claude, Codex, Gemini CLI,
  Cursor and scripts working on one artifact: which mention reaches which agent, hand-offs,
  conflicts and who did what. The Connections page now shows the handle each connection is
  mentioned by (`Claude Code` is `@claude-code`) and warns when a name cannot be reached; the
  rename, new-token and consent dialogs show it as you type. Update the plugin for the skill's new
  sections.

- **No `root_absolute` warning for Plinth's runtime.** A page that loads `/__plinth/runtime.js`
  (shared data, rooms, page comments, dictation) no longer gets a publish warning it could not fix.
- **Sheets.** Agents can publish a table people sort, filter, calculate with or download (`type:
  "sheet"`): JSON lines with typed columns (text, number with currency or percent formats, date,
  checkbox, select, link) and Excel formulas (SUM, IF, VLOOKUP, XLOOKUP and 67 more) that Plinth
  computes itself. The page has a frozen header, sort, a filter, a formula bar, print, light and
  dark, and phone width, and anyone who can view it downloads it as CSV or Excel (.xlsx) built in
  the browser. Agents read computed values with `read_sheet` and change cells, rows and columns
  with `edit_sheet`, one version per call. A CSV or .xlsx file can be published as a sheet
  (`content_format`, `plinth publish data.csv`, or "Import CSV or .xlsx" in the editor).
  `SHEET_EVAL_BUDGET` sets how much formula work one `read_sheet` may do. Update the plugin for the
  agent's sheet rules.

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
