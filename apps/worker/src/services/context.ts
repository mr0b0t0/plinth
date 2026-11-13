import type { Bindings, Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { Principal } from "../policy.ts";

/** Everything a service call needs. Built once per request. */
export interface Ctx {
  env: Bindings;
  config: Config;
  db: Db;
  principal: Principal;
  /** Artifact ids (with access epoch) whose password this requester passed (app-host cookies). */
  passwordPasses: ReadonlyMap<string, number>;
  /** Client IP for rate limits, if known. */
  ip: string | null;
  waitUntil: (p: Promise<unknown>) => void;
}
