// Response shapes for /api/v1 and MCP tool results (structuredContent). snake_case on the wire.

import type { ArtifactSource, ArtifactType } from "./artifactTypes.ts";
import type { CategoryRole, CategoryShareState, ReviewSkipReason } from "./categories.ts";
import type {
  ArtifactEditing,
  ClientType,
  CommentStatus,
  ContentIsolation,
  DataCapability,
  EffectiveRole,
  MentionState,
  PublishWarningCode,
  ReportState,
  Role,
  Visibility,
} from "./constants.ts";
import type { InvitationReport } from "./invitations.ts";
import type { LiveMode } from "./liveDoc.ts";
import type { Anchor } from "./schemas.ts";

export interface Author {
  kind: "user" | "connection";
  /** Person's name or email, or the connection label. Display text, never proof of role. */
  label: string;
  user_id: string | null;
  connection_id: string | null;
  /**
   * The artifact's owner wrote it (in person or through one of their agents), as the server knows
   * it, never from the label. The app marks the owner's versions with it, so a name chosen to look
   * like the owner's visibly lacks the mark. The Worker always sends it; absent reads as false.
   */
  is_owner?: boolean;
}

export interface ArtifactSummary {
  id: string;
  slug: string;
  title: string;
  /** "html" for a hand-written page, "doc" for a Markdown document. Fixed at publish. */
  type: ArtifactType;
  visibility: Visibility;
  current_version: number;
  version_count: number;
  created_at: string;
  updated_at: string;
  /** App page: APP_HOST/a/<slug>. */
  url: string;
  /** Artifact origin on the content host. Needs a viewer token unless already exchanged. */
  content_url: string;
  /**
   * Email and id are only shown to people with a role on the artifact (not to link viewers, nor to
   * a token limited to one artifact).
   */
  owner: { id: string | null; email: string | null; name: string | null };
  /** The caller's role on this artifact. */
  role: EffectiveRole;
  taken_down: boolean;
  /**
   * The current version's thumbnail (an image on the app host, same access as the artifact), or
   * null when this instance takes no thumbnails. It may answer 404 until the first capture lands.
   */
  thumbnail_url: string | null;
  /**
   * The owner's category (docs/spec.md "Categories"). null when unset, and always null for anyone
   * but the owner. Untrusted text.
   */
  category: string | null;
  /**
   * Where the artifact stands in its category's share (docs/spec.md "Category sharing and personal
   * categories"): `pending` until the owner reviews it, then `shared` or `private`. null when its
   * category is not shared, and always null for anyone but the owner. The Worker always sends it.
   */
  category_share?: CategoryShareState | null;
  /**
   * The signed-in person's own category for an artifact shared with them (never on their own
   * artifacts). Seen by that person only, in the app: null for everyone else and for agents.
   */
  my_category?: string | null;
  /**
   * `true` on the design system its owner chose as their default (docs/spec.md "Design systems",
   * The default design system): agents build slides, designs and pages with it without asking.
   * Sent only to the owner (never to a token limited to one artifact), and only when true.
   */
  default?: true;
}

export interface AssetInfo {
  path: string;
  size_bytes: number;
  content_type: string;
  /** Lowercase hex SHA-256 of the bytes, computed by the server. null for files stored before 0006. */
  sha256: string | null;
}

export interface ArtifactDetailBase extends ArtifactSummary {
  /** The version returned (current unless one was asked for). */
  version: number;
  /** The version file holding the source: "index.html" for a page, "content.md" for a doc. */
  source_path: string;
  /** The version's other files. Never lists a reserved path (index.html, content.md). */
  assets: AssetInfo[];
  /**
   * Docs, for owners and editors: people have unsaved page edits (metadata only; the draft text is
   * never returned to agents). Null when there are none. Absent for other types and roles.
   */
  live_draft?: LiveDraftMeta | null;
  /**
   * Where it is edited, for owners and editors (docs/spec.md "Published from code"): "code" when
   * its publisher said its source lives in code, so the next publish from there won't include page
   * edits; "page" otherwise. Absent for everyone else.
   */
  editing?: ArtifactEditing;
  /**
   * HTML pages that name a design system (`<meta name="plinth-design-system">`): that design
   * system, when the caller may view it and it is one; null otherwise. Absent when the page names
   * none, and for other types.
   */
  design_system?: DesignSystemReference | null;
  /**
   * An HTML deck (source deck.json): the text of deck.css and of every slides/<id>.html, so an
   * agent can change one slide and send the others back by sha256 (each is also in `assets`).
   * Untrusted, like all artifact text. Absent for other types and for a Markdown deck.
   */
  files?: { path: string; content: string }[];
  /**
   * The files this version holds that were copied from other artifacts (copy_files), one record
   * per source version and copy time. `title` and `current_version` only when the caller may view
   * that source now (null otherwise). Absent when the version holds no copies.
   */
  copied_from?: CopiedFrom[];
}

/**
 * Files copied from one version of another artifact by one publish (copy_files), as the version
 * records them: the source's id and version, when, and each file's path here and in the source.
 */
