// One part of /__plinth/runtime.js (content/runtime.ts assembles them). A fragment is a run of
// whole lines of plain JavaScript that runs inside the runtime's function scope, after the core
// head and before the core tail, so it may use the core's helpers and add to the plinth object.
import type { Config } from "../../config.ts";

/** The instance settings that decide which fragments an instance serves (RuntimeFragment.included). */
export type RuntimeSwitches = Partial<Pick<Config, "allowPageRequests" | "contentIsolation">>;

/** What a fragment's source may embed: public instance configuration only, never secrets. */
export interface RuntimeContext {
  /** The instance's app origin, as a JSON string literal. */
  appOriginJson: string;
}

export interface RuntimeFragment {
  /** A short name, unique in the assembly list. */
  name: string;
  /**
   * The fragment uses the app channel (toApp, onApp), so the runtime includes it. A fragment that
   * does not leaves the script free of any configuration value.
   */
  usesAppChannel?: boolean;
  /**
   * Only on instances where this holds (a feature that ships off, such as page requests); without
   * it, on every instance. Whether it holds is public configuration, the same for every artifact.
   */
  included?: (switches: RuntimeSwitches) => boolean;
  source: (ctx: RuntimeContext) => string;
}
