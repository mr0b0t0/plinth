// Every switch that keeps identity claims sealed (config.ts IDENTITY_READERS), turned off. A
// feature that adds a reader adds its switch here, one per line, and no assertion changes.
import type { Config } from "../src/config.ts";

export function everyIdentityReaderOff(): {
  /** As env vars, for parseConfig. */
  vars: Record<string, string>;
  /** As config fields, for a parsed config. */
  config: Partial<Config>;
} {
  return {
    vars: {
      ALLOW_SHARED_DATA: "false",
      ALLOW_ROOMS: "false",
      ALLOW_FILES: "false",
      ALLOW_PAGE_REQUESTS: "false",
    },
    config: {
      allowSharedData: false,
      allowRooms: false,
      allowFiles: false,
      allowPageRequests: false,
    },
  };
}

/**
 * The switches of identity readers that ship off (ALLOW_FILES, ALLOW_PAGE_REQUESTS), turned on,
 * as env vars for parseConfig: with them, every reader is active on the test base config.
 */
export function everyIdentityReaderOn(): Record<string, string> {
  return {
    ALLOW_FILES: "true",
    ALLOW_PAGE_REQUESTS: "true",
  };
}
