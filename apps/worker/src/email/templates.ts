// Email bodies. Plain text first (it is what the console provider prints and tests read); the HTML
// version escapes every interpolated value.
import { PRODUCT_NAME } from "@plinth/shared";
import type { EmailMessage } from "./index.ts";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Text someone else wrote (an artifact's title), made safe to quote inside one line of a
 * plain-text email: every run of whitespace and control characters (line breaks, tabs, NEL, the
 * line and paragraph separators) becomes one space, and format characters (bidi overrides,
 * zero-width) are dropped. The text then cannot end the line that labels it as the sharer's and
 * start lines of its own that read as Plinth's.
 */
export function oneLine(s: string): string {
  return s
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
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
