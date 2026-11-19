// Automatic slide layouts and shrink-to-fit. The author writes Markdown only; the layout comes from
// what a slide holds, and text that does not fit its canvas is stepped down in size until it does.

export type SlideLayout = "title" | "section" | "image" | "columns" | "default";

/** The --fit font scales tried in order; the last one is the floor. */
export const FIT_STEPS = [1, 0.9, 0.8, 0.72, 0.64, 0.55] as const;

/** A paragraph this long or shorter is a subtitle on a title slide. */
const SHORT_PARAGRAPH = 160;

const HEADING_RE = /^h[1-6]$/;

function onlyImage(p: Element): boolean {
  if (p.localName !== "p") return false;
  const imgs = p.querySelectorAll("img");
  if (imgs.length !== 1) return false;
  // Nothing else but the image (or a link around it) and whitespace.
  return (p.textContent ?? "").trim() === "";
}

/**
 * The layout of a slide from its head (the Markdown before the first |||) and its column count:
 * title = only an h1 plus at most two short paragraphs; section = only an h2; image = one image,
 * optionally under one heading; columns = ||| present; anything else is the default layout.
 */
export function classifySlide(head: ParentNode, columns: number): SlideLayout {
  if (columns > 0) return "columns";
  const kids = Array.from(head.children);
  const [first] = kids;
  if (!first) return "default";
  if (kids.length === 1 && first.localName === "h2") return "section";
  if (first.localName === "h1" && kids.length <= 3) {
    const rest = kids.slice(1);
    if (
      rest.every(
        (k) =>
          k.localName === "p" &&
          k.querySelector("img") === null &&
          (k.textContent ?? "").trim().length <= SHORT_PARAGRAPH,
      )
    ) {
      return "title";
    }
  }
  const images = head.querySelectorAll("img").length;
  if (images === 1) {
    if (kids.length === 1 && onlyImage(first)) return "image";
    const second = kids[1];
    if (kids.length === 2 && HEADING_RE.test(first.localName) && second && onlyImage(second)) {
      return "image";
    }
  }
  return "default";
}

/** Whether a box's content is bigger than the box. Injected so tests can stub layout. */
export type Measure = (box: HTMLElement) => boolean;

export const overflows: Measure = (box) =>
  box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1;

/**
 * Steps the slide's --fit font scale down from 1 until its body no longer overflows; at the floor
 * it marks the slide data-overflow (presenter view and the overview say so). The slide must be
 * laid out (displayed) for the measure to mean anything. Returns the scale it settled on.
 */
export function fitSlide(slide: HTMLElement, body: HTMLElement, measure: Measure = overflows) {
  let fit: number = FIT_STEPS[0];
  for (const step of FIT_STEPS) {
    fit = step;
    slide.style.setProperty("--fit", String(step));
    if (!measure(body)) {
      slide.removeAttribute("data-overflow");
      return fit;
    }
  }
  slide.setAttribute("data-overflow", "true");
  return fit;
}
