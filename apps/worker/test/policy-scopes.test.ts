// The scope an agent needs for each artifact action (policy.ts scopeFor): reading needs
// artifacts:read for exactly the four read actions, and everything else needs artifacts:write.
import { describe, expect, it } from "vitest";
import { type ArtifactAction, scopeFor } from "../src/policy.ts";

const ALL: ArtifactAction[] = [
  "view",
  "comment",
  "mention",
  "edit",
  "restore",
  "manage",
  "delete",
  "report",
  "data_read",
  "data_write",
  "data_clear",
  "views",
  "live_edit",
];

describe("policy scopes", () => {
  it("only view, report, data_read and views need just artifacts:read", () => {
    const reads = ALL.filter((a) => scopeFor(a) === "artifacts:read");
    expect(reads).toEqual(["view", "report", "data_read", "views"]);
    for (const a of ALL) expect(["artifacts:read", "artifacts:write"], a).toContain(scopeFor(a));
  });
});
