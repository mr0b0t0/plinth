// Editing the people list on an artifact. PUT /artifacts/:ref/sharing replaces every grant, so the
// page computes the whole next list here and sends it.
import { emailSchema, LIMITS, type Role } from "@plinth/shared";

export interface GrantDraft {
  email: string;
  role: Role;
}

export type AddGrantResult = { ok: true; grants: GrantDraft[] } | { ok: false; error: string };

/** Add a person. Normalizes the address; refuses duplicates, the owner and a full list. */
export function addGrant(
  grants: readonly GrantDraft[],
  rawEmail: string,
  role: Role,
  ownerEmail?: string | null,
): AddGrantResult {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return { ok: false, error: "Enter a valid email address." };
  const email = parsed.data;
  if (ownerEmail && email === ownerEmail.toLowerCase()) {
    return { ok: false, error: "That is your own address. As the owner you always have access." };
  }
  if (grants.some((g) => g.email === email)) {
    return { ok: false, error: `${email} is already on the list.` };
  }
  if (grants.length >= LIMITS.maxAllowlistEmails) {
    return { ok: false, error: `The list holds up to ${LIMITS.maxAllowlistEmails} people.` };
  }
  return { ok: true, grants: [...grants, { email, role }] };
}

export function setGrantRole(
  grants: readonly GrantDraft[],
  email: string,
  role: Role,
): GrantDraft[] {
  return grants.map((g) => (g.email === email ? { ...g, role } : g));
}

export function removeGrant(grants: readonly GrantDraft[], email: string): GrantDraft[] {
  return grants.filter((g) => g.email !== email);
}

/** Viewer grants are the allowlist; commenters and editors can always open it too. */
export function countByRole(grants: readonly GrantDraft[]): Record<Role, number> {
  const out: Record<Role, number> = { viewer: 0, commenter: 0, editor: 0 };
  for (const g of grants) out[g.role] += 1;
  return out;
}
