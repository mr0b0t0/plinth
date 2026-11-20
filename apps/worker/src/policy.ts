// The single authorization module. Every read and write of an artifact, its versions, comments,
// sharing settings and mention tasks goes through these functions, on every request (REST, MCP
// and the content host). The UI only mirrors these decisions; it never makes them.
import {
  type ArtifactType,
  type Capabilities,
  type ClientType,
  type DictationAccess,
  type EffectiveRole,
  isPersonalDocId,
  type Role,
  type RoomDocRight,
  type RoomEmitRight,
  type RoomKind,
  type Scope,
  TYPE_REGISTRY,
  type Visibility,
} from "@plinth/shared";

export type Principal =
  /** No credentials. */
  | { kind: "anonymous" }
  /** A viewer who confirmed an email by code but has no account (app-host viewer cookie). */
  | { kind: "viewer"; email: string }
  /** A signed-in person (session cookie). */
  | { kind: "user"; userId: string; email: string; isAdmin: boolean }
  /** An agent acting as a user through a connection (OAuth or personal access token). */
  | {
      kind: "agent";
      userId: string;
      email: string;
      /** null only for the single-user ADMIN_TOKEN. */
      connectionId: string | null;
      connectionLabel: string;
      clientType: ClientType;
      scopes: ReadonlySet<Scope>;
    };

export type ArtifactAction =
  /** Open the content, see metadata and the version list. */
  | "view"
  /** Post a comment or reply, resolve a thread. */
  | "comment"
  /** Mention an agent in a comment (creates a task for the owner's agent). */
  | "mention"
  /** Save a new version (editor, update_artifact). */
  | "edit"
  /** Publish an old version as the next one. */
  | "restore"
  /** Visibility, password, allowlist, roles, title, category. */
  | "manage"
  | "delete"
  | "report"
  /** Read an artifact's shared data (agents and the app; the page goes through pageDataAccess). */
  | "data_read"
  /** Write an artifact's shared data. */
  | "data_write"
  /** Delete all of an artifact's shared data: the owner, signed in, never an agent. */
  | "data_clear"
  /**
   * Read the artifact's stats (who opened it, when, how often, which version): the owner only. An
   * agent needs artifacts:read. The name predates the stats; other code enumerates it.
   */
  | "views"
  /**
   * Read, save or discard a doc's live page draft (#36): an owner or editor who is signed in.
   * Agents never (they push versions), and a viewer confirmed by code must sign in first.
   */
  | "live_edit";

export interface ArtifactFacts {
  ownerId: string;
  visibility: Visibility;
  hasPassword: boolean;
  deleted: boolean;
  takenDown: boolean;
}

export interface AccessFacts {
  /** The principal's grant on this artifact (by email), if any. */
  grantRole: Role | null;
  /** The principal passed this artifact's password (app-host password cookie). */
  passwordPassed: boolean;
  /** ALLOW_PUBLIC_VISIBILITY; when off, public behaves like unlisted. */
  publicEnabled?: boolean;
  /** The principal is an instance admin (takedown review). */
  isAdmin?: boolean;
}

export type DenyReason =
  | "not_found"
  | "login_required"
  | "password_required"
  | "email_required"
  | "forbidden"
  | "taken_down"
  | "scope"
  /** The principal has the role but no account session (a viewer confirmed by code). */
  | "account_required";

export type Decision =
  | { allow: true; role: EffectiveRole | null }
  | { allow: false; reason: DenyReason; role: EffectiveRole | null };

/** The scope an agent needs for each artifact action, one per line. */
const ACTION_SCOPES: Record<ArtifactAction, Scope> = {
  view: "artifacts:read",
  comment: "artifacts:write",
  mention: "artifacts:write",
  edit: "artifacts:write",
  restore: "artifacts:write",
  manage: "artifacts:write",
  delete: "artifacts:write",
  report: "artifacts:read",
  data_read: "artifacts:read",
  data_write: "artifacts:write",
  data_clear: "artifacts:write",
  views: "artifacts:read",
  live_edit: "artifacts:write",
};

