// The HTML string scanner of change lists against hostile input, its cost, and the rule that the
// changes modules stay pure and zod-free (so renderer bundles and the room can import them).
import { describe, expect, it } from "vitest";
import { describeChanges, markdownBlocks, markupSignature, scanHtml } from "../src/index.ts";

const texts = (html: string) => scanHtml(html).runs.map((r) => r.text);

describe("scanHtml", () => {
  it("finds visible text, the title and the nearest heading", () => {
    const s = scanHtml(
      "<!doctype html><html><head><title> Q &amp; A </title></head><body><h1>Top</h1><p>One <b>two</b> three</p><h2>Sub</h2><ul><li>a</li><li>b</li></ul></body></html>",
    );
    expect(s.title).toBe("Q & A");
    expect(s.runs).toEqual([
      { text: "Top", heading: true, under: "" },
      { text: "One two three", heading: false, under: "Top" },
      { text: "Sub", heading: true, under: "Top" },
      { text: "a", heading: false, under: "Sub" },
      { text: "b", heading: false, under: "Sub" },
    ]);
  });

  it("skips an unclosed comment to the end", () => {
    expect(texts("<p>Before</p><!-- never closed <p>after</p>")).toEqual(["Before"]);
  });

  it("never reads script, style or template text as text, whatever they hold", () => {
    const s = scanHtml(
      '<script>document.write("<p>fake</p>")</script><p>Real</p><style>p::after{content:"</p>x"}</style><script>if (a </script>b) {}</script><template><p>later</p></template><noscript><p>no js</p></noscript>',
    );
    expect(s.runs.map((r) => r.text)).toEqual(["Real", "b) {}"]);
    expect(s.scripts).toEqual(['document.write("<p>fake</p>")', "if (a "]);
    expect(s.styles).toEqual(['p::after{content:"</p>x"}']);
  });

  it("treats an end tag in another case, or with attributes, as the end", () => {
    expect(texts("<SCRIPT>x</ScRiPt foo><p>After</p>")).toEqual(["After"]);
    expect(texts("<script>x</scripts><p>still script</p></script><p>After</p>")).toEqual(["After"]);
  });

  it("finds end tags after characters whose lowercase is longer (İ), and lowercases ASCII only", () => {
    const page = (key: string) =>
      `<html><head><title>İstanbul İzmir guide</title><script>const apiKey = "${key}";</script></head><body><p>Hello</p></body></html>`;
    const s = scanHtml(page("one"));
    expect(s.title).toBe("İstanbul İzmir guide");
    expect(s.scripts).toEqual(['const apiKey = "one";']);
    expect(s.runs.map((r) => r.text)).toEqual(["Hello"]);
    const list = describeChanges("html", page("one"), page("two")).items;
    expect(list).toEqual([{ kind: "changed", where: "", what: "Scripts changed" }]);

    const turkish = (word: string) =>
      `<p>${"İ".repeat(20)}</p><script>var x=1</script><p>${word} world</p>`;
    expect(texts(turkish("Hello"))).toEqual(["İ".repeat(20), "Hello world"]);
    expect(describeChanges("html", turkish("Hello"), turkish("Goodbye")).items).toEqual([
      {
        kind: "changed",
        where: "",
        what: "Text changed",
        before: "Hello world",
        after: "Goodbye world",
      },
    ]);
    // U+212A KELVIN SIGN lowercases to "k" in JavaScript, but a browser lowercases ASCII only:
    // <lin\u212A> is not a link element.
    expect(scanHtml('<lin\u212A rel="stylesheet" href="s.css">').styles).toEqual([]);
    expect(texts("<p>İ</p><TITLE>T</tİtle></TITLE><p>after</p>")).toEqual(["İ", "after"]);
  });

  it("decodes character references once, as text", () => {
    expect(
      texts("<p>&lt;b&gt;bold&lt;/b&gt; &amp;amp; &#x1F600; &#0; &#xD800; &unknown; &nbsp;x</p>"),
    ).toEqual(["<b>bold</b> &amp; 😀 � � &unknown; x"]);
  });

  it("keeps a stray < as text and stops at an unclosed tag", () => {
    expect(texts("<p>1 < 2 and 3 <> 4</p>")).toEqual(["1 < 2 and 3 <> 4"]);
    expect(texts('<p>Before</p><img src="x')).toEqual(["Before"]);
    expect(texts("<p>Before</p><div class='open")).toEqual(["Before"]);
  });

  it("reads quoted attributes holding > and the attributes it lists", () => {
    const s = scanHtml(
      '<a title="a > b" href="/x?y=1&amp;z=2">go</a><img alt=">" src=pic.png><link rel="preload stylesheet" href="s.css"><form></form><p style="color: red">x</p><script src="app.js"></script>',
    );
    expect(s.links).toEqual(["/x?y=1&z=2"]);
    expect(s.images).toEqual(["pic.png"]);
    expect(s.forms).toBe(1);
    expect(s.styles).toEqual(["link:s.css", "attr:color: red"]);
    expect(s.scripts).toEqual(["src:app.js"]);
    expect(s.runs.map((r) => r.text)).toEqual(["go", "x"]);
  });

  it("is linear: a megabyte of hostile input scans quickly", () => {
    const inputs = [
      "<".repeat(1_000_000),
      "<a ".repeat(330_000),
      `<p title="${"x".repeat(1_000_000)}`,
      "<!--".repeat(250_000),
      "&#".repeat(500_000),
      "<script>".repeat(125_000),
      "</".repeat(500_000),
    ];
    for (const input of inputs) {
      const t = Date.now();
      scanHtml(input);
      expect(Date.now() - t).toBeLessThan(1500);
    }
  });
});

