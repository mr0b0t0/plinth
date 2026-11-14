import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TYPES,
  ASSET_PATH_RE,
  jsonForScript,
  LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  sourceOf,
  TYPE_REGISTRY,
  typeDef,
  typedShellHtml,
} from "../src/index.ts";

const LS = "\u2028";
const PS = "\u2029";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The JSON inside the shell's data block, as the renderer reads it. */
function payloadOf(shell: string): unknown {
  const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(shell);
  if (!m?.[1]) throw new Error("no payload");
  return JSON.parse(m[1]);
}

describe("type registry", () => {
  const defs = ARTIFACT_TYPES.map((t) => TYPE_REGISTRY[t]);

  it("has one row per type, keyed by its own id", () => {
    expect(Object.keys(TYPE_REGISTRY).sort()).toEqual([...ARTIFACT_TYPES].sort());
    for (const t of ARTIFACT_TYPES) expect(TYPE_REGISTRY[t].id).toBe(t);
  });

  it("has unique ids and source paths", () => {
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => d.sourcePath)).size).toBe(defs.length);
  });

  it("reserves each type's own source path, and every source path is a valid asset path", () => {
    for (const d of defs) {
      expect(d.reservedPaths).toContain(d.sourcePath);
      expect(d.reservedPaths).toContain("index.html");
      expect(ASSET_PATH_RE.test(d.sourcePath)).toBe(true);
    }
  });

  it("gives html no renderer and doc one", () => {
    expect(TYPE_REGISTRY.html.renderer).toBeNull();
    expect(TYPE_REGISTRY.html.assetTypes).toBeNull();
    expect(TYPE_REGISTRY.html.sourcePath).toBe("index.html");
    expect(TYPE_REGISTRY.html.sourceField).toBe("html");
    expect(TYPE_REGISTRY.html.maxSourceBytes).toBe(LIMITS.maxHtmlBytes);
    expect(TYPE_REGISTRY.doc.renderer).toEqual({ script: "doc.js", style: "doc.css" });
    expect(TYPE_REGISTRY.doc.sourcePath).toBe("content.md");
    expect(TYPE_REGISTRY.doc.sourceField).toBe("content");
    expect(TYPE_REGISTRY.doc.reservedPaths).toEqual(["index.html", "content.md"]);
    expect(TYPE_REGISTRY.doc.maxSourceBytes).toBe(LIMITS.maxDocBytes);
    expect(TYPE_REGISTRY.doc.editor).toEqual({ language: "markdown", wordWrap: "on" });
    // The HTML editor keeps the wrapping it had before types existed.
    expect(TYPE_REGISTRY.html.editor).toEqual({ language: "html", wordWrap: "on" });
  });

  it("limits doc assets to images", () => {
    const re = TYPE_REGISTRY.doc.assetTypes;
    expect(re).not.toBeNull();
    for (const ok of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(re?.test(ok)).toBe(true);
    }
    expect(re?.test("image/svg+xml")).toBe(true);
    for (const bad of ["text/html", "application/javascript", "image/png; x", "ximage/png"]) {
      expect(re?.test(bad)).toBe(false);
    }
  });

  it("looks up known types and returns null for anything else", () => {
    expect(typeDef("doc")).toBe(TYPE_REGISTRY.doc);
    expect(typeDef("html")).toBe(TYPE_REGISTRY.html);
    for (const bad of ["", "deck", "DOC", "toString", "__proto__", "constructor"]) {
      expect(typeDef(bad)).toBeNull();
    }
  });

  it("has renderer protocol constants and a 1 MB doc limit", () => {
    expect(LIMITS.maxDocBytes).toBe(1024 * 1024);
    expect(RENDERER_MESSAGE_SOURCE).toBe("plinth-renderer");
    expect(RENDERER_PROTOCOL_VERSION).toBe(1);
  });
});

describe("jsonForScript", () => {
  const samples = [
    "",
    "plain",
    "</script><script>alert(1)</script>",
    "<!-- comment --> <![CDATA[ x ]]>",
    `line${LS}sep${PS}para`,
    "a & b && c &amp; d",
    '"quotes" and \\ backslashes \n\t',
    "emoji \u{1F600} and \u0000 nul",
  ];

  it("round-trips arbitrary strings through JSON.parse", () => {
    for (const s of samples) {
      expect(JSON.parse(jsonForScript(s))).toBe(s);
      expect(JSON.parse(jsonForScript({ text: s, n: 1 }))).toEqual({ text: s, n: 1 });
    }
  });

  it("never emits characters that could leave a script data block", () => {
    for (const s of samples) {
      const out = jsonForScript({ text: s });
      for (const c of ["<", ">", "&", LS, PS]) expect(out).not.toContain(c);
    }
  });
});

describe("typedShellHtml", () => {
  const def = TYPE_REGISTRY.doc;
  const appOrigin = "https://plinth.example";

  it("builds the doc shell at the artifact root", () => {
    const shell = typedShellHtml(def, { title: "Notes", text: "# Hi", base: "", appOrigin });
    expect(shell.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8">')).toBe(
      true,
    );
    expect(shell).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(shell).toContain('<meta name="color-scheme" content="light dark">');
    expect(shell).toContain("<title>Notes</title>");
    expect(shell).toContain('<link rel="stylesheet" href="/__plinth/types/doc/doc.css">');
    expect(shell).toContain('<main id="__plinth-doc" class="plinth-doc" tabindex="-1"></main>');
    expect(shell).toContain('<script src="/__plinth/types/doc/doc.js"></script>');
    expect(shell.endsWith("</body></html>")).toBe(true);
    expect(payloadOf(shell)).toEqual({
      v: 1,
      type: "doc",
      path: "content.md",
      app_origin: appOrigin,
      text: "# Hi",
    });
  });

  it("prefixes renderer URLs with the path-fallback base", () => {
    const base = "/__content/abcdefghij0123456789";
    const shell = typedShellHtml(def, { title: "t", text: "", base, appOrigin });
    expect(shell).toContain(`<link rel="stylesheet" href="${base}/__plinth/types/doc/doc.css">`);
    expect(shell).toContain(`<script src="${base}/__plinth/types/doc/doc.js"></script>`);
  });

  it("escapes a hostile title", () => {
    const title = `</title><script>alert("x")</script>&'`;
    const shell = typedShellHtml(def, { title, text: "", base: "", appOrigin });
    expect(shell).toContain(
      "<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</title>",
    );
    expect(count(shell, "<title>")).toBe(1);
    expect(count(shell, "<script")).toBe(2);
  });

  it("keeps hostile Markdown inside the data block", () => {
    const text = "# T\n\n</script><script>alert(1)</script>\n<!-- x -->";
    const shell = typedShellHtml(def, { title: "t", text, base: "", appOrigin });
    expect(count(shell, "<script")).toBe(2);
    expect(count(shell, "</script>")).toBe(2);
    expect(shell).not.toContain("<!--");
    expect((payloadOf(shell) as { text: string }).text).toBe(text);
  });

  it("refuses a type without a renderer", () => {
    expect(() =>
      typedShellHtml(TYPE_REGISTRY.html, { title: "t", text: "", base: "", appOrigin }),
    ).toThrow();
  });
});

describe("sourceOf", () => {
  it("reads html for a page and content for a doc, with the registry row", () => {
    expect(sourceOf({ type: "html", html: "<p>x</p>" })).toEqual({
      def: TYPE_REGISTRY.html,
      text: "<p>x</p>",
    });
    expect(sourceOf({ type: "doc", content: "# x" })).toEqual({
      def: TYPE_REGISTRY.doc,
      text: "# x",
    });
  });
});
