// The privacy notice and the acceptable use policy describe files people add to pages only on an
// instance that offers them.
import { describe, expect, it } from "vitest";
import { legalDoc } from "./legalDocs.tsx";
import { CONFIG } from "./test-utils.ts";

const withFiles = (id: "privacy" | "acceptable-use", files: boolean) =>
  JSON.stringify(legalDoc(id, { ...CONFIG, files }), (_k, v) => (typeof v === "function" ? "" : v));

describe("privacy notice and acceptable use: files people add to pages", () => {
  it("describes what is kept, who sees it and for how long, only when the instance offers it", () => {
    const on = withFiles("privacy", true);
    expect(on).toContain("Files people add to pages");
    expect(on).toContain("email address and role of the person who added it");
    expect(on).toContain("never its contents");
    expect(on).toContain("with any details saved inside it, such as where and when");
    expect(on).toContain("Files never");
    expect(on).toContain("An upload not finished");
    expect(on).toContain(" or keeps the files they add");
    const off = withFiles("privacy", false);
    expect(off).not.toContain("Files people add to pages");
    expect(off).not.toContain("keeps the files they add");
  });

  it("forbids files that break the rules and pages that collect secrets as files", () => {
    const on = withFiles("acceptable-use", true);
    expect(on).toContain("Adding files to a page that break any of these rules");
    expect(on).toContain("passwords, payment details or identity documents");
    expect(on).toContain("also deletes the files people added to it");
    const off = withFiles("acceptable-use", false);
    expect(off).not.toContain("Adding files to a page");
    expect(off).not.toContain("files people added");
  });
});
