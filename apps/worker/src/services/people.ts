// Who has access to an artifact, with display names (docs/spec.md "Who is viewing: names and the
// people list"): the owner and every grant, never who opened the page or when. One list serves the
// page (content/people.ts), agents (list_artifact_data's summary) and REST
// (GET /api/v1/artifacts/:ref/people), all only on a page that declares `data viewer people`
// (policy.ts peopleListOffered), plus the names in the owner's sharing settings. Callers decide
// access through policy.ts first. Search runs only over this one list (at most the owner and
// LIMITS.maxAllowlistEmails grants), and a grant holder's name shows only once they have taken part
// (policy.ts accessListShowsName): nothing here takes an address the caller typed and says whether
// it has an account or what it is called. Names, emails and queries are never logged.
import { type EffectiveRole, pageDisplayName, RATE_LIMITS } from "@plinth/shared";
import { viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { accessListShowsName } from "../policy.ts";

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
}

/**
 * The owner first, then grants by email, in one statement, each with whether its holder has taken
 * part in the artifact (comments.author_email, artifact_docs.created_by_email or updated_by_email,
 * versions.created_by_user). That is only worked out for a holder whose account has a name, since
 * nobody else has one to show. A grant on the owner's own email (only possible by hand in SQL; the
 * sharing API drops it) is skipped.
 */
async function accessRows(d1: D1Database, artifactId: string): Promise<AccessRow[]> {
  const { results } = await d1
    .prepare(
      `SELECT email, name, role, took_part FROM (
         SELECT u.email AS email, u.name AS name, 'owner' AS role, 0 AS took_part, 0 AS ord
           FROM artifacts a JOIN users u ON u.id = a.owner_id WHERE a.id = ?1
         UNION ALL
         SELECT g.email, u.name, g.role,
                CASE WHEN u.name IS NULL THEN 0 ELSE (
                  EXISTS (SELECT 1 FROM comments c
                           WHERE c.artifact_id = ?1 AND c.author_email = g.email)
                  OR EXISTS (SELECT 1 FROM artifact_docs d
                              WHERE d.artifact_id = ?1
                                AND (d.created_by_email = g.email OR d.updated_by_email = g.email))
                  OR EXISTS (SELECT 1 FROM versions v
                              WHERE v.artifact_id = ?1 AND v.created_by_user = u.id)
                ) END,
                1
           FROM access_grants g LEFT JOIN users u ON u.email = g.email
          WHERE g.artifact_id = ?1
            AND g.email <> coalesce((SELECT o.email FROM artifacts a2 JOIN users o
                                       ON o.id = a2.owner_id WHERE a2.id = ?1), '')
       ) ORDER BY ord, email`,
    )
    .bind(artifactId)
    .all<AccessRow>();
  return results;
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
 * Everyone with access: the owner first, then grants by email. `readerEmail` is the identity of
 * whoever reads the list (the claim's email on the page, the principal's for agents and REST), so
 * their own row carries their name.
 */
export async function peopleWithAccess(
  d1: D1Database,
  secret: string,
  artifactId: string,
  readerEmail: string | null,
): Promise<Person[]> {
  const out: Person[] = [];
  for (const r of await accessRows(d1, artifactId)) {
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
 * The names the owner's sharing settings show beside each grant, under the same rule as the people
 * list (the owner holds no grant, so no row is their own). An address missing from the map has no
 * name to show.
 */
export async function grantNames(
  d1: D1Database,
  artifactId: string,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const r of await accessRows(d1, artifactId)) {
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