export function principalEmail(p: Principal): string | null {
  return p.kind === "anonymous" ? null : p.email;
}

export function principalUserId(p: Principal): string | null {
  return p.kind === "user" || p.kind === "agent" ? p.userId : null;
}

/** The scope an agent needs for an artifact action. */
export function scopeFor(action: ArtifactAction): Scope {
  return ACTION_SCOPES[action];
}

/** Effective role, ignoring visibility: owner, a granted role, or null. */
export function roleOf(
  p: Principal,
  artifact: ArtifactFacts,
  access: AccessFacts,
): EffectiveRole | null {
  const uid = principalUserId(p);
  if (uid && uid === artifact.ownerId) return "owner";
  return principalEmail(p) ? access.grantRole : null;
}

const deny = (reason: DenyReason, role: EffectiveRole | null = null): Decision => ({
  allow: false,
  reason,
  role,
});

export function decide(
  p: Principal,
  action: ArtifactAction,
  artifact: ArtifactFacts,
  access: AccessFacts,
): Decision {
  if (artifact.deleted) return deny("not_found");
  if (p.kind === "agent" && !p.scopes.has(scopeFor(action))) return deny("scope");

  const role = roleOf(p, artifact, access);
  const isAdmin = access.isAdmin === true && p.kind === "user";

  if (artifact.takenDown) {
    // Only the owner may still manage or delete it; an admin may look at it to review a report.
    if (role === "owner" && (action === "manage" || action === "delete"))
      return { allow: true, role };
    if (isAdmin && action === "view") return { allow: true, role };
    return deny("taken_down", role);
  }

  switch (action) {
    case "view":
    case "report":
      return canView(p, artifact, access, role, isAdmin);
    case "comment":
    case "mention": {
      const v = canView(p, artifact, access, role, isAdmin);
      if (!v.allow) return v;
      return role === "owner" || role === "editor" || role === "commenter"
        ? { allow: true, role }
        : deny(p.kind === "anonymous" ? "login_required" : "forbidden", role);
    }
    case "edit":
    case "restore":
      return role === "owner" || role === "editor"
        ? { allow: true, role }
        : deny(p.kind === "anonymous" ? "login_required" : "forbidden", role);
    case "manage":
    case "delete":
      return role === "owner"
        ? { allow: true, role }
        : deny(p.kind === "anonymous" ? "login_required" : "forbidden", role);
    case "data_read":
    case "data_write":
      return role === "owner" || role === "editor"
        ? { allow: true, role }
        : deny(p.kind === "anonymous" ? "login_required" : "forbidden", role);
    case "data_clear":
      return role === "owner" && p.kind === "user"
        ? { allow: true, role }
        : deny(p.kind === "anonymous" ? "login_required" : "forbidden", role);
    case "views":
      return role === "owner"
        ? { allow: true, role }
        : deny(p.kind === "anonymous" ? "login_required" : "forbidden", role);
    case "live_edit":
      if (role !== "owner" && role !== "editor")
        return deny(p.kind === "anonymous" ? "login_required" : "forbidden", role);
      if (p.kind === "user") return { allow: true, role };
      return deny(p.kind === "viewer" ? "account_required" : "forbidden", role);
  }
}

function canView(
  p: Principal,
  artifact: ArtifactFacts,
  access: AccessFacts,
  role: EffectiveRole | null,
  isAdmin: boolean,
): Decision {
  if (role) return { allow: true, role };
  if (isAdmin) return { allow: true, role: null };
  switch (artifact.visibility) {
    case "public":
    case "unlisted":
      return { allow: true, role: null };
    case "password":
      // An artifact set to password with no password set is closed to everyone but grants.
      if (!artifact.hasPassword) return deny("forbidden");
      return access.passwordPassed ? { allow: true, role: null } : deny("password_required");
    case "allowlist":
      // Listed emails have a grant and returned above.
      return deny(p.kind === "anonymous" ? "email_required" : "forbidden");
  }
}

