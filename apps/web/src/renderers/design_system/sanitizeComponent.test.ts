// The allowlist pass over component example HTML: what a preview frame may hold. Each case is the
// serialized output, so a change to what survives shows as a diff.
import { describe, expect, it } from "vitest";
import { isSafePreviewSrc, sanitizeComponentHtml } from "./sanitizeComponent.ts";

const clean = (html: string) => sanitizeComponentHtml(html, document);

describe("sanitizeComponentHtml", () => {
  const cases: [string, string, string][] = [
    [
      "keeps plain markup and classes",
      '<button class="btn btn--primary" type="button">Save</button>',
      '<button class="btn btn--primary" type="button">Save</button>',
    ],
    [
      "removes script with its content",
      "<p>a</p><script>alert(1)</script><p>b</p>",
      "<p>a</p><p>b</p>",
    ],
    [
      "removes event handlers",
      '<img src="x.png" onerror="alert(1)" alt="x">',
      '<img src="x.png" alt="x">',
    ],
    [
      "removes handlers on any element",
      '<div onclick="x()" onmouseover="y()">t</div>',
      "<div>t</div>",
    ],
    ["neutralizes javascript: links", '<a href="javascript:alert(1)">x</a>', '<a href="#">x</a>'],
    [
      "keeps fragment links only",
      '<a href="#top">a</a><a href="https://example.com">b</a>',
      '<a href="#top">a</a><a href="#">b</a>',
    ],
    [
      "drops data:text/html sources",
      '<img src="data:text/html,<script>alert(1)</script>">',
      "<img>",
    ],
    [
      "keeps data: raster images",
      '<img src="data:image/png;base64,iVBORw0KGgo=">',
      '<img src="data:image/png;base64,iVBORw0KGgo=">',
    ],
    [
      "drops outside and absolute sources",
      '<img src="https://evil.example/x.png"><img src="//evil.example/x"><img src="/x.png"><img src="../x.png">',
      "<img><img><img><img>",
    ],
    [
      "removes meta refresh",
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>x</p>',
      "<p>x</p>",
    ],
    ["removes base", '<base href="https://evil.example/"><p>x</p>', "<p>x</p>"],
    [
      "unwraps forms and drops formaction and action",
      '<form action="https://evil.example"><input name="q" formaction="https://evil.example"><button formaction="/x">Go</button></form>',
      '<input name="q"><button>Go</button>',
    ],
    [
      "removes iframes and srcdoc",
      '<iframe srcdoc="<script>alert(1)</script>"></iframe><p>x</p>',
      "<p>x</p>",
    ],
    [
      "removes object and embed",
      '<object data="x.swf"></object><embed src="x.swf"><p>x</p>',
      "<p>x</p>",
    ],
    [
      "removes SVG use, foreignObject and animate",
      '<svg viewBox="0 0 10 10"><use href="https://evil.example/s.svg#a"></use><foreignObject><p>x</p></foreignObject><animate attributeName="href" to="javascript:alert(1)"></animate><circle cx="5" cy="5" r="4" fill="red"></circle></svg>',
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"></circle></svg>',
    ],
    [
      "drops xlink:href and outside url() in SVG paint",
      '<svg><rect width="4" height="4" fill="url(https://evil.example/p)" xlink:href="x"></rect><rect fill="url(#grad)"></rect></svg>',
      '<svg><rect width="4" height="4"></rect><rect fill="url(#grad)"></rect></svg>',
    ],
    [
      "drops style with an outside url()",
      '<div style="background: url(https://evil.example/x.png)">x</div>',
      "<div>x</div>",
    ],
    [
      "drops style with image-set or escapes",
      '<div style="background-image: image-set(\'https://evil.example/x.png\' 1x)">a</div><div style="background: u\\72l(x)">b</div>',
      "<div>a</div><div>b</div>",
    ],
    [
      "keeps style with a relative url()",
      '<div style="background: url(img/a.png) no-repeat; color: red">x</div>',
      '<div style="background: url(img/a.png) no-repeat; color: red">x</div>',
    ],
    [
      "keeps style with a quoted relative url() and a raster data: url()",
      "<div style=\"background: url(&quot;img/a.png&quot;), url('data:image/png;base64,iVBORw0KGgo=')\">x</div>",
      "<div style=\"background: url(&quot;img/a.png&quot;), url('data:image/png;base64,iVBORw0KGgo=')\">x</div>",
    ],
    [
      "drops style whose quoted url() holds a ) (off-host behind the first parenthesis)",
      '<div style="background:url(&quot;//evil.example/x)y&quot;)">a</div><div style="background:url(\'//evil.example/x)y\')">b</div>',
      "<div>a</div><div>b</div>",
    ],
    [
      "drops style with a protocol-relative or schemed url()",
      '<div style="background:url(//evil.example/x)">a</div><div style="background:url(&quot; //evil.example/x &quot;)">b</div><div style="background:url(HTTPS://evil.example/x)">c</div><div style="background:URL(/x.png)">d</div>',
      "<div>a</div><div>b</div><div>c</div><div>d</div>",
    ],
    [
      "drops style whose url() cannot be read plainly",
      '<div style="background:url(&quot;img/a.png">a</div><div style="background:url(img/a.png">b</div><div style="background:url(&quot;a.png&quot; x)">c</div><div style="background:url(a b.png)">d</div><div style="background:url(a&quot;.png)">e</div><div style="background:url(img/%2e%2e/a.png)">f</div>',
      "<div>a</div><div>b</div><div>c</div><div>d</div><div>e</div><div>f</div>",
    ],
    [
      "keeps SVG title and desc as text only",
      '<svg><title>Logo <b>mark</b><img src=x onerror="alert(1)"></title><desc><p>A</p> desc</desc><circle r="1"></circle></svg>',
      '<svg><title>Logo mark</title><desc>A desc</desc><circle r="1"></circle></svg>',
    ],
    ["still drops the HTML title element", "<title>t</title><p>x</p>", "<p>x</p>"],
    [
      "removes svg style (mXSS)",
      "<svg><style>@import url(https://evil.example/x.css)</style></svg>",
      "<svg></svg>",
    ],
    [
      "removes noscript and template",
      "<noscript><p>a</p></noscript><template><script>x</script></template><p>b</p>",
      "<p>b</p>",
    ],
    [
      "removes style elements: CSS belongs in css",
      "<style>body{display:none}</style><p>x</p>",
      "<p>x</p>",
    ],
    [
      "removes link and target",
      '<link rel="stylesheet" href="https://evil.example/x.css"><a href="#a" target="_top">x</a>',
      '<a href="#a">x</a>',
    ],
    [
      "keeps form controls and their state",
      '<label for="a">A</label><input id="a" type="checkbox" checked disabled><select><option selected>One</option></select><textarea rows="2">t</textarea>',
      '<label for="a">A</label><input id="a" type="checkbox" checked="" disabled=""><select><option selected="">One</option></select><textarea rows="2">t</textarea>',
    ],
    [
      "keeps details open and closes dialogs",
      "<details open><summary>S</summary>b</details><dialog open>d</dialog>",
      '<details open=""><summary>S</summary>b</details><dialog>d</dialog>',
    ],
    [
      "keeps aria and data attributes",
      '<span role="status" aria-live="polite" data-state="on">x</span>',
      '<span role="status" aria-live="polite" data-state="on">x</span>',
    ],
    ["drops comments", "<p>a<!-- <script>x</script> --></p>", "<p>a</p>"],
    [
      "checks every srcset candidate",
      '<img srcset="a.png 1x, https://evil.example/b.png 2x"><img srcset="a.png 1x, b.png 2x">',
      '<img><img srcset="a.png 1x, b.png 2x">',
    ],
  ];
  for (const [name, input, output] of cases) {
    it(name, () => {
      expect(clean(input)).toBe(output);
    });
  }

  it("never lets a script element or an on* attribute through a corpus of tricks", () => {
    const corpus = [
      "<scr<script>ipt>alert(1)</script>",
      "<svg><script>alert(1)</script></svg>",
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      "<img src=x onerror=alert(1)//>",
      '<a href="  javascript:alert(1)">x</a>',
      '<a href="jav&#x09;ascript:alert(1)">x</a>',
      '<div><svg><g onload="alert(1)"></g></svg></div>',
      "<table><tr><td><script>alert(1)</script></td></tr></table>",
      "<select><style><img src=x onerror=alert(1)></style></select>",
      "<noscript><img src=x onerror=alert(1)></noscript>",
    ];
    for (const html of corpus) {
      const out = clean(html);
      expect(out, html).not.toMatch(/<script/i);
      expect(out, html).not.toMatch(/\son[a-z]+=/i);
      expect(out, html).not.toMatch(/javascript:/i);
    }
  });
});

describe("isSafePreviewSrc", () => {
  it("takes relative paths and raster data URLs only", () => {
    for (const ok of ["img/a.png", "a.png", "fonts/x.woff2?v=1", "data:image/webp;base64,AAAA"]) {
      expect(isSafePreviewSrc(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "/a.png",
      "//evil.example/a.png",
      "https://evil.example/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,AAAA",
      "../a.png",
      "img/../../a.png",
      "img\\a.png",
      "img/%2e%2e/a.png",
      "a\u0000.png",
    ]) {
      expect(isSafePreviewSrc(bad), bad).toBe(false);
    }
  });
});
