// Email bodies. Plain text first (it is what the console provider prints and tests read); the HTML
// version escapes every interpolated value.
import { LIMITS, PRODUCT_NAME, REFUSED_CHARS, type Role } from "@plinth/shared";
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

/**
 * Untrusted text (a title, a share's name, a display name) as an email may show it: NFC, control
 * and format (invisible, bidi) characters dropped, whitespace runs to one space, cut to `max` code
 * points with an ellipsis, and anything that reads as a web address defanged (`https[:]//`,
 * `www[.]`), so that the artifact link stays the only link the message offers.
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
  return cut.replace(/([a-z][a-z0-9+.-]*):\/\//giu, "$1[:]//").replace(/\bwww\./giu, "www[.]");
}

const ROLE_SENTENCE: Record<"artifact" | "category", Record<Role, string>> = {
  artifact: {
    viewer: "You can view it.",
    commenter: "You can view it and comment on it.",
    editor: "You can view it, comment on it and publish new versions of it.",
  },
  category: {
    viewer: "It is a collection of artifacts. You can view the ones it shares with you.",
    commenter:
      "It is a collection of artifacts. You can view the ones it shares with you and comment on them.",
    // Category grants are viewer or commenter only (never editor); kept so the table is total.
    editor: "It is a collection of artifacts. You can view the ones it shares with you.",
  },
};

/**
 * '<owner> shared "<title>" with you': an owner added this person to an artifact (`artifact`) or
 * to a shared category (`category`, where the title is the name the people see and the link is the
 * portal). It carries the one link and the role, and never a code, a token or anything else to
 * copy. The owner's name and the title are untrusted: emailText cleans them for both bodies, and
 * the HTML escapes every value as well.
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
}): EmailMessage {
  const name = opts.ownerName ? emailText(opts.ownerName, LIMITS.maxDisplayNameLength) : "";
  const title = emailText(opts.title, LIMITS.maxTitleLength) || "Untitled";
  const subjectTitle = emailText(opts.title, 80) || "Untitled";
  const who = name ? `${name} (${opts.ownerEmail})` : opts.ownerEmail;
  const subject = `${name || opts.ownerEmail} shared "${subjectTitle}" with you`;
  const role = ROLE_SENTENCE[opts.kind][opts.role];
  const confirm = `If ${PRODUCT_NAME} asks who you are when you open it, confirm this email address with the code it sends you then.`;
  const authored = `The title${name ? " and the name" : ""} above were written by the person who shared it, not by ${PRODUCT_NAME}.`;
  const why = `You got this email because ${opts.ownerEmail} added ${opts.to} on ${PRODUCT_NAME}. If you did not expect it, you can ignore it.`;
  const text = [
    `${who} shared "${title}" with you on ${PRODUCT_NAME}.`,
    role,
    "",
    "Open it:",
    opts.link,
    "",
    confirm,
    "",
    authored,
    why,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">
<p>${escapeHtml(who)} shared “<strong>${escapeHtml(title)}</strong>” with you on ${escapeHtml(PRODUCT_NAME)}.<br>
${escapeHtml(role)}</p>
<p><a href="${escapeHtml(opts.link)}">Open it on ${escapeHtml(PRODUCT_NAME)}</a></p>
<p>${escapeHtml(confirm)}</p>
<p style="color:#555;font-size:0.9em">${escapeHtml(authored)}<br>
${escapeHtml(why)}</p>
</body></html>`;
  return { to: opts.to, subject, text, html };
}