// ---------- shared data on the page (content host, content cookie) ----------

/** The identity a content cookie carries for an identified viewer (sealed claim, opened). */
export interface PageClaim {
  email: string;
  role: EffectiveRole;
  /** u_ + 24 hex, per artifact and email (crypto.ts viewerIdFor). */
  viewerId: string;
  /**
   * The gate's principal was signed in (not a viewer confirmed by code). Only then may a doc
   * editor write the live draft; passes issued without the flag watch.
   */
  account?: boolean;
}

/**
 * What a page may do with its artifact's shared data. `enabled` is sharedDataActive(config).
 * Anyone with a content pass may read once the current version declares `data`; only identified
 * viewers write; authors and the viewer's email are visible only to identified viewers on a page
 * that also declares `viewer`.
 */
export function pageDataAccess(
  claim: PageClaim | null,
  caps: Capabilities | null,
  enabled: boolean,
): { read: boolean; write: boolean; seeIdentity: boolean } {
  const read = enabled && caps?.data === true;
  const write = read && claim !== null;
  return { read, write, seeIdentity: write && caps?.viewer === true };
}

/**
 * May this writer create, update or delete this document? Rules, in order:
 * 1. creating a personal (u_) id other than the writer's own: forbidden, for every role;
 * 2. any other create: allowed;
 * 3. owner or editor: allowed (moderation);
 * 4. a personal doc: only by its person;
 * 5. otherwise: in a collection the page declares shared, or by the document's creator.
 * A null writer (anonymous link viewer) is read-only. Agents and app writers pass their user's
 * email, role and viewer id. The guarded write repeats the ownership condition in SQL.
 */
export function canModifyDoc(
  writer: PageClaim | null,
  doc: { docId: string; creatorEmail: string | null },
  op: "create" | "update" | "delete",
  collectionShared: boolean,
): { allow: true } | { allow: false; reason: "read_only" | "forbidden" } {
  if (!writer) return { allow: false, reason: "read_only" };
  const no = { allow: false, reason: "forbidden" } as const;
  const personal = isPersonalDocId(doc.docId);
  if (op === "create") return personal && doc.docId !== writer.viewerId ? no : { allow: true };
  if (writer.role === "owner" || writer.role === "editor") return { allow: true };
  if (personal) return doc.docId === writer.viewerId ? { allow: true } : no;
  return collectionShared || doc.creatorEmail === writer.email ? { allow: true } : no;
}

// ---------- live rooms on the page (content host, content cookie) ----------

/** What a socket on an artifact's room may do. */
export interface RoomAccess {
  join: boolean;
  /**
   * Which topics this socket may emit: `all` (owners and editors on a page room), `open`
   * (commenters: the page's open topics), `none` (viewers, and every doc socket).
   */
  emit: RoomEmitRight;
  /** The page's plinth-room-open topics, as declared (what `open` allows). */
  openTopics: string[];
  /** Peers carry email and role. */
  seeIdentity: boolean;
  /** On a doc socket: follow the live draft, or edit it. */
  doc: RoomDocRight;
}

const NO_ROOM: RoomAccess = {
  join: false,
  emit: "none",
  openTopics: [],
  seeIdentity: false,
  doc: "none",
};

/**
 * May this viewer join the artifact's room, and what may they do there? `active` is
 * roomsActive(config, env); `caps` the current version's declaration; `type` the artifact's type.
 * Only identified viewers join (no anonymous link viewers in v1). A page room needs an HTML
 * artifact that declares `room`: everyone identified joins and sets presence; owners and editors
 * emit any topic, commenters only the page's open topics, and viewers never emit (as Claude's
 * artifact `room` capability, which never lets a plain viewer emit). Identities show only with
 * `viewer`. A doc socket is Plinth's own editing channel for types with liveEdit: owners and
 * editors only, who see each other's emails; signed-in ones write, ones confirmed by code watch.
 * Checked at the upgrade, and through the room's stamped header on every message.
 */