export interface CopyRecord {
  artifact: string;
  version: number;
  copied_at: string;
  files: { path: string; from: string }[];
}

/** A CopyRecord as get_artifact returns it, with the source as the caller may see it now. */
export interface CopiedFrom extends Omit<CopyRecord, "artifact" | "files"> {
  /** The source's id, or null when the caller may not view it now. */
  artifact: string | null;
  /** `from`, the file's path in the source, only when the caller may view it now. */
  files: { path: string; from?: string }[];
  title: string | null;
  current_version: number | null;
}

/** The design system an HTML page says it was built on, as get_artifact returns it. */
export interface DesignSystemReference {
  id: string;
  title: string;
  /** The version the page names, or null when it names none. */
  version: number | null;
  current_version: number;
}

/** Unsaved page edits of a doc (#36), as metadata. */
export interface LiveDraftMeta {
  /** The version the draft is based on. */
  base_version: number;
  /** Always true while a draft exists (a draft equal to its base is deleted). */
  dirty: boolean;
  /** Set while a version published meanwhile changed the same lines and needs review. */
  conflict_version: number | null;
  updated_at: string;
}

/**
 * One version of an artifact with its source: `html` for a page, `content` (Markdown) for a doc.
 * Use sourceOf() to read the source without caring which.
 */
export type ArtifactDetail = ArtifactDetailBase & ArtifactSource;

export interface VersionInfo {
  number: number;
  size_bytes: number;
  note: string | null;
  created_at: string;
  author: Author;
  /** Set when this version was published by restoring an older one. */
  restored_from: number | null;
}

export interface PublishResult {
  id: string;
  slug: string;
  type: ArtifactType;
  version: number;
  url: string;
  content_url: string;
  visibility: Visibility;
  /** Advisory: what the published files reference but will not load. [] on a restore. */
  warnings: PublishWarning[];
  /** How the version's files were stored: written now, or reused from earlier versions. */
  stored: StoredSummary;
  /** The stored (snapped) category, present only when this call set one. Never on a restore. */
  category?: string;
  /**
   * The owner's own results only, when the artifact's category is shared: filing never shares,
   * so a new filing is `pending` until the owner reviews it in the app (`review_url`).
   */
  category_share?: CategoryShareResult;
  /**
   * A whiteboard publish or update that carried a starting board: how many blocks and arrows were
   * written to its shared data. Absent otherwise, and when the board was not seeded (the result
   * then has the warning board_not_seeded).
   */
  board?: { blocks: number; arrows: number };
  /** The files this call copied from other artifacts (copy_files). Absent when it copied none. */
  copied_from?: CopyRecord[];
}

/** Where an artifact stands in its shared category, for its owner's own results. */
export interface CategoryShareResult {
  state: CategoryShareState;
  /** pending only: the dashboard's review dialog for that share. */
  review_url?: string;
}

/** One publish warning. Never blocks a publish. Text echoed from files is truncated and escaped. */
export interface PublishWarning {
  code: PublishWarningCode;
  /** The version file the reference is in. */
  file: string;
  /** The reference as written (truncated). */
  ref?: string;
  host?: string;
  /** For a warning reported once per file: how many references it covers. */
  count?: number;
  /** For a design system's warnings: where in system.json, like "components[0].examples[1].html". */
  path?: string;
  message: string;
}

export interface StoredSummary {
  /** Files in the version, the source included. */
  files: number;
  /** Files written to storage by this publish. */
  written: number;
  /** Files reused from an earlier version of the same artifact (no new object). */
  reused: number;
  /** Logical bytes of the version (what a viewer loads). */
  bytes: number;
  /** Bytes written to storage by this publish. */
  bytes_written: number;
}

/** This instance's publish limits (GET /api/v1/config and start_upload). */
export interface InstanceLimits {
  max_html_bytes: number;
  max_doc_bytes: number;
  /** MAX_VERSION_BYTES: source plus assets, uncompressed. */
  max_version_bytes: number;
  /** MAX_ASSETS_PER_VERSION */
  max_assets_per_version: number;
  max_asset_path_length: number;
  /** JSON body of an inline publish or update (POST/PUT /artifacts, /mcp). */
  max_request_bytes: number;
  /** Bytes on the wire of one bundle (POST /uploads/:id/bundle). */
  max_bundle_bytes: number;
  /** One file in a bundle. */
  max_bundle_file_bytes: number;
  /** A sheet's JSON lines (sheet.jsonl), its data rows and its columns. */
  max_sheet_bytes: number;
  max_sheet_rows: number;
  max_sheet_columns: number;
}

