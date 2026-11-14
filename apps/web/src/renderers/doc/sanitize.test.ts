// The DOM allowlist pass that runs on the Markdown output before it is inserted. It is the second
// line of defense, so these tests feed it HTML the Markdown layer would never produce.
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitize.ts";

function clean(html: string): HTMLElement {
  const host = document.createElement("div");
  host.append(sanitizeHtml(html, document));
  return host;
}

describe("sanitizeHtml", () => {
  it("removes injected scripts with their content", () => {
    const out = clean("<p>a<script>window.__pwned=1</script>b</p><script src=x></script>");
    expect(out.querySelector("script")).toBeNull();
    expect(out.innerHTML).toBe("<p>ab</p>");
  });

  it("removes other active and embedding elements", () => {
    const out = clean(
      '<iframe src="https://evil.example"></iframe><object data=x></object><embed src=x><style>p{}</style><svg onload=alert(1)><circle/></svg><math><mi>x</mi></math><form><input></form><link rel=stylesheet href=x><meta http-equiv=refresh content=0><base href=//evil.example><template><img src=x onerror=alert(1)></template><noscript>x</noscript>',
    );
    expect(out.children).toHaveLength(0);
  });

  it("strips event handlers and style", () => {
    const out = clean(
      '<p onclick="alert(1)" style="color:red" onmouseover="x">t</p><img src="a.png" onerror="alert(1)" alt="a">',
    );
    const p = out.querySelector("p");
    expect(p?.getAttributeNames()).toEqual([]);
    expect(out.querySelector("img")?.getAttributeNames().sort()).toEqual(["alt", "src"]);
  });

  it("keeps only plinth-doc__ and language- classes", () => {
    const out = clean(
      '<div class="plinth-doc__table evil"><code class="language-js hljs"></code><span class="x y"></span></div>',
    );
    expect(out.querySelector("div")?.getAttribute("class")).toBe("plinth-doc__table");
    expect(out.querySelector("code")?.getAttribute("class")).toBe("language-js");
    expect(out.querySelector("span")?.hasAttribute("class")).toBe(false);
  });

  it("re-checks href and src", () => {
    const out = clean(
      '<a href="javascript:alert(1)">a</a><a href="https://example.com" target="_blank">b</a><img src="https://example.com/x.png"><img src="data:image/svg+xml;base64,AA"><img src="ok.png">',
    );
    const [a, b] = Array.from(out.querySelectorAll("a"));
    expect(a?.hasAttribute("href")).toBe(false);
    expect(b?.getAttribute("href")).toBe("https://example.com");
    expect(b?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(Array.from(out.querySelectorAll("img")).map((i) => i.getAttribute("src"))).toEqual([
      null,
      null,
      "ok.png",
    ]);
  });

  it("keeps href only on a and src only on img", () => {
    const out = clean('<p href="https://example.com" src="a.png">x</p>');
    expect(out.querySelector("p")?.getAttributeNames()).toEqual([]);
  });

  it("unwraps unknown elements but keeps their text", () => {
    const out = clean("<p><b>bold</b> <u>under</u> <marquee>m</marquee></p>");
    expect(out.innerHTML).toBe("<p>bold under m</p>");
  });

  it("removes comments and ids that could clobber the shell", () => {
    const out = clean('<!-- c --><h2 id="__plinth-content">t</h2><h2 id="ok">u</h2>');
    expect(out.innerHTML).toBe('<h2>t</h2><h2 id="ok">u</h2>');
  });

  it("limits enumerated attribute values", () => {
    const out = clean(
      '<a href="#x" target="_top">a</a><div tabindex="5" role="button"></div><ol start="2"><li start="3">x</li></ol><img src="a.png" loading="eager" decoding="bogus">',
    );
    expect(out.querySelector("a")?.hasAttribute("target")).toBe(false);
    expect(out.querySelector("div")?.getAttributeNames()).toEqual([]);
    expect(out.querySelector("ol")?.getAttribute("start")).toBe("2");
    expect(out.querySelector("li")?.hasAttribute("start")).toBe(false);
    expect(out.querySelector("img")?.getAttribute("loading")).toBe("eager");
    expect(out.querySelector("img")?.hasAttribute("decoding")).toBe(false);
  });
});
