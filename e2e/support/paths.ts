import path from "node:path";

/** Repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const WORKER_DIR = path.join(ROOT, "apps", "worker");
export const WRANGLER = path.join(WORKER_DIR, "node_modules", ".bin", "wrangler");
/** Local D1/R2 state for the e2e Worker. Wiped at the start of every run. */
export const STATE_DIR = path.join(ROOT, "e2e", ".wrangler-state");