/** POST /api/v1/uploads and the start_upload MCP tool. */
export interface StartUploadResult {
  upload_id: string;
  /** Single use, shown once. Send it only in the Authorization header of the bundle request. */
  upload_token: string;
  expires_at: string;
  /** Absolute: <APP_ORIGIN>/api/v1/uploads/<upload_id>/bundle */
  upload_url: string;
  target: /**
   * `id` is reserved at mint: the artifact the bundle creates gets exactly this id, so after a
   * lost response get_artifact(id) says whether it was published (not_found: it was not).
   */
    | { mode: "publish"; id: string; type: ArtifactType }
    | {
        mode: "update";
        id: string;
        slug: string;
        type: ArtifactType;
        base_version: number;
        visibility: Visibility;
      };
  limits: InstanceLimits;
  content_isolation: ContentIsolation;
  /** Shell commands with a <folder> placeholder. npx only on release builds >= MIN_UPLOAD_CLI_VERSION. */
  commands: { curl: string; npx?: string };
  next: string;
  /**
   * The owner's own upload into a shared category: the state the artifact will be in once the
   * bundle commits (always `pending`).
   */
  category_share?: CategoryShareResult;
}

/**
 * GET /api/v1/uploads/:id with the upload token: whether that upload committed, for a client whose
 * bundle response was lost. `receiving` means a bundle request still holds the receiving lease.
 */
export interface UploadStatus {
  upload_id: string;
  /**
   * taken_down: the artifact was taken down, so nothing was published and it takes no new version
   * (the bundle is never to be sent again).
   */
  state: "open" | "receiving" | "used" | "dead" | "taken_down" | "expired" | "exhausted";
  mode: "publish" | "update";
  /** The artifact: the update's target, or the id a publish creates (reserved at mint). */
  id: string;
  /** The version the upload committed, once used. */
  version: number | null;
  /** The artifact's app URL, once used. */
  url: string | null;
  expires_at: string;
  receiving_until: string | null;
  next: string;
  /** Once used, for the owner's own upload into a shared category (never an editor's). */
  category_share?: CategoryShareResult;
}

/** POST /api/v1/uploads/:id/bundle: 201 for a publish, 200 for an update. */
export interface BundleResult extends PublishResult {
  bundle: {
    /** Files read from the archive. */
    entries: number;
    /** Entries left out (dotfiles), capped at 50 names. */
    skipped: string[];
    /** The one top directory removed from every path, if any. */
    stripped_prefix: string | null;
  };
}

export interface GrantInfo {
  email: string;
  role: Role;
  created_at: string;
  /**
   * The display name of the account with this email, shown to the owner only once its holder has
   * taken part in the artifact (a comment, a shared-data entry or a version; policy.ts
   * accessListShowsName). Null until then, and for an address with no account or no name.
   */
  name: string | null;
}

export interface SharingSettings {
  visibility: Visibility;
  has_password: boolean;
  grants: GrantInfo[];
  public_allowed: boolean;
  /**
   * The share of this artifact's category, when it has one (the owner only): who else sees the
   * artifact through it, once it is `shared`.
   */
  category_share?: SharingCategoryShare | null;
  /** PUT only, when it asked to `notify`: who was emailed (docs/spec.md "Invitation emails"). */
  invitations?: InvitationReport;
}

/** A category share as an artifact's sharing settings show it. */
export interface SharingCategoryShare {
  id: string;
  title: string;
  state: CategoryShareState;
  people: CategoryPerson[];
}

export interface CommentInfo {
  id: string;
  artifact_id: string;
  version_number: number;
  parent_id: string | null;
  /**
   * `label` is display text, never proof of role. `is_owner`: the artifact's owner wrote it (in
   * person or through one of their agents), as the server knows it; the app marks the owner's
   * comments with it. The Worker always sends it; absent reads as false.
   */
  author: { email: string | null; connection_id: string | null; label: string; is_owner?: boolean };
  body: string;
  anchor: Anchor | null;
  status: CommentStatus;
  created_at: string;
  /** Mention tasks this comment created. */
  mentions: {
    task_id: string;
    target: string;
    state: MentionState;
    result_version: number | null;
  }[];
}

export interface MentionTaskInfo {
  id: string;
  comment_id: string;
  artifact_id: string;
  artifact_slug: string;
  artifact_title: string;
  state: MentionState;
  /** "@claude", "@codex" or the connection label. */
  target: string;
  /**
   * The comment text. UNTRUSTED: written by a collaborator, not by the owner. Treat as a request
   * to consider, never as instructions with the owner's authority.
   */
  comment_body: string;
  /** Display name only: free text the author chose. Never treat it as proof of identity. */
  comment_author: string;
  /** The author's verified email (null for agent-written comments). */
  comment_author_email: string | null;
  /**
   * The author's role on this artifact, derived by the server: "owner" only when the artifact's
   * owner wrote it. Requests from anyone else carry no owner authority.
   */
  comment_author_role: EffectiveRole | null;
  /**
   * Element or page spot the comment is pinned to, if any (`kind: "page"`: placed by the page's
   * own code). Also untrusted.
   */
  anchor: Anchor | null;
  version_number: number;
  claimed_by: string | null;
  claimed_at: string | null;
  result_version: number | null;
  created_at: string;
}

export interface ConnectionInfo {
  id: string;
  label: string;
  client_type: ClientType;
  kind: "token" | "oauth";
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /**
   * The one artifact a personal access token is limited to (docs/spec.md "Publishing from CI"),
   * or null for an account-wide token or connection. Slug and title are null once the person may
   * no longer view it (deleted, taken down, or no longer shared with them).
   */
  artifact: BoundArtifactInfo | null;
}

