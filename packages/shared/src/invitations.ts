// Invitation emails (docs/spec.md "Invitation emails"): when an owner adds people to an artifact or
// to a shared category and asks for it, Plinth emails each new person a link. Pure code, used by
// the Worker, the web app and tests.
import { RATE_LIMITS } from "./constants.ts";

/**
 * Why a person added with `notify` was not emailed. `owner_unverified`: the owner's address is not
 * verified; `taken_down`: the artifact is taken down, so the link would not open; `already_emailed`:
 * this person was emailed about the same artifact or share within the last day; `change_limit`,
 * `owner_limit` and `recipient_limit`: RATE_LIMITS.invitationsPerChange, invitationsPerOwnerPerDay
 * or invitationsPerRecipientPerDay.
 */
export const INVITATION_SKIP_REASONS = [
  "owner_unverified",
  "taken_down",
  "already_emailed",
  "change_limit",
  "owner_limit",
  "recipient_limit",
] as const;
export type InvitationSkipReason = (typeof INVITATION_SKIP_REASONS)[number];

/**
 * What a sharing change with `notify: true` did about email. Present in the result only when the
 * request asked to notify. `emailed` lists the addresses an invitation was handed to the email
 * provider for; `skipped` the people added who were not emailed, and why. People who already had
 * access are in neither list: only a new grant is ever announced.
 */
export interface InvitationReport {
  emailed: string[];
  skipped: { email: string; reason: InvitationSkipReason }[];
}

/** Plain-language text for a skip reason, for the app's toasts. */
export function invitationSkipText(reason: InvitationSkipReason): string {
  switch (reason) {
    case "owner_unverified":
      return "Invitations need a verified email address on your account.";
    case "taken_down":
      return "It was taken down, so nobody is emailed about it.";
    case "already_emailed":
      return "They were emailed about it in the last day.";
    case "change_limit":
      return `One change emails at most ${RATE_LIMITS.invitationsPerChange} people. Send the others the link yourself.`;
    case "owner_limit":
      return "You reached today's limit of invitation emails. Send them the link yourself.";
    case "recipient_limit":
      return "That address got too many invitations today. Send them the link yourself.";
  }
}

/** "Not emailed: a@x (reason); b@y (reason)" for the skipped people, or null when none. */
export function invitationSkippedSummary(report: InvitationReport | undefined): string | null {
  const skipped = report?.skipped ?? [];
  if (skipped.length === 0) return null;
  const reasons = [...new Set(skipped.map((s) => s.reason))];
  const who = skipped.map((s) => s.email).join(", ");
  return `Not emailed: ${who}. ${reasons.map(invitationSkipText).join(" ")}`;
}
