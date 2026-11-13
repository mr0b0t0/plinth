// Random ids, hashing, HMAC-signed tokens and password hashing, all on WebCrypto.

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const enc = new TextEncoder();

/** Uniform random string over an alphabet (rejection sampling, no modulo bias). */
export function randomString(length: number, alphabet = BASE62): string {
  const max = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const buf = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of buf) {
      if (b < max) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** 20 lowercase letters/digits: a valid DNS label, ~103 bits. Used for artifact ids. */
export function newArtifactId(): string {
  return randomString(20, LOWER_ALNUM);
}

/** Generic row id. */
export function newId(): string {
  return randomString(20, LOWER_ALNUM);
}

/** Six-digit numeric code. */
export function newSixDigitCode(): string {
  return randomString(6, "0123456789");
}

/** Opaque bearer token with a readable prefix, e.g. plinth_pat_… (~238 bits). */
export function newToken(prefix: string): string {
  return `${prefix}${randomString(40)}`;
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/** SHA-256 for high-entropy secrets (tokens). Never use for passwords. */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Compact signed token: base64url(JSON payload) "." base64url(HMAC-SHA256). The payload must carry
 * `k` (kind) and `exp` (unix ms). Kinds keep one token type from being accepted as another.
 */
export interface SignedPayload {
  k: string;
  exp: number;
  [key: string]: unknown;
}

export async function signToken(secret: string, payload: SignedPayload): Promise<string> {
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${base64url(sig)}`;
}

export async function verifyToken<T extends SignedPayload>(
  secret: string,
  token: string,
  kind: string,
  now = Date.now(),
): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts as [string, string];
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64url(sig);
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body));
  if (!ok) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const p = payload as SignedPayload;
  if (p.k !== kind || typeof p.exp !== "number" || p.exp <= now) return null;
  return p as T;
}

// Passwords: PBKDF2-SHA256. Workers caps iterations at 100,000.
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, saltB64, hashB64] = stored.split("$");
  if (alg !== "pbkdf2-sha256" || !iter || !saltB64 || !hashB64) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS)
    return false;
  const hash = await pbkdf2(password, fromBase64url(saltB64), iterations);
  return timingSafeEqual(base64url(hash), hashB64);
}
