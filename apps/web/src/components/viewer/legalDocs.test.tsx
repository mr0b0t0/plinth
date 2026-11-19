// The privacy notice's dictation paragraph appears only on an instance that offers dictation.
import { describe, expect, it } from "vitest";
import { legalDoc } from "./legalDocs.tsx";
import { CONFIG } from "./test-utils.ts";

const text = (dictation: boolean) =>
  JSON.stringify(legalDoc("privacy", { ...CONFIG, dictation }), (_k, v) =>
    typeof v === "function" ? "" : v,
  );

describe("privacy notice: dictation", () => {
  it("is described only when the instance offers it", () => {
    expect(text(true)).toContain("Dictation");
    expect(text(true)).toContain("Chrome sends the audio to Google");
    expect(text(true)).toContain("We do not receive or keep the");
    expect(text(false)).not.toContain("Dictation");
    expect(text(false)).not.toContain("audio");
  });
});
