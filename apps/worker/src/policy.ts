// The single authorization module. Every read and write of an artifact, its versions, comments,
// sharing settings and mention tasks goes through these functions, on every request (REST, MCP
// and the content host). The UI only mirrors these decisions; it never makes them.
import {
  type Capabilities,
  type ClientType,
  type EffectiveRole,
  isPersonalDocId,
  type Role,
  type Scope,
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
  /** Visibility, password, allowlist, roles, title. */
  | "manage"
  | "delete"
  | "report"
  /** Read an artifact's shared data (agents and the app; the page goes through pageDataAccess). */
  | "data_read"
  /** Write an artifact's shared data. */
  | "data_write"
  /** Delete all of an artifact's shared data: the owner, signed in, never an agent. */
  | "data_clear"
  /** Read the artifact's open counts: the owner only. */
  | "views";

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
  | "scope";

export type Decision =
  | { allow: true; role: EffectiveRole | null }
  | { allow: false; reason: DenyReason; role: EffectiveRole | null };

const READ_ACTIONS: ReadonlySet<ArtifactAction> = new Set(["view", "report", "data_read", "views"]);

export function principalEmail(p: Principal): string | null {
  return p.kind === "anonymous" ? null : p.email;
}

export function principalUserId(p: Principal): string | null {
  return p.kind === "user" || p.kind === "agent" ? p.userId : null;
}

/** The scope an agent needs for an artifact action. */
export function scopeFor(action: ArtifactAction): Scope {
  return READ_ACTIONS.has(action) ? "artifacts:read" : "artifacts:write";
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
