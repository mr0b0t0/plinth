// Golden output of the type registry and the typed shell, recorded before the registry was split
// into per-type modules (artifactTypes/<type>.ts). A refactor of the registry must leave every
// field and every shell byte as it was; a type PR adds its own row to the golden file and leaves
// the html and doc rows alone.
import { describe, expect, it } from "vitest";
import { ARTIFACT_TYPES, TYPE_REGISTRY, typedShellHtml } from "../src/index.ts";

/** The registry as plain JSON: a RegExp becomes its literal text, so a changed pattern shows. */
function serialize(value: unknown): unknown {
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  }
  return value;
}

const APP = "https://plinth.example";

describe("type registry golden", () => {
  it("keeps every type's row, in order", async () => {
    const rows = ARTIFACT_TYPES.map((t) => [t, serialize(TYPE_REGISTRY[t])]);
    expect(Object.keys(TYPE_REGISTRY)).toEqual([...ARTIFACT_TYPES]);
    await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot(
      "./__golden__/type-registry.txt",
    );
  });

  it("keeps the doc shell's bytes", async () => {
    const def = TYPE_REGISTRY.doc;
    const shells = [
      typedShellHtml(def, { title: "Notes", text: "# Hi\n\nBody", base: "", appOrigin: APP }),
      typedShellHtml(def, {
        title: `</title><script>alert("x")</script>&'`,
        text: "# T\n\n</script><script>alert(1)</script>\n<!-- x -->\u2028\u2029",
        base: "/__content/abcdefghij0123456789",
        appOrigin: APP,
      }),
      typedShellHtml(def, { title: "", text: "", base: "", appOrigin: "", live: "room" }),
    ];
    await expect(`${shells.join("\n----\n")}\n`).toMatchFileSnapshot("./__golden__/doc-shell.txt");
  });
});
