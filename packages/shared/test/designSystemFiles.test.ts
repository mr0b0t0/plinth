// The files a design system offers to other artifacts (designSystemFiles.ts): the four generated
// files and the copy_files entries that install a version under ds/<prefix>/.
import { describe, expect, it } from "vitest";
import {
  DESIGN_SYSTEM_TOKENS_FORMAT,
  DS_GENERATED_FILES,
  designSystemCss,
  designSystemFilePaths,
  designSystemGeneratedFile,
  designSystemInstall,
  isDsGeneratedFile,
  parseDesignSystem,
} from "../src/index.ts";

const REF = { id: "abcdefghij0123456789", version: 3 };

function parse(source: Record<string, unknown>) {
  const r = parseDesignSystem(JSON.stringify({ format: "plinth.design-system/1", ...source }));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

const FULL = parse({
  name: "Acme */ UI",
  prefix: "acme",
  fonts: [
    { family: "Inter", google: "https://fonts.googleapis.com/css2?family=Inter&display=swap" },
    { family: "Acme Mono", src: "fonts/mono.woff2", weight: "400" },
    { family: "Acme Gone", src: "fonts/gone.woff2" },
  ],
  tokens: { color: { $type: "color", bg: { $value: "#ffffff" } } },
  themes: { dark: { color: { bg: { $value: "#000000" } } } },
  css: ".a { background: url(img/bg.png) } .b { background: url(img/missing.png) }",
  components: [
    {
      id: "card",
      name: "Card",
      css: ".card { background: url(./img/bg.png?x#y) }",
      examples: [{ name: "One", html: "<div class=card></div>" }],
    },
  ],
});

describe("generated files", () => {
  it("names exactly four, none of which a design system's assets can take", () => {
    expect(DS_GENERATED_FILES).toEqual([
      "tokens.css",
      "fonts.css",
      "components.css",
      "tokens.json",
    ]);
    for (const f of DS_GENERATED_FILES) expect(isDsGeneratedFile(f)).toBe(true);
    expect(isDsGeneratedFile("system.json")).toBe(false);
  });

  it("tokens.css is the compiled CSS under a header of ids and numbers only", () => {
    const f = designSystemGeneratedFile(FULL, "tokens.css", REF);
    expect(f?.contentType).toBe("text/css; charset=utf-8");
    expect(f?.text).toBe(
      `/* Plinth design system ${REF.id} v3: tokens. Generated from system.json. */\n${designSystemCss(FULL)}\n`,
    );
    // The name, which holds "*/", never reaches the file.
    expect(f?.text).not.toContain("Acme");
  });

  it("fonts.css declares the system's own font files by relative path", () => {
    const text = designSystemGeneratedFile(FULL, "fonts.css", REF)?.text ?? "";
    expect(text).toContain(
      '@font-face{font-family:"Acme Mono";src:url("fonts/mono.woff2") format("woff2")',
    );
    expect(text).not.toContain("googleapis");
  });

  it("components.css holds the shared and component CSS", () => {
    const text = designSystemGeneratedFile(FULL, "components.css", REF)?.text ?? "";
    expect(text).toContain("/* shared */");
    expect(text).toContain("/* card */");
  });

  it("tokens.json holds the resolved tokens with the design system's id and version", () => {
    const f = designSystemGeneratedFile(FULL, "tokens.json", REF);
    expect(f?.contentType).toBe("application/json; charset=utf-8");
    const j = JSON.parse(f?.text ?? "{}");
    expect(j).toMatchObject({
      format: DESIGN_SYSTEM_TOKENS_FORMAT,
      design_system: REF,
      prefix: "acme",
      font_links: ["https://fonts.googleapis.com/css2?family=Inter&display=swap"],
    });
    expect(j.tokens).toEqual([
      {
        path: "color.bg",
        css_var: "--acme-color-bg",
        type: "color",
        value: "#ffffff",
        dark: "#000000",
        alias_of: null,
        description: null,
        deprecated: false,
      },
    ]);
  });

  it("is null for any other path", () => {
    expect(designSystemGeneratedFile(FULL, "system.json", REF)).toBeNull();
    expect(designSystemGeneratedFile(FULL, "ds/acme/tokens.css", REF)).toBeNull();
  });
});

describe("installing", () => {
  it("lists the generated files, the font files it has, and the files its CSS names", () => {
    const stored = new Set(["fonts/mono.woff2", "img/bg.png", "img/unused.png"]);
    const install = designSystemInstall(FULL, REF, stored);
    expect(install.folder).toBe("ds/acme");
    expect(install.copy_files.map((c) => c.path)).toEqual([
      "fonts.css",
      "tokens.css",
      "components.css",
      "tokens.json",
      "fonts/mono.woff2",
      "img/bg.png",
    ]);
    for (const c of install.copy_files) {
      expect(c).toEqual({ artifact: REF.id, path: c.path, to: `ds/acme/${c.path}`, version: 3 });
    }
    expect(install.stylesheets).toEqual([
      "ds/acme/fonts.css",
      "ds/acme/tokens.css",
      "ds/acme/components.css",
    ]);
  });

  it("leaves out fonts.css and components.css when there is nothing for them", () => {
    const plain = parse({
      name: "Plain",
      tokens: { size: { $type: "dimension", s: { $value: "4px" } } },
    });
    const install = designSystemInstall(plain, REF, new Set());
    expect(install.folder).toBe("ds/ds");
    expect(install.copy_files.map((c) => c.path)).toEqual(["tokens.css", "tokens.json"]);
    expect(install.stylesheets).toEqual(["ds/ds/tokens.css"]);
  });

  it("lists every path copy_files can take: the source, generated, then stored", () => {
    expect(designSystemFilePaths("system.json", ["system.json", "fonts/mono.woff2"])).toEqual([
      "system.json",
      ...DS_GENERATED_FILES,
      "fonts/mono.woff2",
    ]);
  });
});
