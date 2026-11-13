#!/usr/bin/env node
// Fail if the web app's client bundle contains anything secret.
//
//   pnpm --filter @plinth/web build && node scripts/check-bundle-secrets.mjs [dir]
//
// Scans every file under apps/web/dist (or [dir]) for:
//   - the values of SESSION_SECRET, TOKEN_SIGNING_KEY, ADMIN_TOKEN, SENDGRID_API_KEY and
//     RESEND_API_KEY from apps/worker/.dev.vars, if that file exists;
//   - secret-looking strings: Plinth tokens, SendGrid and Resend keys, private keys, AWS keys, and
//     any of those variable names assigned a value.
// Exits 1 on any hit (printing the file and the kind of hit, never the secret), 2 if there is
// nothing to scan.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(process.argv[2] ?? join(root, "apps/web/dist"));
const devVars = join(root, "apps/worker/.dev.vars");
const SECRET_NAMES = [
  "SESSION_SECRET",
  "TOKEN_SIGNING_KEY",
  "ADMIN_TOKEN",
  "SENDGRID_API_KEY",
  "RESEND_API_KEY",
];

if (!existsSync(dist) || !statSync(dist).isDirectory()) {
  console.error(
    `check-bundle-secrets: ${relative(root, dist) || dist} does not exist. Build first:`,
  );
  console.error("  pnpm --filter @plinth/web build");
  process.exit(2);
}

/** Values of the secret variables in .dev.vars (KEY=value lines, optional quotes). */
function secretValues() {
  if (!existsSync(devVars)) return [];
  const out = [];
  for (const line of readFileSync(devVars, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !SECRET_NAMES.includes(m[1])) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    // Short values would match by accident and are not real secrets anyway.
    if (value.length >= 8) out.push({ name: m[1], value });
  }
  return out;
}

const PATTERNS = [
  ["Plinth personal access token", /plinth_pat_[A-Za-z0-9]{20,}/],
  ["Plinth OAuth access token", /plinth_at_[A-Za-z0-9]{20,}/],
  ["Plinth OAuth refresh token", /plinth_rt_[A-Za-z0-9]{20,}/],
  ["Plinth viewer session", /plinth_vs_[A-Za-z0-9]{20,}/],
  ["SendGrid API key", /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ["Resend API key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  [
    "secret variable with a value",
    new RegExp(`\\b(?:${SECRET_NAMES.join("|")})\\b["']?\\s*[:=]\\s*["'\`][^"'\`\\s]{8,}`),
  ],
];

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (entry.isFile()) yield p;
  }
}

const values = secretValues();
const hits = [];
let scanned = 0;
for (const file of files(dist)) {
  scanned += 1;
  const text = readFileSync(file).toString("latin1");
  const rel = relative(root, file);
  for (const { name, value } of values) {
    if (text.includes(value)) hits.push(`${rel}: value of ${name} from apps/worker/.dev.vars`);
  }
  for (const [kind, re] of PATTERNS) {
    if (re.test(text)) hits.push(`${rel}: ${kind}`);
  }
}

if (scanned === 0) {
  console.error(`check-bundle-secrets: no files in ${relative(root, dist)}`);
  process.exit(2);
}
if (hits.length > 0) {
  console.error("check-bundle-secrets: secrets found in the client bundle:");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(
  `check-bundle-secrets: ${scanned} files in ${relative(root, dist)} are clean` +
    (values.length ? ` (checked ${values.length} values from .dev.vars)` : " (no .dev.vars)"),
);
