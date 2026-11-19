// The design system format (designSystem.ts): parsing, every refusal with its path, the CSS
// injection guard, the compiled CSS and the page reference meta.
import { describe, expect, it } from "vitest";
import {
  cssUrlArgs,
  DESIGN_SYSTEM_FORMAT,
  type DesignSystem,
  type DsParseResult,
  designSystemComponentCss,
  designSystemCss,
  designSystemFontFaces,
  designSystemFontLinks,
  designSystemJsonSchema,
  isPlainRelativeUrl,
  LIMITS,
  parseDesignSystem,
  parseDesignSystemRef,
} from "../src/index.ts";

const ACME = {
  format: DESIGN_SYSTEM_FORMAT,
  name: "Acme UI",
  description: "Product UI for Acme's web apps.",
  prefix: "acme",
  fonts: [
    {
      family: "Inter",
      google: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap",
    },
    { family: "Acme Mono", src: "fonts/acme-mono.woff2", weight: "400", style: "normal" },
  ],
  tokens: {
    color: {
      $type: "color",
      brand: { "500": { $value: "#3355ff", $description: "Primary actions" } },
      bg: { $value: "#ffffff" },
      fg: { $value: "#1f2328" },
      accent: { $value: "{color.brand.500}" },
      p3: { $value: { colorSpace: "display-p3", components: [1, 0, 0], alpha: 0.5 } },
      hexobj: { $value: { colorSpace: "srgb", components: [0, 0, 1], hex: "#0000FF" } },
    },
    space: {
      $type: "dimension",
      "1": { $value: "4px" },
      "2": { $value: { value: 8, unit: "px" } },
    },
    radius: { $type: "dimension", md: { $value: "8px" } },
    font: {
      body: {
        $type: "typography",
        $value: {
          fontFamily: ["Inter", "Segoe UI", "sans-serif"],
          fontSize: "16px",
          fontWeight: "semi-bold",
          lineHeight: 1.5,
        },
      },
      mono: { $type: "fontFamily", $value: "'Acme Mono', ui-monospace" },
    },
    shadow: {
      card: {
        $type: "shadow",
        $value: {
          color: "{color.fg}",
          offsetX: "0px",
          offsetY: "1px",
          blur: "3px",
          spread: "0px",
        },
      },
    },
    motion: {
      fast: { $type: "duration", $value: { value: 120, unit: "ms" } },
      ease: { $type: "cubicBezier", $value: [0.2, 0, 0, 1] },
    },
    line: { $type: "border", $value: { color: "{color.fg}", width: "1px", style: "solid" } },
    opacity: { $type: "number", $value: 0.5 },
  },
  themes: {
    dark: {
      color: {
        bg: { $value: "#0d1117" },
        fg: { $value: "#e6edf3" },
        brand: { "500": { $value: "#6b8cff" } },
      },
    },
  },
  guidelines: "# Using Acme UI",
  css: ".acme-btn { font: inherit; }",
  components: [
    {
      id: "button",
      name: "Button",
      css: ".acme-btn--primary { background: var(--acme-color-accent); }",
      examples: [
        { name: "Primary", html: '<button class="acme-btn">Save</button>', height: 96 },
        { name: "Disabled", html: "<button disabled>Save</button>" },
      ],
    },
  ],
};

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const withChange = (f: (ds: Json) => void): string => {
  const ds = clone(ACME) as unknown as Json;
  f(ds);
  return JSON.stringify(ds);
};

function ok(r: DsParseResult): DesignSystem {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.value;
}

function errorsOf(text: string) {
  const r = parseDesignSystem(text);
  if (r.ok) throw new Error("expected a refusal");
  return r.errors;
}

function refusedAt(text: string, path: string, message?: RegExp) {
  const errors = errorsOf(text);
  const hit = errors.find((e) => e.path === path);
  expect(hit, `no error at ${path}: ${JSON.stringify(errors)}`).toBeDefined();
  if (message) expect(hit?.message).toMatch(message);
}

const tokens = (ds: Json) => ds.tokens as Json;
const color = (ds: Json) => tokens(ds).color as Json;

