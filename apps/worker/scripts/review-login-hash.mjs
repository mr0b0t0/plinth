#!/usr/bin/env node
// Hash the review account's password for REVIEW_LOGIN_PASSWORD_HASH (src/auth/review-login.ts).
// Reads the password from stdin, never from the command line (where it would land in the shell
// history and the process list), and prints the hash on stdout:
//
//   umask 077
//   openssl rand -base64 24 > review-password.txt     # the password, for the reviewers only
//   node apps/worker/scripts/review-login-hash.mjs < review-password.txt \
//     | pnpm --filter @plinth/worker exec wrangler secret put REVIEW_LOGIN_PASSWORD_HASH --config wrangler.production.jsonc
//
// The format is the one src/lib/crypto.ts hashPassword writes and src/config.ts accepts:
// pbkdf2-sha256$100000$<16-byte salt>$<32-byte hash>, base64url without padding. 100,000 is the
// most PBKDF2 iterations Cloudflare Workers allows. One trailing newline is dropped from stdin.
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ITERATIONS = 100_000;
/** Shorter passwords are refused: the password, not the iteration count, is what stops guessing. */
export const MIN_LENGTH = 16;

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** The REVIEW_LOGIN_PASSWORD_HASH value for `password`. */
export async function reviewLoginHash(
  password,
  salt = webcrypto.getRandomValues(new Uint8Array(16)),
) {
  if (typeof password !== "string" || password.length < MIN_LENGTH) {
    throw new Error(`the password must be at least ${MIN_LENGTH} characters`);
  }
  if (password.length > 256) throw new Error("the password must be at most 256 characters");
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    key,
    256,
  );
  return `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error(
      "review-login-hash: pass the password on stdin, not as an argument (see the comment at the top of this file)",
    );
    process.exit(2);
  }
  if (process.stdin.isTTY) {
    console.error("review-login-hash: pipe the password in, e.g. < review-password.txt");
    process.exit(2);
  }
  try {
    process.stdout.write(`${await reviewLoginHash(await readStdin())}\n`);
  } catch (e) {
    console.error(`review-login-hash: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
