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
    expect(withSharing(true)).toContain("The title is the category's name unless you change it.");
    expect(withSharing(true)).toContain("your name and email address");
    expect(withSharing(true)).not.toContain("never the category");
    expect(withSharing(false)).not.toContain("Shared categories");
  });

  it("names personal categories as seen by their person only, whatever the switch", () => {
    for (const on of [true, false]) {
      expect(withSharing(on)).toContain("artifacts shared with you under are seen by you only");
    }
  });
});

const forMode = (single_user_mode: boolean) =>
  JSON.stringify(legalDoc("privacy", { ...CONFIG, single_user_mode }), (_k, v) =>
    typeof v === "function" ? "" : v,
  );

describe("privacy notice: a viewing code signs the address in", () => {
  it("says confirming the code creates an account, except on a single-user instance", () => {
    const sentence =
      "confirming the code we email you signs you in and creates a Plinth account for that address if it has none";
    expect(forMode(false)).toContain(sentence);
    expect(forMode(true)).not.toContain(sentence);
  });

  it("records people who confirmed a code as signed in, except on a single-user instance", () => {
    const signedIn = "including anyone who confirmed their address with a code we emailed them.";
    const viewer = "and the email address of viewers who confirmed it with a code.";
    expect(forMode(false)).toContain(signedIn);
    expect(forMode(false)).not.toContain(viewer);
    expect(forMode(true)).toContain(viewer);
    expect(forMode(true)).not.toContain(signedIn);
  });
});
