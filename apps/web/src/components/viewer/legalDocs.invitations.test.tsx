// The privacy notice's invitations paragraph (docs/spec.md "Invitation emails"): on every instance,
// naming categories only where category sharing is on, and how long the hashed record is kept.
import { describe, expect, it } from "vitest";
import { legalDoc } from "./legalDocs.tsx";
import { CONFIG } from "./test-utils.ts";

const text = (category_sharing: boolean) =>
  JSON.stringify(legalDoc("privacy", { ...CONFIG, category_sharing }), (_k, v) =>
    typeof v === "function" ? "" : v,
  );

describe("privacy notice: invitations", () => {
  it("says what an invitation email holds and that it is sent on the owner's behalf", () => {
    for (const on of [true, false]) {
      const t = text(on);
      expect(t).toContain("Invitations");
      expect(t).toContain("chooses to notify you, we");
      expect(t).toContain("email you on their behalf: their name and email address");
      expect(t).toContain("When you notify the people you add, we send them those details about");
      expect(t).toContain("for up to three days");
      // The opt-out record: kept until turned back on, and past an account's closing.
      expect(t).toContain("If you turn invitation emails off (the link at");
      expect(t).toContain("until you turn them back on");
      expect(t).toContain("It stays when your account is closed, so that invitations do not");
    }
  });

  it("names shared categories only where the instance offers them", () => {
    expect(text(true)).toContain(" or a shared category");
    expect(text(true)).toContain("(or the name they chose for the category)");
    expect(text(false)).not.toContain(" or a shared category");
    expect(text(false)).not.toContain("the name they chose for the category");
  });
});