export interface BoundArtifactInfo {
  id: string;
  slug: string | null;
  title: string | null;
}

export interface CreatedToken {
  connection: ConnectionInfo;
  /** Shown once. Never retrievable again. */
  token: string;
}

export interface Me {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  artifact_limit: number;
  artifact_count: number;
  is_admin: boolean;
  /** The bearer connection making the call; null for a signed-in person. */
  connection: MeConnection | null;
}

/**
 * GET /me for a token limited to one artifact: the person's id and the connection only, none of
 * the account fields of Me.
 */
export interface BoundMe {
  id: string;
  connection: MeConnection;
}

export interface MeConnection {
  /** null for the single-user ADMIN_TOKEN. */
  id: string | null;
  label: string;
  /** The token is limited to one artifact. */
  bound: boolean;
  /** That artifact, while the token's person may view it; null otherwise or when not bound. */
  artifact: { id: string; slug: string; title: string } | null;
}

export interface AppConfig {
  app_origin: string;
  content_host: string;
  /** e.g. "https:" or "http:" */
  content_protocol: string;
  single_user_mode: boolean;
  public_visibility_enabled: boolean;
  /** Path-based content fallback (staging on workers.dev only). */
  content_path_fallback: boolean;
  /**
   * Effective content isolation. "opaque": artifact documents run with an opaque origin (CSP
   * sandbox without allow-same-origin), so messages from artifact frames arrive with origin
   * "null". Always "opaque" with the path fallback.
   */
  content_isolation: ContentIsolation;
  environment: "development" | "staging" | "production";
  /**
   * Who runs this instance (OPERATOR_* settings), for its terms and privacy pages. null on an
   * instance whose operator published none (a personal or local instance).
   */
  operator: OperatorInfo | null;
  /** The email provider, named as a processor in the privacy notice. */
  email_provider: "sendgrid" | "resend" | "console";
  /** Default artifact quota per account (MAX_ARTIFACTS_PER_USER). */
  max_artifacts_per_user: number;
  /**
   * Plinth's source repository, linked from the banner under every artifact. null when the
   * operator turned the link off (SHOW_SOURCE_LINK=false).
   */
  source_url: string | null;
  /** This instance's publish limits (MAX_VERSION_BYTES, MAX_ASSETS_PER_VERSION and fixed ones). */
  limits: InstanceLimits;
  /** Hosts artifacts may load scripts and styles from (CDN_ALLOWLIST, the same list the CSP uses). */
  cdn_allowlist: string[];
  /** How long an upload ticket from start_upload stays valid, in seconds. */
  upload_ticket_ttl_s: number;
  /**
   * The review account's password sign-in (REVIEW_LOGIN_EMAIL and REVIEW_LOGIN_PASSWORD_HASH) is
   * on: the sign-in page links to /login/review. Off on almost every instance.
   */
  review_login: boolean;
  /**
   * VIEW_LOG_RETENTION_DAYS: how long each counted open is kept with who made it, for the privacy
   * notice and the owner's stats (docs/spec.md "Artifact stats").
   */
  view_log_retention_days: number;
  /**
   * Owners may share a category with people (ALLOW_CATEGORY_SHARING). The Worker always sends it;
   * absent reads as off.
   */
  category_sharing?: boolean;
  /**
   * Every artifact type, and whether this instance publishes it now: a whiteboard needs shared
   * data on and origin isolation. The Worker always sends it; absent reads as every type available.
   */
  artifact_types?: { id: ArtifactType; available: boolean }[];
  /**
   * How owners and editors edit docs, decks and sheets on their page here: "room" (live with each other,
   * with rooms), "solo" (alone, origin isolation without rooms), or null when editing on the page
   * is off (ALLOW_LIVE_EDITING=false, or opaque isolation and the path fallback). The Worker
   * always sends it; absent reads as null.
   */
  inline_editing?: "room" | "solo" | null;
  /**
   * Owners may have Plinth email the people they add (docs/spec.md "Invitation emails"): false when
   * the operator set INVITATION_EMAILS_PER_DAY=0, with EMAIL_PROVIDER=console outside development,
   * and in SINGLE_USER_MODE (config.ts invitationEmailsActive). The Worker always sends it; absent
   * reads as on.
   */
  invitation_emails?: boolean;
  /**
   * Open views apply new versions while keeping the reader's state (ALLOW_LIVE_VIEWS): a doc
   * updates in place, a page with the runtime carries its scroll, location and state, and a page
   * that declares `hold` waits while the viewer is using it. Absent or false: a new version
   * replaces the page, as before.
   */
  live_views?: boolean;
  /**
   * Designs can be downloaded as PNG or PDF rendered on the server (DESIGN_EXPORT with a Browser
   * Rendering binding). The Worker always sends it; absent reads as off.
   */
  design_export?: boolean;
}

