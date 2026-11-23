import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "../src/markdown.ts";

const LINK = 'rel="noopener noreferrer nofollow" target="_blank"';

/** Decode the entities the renderer writes, as a browser would inside an attribute. */
function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const ALLOWED_TAG =
  /^<(?:\/?(?:p|br|strong|em|code|pre|ul|li|blockquote|span|a)|span class="mention"|a href="([^"<>]*)" rel="noopener noreferrer nofollow" target="_blank")>$/;

/**
 * Structural safety check: every tag in the output is one the renderer writes, every link points
 * to http(s) or mailto once decoded, and no raw markup characters remain outside those tags.
 */
function assertSafe(html: string, input: string) {
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    const m = ALLOWED_TAG.exec(tag);
    expect(m, `unexpected tag ${tag} for input ${JSON.stringify(input)}`).not.toBeNull();
    const href = m?.[1];
    if (href !== undefined) {
      expect(decode(href), `href for input ${JSON.stringify(input)}`).toMatch(
        /^(https?:\/\/|mailto:)/i,
      );
    }
  }
  const text = html.replace(/<[^>]*>/g, "");
  expect(text, `stray markup for input ${JSON.stringify(input)}`).not.toMatch(/[<>"'\0]/);
}

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("renderMarkdown: formatting", () => {
  it("paragraphs and line breaks", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>two</p>\n<p>three</p>");
    expect(renderMarkdown("a\r\nb")).toBe("<p>a<br>b</p>");
    expect(renderMarkdown("")).toBe("");
  });

  it("bold, emphasis and inline code", () => {
    expect(renderMarkdown("**bold** and *em* and `x < y`")).toBe(
      "<p><strong>bold</strong> and <em>em</em> and <code>x &lt; y</code></p>",
    );
    expect(renderMarkdown("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>");
    expect(renderMarkdown("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });

  it("fenced code blocks keep content escaped and unformatted", () => {
    expect(renderMarkdown("```js\nconst a = '<b>';\n**x**\n```\nafter")).toBe(
      "<pre><code>const a = &#39;&lt;b&gt;&#39;;\n**x**</code></pre>\n<p>after</p>",
    );
    expect(renderMarkdown("```\nunclosed <i>")).toBe("<pre><code>unclosed &lt;i&gt;</code></pre>");
  });

  it("lists and quotes", () => {
    expect(renderMarkdown("- one\n- **two**\n\nend")).toBe(
      "<ul><li>one</li><li><strong>two</strong></li></ul>\n<p>end</p>",
    );
    expect(renderMarkdown("> quoted\n> - item\nnext")).toBe(
      "<blockquote><p>quoted</p>\n<ul><li>item</li></ul></blockquote>\n<p>next</p>",
    );
  });

  it("highlights mentions but not email addresses", () => {
    expect(renderMarkdown("@claude please, mail a@b.com or @Work-Claude.")).toBe(
      '<p><span class="mention">@claude</span> please, mail a@b.com or <span class="mention">@Work-Claude</span>.</p>',
    );
  });

  it("highlights @agent:other whole, and only the name before :other elsewhere", () => {
    expect(renderMarkdown("@agent:other and @work:other.")).toBe(
      '<p><span class="mention">@agent:other</span> and <span class="mention">@work</span>:other.</p>',
    );
  });

  it("links: markdown links and bare URLs to http, https and mailto", () => {
    expect(renderMarkdown("[docs](https://example.com/a?b=1&c=2)")).toBe(
      `<p><a href="https://example.com/a?b=1&amp;c=2" ${LINK}>docs</a></p>`,
    );
    expect(renderMarkdown("see https://example.com/x.")).toBe(
      `<p>see <a href="https://example.com/x" ${LINK}>https://example.com/x</a>.</p>`,
    );
    expect(renderMarkdown("[mail](mailto:a@b.com)")).toBe(
      `<p><a href="mailto:a@b.com" ${LINK}>mail</a></p>`,
    );
    expect(renderMarkdown("HTTP://EXAMPLE.COM")).toBe(
      `<p><a href="HTTP://EXAMPLE.COM" ${LINK}>HTTP://EXAMPLE.COM</a></p>`,
    );
    expect(renderMarkdown("[**bold** `c`](http://x.io)")).toBe(
      `<p><a href="http://x.io" ${LINK}><strong>bold</strong> <code>c</code></a></p>`,
    );
  });

  it("does not link a mention inside a URL", () => {
    expect(renderMarkdown("https://example.com/@claude")).toBe(
      `<p><a href="https://example.com/@claude" ${LINK}>https://example.com/@claude</a></p>`,
    );
  });
});

describe("renderMarkdown: XSS", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<iframe src=javascript:alert(1)>",
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](  javascript:alert(1))",
    "[x](java\tscript:alert(1))",
    "[x](javascript&#58;alert(1))",
    "[x](&#106;avascript:alert(1))",
    "[x](&#x6A;avascript:alert(1))",
    "[x](%6A%61vascript:alert(1))",
    "[x](vbscript:msgbox(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](DATA:text/html,<script>alert(1)</script>)",
    "[x](//evil.example)",
    "[x](/relative)",
    "[x](file:///etc/passwd)",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    '[x](https://ok.example" onmouseover="alert(1))',
    "[x](https://ok.example' onmouseover='alert(1))",
    '[x" onmouseover="alert(1)](https://ok.example)',
    "[<img src=x onerror=alert(1)>](https://ok.example)",
    '[x](https://ok.example/"><script>alert(1)</script>)',
    'https://ok.example/"onmouseover="alert(1)',
    "https://ok.example/<script>alert(1)</script>",
    "**<script>alert(1)</script>**",
    "*<b onclick=alert(1)>x</b>*",
    "`<script>`",
    "```\n</code></pre><script>alert(1)</script>\n```",
    "> <script>alert(1)</script>",
    "- <img src=x onerror=alert(1)>",
    "@<script>alert(1)</script>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "&#60;script&#62;alert(1)&#60;/script&#62;",
    "&amp;lt;script&amp;gt;",
    "\0<script>\0",
    "\u00000\u0000",
    "[a](https://x.example/\u00000\u0000)",
    "[`x`](javascript:alert(1))",
    "[[x](javascript:alert(1))](https://ok.example)",
    "[x](https://ok.example)[y](javascript:alert(1))",
    '<a href="javascript:alert(1)">x</a>',
    "<style>body{display:none}</style>",
    "<!-- comment --><p>",
    ">>>>>>>>>>>>>>>>>>>> deep <script>",
    "**[x](https://a.example)**",
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  ];

  it.each(payloads)("renders %j safely", (input) => {
    const html = renderMarkdown(input);
    assertSafe(html, input);
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toMatch(/href="(?!https?:\/\/|mailto:)/i);
  });

  it("keeps unsafe links as visible text", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).toBe("<p>[x](javascript:alert(1))</p>");
    expect(renderMarkdown("[x](data:text/html,hi)")).toBe("<p>[x](data:text/html,hi)</p>");
  });

  it("quotes in URLs and link text stay inside the attribute or text", () => {
    expect(renderMarkdown('[x](https://ok.example/a"b)')).toBe(
      `<p><a href="https://ok.example/a&quot;b" ${LINK}>x</a></p>`,
    );
    expect(renderMarkdown('[a"b](https://ok.example)')).toBe(
      `<p><a href="https://ok.example" ${LINK}>a&quot;b</a></p>`,
    );
  });

  it("bare URLs stop at escaped quotes and angle brackets", () => {
    expect(renderMarkdown('"https://ok.example"')).toBe(
      `<p>&quot;<a href="https://ok.example" ${LINK}>https://ok.example</a>&quot;</p>`,
    );
  });

  it("entities in the source are shown literally, never decoded into markup", () => {
    expect(renderMarkdown("&lt;b&gt;")).toBe("<p>&amp;lt;b&amp;gt;</p>");
  });

  it("survives random combinations of markup characters", () => {
    const pieces = [
      "<",
      ">",
      '"',
      "'",
      "&",
      "*",
      "**",
      "`",
      "```",
      "[",
      "]",
      "(",
      ")",
      "@a",
      "https://x.io",
      "javascript:",
      "mailto:",
      "\n",
      "> ",
      "- ",
      " ",
      "&#39;",
      "&quot;",
      "\0",
      "1",
    ];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      let input = "";
      const len = 1 + rand(30);
      for (let j = 0; j < len; j++) input += pieces[rand(pieces.length)];
      assertSafe(renderMarkdown(input), input);
    }
  });

  it("handles long pathological input quickly", () => {
    const inputs = [
      "*".repeat(10_000),
      "**a".repeat(3_000),
      "[".repeat(5_000) + "](".repeat(2_000),
      "> ".repeat(5_000),
      "https://x.io/".repeat(700),
      "@a".repeat(5_000),
    ];
    const start = Date.now();
    for (const input of inputs) assertSafe(renderMarkdown(input), input.slice(0, 40));
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
