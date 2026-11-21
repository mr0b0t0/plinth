// Who has access to an artifact, with display names (docs/spec.md "Who is viewing: names and the
// people list"): the owner and every grant, never who opened the page or when. One list serves the
// page (content/people.ts), agents (list_artifact_data's summary) and REST
// (GET /api/v1/artifacts/:ref/people), all only on a page that declares `data viewer people`
// (policy.ts peopleListOffered), plus the names in the owner's sharing settings. Callers decide
// access through policy.ts first. The list holds the direct grants and, with category sharing on,
// the people the artifact reaches through its shared category (policy.ts categoryRoleOf decides
// which). Search runs only over this one list (at most the owner, LIMITS.maxAllowlistEmails direct
// grants and one share's people), and a grant holder's name shows only once they have taken part
// (policy.ts accessListShowsName): nothing here takes an address the caller typed and says whether
// it has an account or what it is called. Names, emails and queries are never logged.
import {
  type CategoryRole,
  type EffectiveRole,
  pageDisplayName,
  RATE_LIMITS,
  type Role,
} from "@plinth/shared";
import { viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { accessListShowsName, type CategoryArtifactFacts, grantedRole } from "../policy.ts";

/**
 * The refusal (403 forbidden) for an owner or editor on a page that declares the list while a
 * served version's writer may not read it (policy.ts peopleListOffered), on the page route and REST.
 */
export const PEOPLE_WRITER_REFUSED =
  "A version of this artifact was published with a token limited to one artifact, or by an " +
  "account that is gone, so it lists nobody";

export interface Person {
  /** The per-artifact `u_` viewer id (crypto.ts viewerIdFor). */
  id: string;
  email: string;
  /** Null without a name, or while policy.ts accessListShowsName keeps it back. */
  name: string | null;
  role: EffectiveRole;
}

interface AccessRow {
  email: string;
  name: string | null;
  role: EffectiveRole;
  /** 1 when this grant holder has written a comment, a shared-data entry or a version here. */
  took_part: number;
  /** 0 the owner, 1 a direct grant, 2 a category grant. */
  src: 0 | 1 | 2;
  /** On the owner's row: the artifact's owner and category review (policy.ts categoryRoleOf). */
  owner_id: string | null;
  category_key: string | null;
  category_review: "shared" | "private" | null;
  category_review_share: string | null;
  /** On a category grant's row: the share it is on. */
  share_id: string | null;
  share_owner_id: string | null;
  share_key: string | null;
}

/**
 * Has this grant holder taken part in the artifact (?1)? `g` is the grant's alias, `u` its holder's
 * account. Only worked out for a holder whose account has a name, since nobody else has one to show.
 */
const tookPart = (g: string) => `CASE WHEN u.name IS NULL THEN 0 ELSE (
                  EXISTS (SELECT 1 FROM comments c
                           WHERE c.artifact_id = ?1 AND c.author_email = ${g}.email)
                  OR EXISTS (SELECT 1 FROM artifact_docs d
                              WHERE d.artifact_id = ?1
                                AND (d.created_by_email = ${g}.email OR d.updated_by_email = ${g}.email))
                  OR EXISTS (SELECT 1 FROM versions v
                              WHERE v.artifact_id = ?1 AND v.created_by_user = u.id)
                ) END`;

const OWNER_EMAIL = `coalesce((SELECT o.email FROM artifacts a2 JOIN users o
                                       ON o.id = a2.owner_id WHERE a2.id = ?1), '')`;

/**
 * The access list's one statement: the owner (with the artifact's category review), then direct
 * grants, then, with category sharing on, the grants on the current share of the artifact's owner
 * and category key (the share policy.ts categoryRoleOf may count, found as services/artifacts.ts
 * finds it for roleOf). Every branch is reached by key: the artifact's id, access_grants and
 * category_grants by their primary keys, category_shares by UNIQUE (owner_id, category_key), users
 * by email. A grant on the owner's own email (only possible by hand in SQL; the APIs drop it) is
 * skipped. Exported for the query-plan test.
 */
export function accessListSql(categorySharing: boolean): string {
  const category = categorySharing
    ? `
         UNION ALL
         SELECT cg.email, u.name, cg.role, ${tookPart("cg")}, 2,
                NULL, NULL, NULL, NULL, s.id, s.owner_id, s.category_key
           FROM artifacts a3
           JOIN category_shares s ON s.owner_id = a3.owner_id AND s.category_key = a3.category_key
           JOIN category_grants cg ON cg.share_id = s.id
           LEFT JOIN users u ON u.email = cg.email
          WHERE a3.id = ?1 AND cg.email <> ${OWNER_EMAIL}`
    : "";
  return `SELECT email, name, role, took_part, src, owner_id, category_key, category_review,
                 category_review_share, share_id, share_owner_id, share_key FROM (
         SELECT u.email AS email, u.name AS name, 'owner' AS role, 0 AS took_part, 0 AS src,
                a.owner_id AS owner_id, a.category_key AS category_key,
                a.category_review AS category_review,
                a.category_review_share AS category_review_share,
                NULL AS share_id, NULL AS share_owner_id, NULL AS share_key
           FROM artifacts a JOIN users u ON u.id = a.owner_id WHERE a.id = ?1
         UNION ALL
         SELECT g.email, u.name, g.role, ${tookPart("g")}, 1,
                NULL, NULL, NULL, NULL, NULL, NULL, NULL
           FROM access_grants g LEFT JOIN users u ON u.email = g.email
          WHERE g.artifact_id = ?1 AND g.email <> ${OWNER_EMAIL}${category}
       ) ORDER BY src = 0 DESC, email, src`;
}

/**
 * The owner first, then everyone with a grant that counts, by email, each once at their highest
 * role, with whether they have taken part in the artifact (comments.author_email,
 * artifact_docs.created_by_email or updated_by_email, versions.created_by_user). With
 * `categorySharing` (ALLOW_CATEGORY_SHARING), a grant on the artifact's category share counts
 * exactly when policy.ts grantedRole lets it (categoryRoleOf: the owner reviewed this artifact as
 * shared into that very share, the share is the owner's own, never above commenter); the stronger
 * of it and a direct grant is the role listed. Off, the statement and the list are as before.
 */
async function accessRows(
  d1: D1Database,
  artifactId: string,
  categorySharing: boolean,
): Promise<AccessRow[]> {
  const { results } = await d1
    .prepare(accessListSql(categorySharing))
    .bind(artifactId)
    .all<AccessRow>();
  const owner = results.find((r) => r.src === 0);
  if (!owner) return [];
  const facts: CategoryArtifactFacts = {
    ownerId: owner.owner_id as string,
    categoryShare: {
      key: owner.category_key,
      review: owner.category_review,
      reviewShareId: owner.category_review_share,
    },
  };
  // An email has at most one direct and one category row (both primary keys hold the email):
  // fold them into one, in the statement's order (by email).
  const byEmail = new Map<string, { direct: AccessRow | null; category: AccessRow | null }>();
  for (const r of results) {
    if (r.src === 0) continue;
    const e = byEmail.get(r.email) ?? { direct: null, category: null };
    if (r.src === 1) e.direct = r;
    else e.category = r;
    byEmail.set(r.email, e);
  }
  const out: AccessRow[] = [owner];
  for (const { direct, category } of byEmail.values()) {
    const role = grantedRole(facts, {
      grantRole: (direct?.role as Role | undefined) ?? null,
      categoryGrant:
        category?.share_id && category.share_owner_id && category.share_key
          ? {
              shareId: category.share_id,
              shareOwnerId: category.share_owner_id,
              shareKey: category.share_key,
              role: category.role as CategoryRole,
            }
          : null,
      categorySharing,
      passwordPassed: false,
    });
    const base = direct ?? category;
    if (role === null || base === null) continue;
    // took_part is the same on both rows: it is worked out from the email and its account.
    out.push({ ...base, role });
  }
  return out;
}

/** The name an access list shows for this row, read by `readerEmail` (null: nobody's own row). */
function shownName(r: AccessRow, readerEmail: string | null): string | null {
  const show = accessListShowsName({
    role: r.role,
    you: readerEmail !== null && r.email === readerEmail,
    tookPart: r.took_part === 1,
  });
  return show ? pageDisplayName(r.name) : null;
}

/**
 * Everyone with access: the owner first, then everyone with a grant that counts, by email, each
 * once at their highest role (accessRows). `readerEmail` is the identity of whoever reads the list
 * (the claim's email on the page, the principal's for agents and REST), so their own row carries
 * their name. `categorySharing` is ALLOW_CATEGORY_SHARING: on, the people the artifact reaches
 * through its shared category are listed too.
 */
export async function peopleWithAccess(
  d1: D1Database,
  secret: string,
  artifactId: string,
  readerEmail: string | null,
  categorySharing: boolean,
): Promise<Person[]> {
  const out: Person[] = [];
  for (const r of await accessRows(d1, artifactId, categorySharing)) {
    out.push({
      id: await viewerIdFor(secret, artifactId, r.email),
      email: r.email,
      name: shownName(r, readerEmail),
      role: r.role,
    });
  }
  return out;
}

/**
 * The names the owner's sharing settings show beside each direct grant, under the same rule as the
 * people list (the owner holds no grant, so no row is their own). An address missing from the map
 * has no name to show. The settings list the category's people by address alone, so only direct
 * grants are read here.
 */
export async function grantNames(
  d1: D1Database,
  artifactId: string,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const r of await accessRows(d1, artifactId, false)) {
    if (r.role !== "owner") out.set(r.email, shownName(r, null));
  }
  return out;
}