export function roomAccess(
  claim: PageClaim | null,
  caps: Capabilities | null,
  kind: RoomKind,
  ctx: { active: boolean; type: ArtifactType },
): RoomAccess {
  if (!ctx.active || !claim) return NO_ROOM;
  const editor = claim.role === "owner" || claim.role === "editor";
  if (kind === "doc") {
    if (!TYPE_REGISTRY[ctx.type]?.liveEdit || !editor) return NO_ROOM;
    return {
      join: true,
      emit: "none",
      openTopics: [],
      seeIdentity: true,
      doc: claim.account === true ? "write" : "watch",
    };
  }
  if (ctx.type !== "html" || caps?.room !== true) return NO_ROOM;
  return {
    join: true,
    emit: editor ? "all" : claim.role === "commenter" ? "open" : "none",
    openTopics: [...caps.roomOpen],
    seeIdentity: caps.viewer === true,
    doc: "none",
  };
}

/** Can this agent see and act on a mention task? Only the owner's agents, matching the target. */
export function canActOnMention(
  p: Principal,
  task: { targetConnection: string | null; targetClientType: ClientType | null },
  artifactOwnerId: string,
): boolean {
  if (p.kind !== "agent" || !p.scopes.has("mentions")) return false;
  if (p.userId !== artifactOwnerId) return false;
  if (task.targetConnection) return p.connectionId === task.targetConnection;
  return task.targetClientType === p.clientType;
}

/**
 * Owner-only metadata (the category) is the owner's own organisation: hidden from every other role,
 * including editors and an admin reviewing a report.
 */
export function seesOwnerMetadata(role: EffectiveRole | null): boolean {
  return role === "owner";
}

/**
 * Renaming or merging a category across the owner's artifacts: the signed-in owner only, never an
 * agent or bearer token (as data_clear). The service scopes the rows to the caller's own.
 */
export function mayBulkEditCategories(p: Principal): boolean {
  return p.kind === "user";
}

/** Can this principal manage its own connections and tokens? People only, never agents. */
export function canManageConnections(p: Principal): p is Extract<Principal, { kind: "user" }> {
  return p.kind === "user";
}

/** Can this principal set public visibility? Needs the flag, a verified email and account age. */
export function canMakePublic(opts: {
  enabled: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  minAccountAgeHours: number;
  now?: number;
}): boolean {
  if (!opts.enabled || !opts.emailVerifiedAt) return false;
  const ageMs = (opts.now ?? Date.now()) - Date.parse(opts.createdAt);
  return ageMs >= opts.minAccountAgeHours * 3600 * 1000;
}

/** Admin pages (reports, takedown). */
export function isAdmin(p: Principal): boolean {
  return p.kind === "user" && p.isAdmin;
}

// ---------- voice: dictation on the page (app host, the viewer gate) ----------

/**
 * May this viewer dictate into this page? There is no server resource behind dictation: the
 * decision travels in the gate and the app (Plinth's own code on APP_HOST) enforces it, while the
 * app's Permissions-Policy keeps every frame away from the microphone whatever the page does.
 * `identity` is the gate's identified viewer (the owner, or a grant holder confirmed by sign-in or
 * email code), null for anonymous link viewers and admins without a role; `active` is
 * dictationActive(config); `caps` the current version's declaration. Rules, in order: an HTML page
 * that declares `dictation`; origin isolation; the switch; an identified viewer.
 */
export function dictationAccess(
  identity: { email: string; role: EffectiveRole } | null,
  caps: Capabilities | null,
  ctx: { active: boolean; isolation: "origin" | "opaque"; type: ArtifactType },
): DictationAccess {
  if (ctx.type !== "html" || caps?.dictation !== true) {
    return { available: false, reason: "not_declared" };
  }
  if (ctx.isolation !== "origin") return { available: false, reason: "opaque_isolation" };
  if (!ctx.active) return { available: false, reason: "disabled" };
  if (!identity) return { available: false, reason: "not_identified" };
  return { available: true, reason: null };
}