/** GET /artifacts/:ref/export/options: what one version of a design can be downloaded as. */
export interface DesignExportOptions {
  id: string;
  version: number;
  /**
   * The version's artboards, in source order. Names are untrusted text. A board with
   * `auto_height` (height="auto") is as tall as its content when it renders; `height` is then its
   * least height.
   */
  boards: { id: string; name: string; width: number; height: number; auto_height?: boolean }[];
  /** The largest PNG, in device pixels (width x height x scale^2). */
  max_pixels: number;
}

export interface OperatorInfo {
  name: string;
  /** Registered (geographic) address. */
  address: string | null;
  /** Company registration or VAT number. */
  registration: string | null;
  /** The one published contact address: general, privacy, abuse and authorities. */
  email: string;
  /** The hosting provider named as a processor, e.g. "Cloudflare". */
  hosting: string;
}

/** GET /api/v1/view/:ref — what the viewer needs to do before the artifact can be shown. */
export type ViewGate =
  | {
      status: "ok";
      artifact: ViewArtifact;
      enter_url: string;
      role: EffectiveRole | null;
      /** Shared data, present only when the current version declares a capability. */
      data?: ViewGateData;
      /**
       * On-page editing of a doc: only for owners and editors on the current version, while live
       * editing is on under origin isolation. Absent otherwise.
       */
      live?: ViewGateLive;
      /**
       * The version being shown declares `comments` (HTML only): the page may open the comment
       * composer with its own anchors, and the frame never loads in review mode. Absent otherwise.
       */
      page_comments?: true;
      /**
       * Live views: open the watch socket (GET /api/v1/view/:id/watch) to learn of new versions,
       * and of shared-data changes, as they happen. Absent: poll as before.
       */
      watch?: true;
      /**
       * Who the page shows this viewer as, beyond the email `data` names, and whether it lists
       * the people it is shared with. Absent when there is nothing to tell.
       */
      people?: ViewGatePeople;
      /**
       * The current version declares `hold` (HTML only, while ALLOW_LIVE_VIEWS is on): while the
       * viewer is using the page (focus inside its frame), a newer version waits behind an Update
       * button instead of replacing it. Absent otherwise.
       */
      hold?: true;
      /**
       * Which of the owner's agents a mention can reach (docs/spec.md "Asking an agent"): present
       * for everyone who may mention them here (the owner, editors and commenters, never agents).
       * The composer suggests `@agent:other` when `other` is among them.
       */
      ask?: ViewGateAsk;
      /**
       * Editing on the page is off for this owner or editor of a live type on the current
       * version, and why. Never together with `live`.
       */
      live_off?: ViewGateLiveOff;
      /**
       * Published from code (docs/spec.md "Published from code"): with `live` only, the artifact's
       * publisher said its source lives in code, so edit mode says that the next publish from
       * there won't include page edits. Absent otherwise.
       */
      from_code?: true;
      /**
       * The version shown has no source editor although its type has one: an HTML deck, whose
       * source is deck.json and its slide files. The menus offer no Edit. Absent otherwise.
       */
      no_editor?: true;
    }
  | { status: "password_required"; artifact: ViewArtifactStub }
  | { status: "email_required"; artifact: ViewArtifactStub }
  | { status: "not_found" }
  | { status: "taken_down"; artifact: ViewArtifactStub };

/** How an owner or editor may edit this doc on its page (GET /view/:ref). */
export interface ViewGateLive {
  /** "room": live with the other editors; "solo": alone, Save makes a version. */
  mode: LiveMode;
  /** Confirmed by code without an account: they can watch, and must sign in to edit. */
  sign_in?: true;
  draft: LiveDraftInfo | null;
}

/**
 * Which of the owner's agents a mention can reach: the client types of the owner's connections
 * that can take mentions (not revoked, not limited to one artifact, with the `mentions` scope), in
 * CLIENT_TYPES order. Never a connection's label or id.
 */
export interface ViewGateAsk {
  targets: ClientType[];
}

/** Why editing on the page is off (ALLOW_LIVE_EDITING off, or opaque isolation). */
export type LiveOffReason = "disabled" | "isolation";

export interface ViewGateLiveOff {
  reason: LiveOffReason;
}

/** Unsaved page edits, as an editor is told about them. */
export interface LiveDraftInfo extends LiveDraftMeta {
  /** Whose edit was the last one flushed (an account's email), when known. */
  updated_by_email: string | null;
}

/** GET /api/v1/artifacts/:ref/live */
export interface LiveInfo {
  /** null: on-page editing is off here (ALLOW_LIVE_EDITING, or opaque isolation). */
  mode: LiveMode | null;
  draft: LiveDraftInfo | null;
  /** Doc sockets open now (room mode), or null when that cannot be read. */
  editors_online: number | null;
  idle_checkpoint_s: number;
  auto_checkpoint_min_s: number;
}

/** POST /api/v1/artifacts/:ref/live/checkpoint */
export type LiveCheckpointResult =
  | { saved: true; version: PublishResult; live: { rev: number; dirty: boolean } }
  | {
      saved: false;
      reason: "clean" | "unchanged" | "too_soon" | "busy";
      /** too_soon: an idle autosave can be tried again after this many seconds. */
      retry_in_s?: number;
    };