/** The form terms and fields are compared in: NFKC, lower case. */
function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * The people whose name or email contains every whitespace-separated term of `q`, ignoring case
 * and compatibility forms. An empty or missing query matches everyone. Callers cap `q` at
 * LIMITS.maxPeopleQueryLength. Only shown names are searched, so a search cannot find a name the
 * list keeps back.
 */
export function matchPeople(people: readonly Person[], q: string | undefined): Person[] {
  const terms = fold(q ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return [...people];
  return people.filter((p) => {
    const hay = [fold(p.email), fold(p.name ?? "")];
    return terms.every((t) => hay.some((h) => h.includes(t)));
  });
}

/**
 * Count one read of the list by `reader` (the email that holds the role) on this artifact, or
 * throw 429 rate_limited: RATE_LIMITS.peopleReadsPerViewerPerHour, one bucket for the page route
 * and REST together, so a script gets no more reads than the page would.
 */
export async function countPeopleRead(
  d1: D1Database,
  artifactId: string,
  reader: string,
): Promise<void> {
  const r = await hit(
    d1,
    `people:${artifactId}:${reader}`,
    RATE_LIMITS.peopleReadsPerViewerPerHour,
    3600,
  );
  if (!r.allowed) {
    throw new ApiError("rate_limited", "Too many requests, try again later", {
      retry_after: r.retryAfter,
    });
  }
}

/** One person with access by `u_` id, or null when the id is nobody with access now. */
export function personById(people: readonly Person[], id: string): Person | null {
  return people.find((p) => p.id === id) ?? null;
}
