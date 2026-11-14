// Read-only SQL against the e2e Worker's local D1, for the few checks no API can make (rows a
// takedown wiped, when the artifact itself is no longer readable). It runs `wrangler d1 execute
// --local` on the same state directory as support/server.ts; never use it to write.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STATE_DIR, WORKER_DIR, WRANGLER } from "./paths.ts";

const run = promisify(execFile);

/** Rows of one SELECT. Values must be inlined by the caller, so only pass ids the server made. */
export async function selectLocal<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!/^\s*select\b/i.test(sql)) throw new Error("selectLocal runs SELECT statements only");
  const { stdout } = await run(
    WRANGLER,
    ["d1", "execute", "DB", "--local", "--persist-to", STATE_DIR, "--json", "--command", sql],
    { cwd: WORKER_DIR, encoding: "utf8", timeout: 60_000 },
  );
  const parsed = JSON.parse(stdout) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

/** An id the server generated, safe to inline in SQL. */
export function sqlId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`not a server id: ${id}`);
  return `'${id}'`;
}
