# Changelog

Notable changes to Plinth, newest first. Version numbers follow the npm CLI
([`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth)) and the Docker image
(`ghcr.io/mr0b0t0/plinth`), which ship the same Worker. The hosted instance at
[plinth.aconite.io](https://plinth.aconite.io) runs `main`.

Add a line under **Unreleased** in the pull request that makes a change people will notice.
`pnpm release <version>` turns that section into the release notes ([docs/releasing.md](docs/releasing.md)).

## Unreleased

- **Designs: fluid pages, notes, flows and links to one board.** An artboard with `height="auto"`
  is as tall as its content, so a responsive web page shows whole on the canvas, in print and in
  exports. Boards can be placed with `x` and `y` (rows stay the default), and `<!-- note kind="sticky" -->`
  and `<!-- note kind="title" -->` add stickies and titles to the canvas (any other `<!-- note`
  comment stays part of its board, as before). A link to `#board=<id>`
  inside a board moves to that board, for clickable prototypes, and the app's address keeps the
  board on view (`#board=<id>`), so a reload or a shared link opens on it. A flow moves only on a
  click, a board in use stays still while a page next to it grows, and a link to a board that is
  gone drops out of the address.
- **Installing design systems, tightened.** `get_design_system` takes `install_for` and `folder`:
  its install list holds only what the target type takes (a design gets no fonts or
  `tokens.json`), and it also gives a deck's `faces` and `designSystems` record. A design system
  without its own prefix installs under a name from its title instead of `ds/ds/`, and two systems
  can no longer share a folder. Copies are checked after the publish rate, an admin's review
  access never lets them copy, and `get_artifact` names a copy's source only to people who can
  open it. A taken-down default design system is no longer reported as the default.

- **Dashboard card menus.** An open card's actions menu now covers the cards below it (the next
  card's `⋯` button showed through it), and on a phone a left-column card's menu stays on screen
  instead of running past its edge.
- **Craft guides for agents.** The plinth-artifacts skill now teaches how to make each type of
  artifact read and look finished, not only what Plinth accepts: one guide per type, for pages and
  dashboards (chart and KPI craft, summary before detail, every number from the data), docs (lead
  with the answer, sized to the ask, sources and an as-of date), decks (one idea per slide, heading
  levels and slide kinds used on purpose), sheets (important columns first, a build order, types,
  widths and a notes column), designs (placeholders, no AI tropes, contrast, touch targets and real
  controls), design systems (a brand-book guide, exact values, contrast in every theme) and
  whiteboards (the idea's shape, a size budget, at most four colors, extending a board without
  disturbing people's work). The MCP tool descriptions point agents without the skill at them.
- **Design systems that other artifacts use.** Mark one of your design systems as your default
  from its menu on the dashboard (**Set as default**); agents then use it for pages, decks and
  designs without asking. A publish or update can now copy files from another artifact you can
  view, on the server (`copy_files`), so an agent installs a design system's `tokens.css`,
  `fonts.css`, `components.css`, `tokens.json`, fonts and images into a page under `ds/<prefix>/`
  in the same call (`get_design_system` lists the entries to send). The copies become the page's
  own files and record where they came from. Designs name the design system they were built on,
  like pages, and get the same outdated warning. Apply migration `0022_design_system_reuse.sql`.

- **Ask an agent and sheet editing fixes.** "Publish my changes first" in the Ask dialog now runs
  the same Publish as the edit strip: a version published meanwhile opens the review in solo mode
  too (it showed a generic notification), and a lost session asks to sign in again. A request no
  agent can take no longer counts against the hourly comment limit. Requests for clients other
  than Claude and Codex are labelled `@agent:other`, so they never read like a mention of a
  connection named "Agent". The renderer's `ask` message is limited like a page's own comment
  requests (no dialog open, the tab visible, at most one reopen a second), and the docs no longer
  promise page anchors that no renderer sends yet. On a sheet's page, tapping the docked check on
  a phone keeps a value it cannot save instead of dropping it, the cell field stays put (and the
  keyboard open) when someone else's change redraws the grid, an option's hidden arrows can't be
  tapped, Move row up and down are off while a sort is on, and while a filter hides rows a row
  moves past them to the next row shown.

- **Review a newer version in the page itself.** When a version is published while people have
  unpublished changes on a doc or a sheet that are not combined with it, **Review changes** opens
  the review inside the page: their changes and the new version (or every version since, named as
  "v6 to v7") side by side, each with its own images, with what each changed, files included, and
  two choices. Each side marks the blocks or cells it changed and opens at its first change, and
  its list names each change once ("Paragraph changed", "Qty, row 3") with only the words or
  values that changed, as the page shows them. **Publish your changes** publishes them as they are,
  with the files they were made with, as the next version (the other stays in History); **Discard
  your changes** asks first, in the app's own confirmation; **Back** leaves the review. It looks like the rest of the app. The
  strip offers only **Review changes** while a version waits (and only its status while the
  review is open, without an "Updated to" notification beside it), and the line shown to people
  who are not editing is one short line of text in the strip's look ("Unpublished changes · Ana,
  3 h ago"): the Edit toggle is the one way in. Both choices are safe against
  another editor choosing at the same moment: exactly one takes effect, and every other open
  review closes saying what happened. No source is shown. Changes
  the tab kept from before a reload are reviewed the same way when a newer version is current.
- **Publish on the page.** A doc that can be edited on its page no longer offers **Edit source**
  in its menu: the Edit toggle is the one way in and out (on a phone, **Edit on the page** in the
  ⋯ menu, and **Done** on the strip). The edit strip has one action, **Publish**, once there is
  something to publish (when the changes can't be published yet, its tooltip says why), and its
  status says "Draft saved", "Publishing…" and "Published as v7", on one line at any width.
  **Discard unpublished changes** is in the ⋯ menu. The strip shows how many others are editing,
  with who and where in a tooltip. A doc's block being edited keeps the page's own type, with no
  box around it, and a "+" shows only beside the block under the pointer or being edited; on a
  phone only the "+" above the block being edited and the one at the end show, clear of the text.
  A page Publish keeps the files of the version the changes were made from
  (`files_from_version` on `PUT /api/v1/artifacts/:ref`, from the signed-in app only; bearer tokens
  get 403). The review's choices stay off while a newer version it is moving to loads, so a choice
  always names the version on screen. `GET /api/v1/artifacts/:ref/live/draft`
  is removed, and `GET /api/v1/config` says whether editing on the page is on (`inline_editing`).
- **A doc never starts like a web page by accident.** Typing `<html>` at the start of a block is
  kept as text, so the doc can still be published.
- Notifications no longer cover a dialog's buttons, and a pointer resting on one no longer keeps
  it on screen for good.
- **Leading a deck is steadier.** A presenter whose connection drops keeps the lead when it comes
  back, instead of turning Lead viewers off and following its own old connection. Paging quickly (a held arrow key) always leaves
  followers on the presenter's last slide. A deck's room keeps 4 of its slots for owners and
  editors, so viewers' tabs can never lock the presenter out. Opening another deck in the same tab
  no longer leads that deck's viewers.
- **A held page stays held after you switch apps.** A page that declares `hold` was replaced by a
  new version once its window lost focus, so text you were typing before switching to another app
  or tab could be lost; it now waits for Update as long as focus is still in the page. State a page
  handed to the next version is read only by that version's frame: a reload of the old page in the
  meantime no longer picks it up (unless the page renamed its window: then it carries as before).
- **Project files for a page.** Agents now have a recipe for pages that show files from a project
  (a log viewer, a CSV explorer, a code tour): publish copies of the files the user chose under
  `files/` and read them by relative URL; a refresh is a new version. Only the user in the session
  chooses the files: a mention, even from the owner, never makes the agent read one, and agents can
  remember the user's choice in a local `.plinth-files.json` that is never published or committed.
  Project files that Plinth would serve as a page or code (`.html`, `.svg`, `.js`, `.css`…) go up
  with `.txt` added, so opening one never runs it, or are embedded in the page as JSON with every
  `<` escaped, so a `</script>` in the file cannot end the block. A big refresh through an upload
  or the CLI holds the page and every file it keeps. Update the plugin for the agent's project
  files rules. Plugin 0.26.0.
- **A `sensitive_file` publish warning.** A publish, update or upload that sends a file whose name
  usually holds secrets (`.env`, `*.pem`, `id_rsa`, `credentials.json`), or a `.plinth-files.json`
  record, lists `sensitive_file` first, so the agent stops and asks before handing over the link.
  It checks names only, never blocks, and is not reported for files carried forward, reused by
  hash or restored.
- **`sensitive_file` knows more names**: `.envrc`, `.pgpass`, `*.p8`, `*.ppk`, `*.tfvars`, files
  under `.kube/`, and `.docker/config.json`.
- **Shorter MCP tool descriptions.** The sentence that nothing on Plinth chooses local files is on
  the tools that return artifact files, versions, comments, mentions or shared data instead of on
  every tool, which takes about 3,750 characters (some 950 tokens) off what an agent loads. The
  project files rules stay on each tool that publishes files.
- **Project files: safer types, and a marked list.** Agents add `.txt` to page and code files in
  any letter case (`App.HTML` too), send project files only as plain text, and, when they offer
  files taken from the artifact, mark each one the user has not chosen before and say who added
  it.
- **Pages for clients and approvers, and several agents on one artifact.** Three finished example
  pages for people outside your team, who confirm their email by code with no account: an approval
  sign-off, a client intake form and a client checklist (`docs/examples/`). What your side decides
  stays in the page's versions; what they contribute is shared data stamped with who wrote it, and
  the pages count only what those stamps vouch for. A new guide covers Claude, Codex, Gemini CLI,
  Cursor and scripts working on one artifact: which mention reaches which agent, hand-offs,
  conflicts and who did what. The rename, new-token and consent dialogs show the handle a name
  is mentioned by as you type (`Claude Code` is `@claude-code`), and the Connections page warns on
  a connection's row when a name cannot be reached.
- **A mention skips connections that cannot answer it.** `@<handle>` no longer goes to a
  connection without the "Answer mentions" permission, where it would wait for ever; a newer one
  with the same handle that can answer gets it, and the Connections page warns accordingly.
- **A clearer hint for names no mention can reach.** The rename and new-token dialogs now say
  "start and end the name with a Latin letter or digit", which also covers names in other scripts
  and names ending in a dot.
- **The intake example shows who changed an answer.** Answers the owner or an editor changed say
  "Changed by" with their email and role on the response's date line, and a question whose id is
  `constructor` or another built-in name no longer shows a stray answer.
- **The approval example keeps your own decision current.** "You approved · Withdraw" follows the
  shared data, so it updates when the owner or an editor changes or deletes your sign-off, without
  a reload. Who changed a sign-off now joins its decision and date line ("· Changed by" with the
  email, and the role when there is one), as on the intake page.
- **No `root_absolute` warning for Plinth's runtime.** A page that loads `/__plinth/runtime.js`
  (shared data, rooms, page comments) no longer gets a publish warning it could not fix.
- **Dashboard previews in the list, and one card height.** Each row of the list view starts with a
  small preview of the page, its thumbnail, in place of the page glyph (the glyph stays until a
  thumbnail exists). A card shows its category as plain text on its info line instead of a chip on
  a line of its own, so every card in the grid has the same height; a long name ends in "…" and
  shows in full on hover. On phones the category moves from beside the title to a row's second
  line, and on a card it takes the place of "You".
- **Download a deck as .pptx.** **Download .pptx** in a deck's menu saves it as an editable
  PowerPoint file (Keynote and Google Slides open it too): one slide per slide with its text,
  lists, tables, images, links, footer, slide numbers and speaker notes, in the colours on screen.
  The file is built in the viewer's browser from the slides as shown; nothing goes to the server.
  On instances with opaque content isolation the file leaves out the deck's image files, and says
  so. Plugin 0.23.0.
- **.pptx: images four at a time.** The download reads and draws at most four of a deck's images
  at once, so a deck with hundreds of them no longer risks a phone's tab, and an image the browser
  cannot draw is counted among those left out.
- **.pptx: space above tables.** A table right under a list or a paragraph keeps the gap the slide
  shows, instead of sitting against the last line.
- **.pptx: an interrupted download says what to do.** When a newer version replaces the deck while
  the file is made, the notice says to download it again if no file was saved.
- **Open pages follow new versions at once.** An artifact page that is open picks up a version an
  agent or editor publishes within seconds, without waiting for its 15 s check (one "Updated to
  vN" notice at a time, however many versions arrive in a row), and pages that keep
  shared data (`onSnapshot`) see other people's changes within about a second. The app holds one
  WebSocket on its own host that carries only version numbers and "data changed" signals; nothing
  about the page or its data travels over it. On by default wherever the `ROOMS` binding is
  configured (also under opaque isolation, for versions); `ALLOW_LIVE_VIEWS=false` turns it off and
  pages poll as before. `LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT` (1000) caps the open views that get
  pushes, half for the people an artifact is shared with and half for everyone else, so a link
  viewer can never tell from the socket whether the owner or a collaborator has the page open.
  After a deploy, open pages reconnect spread over 10 seconds, and a busy shared page sends its
  views at most one "data changed" signal per spread (2 s at the default). A
  reverse proxy must pass WebSocket upgrades on the app host too. Plugin 0.24.0: the agent's rule
  never to tell people to reload.
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
  with its own images and styles. Update the plugin for the agent's design rules. Plugin 0.25.0.
- **Sheets.** Agents can publish a table people sort, filter, calculate with or download (`type:
  "sheet"`): JSON lines with typed columns (text, number with currency or percent formats, date,
  checkbox, select, link) and Excel formulas (SUM, IF, VLOOKUP, XLOOKUP and 67 more) that Plinth
  computes itself. The page has a frozen header, sort, a filter, a formula bar, print, light and
  dark, and phone width, and anyone who can view it downloads it as CSV or Excel (.xlsx) built in
  the browser. Agents read computed values with `read_sheet` and change cells, rows and columns
  with `edit_sheet`, one version per call; people never see the JSON lines (no source editor or
  source diff: Compare shows the versions rendered). A CSV or .xlsx file can be published as a
  sheet (`content_format` or `plinth publish data.csv`); ids, phone numbers and leading zeros stay
  text, and a semicolon-separated file reads decimal commas. A downloaded CSV quotes every text
  value, so Excel in a semicolon locale never splits a cell into a formula.
  `SHEET_EVAL_BUDGET` sets how much formula work one `read_sheet` may do. Plugin 0.26.0.
- **Who is viewing: names and the people list.** Set your name from the account menu ("Your
  name…") and the sidebar shows it; pages that show who is viewing now show it beside your email,
  on `plinth.viewer`, on the entries you write and in live rooms. A page that declares `data viewer people` lets its
  owner and editors list everyone it is shared with (`plinth.people.list()`, with search), and the
  line under the bar tells every invited viewer. On such a page their agents get the same list in
  `list_artifact_data` and `GET /api/v1/artifacts/:ref/people`; agents see authors' names on any
  page. The list and the owner's sharing settings name a person once they have commented, entered
  something or published a version there, so adding an address never reveals whether it has an
  account. Names are display text: no `@`, no invisible or blank-only characters, never a role;
  the owner's own comments and versions carry a quiet "Owner" mark (`is_owner`), so a name chosen
  to look like the owner's visibly lacks it. Once a token limited to one artifact has
  published a version of a page, that page lists nobody. Plugin 0.27.0.
- **Your own categories for artifacts shared with you, and sharing a whole category.** On the
  dashboard, "Move to category…" now files an artifact someone shared with you under a category of
  your own, which only you see; the Category menu covers yours under Shared (#42). Owners can share
  one of their categories with people (viewer or commenter) under a title, the category's name
  unless they change it: the people get one page, `/p/<id>`, listing the artifacts the owner ticked, and confirm their email there
  once. Filing an artifact under a shared category never shares it: it waits for the owner's review
  (one "to review" line on the dashboard), and the owner's agent is told so
  (`category_share.state: "pending"` with a review link). Un-ticking an artifact takes it away from
  the category's people even when a new version was published while the dialog was open, and a
  taken-down artifact never waits for review. On by default; `ALLOW_CATEGORY_SHARING` turns it
  off. A token limited to one artifact never sees or manages category sharing: it holds no role
  through a category grant, and the share, portal and personal-category routes answer it 403
  `token_bound`. On a page that lists who has access, the owner and editors see the category's
  people too, each once at their highest role. Migration `0013_category_sharing.sql`. Plugin 0.28.0.
- **People you share with get an account.** Confirming the emailed code at an artifact's gate or
  a shared collection now signs the person in to Plinth with that address, creating their account
  the first time, as the owner's own code already did. What is shared with them then shows under
  Shared on their dashboard, they can come back without a new code, and an editor can edit a doc
  on its page. The gate and the shared category's page say "Sign in", the email and the privacy
  notice say that an account is created, and someone already signed in is told instead that
  confirming another address switches them to it. The privacy notice says their opens are
  recorded as a signed-in person's.
  The code's email is now a sign-in email ("Your Plinth sign-in code"), warning to type the code
  only into Plinth's own sign-in form and never to give it to anyone before it shows the title or name the sharer wrote (on one line, so neither can
  add lines of its own), and wrong guesses at it count against the same per-address limit as the
  sign-in code. On a single-user instance, where only the admin may sign in, the code still starts
  a viewer session without an account, and viewer sessions started earlier keep working until
  they expire. Plugin 0.29.0.
- **Whiteboards.** Agents can publish a board of notes, text, boxes, ellipses and arrows that
  people edit together (`type: "whiteboard"`). The board lives in the artifact's shared data, so
  everyone it lets edit (editors by default, or commenters too when its settings say so) moves, resizes, writes on,
  colours, connects and deletes blocks on the page, with live cursors and drags; viewers follow
  read-only. When two people (or a person and an agent) change one block at once, each keeps the
  fields they changed; where both changed the same one, the first save stands and the other person
  is told (for text, with a button to put theirs back). Pan and zoom with the mouse, a trackpad,
  touch or the keyboard, and download the board as PNG or SVG from the ⋯ menu. The toolbar shows
  only what applies, in one row: the add buttons for people who may edit, a block's colours,
  Connect and Delete while it is selected, and who else is here. A version holds only the board's
  settings (`board.json`), and a new board can start with a list of blocks and arrows, written
  once into its shared data; the history's restore on a board is Restore settings. Agents read the board with `list_artifact_data` and add or move
  blocks with `write_artifact_data`. Needs shared data and origin isolation; `GET /api/v1/config`
  lists which types an instance publishes (`artifact_types`). Plugin: when and how agents
  publish and change whiteboards.
- **Board settings for whiteboards.** Owners and editors change a board's background (dots, grid
  or plain) and who can change it (editors only, or commenters and editors) without typing
  anything: from **Settings** in the board's ⋯ menu, which is the settings page's new Board section
  for the owner and a small dialog over the board for an editor. Each save is a new version; if
  someone published a newer one meanwhile, nothing is overwritten: the newer settings are shown
  and the board loads that version. Any other refusal shows its own message. The skill tells
  agents to read a board's settings again before changing them, since people change them too.
- **Email people when you share with them.** Adding someone to an artifact's People, or to a
  shared category, with **Notify people** ticked (the default) emails them that you shared it with
  them, with the title, their role and the link. Only people the change adds are emailed, at most once a
  day per artifact, within daily limits per owner (20, `INVITATION_EMAILS_PER_OWNER_PER_DAY`),
  per owner and recipient (3), per recipient (10) and for the whole instance (1000,
  `INVITATION_EMAILS_PER_DAY`; `0` turns invitation emails off), and only from a verified account. `PUT /api/v1/artifacts/:ref/sharing`, `set_visibility` and the category share
  endpoints take `notify` (default `false`): agents email people only when asked, and the result's
  `invitations` says who was emailed and who was not, and why. A change's emails go to the provider
  in one batch request (Resend) or one at a time, never all at once, so they stay within its
  request rate and leave room for sign-in codes; one the provider refuses can be sent again by
  adding the person again. Each email's footer and `List-Unsubscribe` header link
  `/invitation-emails`, where the recipient signs in and turns invitation emails to their address
  off (or back on); owners who share with them are told `opted_out`, and the access still applies.
  The opt-out and the per-address limits cover the inbox, so `bo+x@gmail.com` and `b.o@gmail.com`
  count as `bo@gmail.com`, and an `opted_out` answer costs the owner one of their daily
  invitations, as an email would.
  Host names in titles and names are defanged (`office365-reset[.]co`) so mail clients do not link
  them. `EMAIL_PROVIDER=console` outside development and `SINGLE_USER_MODE` send no invitations.
  Migration `0021_invitation_opt_outs.sql`.
- **Edit a sheet on its page, live with other editors.** Owners and editors turn on Edit on a
  sheet and change cells right in the grid: Enter, a double-click or typing opens a cell, Enter and
  Tab move on, Escape puts it back, a checkbox toggles with Space, and pasting cells from a
  spreadsheet fills the rows they cover. Row and Column menus in the sheet's bar insert and delete
  rows and columns and change a column's name, type and format. The others editing see each change
  as it is typed, and rows someone holds are tinted. Save version (or a pause) makes the next
  version, as for docs. The Edit toggle is the only way to edit a sheet: there is still no source
  editor. A version published meanwhile (by an agent, the CLI, REST or a restore) is never merged
  into the page edits: editing pauses, and the editors review both sheets side by side, with the
  cells each side changed marked, and choose **Publish mine** (the page edits become the next
  version, and the other stays in the history) or **Discard mine** (pressed twice: it turns into
  "Discard for everyone"). When two people change rows at once, each change lands on the row it was
  made on, or is dropped with a note when that row is gone. While one editor publishes or discards,
  a second choice or a Discard from someone else waits with a note instead of undoing it, for docs
  too. A save that takes longer than 30 seconds keeps the edits made while it ran, for docs too,
  and never sends them to review against its own version. While a doc or sheet is edited on its
  page, a version published meanwhile no longer shows an "Updated to" notice (the strip says it,
  and the version picker follows), and at phone width the edit strip keeps to one line. Numbers
  are typed in your locale. Follows `ALLOW_LIVE_EDITING`. The agent's sheet rules say a
  `live_draft` on a sheet needs no action.
- **Compare says what changed, in words.** History's Compare page no longer shows a source diff.
  It lists what changed between the two versions the way the page shows it: "Under “Pricing”:
  paragraph changed" with the text before and after, "Slide 4 moved to 2", "B7 changed: 12 → 14",
  "color.brand.500 changed", boards added or resized, a page's title, text, links and images, and
  the files added, removed or replaced. A page restyled with nothing else changed says "Layout or
  formatting changed". A heading, paragraph, slide or row added before another reads as added,
  not as the next one renamed or changed: blocks pair by the words they share, never by their
  place alone, so a paragraph rewritten with none of its words kept reads as removed and added. Items come in the order the page reads, a changed list names only the item that
  changed, and a sheet total that only recomputed for an added row is left out. A large edit the
  diff gives up on still lists only the blocks that changed, a block added or removed in it
  included, and two same-titled slides edited in
  place are not listed as moved. Every type
  compares this way, designs included, and a whiteboard lists its settings in the Board settings
  dialog's words ("Background: Dots → Grid", "Who can change the board: Editors only → Commenters
  and editors"), with History's "Restore settings" unchanged. The two
  versions are still rendered side by side below the list, one at a time with a Before and After
  switch on a phone. Older links with `view=source` open the same page. Agents still read and write
  source as before.
- **The CLI publishes design systems.** `plinth publish <dir>` publishes a folder with
  `system.json` at its top (and its images and fonts) as a design system, `--id` updates one with
  only the changed files, and `plinth upload` sends one for a `start_upload` ticket. `system.json`
  is checked against the 1 MB limit before anything is sent. A folder with `index.html` at its top
  is still a page.
- **Open pages keep their place when a new version arrives.** A doc updates in place: the frame is
  not reloaded, the heading you were reading stays where it was, and an image the new version
  changed under the same name shows the new file. A page that loads
  `/__plinth/runtime.js` keeps its scroll position and where it was inside the artifact (a
  sub-page the new version no longer has opens at its root instead), and can hand state to the
  next version with `plinth.onVersion` (read back as `plinth.carried`). A page that declares `hold`
  (`<meta name="plinth-capabilities" content="hold">`) is not replaced while you are using it: a
  "v5 is available" toast offers Update instead. Every other page is replaced at once, as before.
  Follows `ALLOW_LIVE_VIEWS`; off, every update reloads the frame as before.
- **Follow the presenter in a deck.** An owner or editor can turn on **Lead viewers** in a deck's
  controls or presenter view, and the people the deck is shared with who have it open follow their
  slide, shown as "Following" in the deck's controls; paging by hand pauses it until
  they choose "Back to slide N". Someone who opens the deck mid-talk lands on the presenter's
  slide. Only slide numbers travel, over the deck's live room; nobody sees who else is watching.
  It needs live rooms (origin isolation and the `ROOMS` binding) and is on by default;
  `ALLOW_SLIDES_FOLLOW=false` turns it off. Link viewers without an identity do not follow. The lead carries on when an agent
  publishes a new version or the owner changes who the deck is shared with.
- **Download a design as PNG or PDF.** On instances with a Browser Rendering binding, a design's
  artifact menu has **Download .png** (the one artboard at once, or pick one when there are more;
  2x where it fits, else 1x, transparent where the board is) and **Download .pdf** (every board,
  each on a page of its own size) in place of Print or save as PDF, rendered by the server from
  the version on screen with the same safety as thumbnails. Anyone who may view the design can
  export it, except a token limited to one artifact (`token_bound`, as for thumbnails), up to 30
  times an hour per person (`DESIGN_EXPORTS_PER_HOUR`; signed out, per network), 20 times an hour
  per design for everyone but its owner and editors (`DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR`) and
  120 times an hour for the whole instance (`DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR`), which bounds
  the operator's browser time; at most two render at once across the instance, and
  `DESIGN_EXPORT=false` turns it off. A PNG is at most 4,000,000 pixels (a board of up to
  1,000,000 px at 2x, a 1080x1080 or 1920x1080 one at 1x only) and any file at most 24 MB, so one
  export cannot run the Worker out of memory. Scripts and agents use
  `GET /api/v1/artifacts/<id>/export?format=png&board=<id>&scale=1|2` or `?format=pdf` (every
  board, or `&board=<id>`), with `/export/options` listing the boards. Without the binding nothing
  changes: Print or save as PDF stays.
- **Thumbnail capture failures are logged without URLs**, so a capture's one-time enter token
  never reaches the Worker's logs.
- **Ask an agent.** People change an HTML page or a design by asking the owner's agent: **Ask an
  agent** (in the bar for owners and editors, in the ⋯ menu for commenters and at phone width)
  opens the comments panel in request mode, where they point at an element or a board, describe
  the change and, when the owner has more than one, pick the agent: Claude, Codex, or any other
  connected client such as ChatGPT, Cursor or Gemini. It reaches that agent as a mention, and is
  offered only when the owner has an agent that can take it. While editing a doc or a
  sheet on its page, **Ask an agent** in the ⋯ menu opens a dialog that keeps the edits, with
  **Publish my changes first** (off by default). Where editing on the page is off, the Edit slot
  shows Ask an agent with the reason. A toast confirms a sent request.
  `POST /api/v1/artifacts/:ref/comments` takes `request_to`
  (refused with `no_agent` when the owner has no such agent), and the viewer gate says who a
  request can go to (`ask`) and why editing is off (`live_off`).
- **Picking an element at phone width.** While a comment or a request picks an element, the
  comments sheet shrinks to its bottom bar, which sits under the artifact instead of covering it.
- **Sheet columns and row order on the page.** In a sheet's edit mode the bar's Row menu also
  moves the selected row up or down (Alt+Shift+Up and Down do too), and the Column menu freezes the
  columns up to the selected one or unfreezes them. A moved row keeps every formula pointing at the
  cells it meant, and a total moved next to its range never adds itself. Drag a header's edge (or
  press Alt+Left and Alt+Right on it) to change a column's width. The column settings add thousands
  separators, and a select column's options as a list to rename, reorder, add to (type it and press
  Enter) and remove from; renaming an option renames it in the cells that hold it, and an option a
  cell holds cannot be removed. The settings follow their column while someone else inserts or
  deletes one before it, and close only once the change is sent. At phone width a cell opens in an
  editor docked at the bottom of the page, under its address and the column's name, saved with
  Enter or its check button, and the settings are a sheet across the bottom. Focus and the
  selection have one ring colour, the app's. The grid is a proper grid for keyboards and screen
  readers: one tab stop, the arrows, Home and End, and cells someone else is editing say so. When
  someone else's change redraws the grid, the focus stays where you were typing (the column
  settings, the filter or a cell).
- **New and Import.** **New** on the dashboard starts a blank document or sheet that opens
  straight in edit mode, with the focus on its title or first cell (where editing on the page is
  on), or imports a spreadsheet (.xlsx, .csv or .tsv) as a new sheet, converted by Plinth as it is
  for agents. A sheet's ⋯ menu has **Replace with a file…**, which makes the next version from a
  file and keeps the link, sharing and comments; it asks again when a newer version was published
  meanwhile, is hidden while there are unpublished changes on the page, and asks a person confirmed
  by email code without an account to sign in first. HTML pages and designs still come only from
  agents. `POST /api/v1/artifacts` takes `note` for the first version.
- **Import and Replace say what a file loses.** Before a sheet is replaced, and in a toast after an
  import, the app says when only the first sheet of an .xlsx is used (naming the others), how many
  formulas become plain values, how many column names are cut to 100 characters, and when a CSV
  was not UTF-8. Such a CSV is now read as Windows-1252, as Excel on Windows saves it, so "Café"
  no longer arrives as "Caf�"; UTF-16 files with a byte order mark are read too. Replacing a sheet
  from its permanent version link now shows the new version on the sheet's own link. New appears
  once the list has loaded, so it no longer jumps from the top bar to the empty state, and file
  names in version notes drop control and bidi characters.
- **Edit docs as formatted text.** On a doc's page, a block opens as formatted text, with a
  format bar at selected text (bold, italic, code, strikethrough, link) and a block menu at its
  corner: **Turn into** another kind,
  **Insert below** (any kind, a divider, a table or an image), **Move up**, **Move down** and
  **Delete**. No
  Markdown is shown anywhere; Plinth writes the changes back as Markdown and keeps every block
  nobody touched byte for byte. A Move, Delete, Turn into or Insert below never runs the blocks
  around it together, even with no blank lines between them (a list that would join another takes a different bullet or
  number style, which looks the same), and neither does clearing a block's text, which removes the
  block the same way at once, so a Publish made while it is still open never has the old text, and what is typed in it meanwhile reaches the doc even when the block is closed first. The menu of a new, still empty block acts on that block. A
  link can go to any address the page links, spaces and
  accented letters included. A change the doc cannot take (at its size limit, or while not
  connected) says so and keeps the block open with what was typed. A block op cut off by a dropped
  connection says so and leaves editing free, and typing waiting for a lease is asked for again once
  the draft is back. An image's alt text opens from its menu (**Alt text**), and its **Ask an
  agent** (or **Insert below**, **Image**) opens the Ask dialog, whose "Pointing at" chip names
  the block by its first words as published, a list's items apart ("Pointing at “Maria: launch
  post · Ana…”"), or by its kind when it has none ("Pointing at the image"). The link field opens under the selected text (docked in the block at phone
  width), and the block menu stays inside the frame. Blocks the
  page cannot show faithfully as formatted text are shown as they are, with **Ask an agent** and
  the block menu (Move and Delete). The **+** between blocks is gone: **Insert below** or Enter
  adds a block. Opening a block moves nothing on the page and hides next to nothing: the format bar
  shows only for selected text, the block's menu sits on its edge, and heading anchors are hidden
  while editing. Punctuation typed at the edge of bold, italic or strikethrough is kept, and text
  the page cannot save as typed stays in its block, which stays open and keeps Publish off until
  it is changed.

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
