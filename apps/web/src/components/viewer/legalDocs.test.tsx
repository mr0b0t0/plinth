// The privacy notice's shared-categories paragraph appears only on an instance that offers
// category sharing.
import { describe, expect, it } from "vitest";
import { legalDoc } from "./legalDocs.tsx";
import { CONFIG } from "./test-utils.ts";

const withSharing = (category_sharing: boolean) =>
  JSON.stringify(legalDoc("privacy", { ...CONFIG, category_sharing }), (_k, v) =>
    typeof v === "function" ? "" : v,
  );

describe("privacy notice: shared categories", () => {
  it("are described only when the instance offers category sharing", () => {
    expect(withSharing(true)).toContain("Shared categories");
    expect(withSharing(true)).toContain("never the category's own name");
    expect(withSharing(false)).not.toContain("Shared categories");
  });

  it("names personal categories as seen by their person only, whatever the switch", () => {
    for (const on of [true, false]) {
      expect(withSharing(on)).toContain("artifacts shared with you under are seen by you only");
    }
  });
});
