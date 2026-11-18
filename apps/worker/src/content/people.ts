// The people list on an artifact's own content origin (docs/spec.md "Who is viewing: names and
// the people list", docs/security.md#the-people-list): GET /__plinth/api/v1/people and
// GET /__plinth/api/v1/people/<u_id>. Both are entries of the shared-data route table
// (content/data-api.ts), so the dispatcher's checks 1 to 10 run first: method, the x-plinth-data
// header, same-origin fetch metadata, the exact Origin, availability, the artifact, the content
// pass at the current epoch, the `data` declaration and pageDataAccess. Then, in order:
//   11. an identity claim (a preview never gets here; capture passes and link viewers carry none):
//       403 feature_disabled, reason not_identified;
//   12. the `viewer people` declaration: 403 feature_disabled, reason not_declared;
//   13. policy (policy.ts pagePeopleAccess): owners and editors only, 403 forbidden otherwise;
//   14. a rate limit per reader per artifact (RATE_LIMITS.peopleReadsPerViewerPerHour), 429.
// The list is who has access (the owner and every grant), never who opened the page. Search runs
// over that list only. Names, emails and queries are never logged.
import { LIMITS, type PagePeopleList, type PagePerson, RATE_LIMITS } from "@plinth/shared";
import { sharedDataActive } from "../config.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { type PageClaim, pagePeopleAccess } from "../policy.ts";
import { matchPeople, type Person, peopleWithAccess, personById } from "../services/people.ts";
import type { DataRouteCtx } from "./data-api.ts";

/** A person id as the page names it: `u_` and 24 hex characters (crypto.ts viewerIdFor). */
export const PERSON_ID_RE = /^u_[0-9a-f]{24}$/;

const HOUR_S = 3600;

/** Steps 11 to 14; the reader's claim when every one passes. */
async function allowed(c: DataRouteCtx): Promise<PageClaim> {
  const { claim } = c;
  if (!claim) {
    throw new ApiError(
      "feature_disabled",
      "Only people this page is shared with can see who has access",
      {
        reason: "not_identified",
      },
    );
  }
  if (c.target.caps?.viewer !== true || c.target.caps.people !== true) {
    throw new ApiError("feature_disabled", "This page does not list its people", {
      reason: "not_declared",
    });
  }
  if (!pagePeopleAccess(claim, c.target.caps, sharedDataActive(c.config)).list) {
    throw new ApiError("forbidden", "Only the owner and editors can see who has access");
  }
  const r = await hit(
    c.env.DB,
    `people:${c.target.id}:${claim.email}`,
    RATE_LIMITS.peopleReadsPerViewerPerHour,
    HOUR_S,
  );
  if (!r.allowed) {
    throw new ApiError("rate_limited", "Too many requests, try again later", {
      retry_after: r.retryAfter,
    });
  }
  return claim;
}

function toPagePerson(p: Person, reader: PageClaim): PagePerson {
  return { id: p.id, email: p.email, name: p.name, role: p.role, you: p.id === reader.viewerId };
}

/** The most a list returns: the owner and every grant. */
const MAX_PEOPLE = LIMITS.maxAllowlistEmails + 1;

function limitParam(v: string | null): number {
  if (v === null) return MAX_PEOPLE;
  const n = /^\d{1,4}$/.test(v) ? Number(v) : Number.NaN;
  if (!(n >= 1 && n <= MAX_PEOPLE)) {
    throw new ApiError("invalid_input", `limit: 1 to ${MAX_PEOPLE}`);
  }
  return n;
}

/** GET /__plinth/api/v1/people?q=&limit= */
export async function listPeopleRoute(c: DataRouteCtx): Promise<PagePeopleList> {
  const q = c.url.searchParams.get("q") ?? undefined;
  if (q !== undefined && q.length > LIMITS.maxPeopleQueryLength) {
    throw new ApiError("invalid_input", `q: at most ${LIMITS.maxPeopleQueryLength} characters`);
  }
  const limit = limitParam(c.url.searchParams.get("limit"));
  const reader = await allowed(c);
  const matched = matchPeople(
    await peopleWithAccess(c.env.DB, c.config.tokenSigningKey, c.target.id),
    q,
  );
  return {
    people: matched.slice(0, limit).map((p) => toPagePerson(p, reader)),
    total: matched.length,
  };
}

/** GET /__plinth/api/v1/people/<u_id>: one person with access now, or 404. */
export async function getPersonRoute(c: DataRouteCtx): Promise<PagePerson> {
  const id = c.params.id as string;
  const reader = await allowed(c);
  const person = PERSON_ID_RE.test(id)
    ? personById(await peopleWithAccess(c.env.DB, c.config.tokenSigningKey, c.target.id), id)
    : null;
  if (!person) throw new ApiError("not_found", "Nobody with access has this id");
  return toPagePerson(person, reader);
}
