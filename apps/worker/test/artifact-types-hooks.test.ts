// Every type has its Worker hooks (services/artifactTypes/<id>.ts), and the per-type behaviour
// stage.ts used to branch on now comes from them.
import { ARTIFACT_TYPES, TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { typeHooks } from "../src/services/artifactTypes.ts";

describe("type hooks", () => {
  it("exist for every registered type", () => {
    for (const t of ARTIFACT_TYPES) {
      const hooks = typeHooks(TYPE_REGISTRY[t]);
      expect(typeof hooks.title).toBe("function");
      expect(typeof hooks.capabilities).toBe("function");
    }
  });

  it("read declarations only from an HTML page", () => {
    const page = '<meta name="plinth-capabilities" content="data viewer">';
    expect(typeHooks(TYPE_REGISTRY.html).capabilities(page)).not.toBeNull();
    expect(typeHooks(TYPE_REGISTRY.html).capabilities("<p>none</p>")).toBeNull();
    expect(typeHooks(TYPE_REGISTRY.doc).capabilities(page)).toBeNull();
  });

  it("give only types that take assets by content type a rule to say", () => {
    for (const t of ARTIFACT_TYPES) {
      const def = TYPE_REGISTRY[t];
      if (!def.assetTypes) expect(typeHooks(def).assetRule).toBeUndefined();
    }
    expect(typeHooks(TYPE_REGISTRY.doc).assetRule).toBe(
      "A doc's assets are images (png, jpg, gif, webp, avif, svg)",
    );
  });
});