describe("parseDesignSystem", () => {
  it("parses the fixture: token order, variable names and inherited types", () => {
    const r = parseDesignSystem(JSON.stringify(ACME));
    const ds = ok(r);
    expect(ds.name).toBe("Acme UI");
    expect(ds.prefix).toBe("acme");
    expect(ds.hasDarkTheme).toBe(true);
    expect(ds.tokens.map((t) => t.path)).toEqual([
      "color.brand.500",
      "color.bg",
      "color.fg",
      "color.accent",
      "color.p3",
      "color.hexobj",
      "space.1",
      "space.2",
      "radius.md",
      "font.body",
      "font.mono",
      "shadow.card",
      "motion.fast",
      "motion.ease",
      "line",
      "opacity",
    ]);
    const by = Object.fromEntries(ds.tokens.map((t) => [t.path, t]));
    expect(by["color.brand.500"]).toMatchObject({
      cssVar: "--acme-color-brand-500",
      type: "color",
      cssValue: "#3355ff",
      value: "#3355ff",
      dark: "#6b8cff",
      darkCssValue: "#6b8cff",
      description: "Primary actions",
      aliasOf: null,
    });
    expect(by["space.2"]?.cssValue).toBe("8px");
    expect(by["color.p3"]?.cssValue).toBe("color(display-p3 1 0 0 / 0.5)");
    expect(by["color.hexobj"]?.cssValue).toBe("#0000ff");
    expect(by["motion.fast"]?.cssValue).toBe("120ms");
    expect(by["motion.ease"]?.cssValue).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(by["font.mono"]?.cssValue).toBe('"Acme Mono", ui-monospace');
    expect(by.line?.cssValue).toBe("1px solid var(--acme-color-fg)");
    expect(by.line?.value).toBe("1px solid #1f2328");
    expect(by.line?.dark).toBe("1px solid #e6edf3");
    expect(by.opacity?.cssValue).toBe("0.5");
    expect(r.ok && r.warnings).toEqual([]);
  });

  it("compiles typography to one variable per part plus a font shorthand", () => {
    const body = ok(parseDesignSystem(JSON.stringify(ACME))).tokens.find(
      (t) => t.path === "font.body",
    );
    expect(body?.parts.map((p) => [p.cssVar, p.cssValue])).toEqual([
      ["--acme-font-body-font-family", 'Inter, "Segoe UI", sans-serif'],
      ["--acme-font-body-font-size", "16px"],
      ["--acme-font-body-font-weight", "600"],
      ["--acme-font-body-line-height", "1.5"],
    ]);
    expect(body?.cssValue).toBe(
      "var(--acme-font-body-font-weight) var(--acme-font-body-font-size)/var(--acme-font-body-line-height) var(--acme-font-body-font-family)",
    );
    expect(body?.value).toBe('600 16px/1.5 Inter, "Segoe UI", sans-serif');
  });

  it("compiles a shadow whose color is an alias, light and dark", () => {
    const card = ok(parseDesignSystem(JSON.stringify(ACME))).tokens.find(
      (t) => t.path === "shadow.card",
    );
    expect(card?.cssValue).toBe("0px 1px 3px 0px var(--acme-color-fg)");
    expect(card?.value).toBe("0px 1px 3px 0px #1f2328");
    expect(card?.dark).toBe("0px 1px 3px 0px #e6edf3");
  });

  it("resolves an alias to var(), and a dark override of its target changes its dark value", () => {
    const accent = ok(parseDesignSystem(JSON.stringify(ACME))).tokens.find(
      (t) => t.path === "color.accent",
    );
    expect(accent).toMatchObject({
      cssValue: "var(--acme-color-brand-500)",
      value: "#3355ff",
      dark: "#6b8cff",
      darkCssValue: null,
      aliasOf: "color.brand.500",
    });
  });

  it("takes an alias's type from its target when it sets none", () => {
    const text = withChange((ds) => {
      tokens(ds).alias = { $value: "{radius.md}" };
    });
    const t = ok(parseDesignSystem(text)).tokens.find((x) => x.path === "alias");
    expect(t).toMatchObject({ type: "dimension", cssValue: "var(--acme-radius-md)", value: "8px" });
  });

  it("accepts a chain of 16 aliases and refuses 17", () => {
    const chain = (n: number) =>
      withChange((ds) => {
        const c = color(ds);
        c.a0 = { $value: "#000000" };
        for (let i = 1; i <= n; i++) c[`a${i}`] = { $value: `{color.a${i - 1}}` };
      });
    const okText = chain(16);
    const last = ok(parseDesignSystem(okText)).tokens.find((t) => t.path === "color.a16");
    expect(last?.value).toBe("#000000");
    refusedAt(chain(17), "tokens.color.a17.$value", /longer than 16/);
  });

  it("refuses a cycle, naming its path", () => {
    const text = withChange((ds) => {
      const c = color(ds);
      c.x = { $value: "{color.y}" };
      c.y = { $value: "{color.x}" };
    });
    refusedAt(text, "tokens.color.x.$value", /cycle: color\.x → color\.y → color\.x/);
  });

  it("refuses a missing target and an incompatible type", () => {
    refusedAt(
      withChange((ds) => {
        color(ds).x = { $value: "{color.nope}" };
      }),
      "tokens.color.x.$value",
      /\{color\.nope\} is not a token/,
    );
    refusedAt(
      withChange((ds) => {
        color(ds).x = { $value: "{radius.md}" };
      }),
      "tokens.color.x.$value",
      /is a dimension, not a color/,
    );
    refusedAt(
      withChange((ds) => {
        (tokens(ds).shadow as Json).bad = {
          $type: "shadow",
          $value: { color: "{radius.md}", offsetX: "0px", offsetY: "0px", blur: "0px" },
        };
      }),
      "tokens.shadow.bad.$value.color",
      /not a color/,
    );
  });

  it("warns when a token aliases a deprecated one", () => {
    const text = withChange((ds) => {
      color(ds).old = { $value: "#123456", $deprecated: "Use brand.500" };
      color(ds).uses = { $value: "{color.old}" };
    });
    const r = parseDesignSystem(text);
    expect(r.ok && r.warnings.map((w) => [w.code, w.path])).toEqual([
      ["ds_deprecated_alias", "tokens.color.uses.$value"],
    ]);
    expect(ok(r).tokens.find((t) => t.path === "color.old")?.deprecated).toBe("Use brand.500");
  });

  it("refuses with exact paths: top-level keys, format, names, depth, count, collisions", () => {
    refusedAt(
      withChange((ds) => {
        ds.colour = {};
      }),
      "colour",
      /not a design system field/,
    );
    refusedAt(
      withChange((ds) => {
        ds.format = "plinth.design-system/2";
      }),
      "format",
    );
    refusedAt(
      withChange((ds) => void delete ds.name),
      "name",
    );
    refusedAt(
      withChange((ds) => {
        ds.prefix = "Acme";
      }),
      "prefix",
    );
    refusedAt(
      withChange((ds) => {
        color(ds)["bad.name"] = { $value: "#fff" };
      }),
      "tokens.color.bad.name",
      /a name is/,
    );
    refusedAt(
      withChange((ds) => {
        color(ds).x = { $value: "#fff", value: 1 };
      }),
      "tokens.color.x.value",
      /not a token property/,
    );
    refusedAt(
      withChange((ds) => {
        color(ds).$weird = 1;
      }),
      "tokens.color.$weird",
      /not a group property/,
    );
    const deep = withChange((ds) => {
      let node: Json = { $type: "number" };
      tokens(ds).d1 = node;
      for (let i = 2; i <= 8; i++) {
        const next: Json = {};
        node[`d${i}`] = next;
        node = next;
      }
      node.d9 = { $value: 1 };
    });
    refusedAt(deep, "tokens.d1.d2.d3.d4.d5.d6.d7.d8.d9", /deeper than 8/);
    const eight = withChange((ds) => {
      let node: Json = { $type: "number" };
      tokens(ds).d1 = node;
      for (let i = 2; i <= 7; i++) {
        const next: Json = {};
        node[`d${i}`] = next;
        node = next;
      }
      node.d8 = { $value: 1 };
    });
    expect(parseDesignSystem(eight).ok).toBe(true);
    const many = withChange((ds) => {
      const n: Json = { $type: "number" };
      for (let i = 0; i <= LIMITS.designSystem.maxTokens; i++) n[`n${i}`] = { $value: i };
      ds.tokens = { n };
    });
    refusedAt(many, "tokens", /more than 2000 tokens/);
    refusedAt(
      withChange((ds) => {
        tokens(ds)["a-b"] = { $type: "number", c: { $value: 1 } };
        tokens(ds).a = { $type: "number", "b-c": { $value: 2 } };
      }),
      "tokens.a.b-c",
      /becomes --acme-a-b-c, as tokens\.a-b\.c does/,
    );
    refusedAt(
      withChange((ds) => {
        color(ds).x = { $value: 1 };
      }),
      "tokens.color.x.$value",
    );
    refusedAt(
      withChange((ds) => {
        tokens(ds).untyped = { $value: "4px" };
      }),
      "tokens.untyped",
      /has no \$type/,
    );
  });

  it("refuses a dark theme that names a token that does not exist, or more than $value", () => {
    refusedAt(
      withChange((ds) => {
        ((ds.themes as Json).dark as Json).ghost = { $value: "#000" };
      }),
      "themes.dark.ghost",
      /no token tokens\.ghost/,
    );
    refusedAt(
      withChange((ds) => {
        ((ds.themes as Json).dark as Json).color = { bg: { $value: "#000", $type: "color" } };
      }),
      "themes.dark.color.bg.$type",
    );
    refusedAt(
      withChange((ds) => {
        (ds.themes as Json).high = {};
      }),
      "themes.high",
    );
  });

  it("warns when there is no dark theme", () => {
    const r = parseDesignSystem(withChange((ds) => void delete ds.themes));
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(["ds_no_dark_theme"]);
    expect(designSystemCss(ok(r))).not.toContain("prefers-color-scheme");
  });

  it("refuses component problems: duplicate ids and every limit", () => {
    const comp = (f: (c: Json[]) => void) =>
      withChange((ds) => {
        f(ds.components as Json[]);
      });
    refusedAt(
      comp((c) => void c.push({ ...(c[0] as Json) })),
      "components[1].id",
      /used by an earlier component/,
    );
    refusedAt(
      comp((c) => {
        (c[0] as Json).id = "Button";
      }),
      "components[0].id",
    );
    refusedAt(
      comp((c) => {
        (c[0] as Json).status = "old";
      }),
      "components[0].status",
    );
    refusedAt(
      comp((c) => {
        (c[0] as Json).examples = [];
      }),
      "components[0].examples",
    );
    refusedAt(
      comp((c) => {
        (c[0] as Json).examples = [{ name: "x", html: "<b>x</b>", height: 39 }];
      }),
      "components[0].examples[0].height",
    );
    refusedAt(
      comp((c) => {
        (c[0] as Json).examples = [{ name: "x", html: "x".repeat(20 * 1024 + 1) }];
      }),
      "components[0].examples[0].html",
      /larger than 20 KB/,
    );
    refusedAt(
      comp((c) => {
        for (let i = 0; i < 200; i++)
          c.push({ id: `c${i}`, name: "C", examples: [{ name: "x", html: "x" }] });
      }),
      "components",
      /more than 200/,
    );
    refusedAt(
      withChange((ds) => {
        ds.guidelines = "x".repeat(200 * 1024 + 1);
      }),
      "guidelines",
      /larger than 200 KB/,
    );
    refusedAt(
      withChange((ds) => {
        ds.name = "n".repeat(121);
      }),
      "name",
      /120/,
    );
  });

  it("warns about markup previews never run, once per example", () => {
    const r = parseDesignSystem(
      withChange((ds) => {
        (ds.components as Json[]).push({
          id: "danger",
          name: "Danger",
          examples: [
            { name: "Script", html: "<b>x</b><script>alert(1)</script>" },
            { name: "Handler", html: '<img src="x" onerror="alert(1)">' },
            { name: "Plain", html: "<p>Only words</p>" },
          ],
        });
      }),
    );
    expect(r.ok && r.warnings.map((w) => [w.code, w.path])).toEqual([
      ["ds_inert_markup", "components[1].examples[0].html"],
      ["ds_inert_markup", "components[1].examples[1].html"],
    ]);
  });
});

