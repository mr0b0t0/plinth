// plinth publish into a shared category: filing never shares, so the CLI says the artifact waits
// for the owner's review (docs/spec.md "Category sharing and personal categories").
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pendingNote } from "../bin/client/publish.mjs";

describe("pendingNote", () => {
  it("names the category and the review link for a pending filing", () => {
    assert.equal(
      pendingNote({
        category: "Acme",
        category_share: { state: "pending", review_url: "https://p.example/dashboard?review=s1" },
      }),
      "Waiting for your review before the people Acme is shared with can see it: https://p.example/dashboard?review=s1",
    );
  });

  it("says nothing for a shared or private artifact, or without the field", () => {
    assert.equal(pendingNote({ category_share: { state: "shared" } }), null);
    assert.equal(pendingNote({ category_share: { state: "private" } }), null);
    assert.equal(pendingNote({ category: "Acme" }), null);
    assert.equal(pendingNote(null), null);
  });

  it("works without a name or link (a read-back after a lost response)", () => {
    assert.equal(
      pendingNote({ category_share: { state: "pending" } }),
      "Waiting for your review before the people its category is shared with can see it in the app",
    );
  });

  it("prints the owner's category name without control characters", () => {
    const line = pendingNote({
      category: "Ac\u001b[31mme",
      category_share: { state: "pending", review_url: "https://p.example/r" },
    });
    assert.ok(line && !line.includes("\u001b"));
  });
});
