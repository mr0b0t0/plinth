// Preview frames: the exact sandbox, the document they show, and nothing but validated font links.
import { type DesignSystem, designSystemCss, parseDesignSystem } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_HEIGHT, mountPreview, PREVIEW_SANDBOX, previewSrcdoc } from "./preview.ts";
import { FIXTURE } from "./testFixture.ts";

function ds(text = JSON.stringify(FIXTURE)): DesignSystem {
  const r = parseDesignSystem(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe("mountPreview", () => {
  it("makes a frame sandboxed exactly allow-same-origin, with no allow attribute", () => {
    const d = ds();
    const comp = d.components[0];
    const ex = comp?.examples[0];
    if (!comp || !ex) throw new Error("fixture");
    const frame = mountPreview(document, d, comp, ex, "light");
    expect(PREVIEW_SANDBOX).toBe("allow-same-origin");
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.hasAttribute("allow")).toBe(false);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.title).toBe("Button: Primary (light)");
    expect(frame.style.height).toBe("96px");
    expect(frame.srcdoc).toContain(designSystemCss(d));
    expect(frame.srcdoc).toContain('<button class="acme-btn acme-btn--primary">Save</button>');
    expect(MAX_PREVIEW_HEIGHT).toBe(1200);
  });
});

describe("previewSrcdoc", () => {
  it("sets the theme, the compiled CSS, the component CSS and the sanitized HTML", () => {
    const d = ds();
    const comp = d.components[0];
    const ex = comp?.examples[0];
    if (!comp || !ex) throw new Error("fixture");
    const light = previewSrcdoc(d, comp, ex, "light", document);
    const dark = previewSrcdoc(d, comp, ex, "dark", document);
    expect(light).toMatch(/^<!doctype html><html lang="en" data-theme="light">/);
    expect(dark).toMatch(/^<!doctype html><html lang="en" data-theme="dark">/);
    expect(dark).toContain('<meta name="color-scheme" content="dark">');
    expect(light).toContain(".acme-btn--primary { background: var(--acme-color-accent)");
    expect(light).toContain('@font-face{font-family:"Acme Mono";src:url("fonts/acme-mono.woff2")');
  });

  it("strips script and handlers from the example", () => {
    const text = JSON.stringify({
      ...FIXTURE,
      components: [
        {
          id: "x",
          name: "X",
          examples: [
            {
              name: "Bad",
              html: '<img src="x.png" onerror="parent.postMessage(1,\'*\')"><script>alert(1)</script>',
            },
          ],
        },
      ],
    });
    const d = ds(text);
    const comp = d.components[0];
    const ex = comp?.examples[0];
    if (!comp || !ex) throw new Error("fixture");
    const src = previewSrcdoc(d, comp, ex, "light", document);
    expect(src).toContain('<body><img src="x.png"></body>');
    expect(src).not.toMatch(/<script|onerror/);
  });

  it("links only the parser's Google Fonts URLs, escaped", () => {
    const d = ds();
    const comp = d.components[0];
    const ex = comp?.examples[0];
    if (!comp || !ex) throw new Error("fixture");
    const links = [...previewSrcdoc(d, comp, ex, "light", document).matchAll(/<link [^>]*>/g)].map(
      (m) => m[0],
    );
    expect(links).toEqual([
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;display=swap">',
    ]);
  });
});