describe("the CSS injection guard", () => {
  const bad = [
    ";",
    "}",
    "{",
    "<",
    ">",
    "\\",
    "@",
    "\n",
    '"',
    "'",
    "url(",
    "URL(",
    "expression(",
    "/*",
    "*/",
  ];
  for (const s of bad) {
    it(`refuses a value holding ${JSON.stringify(s)}`, () => {
      refusedAt(
        withChange((ds) => {
          (tokens(ds).radius as Json).x = { $value: `4px${s}` };
        }),
        "tokens.radius.x.$value",
      );
      refusedAt(
        withChange((ds) => {
          color(ds).x = { $value: `red${s}` };
        }),
        "tokens.color.x.$value",
      );
      refusedAt(
        withChange((ds) => {
          (tokens(ds).font as Json).x = { $type: "fontFamily", $value: [`A${s}B`] };
        }),
        "tokens.font.x.$value",
      );
    });
  }

  it("refuses colors that are not colors and values over 256 characters", () => {
    refusedAt(
      withChange((ds) => {
        color(ds).x = { $value: "red, blue" };
      }),
      "tokens.color.x.$value",
      /not a CSS color/,
    );
    refusedAt(
      withChange((ds) => {
        color(ds).x = { $value: `rgb(${"1 ".repeat(200)})` };
      }),
      "tokens.color.x.$value",
      /256/,
    );
  });

  it("refuses CSS holding <, </style or @import", () => {
    refusedAt(
      withChange((ds) => {
        ds.css = "a { b: c } </style><script>";
      }),
      "css",
      /</,
    );
    refusedAt(
      withChange((ds) => {
        ds.css = "a::before { content: '<' }";
      }),
      "css",
    );
    refusedAt(
      withChange((ds) => {
        ds.css = "@IMPORT url(https://evil.example/x.css);";
      }),
      "css",
      /@import/,
    );
    refusedAt(
      withChange((ds) => {
        ((ds.components as Json[])[0] as Json).css = "</style>";
      }),
      "components[0].css",
    );
  });

  it("refuses CSS escapes, so an escaped at-rule or function cannot pass", () => {
    for (const css of [
      "@\\69mport url(//evil.example/a.css);",
      "@\\000069mport 'x.css';",
      "a { background: u\\72l(//evil.example/x) }",
      "a { content: '\\'' }",
    ]) {
      refusedAt(
        withChange((ds) => {
          ds.css = css;
        }),
        "css",
        /\\/,
      );
    }
    refusedAt(
      withChange((ds) => {
        ((ds.components as Json[])[0] as Json).css = "@\\69mport url(x.css);";
      }),
      "components[0].css",
      /\\/,
    );
  });

  it("refuses url() to another host, a root path or a scheme in CSS blocks", () => {
    const blocks = [
      "a { background: url(//evil.example/x.png) }",
      'a { background: url("//evil.example/x)y") }',
      "a { background: url('https://evil.example/x.png') }",
      "a { background: URL(http://evil.example/x.png) }",
      "a { background: url( /x.png ) }",
      "a { background: url(../x.png) }",
      "a { background: url(data:image/svg+xml;base64,AAAA) }",
      "@font-face { font-family: X; src: url(https://evil.example/x.woff2) }",
    ];
    for (const css of blocks) {
      refusedAt(
        withChange((ds) => {
          ds.css = css;
        }),
        "css",
        /url\(\) with a relative path/,
      );
    }
    refusedAt(
      withChange((ds) => {
        ((ds.components as Json[])[0] as Json).css = "a{background:url(//evil.example/x)}";
      }),
      "components[0].css",
    );
  });

  it("refuses url() it cannot read plainly and functions that take a URL as a string", () => {
    for (const css of [
      'a { background: url("img/a.png) }',
      "a { background: url(img/a.png }",
      'a { background: url("a.png" x) }',
      "a { background: url(a b.png) }",
      "a { background: url(a'b.png) }",
      "a { background: url(javascript:alert(1)) }",
    ]) {
      refusedAt(
        withChange((ds) => {
          ds.css = css;
        }),
        "css",
        /not plain/,
      );
    }
    for (const css of [
      "a { background: image-set('https://evil.example/x.png' 1x) }",
      "a { background: -webkit-image-set('https://evil.example/x.png' 1x) }",
      "a { background: image('https://evil.example/x.png') }",
      "@font-face { font-family: X; src: src('https://evil.example/x.woff2') }",
    ]) {
      refusedAt(
        withChange((ds) => {
          ds.css = css;
        }),
        "css",
        /image-set\(\)/,
      );
    }
  });

  it("keeps CSS blocks with relative, fragment and raster data url()", () => {
    const ds = ok(
      parseDesignSystem(
        withChange((d) => {
          d.css =
            ".hero { background: url(img/hero.png?v=2) no-repeat, url( 'img/b.webp' ) }\n" +
            '.m { mask: url(#mask-1); background-image: url("data:image/png;base64,iVBORw0KGgo=") }\n' +
            ".x { border-image-source: none; list-style-image: url(./dot.png) }";
        }),
      ),
    );
    expect(ds.css).toContain("url(img/hero.png?v=2)");
  });

  it("reads url() arguments as a CSS tokenizer does", () => {
    expect(cssUrlArgs("a{b:url(x.png) url( 'y z' ) URL(\"q\")}")).toEqual(["x.png", "y z", "q"]);
    expect(cssUrlArgs('a{b:url("//evil.example/x)y")}')).toEqual(["//evil.example/x)y"]);
    expect(cssUrlArgs("a{b:url(x.png}")).toBeNull();
    expect(cssUrlArgs("a{b:url('x.png' )")).toEqual(["x.png"]);
    expect(cssUrlArgs("a{b:url('x.png' y)")).toBeNull();
    expect(cssUrlArgs("a{b:url('x.png'")).toBeNull();
    expect(cssUrlArgs("a{b:url(x\\29 .png)}")).toBeNull();
    expect(cssUrlArgs("İİİİ url(//e)")).toEqual(["//e"]);
    expect(cssUrlArgs("no urls here")).toEqual([]);
    for (const u of ["a.png", "img/a.png", "./a.png", "fonts/x.woff2?v=1", "a.svg#icon"]) {
      expect(isPlainRelativeUrl(u), u).toBe(true);
    }
    for (const u of ["", "/a.png", "//e/a", "https://e/a", "../a", "a/../../b", "a%2e", "a b"]) {
      expect(isPlainRelativeUrl(u), u).toBe(false);
    }
  });

  it("refuses Google Fonts URLs that are not css2 or hold quotes", () => {
    const font = (google: string) =>
      withChange((ds) => {
        ds.fonts = [{ family: "Inter", google }];
      });
    refusedAt(font("https://fonts.googleapis.com/css?family=Inter"), "fonts[0].google");
    refusedAt(font("https://evil.example/css2?family=Inter"), "fonts[0].google");
    refusedAt(font('https://fonts.googleapis.com/css2?family=Inter"><script>'), "fonts[0].google");
    refusedAt(font("https://fonts.googleapis.com/css2?family=Inter'x"), "fonts[0].google");
    refusedAt(font("https://fonts.googleapis.com/css2?family=Inter#x"), "fonts[0].google");
    refusedAt(
      withChange((ds) => {
        ds.fonts = [{ family: "Inter", google: ACME.fonts[0]?.google, src: "a.woff2" }];
      }),
      "fonts[0]",
      /exactly one/,
    );
    refusedAt(
      withChange((ds) => {
        ds.fonts = [{ family: "X", src: "../a.woff2" }];
      }),
      "fonts[0].src",
    );
    refusedAt(
      withChange((ds) => {
        ds.fonts = [{ family: "X", src: "a.js" }];
      }),
      "fonts[0].src",
    );
    refusedAt(
      withChange((ds) => {
        ds.fonts = [{ family: 'X"', src: "a.woff2" }];
      }),
      "fonts[0].family",
    );
  });

  it("reports at most 50 problems", () => {
    const text = withChange((ds) => {
      const c = color(ds);
      for (let i = 0; i < 80; i++) c[`bad${i}`] = { $value: `red;${i}` };
    });
    expect(errorsOf(text)).toHaveLength(50);
  });

  it("refuses text that is not JSON or not an object", () => {
    expect(errorsOf("{")[0]?.path).toBe("");
    expect(errorsOf("[]")[0]?.message).toBe("must be a JSON object");
  });
});