/** What the viewer is told about a page's shared data (the notice in the live viewer). */
export interface ViewGateData {
  /** Shared data works on this instance (on, and origin isolation). */
  available: boolean;
  capabilities: DataCapability[];
  /** The page gets an identity claim for this viewer. */
  identified: boolean;
  can_write: boolean;
  /** The email the page sees: only when identified and the page declares `viewer`. */
  email?: string;
  /**
   * The email the page's live room shows the other people in it (and the page): when the page
   * declares `room` and `viewer`, rooms are active and the viewer is identified.
   */
  room_email?: string;
}

/** What the viewer is told about names and the people list (docs/spec.md "Who is viewing"). */
export interface ViewGatePeople {
  /**
   * The viewer's display name, which the page sees and shows wherever it sees their email (the
   * `email` or `room_email` of the data block). Absent without a name.
   */
  name?: string;
  /** The page declares `people`: its owner and editors can list everyone it is shared with. */
  list?: true;
}

export interface ViewArtifactStub {
  id: string;
  slug: string;
  title: string;
}

export interface ViewArtifact extends ViewArtifactStub {
  type: ArtifactType;
  current_version: number;
  /** The version this gate opened (current, or the one asked for). */
  version: number;
  visibility: Visibility;
  owner_name: string | null;
}

export interface ReportInfo {
  id: string;
  artifact_id: string;
  artifact_slug: string;
  artifact_title: string;
  reason: string;
  reporter_email: string | null;
  state: ReportState;
  created_at: string;
}

/** One UTC day of instance activity (GET /api/v1/admin/stats). */
export interface StatsDay {
  day: string;
  users: number;
  artifacts: number;
  publishes: number;
  agent_publishes: number;
  views: number;
  artifacts_viewed: number;
}

/** GET /api/v1/admin/stats: instance-wide aggregates. Never names an artifact, owner or viewer. */
export interface AdminStats {
  generated_at: string;
  days: number;
  view_counts: boolean;
  totals: {
    users: number;
    artifacts: number;
    artifacts_by_visibility: Record<Visibility, number>;
    artifacts_taken_down: number;
    versions: number;
    agent_versions: number;
    storage_bytes: number;
    data_docs: number;
    data_bytes: number;
    data_artifacts: number;
    connections: number;
    connections_by_client: Record<ClientType, number>;
    views: number;
    open_reports: number;
  };
  window: {
    new_users: number;
    new_artifacts: number;
    publishes: number;
    agent_publishes: number;
    connections_used: number;
    views: number;
    artifacts_viewed: number;
  };
  series: StatsDay[];
}

/** The windows an owner's artifact stats cover, in UTC days (GET /api/v1/artifacts/:ref/stats). */
export type StatsRange = 7 | 30 | 90 | 365;

/**
 * How a counted open's viewer is known (artifact_opens.viewer_kind). `user`: signed in to an
 * account. `email`: confirmed an allowlisted email by code, without an account. `anonymous`: a link,
 * public or password visitor. `unknown`: counted before viewers were recorded, or the person was
 * erased since.
 */
export type OpenViewerKind = "user" | "email" | "anonymous" | "unknown";

/** The role an open was made with: a grant's role, or how the page was reached without one. */
export type OpenRole = "editor" | "commenter" | "viewer" | "public" | "link" | "password";

/** One identified person in an artifact's stats, over the window. */
export interface ArtifactStatsPerson {
  /** The account's display name; null for an email viewer or an account without one. */
  name: string | null;
  email: string;
  /** `user` when their last open was signed in, `email` when by an emailed code. */
  kind: "user" | "email";
  /** The role of their last open in the window. */
  role: OpenRole | null;
  /** Their first and last open in the window (UTC ISO). */
  first_opened_at: string;
  last_opened_at: string;
  opens: number;
  /** The version their last open showed; null for opens counted before versions were recorded. */
  last_version_seen: number | null;
}

/** One UTC day of an artifact's opens. `viewers` counts people and anonymous visitors. */
export interface ArtifactStatsDay {
  day: string;
  opens: number;
  viewers: number;
}

/** Opens of one version over the window. */
export interface ArtifactStatsVersion {
  version: number;
  opens: number;
  viewers: number;
}

/**
 * GET /api/v1/artifacts/:ref/stats and get_artifact_stats with an id: one artifact's opens, for its
 * owner only. "Viewers" are the distinct people plus the distinct anonymous visitors.
 */
