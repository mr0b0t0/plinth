// An HTML deck's text files (deck.css and every slides/<id>.html), read from a stored version for
// the two places that need the whole deck at once: get_artifact, so an agent can change one slide
// and send the rest back by sha256, and the content host's shell, which embeds them for the
// renderer (docs/spec.md "Slides", "HTML decks"). Every key comes from the version's own manifest
// through fileKey, so a read never leaves the artifact.
import { HTML_DECK_CSS, slideIdOfPath } from "@plinth/shared";
import type { ManifestEntry } from "./storage.ts";
import { fileKey } from "./storage.ts";

/** At most this many R2 gets at once (Workers allow six open connections per request). */
const PARALLEL_READS = 6;

/** Whether a manifest path is one of an HTML deck's text files. */
export function isDeckFile(path: string): boolean {
  return path === HTML_DECK_CSS || slideIdOfPath(path) !== null;
}

/**
 * deck.css and every slide file of version `v`, by path, in path order. A file whose object is
 * missing is left out (the renderer then shows the deck without it, as it does an order id with
 * no file).
 */
export async function readDeckFiles(
  files: R2Bucket,
  artifactId: string,
  v: { number: number; r2Prefix: string },
  entries: Iterable<ManifestEntry>,
): Promise<Record<string, string>> {
  const wanted = [...entries]
    .filter((e) => isDeckFile(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const out: [string, string][] = [];
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const e = wanted[next++] as ManifestEntry;
      const obj = await files.get(fileKey(artifactId, v, e));
      if (obj) out.push([e.path, await obj.text()]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, wanted.length) }, worker));
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(out);
}
