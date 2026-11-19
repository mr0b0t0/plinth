// The privacy notice describes page requests only on an instance that offers them.
import { describe, expect, it } from "vitest";
import { legalDoc } from "./legalDocs.tsx";
import { CONFIG } from "./test-utils.ts";

const withRequests = (enabled: boolean) =>
  JSON.stringify(
    legalDoc("privacy", {
      ...CONFIG,
      page_requests: {
        enabled,
        per_viewer_per_hour: 10,
        per_artifact_per_hour: 60,
        max_open_per_artifact: 25,
        max_open_per_requester: 3,
        max_body_chars: 4000,
        max_data_bytes: 8192,
      },
    }),
    (_k, v) => (typeof v === "function" ? "" : v),
  );

describe("privacy notice: page requests", () => {
  it("says requests a page sends are stored under the viewer's email, only when they are on", () => {
    const on = withRequests(true);
    expect(on).toContain(
      "This includes requests a page sends to its owner's agent while you have it open, stored under your email like a comment you wrote.",
    );
    expect(on).toContain(" or sends requests to its owner's agent");
    const off = withRequests(false);
    expect(off).not.toContain("requests a page sends");
    expect(off).not.toContain("sends requests to its owner's agent");
    const absent = JSON.stringify(legalDoc("privacy", CONFIG), (_k, v) =>
      typeof v === "function" ? "" : v,
    );
    expect(absent).not.toContain("requests a page sends");
  });
});
