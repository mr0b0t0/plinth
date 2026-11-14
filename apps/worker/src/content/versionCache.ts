// An in-isolate cache of version rows and their parsed manifests for the content host (docs/spec.md,
// "Serving cost"). A version row is immutable, and with commit-last it exists only once committed,
// so a cached copy can never be stale. Access is never cached: serve.ts reads the artifact row
// (visibility, access epoch, takedown, deletion) and checks the content cookie on every request
// before it looks a version up here, and erasure removes the artifact row first, so a cached entry
// is unreachable afterwards.
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { versions } from "../db/schema.ts";
import { type ManifestEntry, parseManifest } from "../services/storage.ts";

export interface CachedVersion {
  id: string;
  artifactId: string;
  number: number;
  r2Prefix: string;
  capabilities: string | null;
  entries: Map<string, ManifestEntry>;
}

/** Total estimated weight the cache may hold, per isolate. */
export const VERSION_CACHE_MAX_WEIGHT = 8 * 1024 * 1024;

const cache = new Map<string, { value: CachedVersion; weight: number }>();
let weight = 0;

function keyOf(artifactId: string, n: number): string {
  return `${artifactId}:${n}`;
}

function put(key: string, value: CachedVersion, w: number): void {
  if (w > VERSION_CACHE_MAX_WEIGHT) return;
  const old = cache.get(key);
  if (old) {
    weight -= old.weight;
    cache.delete(key);
  }
  cache.set(key, { value, weight: w });
  weight += w;
  // Map keeps insertion order; a hit re-inserts, so the first key is the least recently used.
  while (weight > VERSION_CACHE_MAX_WEIGHT) {
    const first = cache.keys().next();
    if (first.done) break;
    const e = cache.get(first.value);
    cache.delete(first.value);
    if (e) weight -= e.weight;
  }
}

/** One committed version of an artifact, from the cache or (once) from D1. Null if none. */
export async function loadVersion(
  db: D1Database,
  artifactId: string,
  n: number,
): Promise<CachedVersion | null> {
  const key = keyOf(artifactId, n);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  const row = await getDb(db)
    .select({
      id: versions.id,
      number: versions.number,
      r2Prefix: versions.r2Prefix,
      capabilities: versions.capabilities,
      manifest: versions.manifest,
    })
    .from(versions)
    .where(and(eq(versions.artifactId, artifactId), eq(versions.number, n)))
    .get();
  if (!row) return null;
  const value: CachedVersion = {
    id: row.id,
    artifactId,
    number: row.number,
    r2Prefix: row.r2Prefix,
    capabilities: row.capabilities,
    entries: new Map(parseManifest(row.manifest).map((e) => [e.path, e])),
  };
  // The parsed manifest costs a few times its JSON length.
  put(key, value, 512 + row.manifest.length * 3 + row.r2Prefix.length);
  return value;
}

/** Forget everything (tests). */
export function clearVersionCache(): void {
  cache.clear();
  weight = 0;
}

/** Entries and estimated weight held (tests). */
export function versionCacheStats(): { entries: number; weight: number } {
  return { entries: cache.size, weight };
}