export interface ArtifactStats {
  /** Whether this instance records opens (VIEW_COUNTS). */
  enabled: boolean;
  days: StatsRange;
  /** VIEW_LOG_RETENTION_DAYS: opens older than this keep only their count. */
  retention_days: number;
  current_version: number;
  totals: {
    opens: number;
    viewers: number;
    /** Distinct identified people (accounts and confirmed emails). */
    people: number;
    /** Distinct anonymous visitors: browsers, approximate (docs/spec.md "Artifact stats"). */
    anonymous_visitors: number;
    anonymous_opens: number;
    /** Every counted open, including those older than the log keeps. */
    all_time_opens: number;
    /** The first UTC day with a counted open (`all_time_opens` counts from it), or null. */
    since: string | null;
  };
  /** One entry per UTC day of the window, oldest first, zero-filled. */
  series: ArtifactStatsDay[];
  /** People who opened it in the window, last opened first, at most LIMITS.maxStatsPeople. */
  people: ArtifactStatsPerson[];
  /** How many people opened it in the window (`people` may be cut to the limit). */
  people_total: number;
  /** Versions opened in the window, newest first. */
  versions: ArtifactStatsVersion[];
}

/** One of the caller's artifacts in their stats summary. */
export interface ArtifactStatsSummaryItem {
  id: string;
  slug: string;
  title: string;
  type: ArtifactType;
  visibility: Visibility;
  current_version: number;
  opens_7d: number;
  opens_30d: number;
  viewers_7d: number;
  viewers_30d: number;
  all_time_opens: number;
  /** The last counted open the log still holds (UTC ISO), or null. */
  last_opened_at: string | null;
}

/**
 * GET /api/v1/stats/artifacts and get_artifact_stats without an id: the caller's own live artifacts
 * (not deleted, not taken down), most recently opened first.
 */
export interface ArtifactStatsSummary {
  enabled: boolean;
  retention_days: number;
  generated_at: string;
  items: ArtifactStatsSummaryItem[];
}

export interface Paged<T> {
  items: T[];
}

/** POST /api/v1/auth/login. The same body whether or not the address has an account. */
export interface LoginRequestResult {
  ok: true;
}

/** POST /api/v1/auth/verify-code and /auth/verify-link. The session cookie is set alongside. */
export interface LoginResult {
  ok: true;
  user: { id: string; email: string };
}

/** GET /api/v1/oauth/requests/:id — what the consent page shows. */
export interface OAuthRequestInfo {
  id: string;
  client_id: string;
  /** Name the client registered itself with. Untrusted: any client can pick any name. */
  client_name: string | null;
  /** Host (and port) the browser returns to after consent, the part a person can check. */
  redirect_host: string;
  redirect_uri: string;
  scopes: string[];
  expires_at: string;
}

/** POST /api/v1/oauth/consent. The SPA navigates to `redirect_to` with location.href. */
export interface OAuthConsentResult {
  redirect_to: string;
}

/** GET /api/v1/__dev/outbox?to=<email> item (development only). */
export interface DevOutboxItem {
  to: string;
  subject: string;
  text: string;
  created_at: string;
}

/** One of the caller's own category names and how many live artifacts use it. */
export interface CategoryCount {
  name: string;
  count: number;
  /** The owner shares this category with people (listed even with no artifact in it yet). */
  shared?: true;
}

/** list_artifacts and GET /api/v1/artifacts: the artifacts plus the caller's own category names. */
export interface ArtifactList {
  items: ArtifactSummary[];
  /** The caller's own categories, most-used first, whatever the query or filter. */
  categories: CategoryCount[];
  /**
   * The signed-in person's own categories for artifacts shared with them, most-used first (the
   * app only; never sent to agents).
   */
  my_categories?: CategoryCount[];
}

// ---------- category sharing (docs/spec.md "Category sharing and personal categories") ----------

/** One person a category is shared with. */
export interface CategoryPerson {
  email: string;
  role: CategoryRole;
}

/** GET /api/v1/category-shares item: one of the owner's shares. */
export interface CategoryShareSummary {
  id: string;
  /** The owner's category name (owner only). */
  category: string;
  /** What the people see: the portal's heading. */
  title: string;
  /** The portal: APP_HOST/p/<id>. */
  portal_url: string;
  people: CategoryPerson[];
  counts: { shared: number; pending: number; private: number };
}

/** One artifact of a shared category, as the owner's review shows it. */
export interface CategoryShareArtifact {
  id: string;
  slug: string;
  title: string;
  current_version: number;
  category_rev: number;
  state: CategoryShareState;
  taken_down: boolean;
  updated_at: string;
  /** Who published the current version: a person's name or email, or a connection label. */
  last_author: string | null;
}

/** GET /api/v1/category-shares/preview?category=: what sharing a category would ask to review. */
export interface CategorySharePreview {
  /** The owner's name for it. */
  category: string;
  artifacts: CategoryShareArtifact[];
}

/** GET /api/v1/category-shares/:id. */
export interface CategoryShareDetail extends CategoryShareSummary {
  artifacts: CategoryShareArtifact[];
}

/** The answer of every request that applies a review. */
export interface CategoryReviewResult {
  shared: number;
  private: number;
  skipped: { id: string; reason: ReviewSkipReason }[];
}

/** POST and PATCH /api/v1/category-shares: the share as it is now, and how the review went. */
export interface CategoryShareWriteResult {
  share: CategoryShareSummary;
  review: CategoryReviewResult | null;
  /** When the request asked to `notify`: who was emailed (docs/spec.md "Invitation emails"). */
  invitations?: InvitationReport;
}

