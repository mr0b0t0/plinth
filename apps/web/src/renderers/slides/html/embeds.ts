// An HTML slide's live embeds (<x-embed>): each one a nested iframe of Plinth's fixed embed loader
// (/__plinth/frames/slides/embed.html, the content host's embedLoader.ts), sandboxed with
// allow-scripts only, so its page runs with an opaque origin: no cookies, no storage, nothing of
// this shell, and, by the loader's own CSP, no network. Viewers cannot click or type into it.
//
// Frames are mounted only while their slide is on stage (the deck view's current slide, presenter
// view's current pane), never in the overview, in print, in a .pptx or in a still such as a
// thumbnail, which show the box without it. Each mount is a new iframe element. The loader posts
// `ready`; only a `ready` whose event.source is that element's own window is answered, once, with
// that embed's own page, posted with "*" (the frame's origin is opaque, so no target origin can
// name it, and the page is what the framed deck may see anyway).
import {
  SLIDE_EMBED_FILE,
  SLIDE_EMBED_MESSAGE_SOURCE,
  SLIDE_EMBED_PROTOCOL_VERSION,
  SLIDE_EMBED_SANDBOX,
} from "@plinth/shared";
import { contentBase } from "../../design/base.ts";

/** The embed loader every embed frame opens: a fixed Plinth page on the artifact's origin. */
export function embedLoaderUrl(loc: { href: string }): string {
  const url = new URL(loc.href);
  return `${url.origin}${contentBase(url.pathname)}/__plinth/frames/slides/${SLIDE_EMBED_FILE}`;
}

/** Whether a message is an embed loader's `ready`. The caller checks which window sent it. */
export function isEmbedReady(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  return (
    m.source === SLIDE_EMBED_MESSAGE_SOURCE &&
    m.v === SLIDE_EMBED_PROTOCOL_VERSION &&
    m.type === "ready"
  );
}

/** An embed frame's styles that author CSS may not change (base.ts draws the rest). */
export const EMBED_FRAME_PINNED = {
  display: "block",
  position: "static",
  width: "100%",
  height: "100%",
  "border-style": "none",
  "pointer-events": "none",
} as const;

export class EmbedFrames {
  /** Each mounted frame's window and the page it is waiting for (answered once). */
  private readonly waiting = new Map<Window, string>();
  private readonly frames = new Set<HTMLIFrameElement>();
  /** Frames whose page was written and has loaded. */
  private readonly loaded = new WeakSet<HTMLIFrameElement>();
  private readonly onMessage = (e: MessageEvent) => {
    if (!isEmbedReady(e.data) || !e.source) return;
    const win = e.source as Window;
    const page = this.waiting.get(win);
    if (page === undefined) return;
    this.waiting.delete(win);
    // The loader's own load came first; the next one is the embed's page, written over it.
    for (const f of this.frames) {
      if (f.contentWindow !== win) continue;
      f.addEventListener("load", () => this.loaded.add(f), { once: true });
    }
    win.postMessage(
      {
        source: SLIDE_EMBED_MESSAGE_SOURCE,
        v: SLIDE_EMBED_PROTOCOL_VERSION,
        type: "render",
        html: page,
      },
      "*",
    );
  };

  constructor(
    private readonly win: Window,
    private readonly loaderUrl: string,
  ) {
    win.addEventListener("message", this.onMessage);
  }

  /** Mounts (on) or removes (off) the frames of these boxes. */
  set(embeds: readonly { box: HTMLElement; page: string }[], on: boolean): void {
    for (const { box, page } of embeds) {
      const current = box.querySelector("iframe");
      if (!on) {
        if (current) this.unmount(current);
        continue;
      }
      if (current) continue;
      const frame = box.ownerDocument.createElement("iframe");
      frame.setAttribute("sandbox", SLIDE_EMBED_SANDBOX);
      frame.setAttribute("title", "Live embed");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("loading", "eager");
      // Inline and !important: no deck.css rule in the slide's shadow root can make the frame take
      // clicks or leave its box.
      for (const [k, v] of Object.entries(EMBED_FRAME_PINNED))
        frame.style.setProperty(k, v, "important");
      frame.src = this.loaderUrl;
      box.append(frame);
      this.frames.add(frame);
      if (frame.contentWindow) this.waiting.set(frame.contentWindow, page);
    }
  }

  /**
   * Resolves once every mounted frame's page is written and loaded (print waits for it, so an
   * embed prints as it first draws), or after `ms`.
   */
  drawn(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const all = [...this.frames].every((f) => this.loaded.has(f));
        if (all || Date.now() - start >= ms) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  private unmount(frame: HTMLIFrameElement): void {
    if (frame.contentWindow) this.waiting.delete(frame.contentWindow);
    this.frames.delete(frame);
    frame.remove();
  }

  stop(): void {
    this.win.removeEventListener("message", this.onMessage);
    for (const f of [...this.frames]) this.unmount(f);
  }
}
