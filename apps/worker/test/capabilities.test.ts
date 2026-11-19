// Reading stored capabilities back (services/artifacts.ts versionCapabilities): every server
// decision on a page reads versions.capabilities through this one function, so the server-only
// write floor (`writers`) a whiteboard's versions carry must survive the round trip, and nothing
// but "commenter" or "editor" may come back as one.
import { boardCapabilities, parseCapabilities, serializeCapabilities } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { versionCapabilities } from "../src/services/artifacts.ts";

describe("versionCapabilities", () => {
  it.each(["editors", "commenters"] as const)(
    "reads a whiteboard's %s capabilities back exactly, writers included",
    (edit) => {
      const caps = boardCapabilities({ v: 1, background: "dots", edit });
      const back = versionCapabilities({ capabilities: serializeCapabilities(caps) });
      expect(back).toEqual(caps);
      expect(back?.writers).toBe(edit === "editors" ? "editor" : "commenter");
    },
  );

  it.each([["viewer"], ["owner"], [1], [null], [["editor"]]])(
    "drops writers %j and parses the rest as before",
    (writers) => {
      const back = versionCapabilities({
        capabilities: JSON.stringify({
          data: true,
          viewer: true,
          shared: ["blocks"],
          room: true,
          roomOpen: ["block.move"],
          writers,
        }),
      });
      expect(back).toEqual({
        data: true,
        viewer: true,
        shared: ["blocks"],
        room: true,
        roomOpen: ["block.move"],
        people: false,
        comments: false,
        dictation: false,
      });
    },
  );

  it("round-trips an HTML declaration with no writers key", () => {
    const caps = parseCapabilities(
      '<meta name="plinth-capabilities" content="data viewer room"><meta name="plinth-room-open" content="*">',
    );
    if (!caps) throw new Error("declared nothing");
    const back = versionCapabilities({ capabilities: serializeCapabilities(caps) });
    expect(back).toEqual(caps);
    expect(back && "writers" in back).toBe(false);
  });
});