describe("markupSignature", () => {
  it("ignores how markup is written and keeps what can show", () => {
    expect(markupSignature("<P CLASS='a  b' id=x>Hi &amp; you</P><!-- n -->\n")).toBe(
      markupSignature('<p id="x" class="a b">\n  Hi &#38; you\n</p>'),
    );
    expect(markupSignature("<pre>a\n  b</pre>")).not.toBe(markupSignature("<pre>a\n b</pre>"));
    expect(markupSignature("<p>a\n  b</p>")).toBe(markupSignature("<p>a\n b</p>"));
    expect(markupSignature("<img src=a width=1>")).not.toBe(markupSignature("<img src=a>"));
  });

  it("is linear: a megabyte of hostile input scans quickly", () => {
    for (const input of [
      "<".repeat(1_000_000),
      "<a ".repeat(330_000),
      "<a b=c>".repeat(140_000),
      "<pre>".repeat(200_000),
      "<!x".repeat(330_000),
      "<?>".repeat(330_000),
      "<!--".repeat(250_000),
      "&#".repeat(500_000),
      "<template>".repeat(100_000),
      "</".repeat(500_000),
    ]) {
      const t = Date.now();
      markupSignature(input);
      // About 0.1 s on an idle machine; a scan that is quadratic here would take minutes.
      expect(Date.now() - t).toBeLessThan(5000);
    }
  }, 60_000);
});

describe("markdownBlocks", () => {
  it("is linear on long lines of syntax characters", () => {
    for (const input of [
      `# ${" ".repeat(500_000)}x`,
      "#".repeat(500_000),
      "*_".repeat(250_000),
      "![".repeat(250_000),
      "[a](".repeat(125_000),
      "`".repeat(500_000),
      "|".repeat(500_000),
    ]) {
      const t = Date.now();
      markdownBlocks(input);
      describeChanges("doc", input, `${input}x`);
      expect(Date.now() - t).toBeLessThan(3000);
    }
  });
});

describe("changes modules", () => {
  // Every module the change describers load, read from disk: none may import zod (or anything
  // that does), so a renderer bundle that imports them stays small.
  const fsModule = "node:fs";
  const pathModule = "node:path";
  const urlModule = "node:url";
  it("are pure and zod-free", async () => {
    const fs = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(p: string, e: "utf8"): string;
    };
    const path = (await import(/* @vite-ignore */ pathModule)) as {
      resolve(...p: string[]): string;
      dirname(p: string): string;
    };
    // The shared package's types know no URL or import.meta.url; vitest runs on Node, which has both.
    const here = (import.meta as unknown as { url: string }).url;
    const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as {
      fileURLToPath(u: string): string;
    };
    const root = path.resolve(path.dirname(fileURLToPath(here)), "../src/changes/index.ts");
    const seen = new Set<string>();
    const queue = [root];
    const external = new Set<string>();
    while (queue.length) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = fs.readFileSync(file, "utf8");
      // Value imports and re-exports only: `import type` is erased.
      for (const m of src.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms)) {
        const spec = m[1] as string;
        if (spec.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec));
        else external.add(spec);
      }
    }
    expect([...external].sort()).toEqual(["diff"]);
    expect([...seen].some((f) => f.endsWith("/schemas.ts") || f.endsWith("/data.ts"))).toBe(false);
  });
});