describe("compiled output", () => {
  it("designSystemCss: light, media dark and explicit dark", () => {
    const ds = ok(parseDesignSystem(JSON.stringify(ACME)));
    expect(designSystemCss(ds)).toMatchSnapshot();
    const lines = designSystemCss(ds).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^:root\{--acme-color-brand-500:#3355ff;/);
    expect(lines[1]).toBe(
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--acme-color-brand-500:#6b8cff;--acme-color-bg:#0d1117;--acme-color-fg:#e6edf3;}}',
    );
    expect(lines[2]).toBe(
      ':root[data-theme="dark"]{--acme-color-brand-500:#6b8cff;--acme-color-bg:#0d1117;--acme-color-fg:#e6edf3;}',
    );
  });

  it("a dark typography override that adds or drops parts defines every variable either theme reads", () => {
    const text = withChange((ds) => {
      const font = tokens(ds).font as Json;
      font.caption = { $type: "typography", $value: { fontFamily: "Inter", fontSize: "12px" } };
      font.small = { $value: "{font.caption}" };
      const dark = (ds.themes as Json).dark as Json;
      dark.font = {
        // Adds a weight and a line height the light value lacks.
        caption: {
          $value: { fontFamily: "Inter", fontSize: "14px", fontWeight: 700, lineHeight: 1.2 },
        },
        // Drops the light value's weight and line height.
        body: { $value: { fontFamily: "Inter", fontSize: "18px" } },
      };
    });
    const ds = ok(parseDesignSystem(text));
    const [light, media, explicit] = designSystemCss(ds).split("\n");
    const declared = (block: string) =>
      new Set([...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const used = (block: string) => [...block.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const lightVars = declared(light ?? "");
    for (const v of used(light ?? "")) expect(lightVars, `light reads ${v}`).toContain(v);
    for (const block of [media ?? "", explicit ?? ""]) {
      const vars = new Set([...lightVars, ...declared(block)]);
      for (const v of used(block)) expect(vars, `dark reads ${v}`).toContain(v);
      expect(block).toContain("--acme-font-caption-font-weight:700;");
      expect(block).toContain("--acme-font-caption-line-height:1.2;");
      // What the dark shorthand resets them to, so the part variables agree with it.
      expect(block).toContain("--acme-font-body-font-weight:normal;");
      expect(block).toContain("--acme-font-body-line-height:normal;");
      // The alias's own part follows its target's dark value.
      expect(block).toContain(
        "--acme-font-small-font-weight:var(--acme-font-caption-font-weight);",
      );
    }
    expect(light).toContain("--acme-font-caption-font-weight:normal;");
    const by = Object.fromEntries(ds.tokens.map((t) => [t.path, t]));
    expect(by["font.caption"]?.dark).toBe("700 14px/1.2 Inter");
    expect(by["font.caption"]?.darkCssValue).toBe(
      "var(--acme-font-caption-font-weight) var(--acme-font-caption-font-size)/var(--acme-font-caption-line-height) var(--acme-font-caption-font-family)",
    );
    expect(by["font.small"]?.parts.map((p) => p.name)).toEqual([
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
    ]);
  });

  it("refuses a dark typography part whose variable another token already has", () => {
    const text = withChange((ds) => {
      const font = tokens(ds).font as Json;
      font.caption = { $type: "typography", $value: { fontFamily: "Inter", fontSize: "12px" } };
      font["caption-font-weight"] = { $type: "fontWeight", $value: 400 };
      ((ds.themes as Json).dark as Json).font = {
        caption: { $value: { fontFamily: "Inter", fontSize: "12px", fontWeight: 700 } },
      };
    });
    refusedAt(text, "tokens.font.caption-font-weight", /--acme-font-caption-font-weight/);
  });

  it("font links and font faces", () => {
    const ds = ok(parseDesignSystem(JSON.stringify(ACME)));
    expect(designSystemFontLinks(ds)).toEqual([ACME.fonts[0]?.google]);
    expect(designSystemFontFaces(ds)).toBe(
      '@font-face{font-family:"Acme Mono";src:url("fonts/acme-mono.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}',
    );
  });

  it("component CSS names each block", () => {
    const ds = ok(parseDesignSystem(JSON.stringify(ACME)));
    expect(designSystemComponentCss(ds)).toBe(
      "/* shared */\n.acme-btn { font: inherit; }\n/* button */\n.acme-btn--primary { background: var(--acme-color-accent); }",
    );
  });

  it("defaults the prefix to ds", () => {
    const ds = ok(parseDesignSystem(withChange((d) => void delete d.prefix)));
    expect(ds.tokens[0]?.cssVar).toBe("--ds-color-brand-500");
  });

  it("the editor schema names the format", () => {
    expect(designSystemJsonSchema.properties.format.const).toBe(DESIGN_SYSTEM_FORMAT);
  });
});

describe("parseDesignSystemRef", () => {
  const id = "abcdefghij0123456789";
  const page = (head: string, body = "") =>
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  it("reads an id, or an id and version", () => {
    expect(
      parseDesignSystemRef(page(`<meta name="plinth-design-system" content="${id}">`)),
    ).toEqual({
      id,
      version: null,
    });
    expect(
      parseDesignSystemRef(page(`<meta content='${id}@4' NAME="Plinth-Design-System">`)),
    ).toEqual({ id, version: 4 });
  });

  it("is null when malformed, absent, commented out or in the body", () => {
    expect(
      parseDesignSystemRef(page(`<meta name="plinth-design-system" content="${id}@0">`)),
    ).toBeNull();
    expect(
      parseDesignSystemRef(page(`<meta name="plinth-design-system" content="nope">`)),
    ).toBeNull();
    expect(parseDesignSystemRef(page("<title>x</title>"))).toBeNull();
    expect(
      parseDesignSystemRef(page(`<!-- <meta name="plinth-design-system" content="${id}"> -->`)),
    ).toBeNull();
    expect(
      parseDesignSystemRef(page("", `<meta name="plinth-design-system" content="${id}">`)),
    ).toBeNull();
  });

  it("treats an unterminated comment as running to the end", () => {
    expect(
      parseDesignSystemRef(page(`<!-- <meta name="plinth-design-system" content="${id}">`)),
    ).toBeNull();
    expect(
      parseDesignSystemRef(page(`<!-- x --><meta name="plinth-design-system" content="${id}">`)),
    ).toEqual({ id, version: null });
  });

  it("skips a meta with an unclosed quote, and tags that only start with meta", () => {
    expect(
      parseDesignSystemRef(page(`<metax name="plinth-design-system" content="${id}">`)),
    ).toBeNull();
    expect(
      parseDesignSystemRef(
        page(`<meta name="a>b" content='c'><meta name="plinth-design-system" content="${id}">`),
      ),
    ).toEqual({ id, version: null });
    expect(
      parseDesignSystemRef(
        page(`<meta name="x><meta name="plinth-design-system" content="${id}">`),
      ),
    ).toBeNull();
  });

  // It runs on every HTML publish and every get_artifact of an HTML page, on text anyone wrote.
  it("is linear on input built to make a scan backtrack", () => {
    const mark = '<meta name="plinth-design-system" content="nope">';
    const inputs = [
      "<meta x".repeat(36_000),
      `${"<meta x".repeat(36_000)}${mark}`,
      `${"<meta".repeat(52_000)}${mark}`,
      `${"<!--".repeat(64_000)}${mark}`,
      `<meta a='${"<meta x ".repeat(32_000)}${mark}`,
      `${"<meta a=".repeat(36_000)}${mark}`,
    ];
    for (const html of inputs) {
      const start = Date.now();
      parseDesignSystemRef(html);
      expect(Date.now() - start, `${html.slice(0, 12)}…`).toBeLessThan(250);
    }
  });

  it("takes the first of two", () => {
    const other = "zzzzzzzzzz0123456789";
    expect(
      parseDesignSystemRef(
        page(
          `<meta name="plinth-design-system" content="${id}@2"><meta name="plinth-design-system" content="${other}">`,
        ),
      ),
    ).toEqual({ id, version: 2 });
  });
});
