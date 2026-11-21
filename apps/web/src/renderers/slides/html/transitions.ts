// How an HTML slide leaves (Claude's `data-transition` on the section of the slide being left):
// `fade` cross-fades, `push` slides the next one in from the side it comes from, and `magic`
// moves each pinned box that has the same id on both slides from its old place to its new one
// while the rest cross-fades. Web Animations on Plinth's own frames and on the boxes of the slide
// arriving; never in the overview, presenter view, print or a still, and never under reduced
// motion. A new change of slide finishes the one running first.
import type { SlideView } from "../deck.ts";

export type TransitionKind = "fade" | "push" | "magic";

const DURATION: Record<TransitionKind, number> = { fade: 400, push: 500, magic: 600 };
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/** The frame being left keeps showing while it goes (slides.css [data-leaving]). */
export const LEAVING_ATTR = "data-leaving";

export interface Running {
  finish(): void;
}

function sectionOf(view: SlideView): HTMLElement | null {
  return view.el.shadowRoot?.querySelector<HTMLElement>("body > section") ?? null;
}

/** The pinned boxes of a slide that have an id, by id, with their box in canvas pixels. */
function pinnedById(
  section: HTMLElement,
  scale: number,
): Map<string, { el: HTMLElement; r: DOMRect }> {
  const origin = section.getBoundingClientRect();
  const out = new Map<string, { el: HTMLElement; r: DOMRect }>();
  for (const e of Array.from(section.querySelectorAll<HTMLElement>("[id]"))) {
    const win = e.ownerDocument.defaultView;
    if (win?.getComputedStyle(e).position !== "absolute") continue;
    const b = e.getBoundingClientRect();
    out.set(e.id, {
      el: e,
      r: new DOMRect(
        (b.left - origin.left) / scale,
        (b.top - origin.top) / scale,
        b.width / scale,
        b.height / scale,
      ),
    });
  }
  return out;
}

/**
 * Plays the transition from `from` to `to` (both frames in the deck view; `to` already active).
 * `forward`: the deck moved on (push comes in from the right). `scale` is the deck view's.
 */
export function playTransition(
  kind: TransitionKind,
  from: SlideView,
  to: SlideView,
  forward: boolean,
  scale: number,
): Running {
  const ms = DURATION[kind];
  const animations: Animation[] = [];
  const opts: KeyframeAnimationOptions = { duration: ms, easing: EASE, fill: "both" };
  from.frame.setAttribute(LEAVING_ATTR, "");
  if (kind === "push") {
    const dir = forward ? 1 : -1;
    animations.push(
      from.frame.animate(
        [{ transform: "translateX(0)" }, { transform: `translateX(${-dir * 100}%)` }],
        opts,
      ),
      to.frame.animate(
        [{ transform: `translateX(${dir * 100}%)` }, { transform: "translateX(0)" }],
        opts,
      ),
    );
  } else {
    animations.push(
      from.frame.animate([{ opacity: 1 }, { opacity: 0 }], opts),
      to.frame.animate([{ opacity: 0 }, { opacity: 1 }], opts),
    );
  }
  if (kind === "magic") {
    const a = sectionOf(from);
    const b = sectionOf(to);
    if (a && b) {
      const before = pinnedById(a, scale);
      for (const [id, now] of pinnedById(b, scale)) {
        const was = before.get(id);
        if (!was || !(now.r.width > 0 && now.r.height > 0)) continue;
        const dx = was.r.x - now.r.x;
        const dy = was.r.y - now.r.y;
        const sx = was.r.width / now.r.width;
        const sy = was.r.height / now.r.height;
        // The box itself moves from where it was; it does not fade with the rest.
        animations.push(
          now.el.animate(
            [
              {
                transformOrigin: "0 0",
                transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
                opacity: 1,
              },
              { transformOrigin: "0 0", transform: "none", opacity: 1 },
            ],
            { duration: ms, easing: EASE },
          ),
        );
        was.el.style.visibility = "hidden";
        const restore = was.el;
        animations[animations.length - 1]?.finished
          .catch(() => undefined)
          .then(() => restore.style.removeProperty("visibility"));
      }
    }
  }
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    from.frame.removeAttribute(LEAVING_ATTR);
    for (const an of animations) an.cancel();
    const a = sectionOf(from);
    for (const e of Array.from(a?.querySelectorAll<HTMLElement>("[id]") ?? []))
      e.style.removeProperty("visibility");
  };
  void Promise.all(animations.map((an) => an.finished.catch(() => undefined))).then(end);
  return { finish: end };
}
