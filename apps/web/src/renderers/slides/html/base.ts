// The rules every HTML slide starts from, inside its shadow root before deck.css: the tag
// defaults of Claude's slide format (h1 to h3 at 96, 64 and 44px and 600, text at 32px, no
// default margins, a 128px slide margin), Plinth's drawing of x-shape, x-icon, x-connector and
// x-embed, reveal.js's fragment states, and the switch that turns motion off. Plinth's own text.

/** The class on a slide's host while its motion is off (reduced motion, print, stills). */
export const STILL_ATTR = "data-still";

export function baseCss(canvas: { width: number; height: number }): string {
  const w = `${canvas.width}px`;
  const h = `${canvas.height}px`;
  return `
html, body {
  display: block;
  margin: 0;
  padding: 0;
}
html {
  position: absolute;
  inset: 0;
  width: ${w};
  height: ${h};
  overflow: hidden;
  contain: strict;
}
body {
  width: ${w};
  height: ${h};
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 32px;
  font-weight: 400;
  line-height: 1.3;
  color: #1f2328;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow-wrap: normal;
}
section {
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: ${w};
  height: ${h};
  margin: 0;
  padding: 128px;
  overflow: hidden;
  background: #ffffff;
}
div {
  position: relative;
}
h1, h2, h3, p, ul, ol, li, table {
  margin: 0;
}
h1, h2, h3 {
  font-weight: 600;
  line-height: 1.1;
}
h1 { font-size: 96px; }
h2 { font-size: 64px; }
h3 { font-size: 44px; }
ul, ol {
  padding-left: 1.2em;
}
a {
  color: inherit;
}
img, svg {
  display: block;
  max-width: none;
}
table {
  border-collapse: collapse;
}
th, td {
  padding: 0.35em 0.6em;
  border: 1px solid rgb(127 127 127 / 0.35);
  text-align: left;
  vertical-align: top;
}
th {
  font-weight: 600;
}
hr {
  width: 100%;
  margin: 0;
  border: 0;
  border-top: 2px solid currentColor;
}
x-shape {
  display: block;
  background: currentColor;
}
x-shape[kind="rounded"] { border-radius: 24px; }
x-shape[kind="ellipse"] { border-radius: 50%; }
x-shape[kind="diamond"] { clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
x-shape[kind="arrow-right"] { clip-path: polygon(0 30%, 60% 30%, 60% 0, 100% 50%, 60% 100%, 60% 70%, 0 70%); }
x-shape[kind="arrow-left"] { clip-path: polygon(100% 30%, 40% 30%, 40% 0, 0 50%, 40% 100%, 40% 70%, 100% 70%); }
x-shape[kind="arrow-down"] { clip-path: polygon(30% 0, 70% 0, 70% 60%, 100% 60%, 50% 100%, 0 60%, 30% 60%); }
x-shape[kind="arrow-up"] { clip-path: polygon(30% 100%, 70% 100%, 70% 40%, 100% 40%, 50% 0, 0 40%, 30% 40%); }
x-shape[kind="line"] {
  height: 0;
  background: none;
  border-top: 2px solid currentColor;
}
x-icon {
  display: inline-block;
  flex: none;
  width: 48px;
  height: 48px;
}
x-icon > svg {
  width: 100%;
  height: 100%;
}
x-connector {
  display: block;
  flex: none;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  border: 0 solid transparent;
  border-width: 2px;
  pointer-events: none;
}
x-connector[x1] {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
}
x-connector > svg {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
}
x-embed {
  display: block;
  position: absolute;
  overflow: hidden;
}
x-embed > iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  pointer-events: none;
}
.fragment {
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.3s ease, visibility 0.3s ease, transform 0.3s ease;
}
.fragment.visible {
  opacity: 1;
  visibility: inherit;
}
`;
}

/**
 * Turns motion off on a host marked STILL_ATTR: no animation and no transition anywhere in the
 * slide, so every box shows its plain rule, the finished look. After deck.css, so it wins.
 */
export const STILL_CSS = `
:host([${STILL_ATTR}]) *, :host([${STILL_ATTR}]) *::before, :host([${STILL_ATTR}]) *::after {
  animation: none !important;
  transition: none !important;
}
`;
