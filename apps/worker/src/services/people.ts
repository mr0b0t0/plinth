// Who has access to an artifact, with display names (docs/spec.md "Who is viewing: names and the
// people list"): the owner and every grant, never who opened the page or when. One list serves the
// page (content/people.ts, owners and editors on a page that declares `people`), agents
// (list_artifact_data's summary) and REST (GET /api/v1/artifacts/:ref/people). Callers decide
// access through policy.ts first. Search runs only over this one list (at most the owner and
// LIMITS.maxAllowlistEmails grants): nothing here takes an email and says whether it has an
// account. Names, emails and queries are never logged.
import { type EffectiveRole, pageDisplayName } from "@plinth/shared";
import { viewerIdFor } from "../lib/crypto.ts";

export interface Person {
  /** The per-artifact `u_` viewer id (crypto.ts viewerIdFor). */
  id: string;
  email: string;
  name: string | null;
  role: EffectiveRole;
}

/**
 * The owner first, then grants by email, in one statement. A grant on the owner's own email (only
 * possible by hand in SQL; the sharing API drops it) is skipped.
 */
export async function peopleWithAccess(
  d1: D1Database,
  secret: string,
  artifactId: string,
): Promise<Person[]> {
  const { results } = await d1
    .prepare(
      `SELECT email, name, role FROM (
         SELECT u.email AS email, u.name AS name, 'owner' AS role, 0 AS ord
           FROM artifacts a JOIN users u ON u.id = a.owner_id WHERE a.id = ?1
         UNION ALL
         SELECT g.email, u.name, g.role, 1
           FROM access_grants g LEFT JOIN users u ON u.email = g.email
          WHERE g.artifact_id = ?1
            AND g.email <> coalesce((SELECT o.email FROM artifacts a2 JOIN users o
                                       ON o.id = a2.owner_id WHERE a2.id = ?1), '')
       ) ORDER BY ord, email`,
    )
    .bind(artifactId)
    .all<{ email: string; name: string | null; role: EffectiveRole }>();
  const out: Person[] = [];
  for (const r of results) {
    out.push({
      id: await viewerIdFor(secret, artifactId, r.email),
      email: r.email,
      name: pageDisplayName(r.name),
      role: r.role,
    });
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
 * LIMITS.maxPeopleQueryLength.
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

/** One person with access by `u_` id, or null when the id is nobody with access now. */
export function personById(people: readonly Person[], id: string): Person | null {
  return people.find((p) => p.id === id) ?? null;
}
