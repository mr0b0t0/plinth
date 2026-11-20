// Email bodies. Plain text first (it is what the console provider prints and tests read); the HTML
// version escapes every interpolated value.
import { LIMITS, PRODUCT_NAME, REFUSED_CHARS, type Role } from "@plinth/shared";
import { parse as parseHost } from "tldts";
import type { EmailMessage } from "./index.ts";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function loginEmail(opts: {
  to: string;
  link: string;
  code: string;
  minutes: number;
}): EmailMessage {
  const { to, link, code, minutes } = opts;
  const subject = `Your ${PRODUCT_NAME} sign-in code: ${code}`;
  const text = [
    `Sign in to ${PRODUCT_NAME}`,
    "",
    "Open this link to sign in:",
    link,
    "",
    `Or enter this code: ${code}`,
    "",
    `The link and the code work once and expire in ${minutes} minutes.`,
    "If you did not ask to sign in, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">
<p>Sign in to ${escapeHtml(PRODUCT_NAME)}</p>
<p><a href="${escapeHtml(link)}">Open this link to sign in</a></p>
<p>Or enter this code: <strong style="font-family:monospace;font-size:1.25em">${escapeHtml(code)}</strong></p>
<p>The link and the code work once and expire in ${minutes} minutes.<br>
If you did not ask to sign in, you can ignore this email.</p>
</body></html>`;
  return { to, subject, text, html };
}

// ---------- invitation emails (docs/spec.md "Invitation emails") ----------

const REFUSED_ALL = new RegExp(REFUSED_CHARS.source, "gu");

/** One host label: letters (any script, with their marks) and digits, hyphens inside. */
const LABEL = "[\\p{L}\\p{M}\\p{N}](?:[\\p{L}\\p{M}\\p{N}_-]*[\\p{L}\\p{M}\\p{N}])?";
/** The dots a host name may be written with (IDNA reads the ideographic and full-width ones as "."). */
const DOT = "[.\u3002\uFF0E\uFF61]";
/** Two or more labels joined by dots: anything that might be a host name. */
const HOST_LIKE = new RegExp(`${LABEL}(?:${DOT}${LABEL})+`, "gu");
const DOTS = new RegExp(DOT, "gu");

/**
 * Every host name in `s` whose suffix is a real public suffix (ICANN or the Public Suffix List's
 * private part, as the pinned tldts knows it) with each dot written `[.]`: `office365-reset[.]co`,
 * `bob@evil[.]com`, `пример[.]рф`. Mail clients linkify bare host names, and these emails go out
 * under the instance's signed sender, so text someone else wrote must not become a link. Words that
 * only look dotted (`Node.js`, `v1.2.3`, `e.g.`, `Q3.plan`) are left alone, since their last label
 * is not a suffix anyone can register under.
 */
export function defangHosts(s: string): string {
  return s.replace(HOST_LIKE, (token) => {
    const host = token.replace(DOTS, ".").toLowerCase();
    const r = parseHost(host, { allowPrivateDomains: true });
    if (r.isIp || r.domain === null || !(r.isIcann || r.isPrivate)) return token;
    return token.replace(DOTS, "[.]");
  });
}

/**
 * Untrusted text (a title, a share's name, a display name) as an email may show it: NFC, control
 * and format (invisible, bidi) characters dropped, whitespace runs to one space, cut to `max` code
 * points with an ellipsis, and anything that reads as a web address defanged (`https[:]//`,
 * `www[.]`, and host names under a public suffix, defangHosts), so that the links Plinth adds stay
 * the only links the message offers.
 */
export function emailText(raw: string, max: number): string {
  const s = raw.normalize("NFC").replace(/\s+/gu, " ").replace(REFUSED_ALL, "").trim();
  const chars = Array.from(s);
  const cut =
    chars.length > max
      ? `${chars
          .slice(0, max - 1)
          .join("")
          .trimEnd()}…`
      : s;
  return defangHosts(cut)
    .replace(/([a-z][a-z0-9+.-]*):\/\//giu, "$1[:]//")
    .replace(/\bwww\./giu, "www[.]");
}

const ROLE_SENTENCE: Record<"artifact" | "category", Record<Role, string>> = {
  artifact: {
    viewer: "You can view it.",
    commenter: "You can view it and comment on it.",
    editor: "You can view it, comment on it and publish new versions of it.",
  },
  category: {
    viewer: "You can view the artifacts in it.",
    commenter: "You can view the artifacts in it and comment on them.",
    // Category grants are viewer or commenter only (never editor); kept so the table is total.
    editor: "You can view the artifacts in it.",
  },
};

/**
 * '<owner> shared "<title>" with you': an owner added this person to an artifact (`artifact`) or
 * to a shared category (`category`, where the title is the name the people see and the link is the
 * portal). It carries the link and the role, and never a code, a token or anything else to copy;
 * its footer links the app's page where the recipient, once signed in as this address, turns these
 * emails off (`optOutLink`, also the List-Unsubscribe header, with no token or address in it). The
 * owner's name and the title are untrusted: emailText cleans them for the subject and both bodies,
 * and the HTML escapes every value as well.
 */
export function invitationEmail(opts: {
  to: string;
  kind: "artifact" | "category";
  ownerEmail: string;
  /** The owner's display name as pages see it (pageDisplayName), or null. */
  ownerName: string | null;
  title: string;
  role: Role;
  link: string;
  /** The app's /invitation-emails page (APP_ROUTES.invitationEmails), on the app host. */
  optOutLink: string;
}): EmailMessage {
  const name = opts.ownerName ? emailText(opts.ownerName, LIMITS.maxDisplayNameLength) : "";
  const title = emailText(opts.title, LIMITS.maxTitleLength) || "Untitled";
  const subjectTitle = emailText(opts.title, 80) || "Untitled";
  const who = name ? `${name} (${opts.ownerEmail})` : opts.ownerEmail;
  // The subject names the owner by address too, so a display name cannot pass for someone else
  // in an inbox list either.
  const subject = `${who} shared "${subjectTitle}" with you`;
  const role = ROLE_SENTENCE[opts.kind][opts.role];
  const authored = `The title${name ? " and the name" : ""} above were written by the person who shared it, not by ${PRODUCT_NAME}.`;
  const why = `You got this email because ${opts.ownerEmail} added ${opts.to} on ${PRODUCT_NAME}. If you did not expect it, you can ignore it.`;
  const stop = `To stop these emails from everyone on ${PRODUCT_NAME}, sign in at:`;
  const text = [
    `${who} shared "${title}" with you on ${PRODUCT_NAME}.`,
    role,
    "",
    "Open it:",
    opts.link,
    "",
    authored,
    why,
    stop,
    opts.optOutLink,
  ].join("\n");
  // The footer is dimmed with opacity, not a fixed grey, so it stays legible in dark mail clients.
  const html = `<!doctype html><html lang="en"><body style="font-family:system-ui,sans-serif;line-height:1.5">
<p>${escapeHtml(who)} shared “<strong>${escapeHtml(title)}</strong>” with you on ${escapeHtml(PRODUCT_NAME)}.<br>
${escapeHtml(role)}</p>
<p><a href="${escapeHtml(opts.link)}">Open it on ${escapeHtml(PRODUCT_NAME)}</a></p>
<p style="opacity:0.7;font-size:0.9em">${escapeHtml(authored)}<br>
${escapeHtml(why)}<br>
<a href="${escapeHtml(opts.optOutLink)}">Stop these emails</a></p>
</body></html>`;
  // RFC 2369. No List-Unsubscribe-Post (RFC 8058 one-click): that POST arrives with no session,
  // so it would need a token in the URL saying whose address to stop (DECISIONS.md).
  const headers = { "List-Unsubscribe": `<${opts.optOutLink}>` };
  return { to: opts.to, subject, text, html, headers };
}
