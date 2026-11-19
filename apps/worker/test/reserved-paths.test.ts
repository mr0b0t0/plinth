// Plinth's own paths on a content host (content/serve.ts RESERVED_PATHS): one row per path, all
// under /__plinth/, none hiding another, and each answered by the same code as before the table.
import { CONTENT_RESERVED_PREFIX } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { DATA_API_PREFIX } from "../src/content/data-api.ts";
import { ROOM_PREFIX } from "../src/content/room.ts";
import { RESERVED_PATHS, reservedPath } from "../src/content/serve.ts";

describe("content reserved paths", () => {
  it("lists every path once, under the reserved prefix, none hiding another", () => {
    const paths = RESERVED_PATHS.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) {
      expect(p.startsWith(CONTENT_RESERVED_PREFIX), p).toBe(true);
      expect(p.length, p).toBeGreaterThan(CONTENT_RESERVED_PREFIX.length);
      for (const q of paths) {
        if (q !== p && q.endsWith("/")) expect(p.startsWith(q), `${q} hides ${p}`).toBe(false);
      }
    }
    // The enter step and versioned paths are not rows: they are the content host's own flow.
    expect(reservedPath(`${CONTENT_RESERVED_PREFIX}enter`, "own")).toBeUndefined();
    expect(reservedPath(`${CONTENT_RESERVED_PREFIX}enter`, "static")).toBeUndefined();
    expect(reservedPath(`${CONTENT_RESERVED_PREFIX}v/2/index.html`, "static")).toBeUndefined();
  });

  it("routes the same paths to the same stages as before the table", () => {
    const own = (p: string) => reservedPath(p, "own")?.path;
    const stat = (p: string) => reservedPath(p, "static")?.path;
    expect(own(`${DATA_API_PREFIX}v1/session`)).toBe(DATA_API_PREFIX);
    expect(own(`${ROOM_PREFIX}v1/page`)).toBe(ROOM_PREFIX);
    expect(own(DATA_API_PREFIX)).toBe(DATA_API_PREFIX);
    // Not a prefix match without the slash.
    expect(own("/__plinth/api")).toBeUndefined();
    expect(own("/__plinth/apix/v1/session")).toBeUndefined();
    expect(stat("/__plinth/bridge.js")).toBe("/__plinth/bridge.js");
    expect(stat("/__plinth/runtime.js")).toBe("/__plinth/runtime.js");
    expect(stat("/__plinth/preview")).toBe("/__plinth/preview");
    expect(stat("/__plinth/types/doc/doc.js")).toBe("/__plinth/types/");
    expect(stat("/__plinth/types/")).toBe("/__plinth/types/");
    // A type's framed page is never a static file: only the "pass" row, behind the content pass.
    expect(stat("/__plinth/frames/design/board.html")).toBeUndefined();
    expect(own("/__plinth/frames/design/board.html")).toBeUndefined();
    expect(reservedPath("/__plinth/frames/design/board.html", "pass")?.path).toBe(
      "/__plinth/frames/",
    );
    expect(reservedPath("/__plinth/types/design/design.js", "pass")).toBeUndefined();
    // Exact files only.
    expect(stat("/__plinth/runtime.js.map")).toBeUndefined();
    expect(stat("/__plinth/preview/x")).toBeUndefined();
    // Stages never overlap.
    expect(stat(`${DATA_API_PREFIX}v1/session`)).toBeUndefined();
    expect(own("/__plinth/runtime.js")).toBeUndefined();
    // Artifact paths are never rows.
    expect(own("/index.html")).toBeUndefined();
    expect(stat("/index.html")).toBeUndefined();
  });
});