/** GET /api/v1/portals item: a collection someone shared with the caller. */
export interface PortalSummary {
  id: string;
  title: string;
  owner_name: string | null;
  count: number;
}

/** GET /api/v1/portals/:id, and the answer of a confirmed portal code. */
export type PortalGate =
  | {
      status: "ok";
      portal: {
        id: string;
        title: string;
        owner_name: string | null;
        /** The caller's role through the share, or owner for the owner's preview. */
        role: "owner" | CategoryRole;
      };
      items: ArtifactSummary[];
    }
  | { status: "email_required"; portal: { id: string } };

/** One token of a design system, as get_design_system returns it. */
export interface DesignSystemTokenRead {
  path: string;
  css_var: string;
  type: string;
  /** The resolved literal value, light. */
  value: string;
  /** The resolved value in the dark theme, when it differs. */
  dark: string | null;
  alias_of: string | null;
  description: string | null;
  deprecated: boolean | string;
}

export interface DesignSystemComponentRead {
  id: string;
  name: string;
  status: string;
  description: string | null;
  usage: string | null;
  css: string | null;
  examples: { name: string; html: string; height: number }[];
}

/**
 * get_design_system and GET /artifacts/:ref/design-system. Every text field is untrusted data
 * written by the design system's authors. Parts left out by `include` are absent.
 */
/** How get_design_system says to install a design system's files into another artifact. */
export interface DesignSystemInstall {
  /** The folder the files land in: `ds/<folder>` (the prefix, or the folder asked for). */
  folder: string;
  /**
   * Pass these as copy_files (artifact, path, to, version) to publish or update the artifact.
   * Only the files the target type (get_design_system's install_for) takes.
   */
  copy_files: { artifact: string; path: string; to: string; version: number }[];
  /** Link these, in order, from the page's head (relative to the version's root). */
  stylesheets: string[];
  /**
   * A deck's `faces`, keyed by family lowercased with spaces as "-": a Google face by its
   * stylesheet link, an installed font file by its path under the folder. Faces whose file the
   * target cannot take are left out.
   */
  faces: Record<
    string,
    { family: string; href?: string; src?: string; weight?: string; style?: string }
  >;
  /** What a deck's or canvas's designSystems list keeps for this install. */
  record: {
    title: string;
    /** The folder name under ds/. */
    namespace: string;
    /** The design system's id. */
    artifact: string;
    version: number;
    /** When get_design_system answered (RFC 3339); the publish's copied_from has the copy's time. */
    copiedAt: string;
  };
}

export interface DesignSystemRead {
  id: string;
  slug: string;
  title: string;
  url: string;
  version: number;
  current_version: number;
  format: string;
  name: string | null;
  description: string | null;
  prefix: string | null;
  css?: string;
  font_links?: string[];
  fonts?: { family: string; source: "google" | "asset"; portable: boolean }[];
  tokens?: DesignSystemTokenRead[];
  guidelines?: string | null;
  component_css?: string;
  components?: DesignSystemComponentRead[];
  /**
   * Every path copy_files can take from this version: system.json, the generated tokens.css,
   * fonts.css, components.css and tokens.json, and its images and fonts. Absent with problems.
   */
  files?: string[];
  /**
   * The copy_files entries that install this version into another artifact under
   * `ds/<prefix>/`, and the stylesheets to link from there. Absent with problems.
   */
  install?: DesignSystemInstall;
  /** Why a stored version no longer parses (a newer rule, or a restore of an old version). */
  problems: { path: string; message: string }[];
  untrusted: true;
}

// ---------- sheets (read_sheet, edit_sheet) ----------

/** A computed value: an error is { error: "#DIV/0!" } and the like. */
export type SheetReadValue = null | number | boolean | string | { error: string };

/** A cell as read_sheet returns it: a literal, or a formula with its computed value. */
export type SheetReadCell = null | number | boolean | string | { f: string; v?: SheetReadValue };

export interface SheetReadColumn {
  letter: string;
  name: string;
  type: string;
  format?: { style: string; decimals?: number; currency?: string; grouping?: boolean };
  options?: string[];
}

/** read_sheet and GET /api/v1/artifacts/:ref/sheet. */
export interface SheetRead {
  id: string;
  slug: string;
  type: "sheet";
  title: string;
  version: number;
  current_version: number;
  columns: SheetReadColumn[];
  /** Data rows (the header is row 1 and not counted). */
  row_count: number;
  /** The range the rows cover, or null when it holds no cells. */
  range: string | null;
  rows: { row: number; cells: SheetReadCell[] }[];
  truncated: boolean;
  /** The range to read next when truncated, else null. */
  next_range: string | null;
  warnings: { code: "eval_budget"; message: string }[];
  untrusted: true;
}

/** edit_sheet and POST /api/v1/artifacts/:ref/sheet/edits. */
export interface SheetEditResult extends PublishResult {
  changed: {
    cells: number;
    rows_inserted: number;
    rows_deleted: number;
    columns_inserted: number;
    columns_deleted: number;
  };
}
