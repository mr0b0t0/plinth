// Presenting a deck (an artifact whose type has `present`, the slides type) from the viewer: the
// slide the frame is on, Present (the app puts its own frame full screen), and Presenter view (the
// frame shows notes, the next slide and a timer) with an optional audience window in step. The app
// only ever handles slide numbers, version numbers and view names; the deck's text stays in the
// frame, on the artifact's own origin.
//
// The slide is kept in the app URL's fragment (#slide=N), written with history.replaceState and
// never sent to the server, so a reload or a shared link opens the same slide. A new frame (a newer
// version, review mode) reports `ready` and is sent back to that slide.
//
// The frame can change view on its own (its `s` key, Escape, its Exit button)
// and reports every change with `view`, so `mode`, the menu and the version pause follow what is
// on screen, whoever switched it.
//
// An audience window shows exactly the presenter window's slide of the presenter window's
// version: it opens on that version's permanent link (so it never moves to a newer version by
// itself), keeps its frame in deck view at any size, sends its frame back to the presenter's slide
// whatever paged it, and loads another version only when the presenter's window shows one. It
// follows the presenter's window until either window closes.
import { APP_ROUTES, type AppConfig, route, typeDef, type ViewGate } from "@plinth/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showToast } from "../ui/index.ts";
import {
  openPresentChannel,
  type PresentChannel,
  readFragment,
  writeFragment,
} from "./presentChannel.ts";
import {
  gotoMessage,
  newNonce,
  postToDeck,
  rendererTargetOrigin,
  viewMessage,
} from "./rendererProtocol.ts";
import { readSlidesFrameMessage } from "./slidesProtocol.ts";
import type { WatchPause } from "./useVersionWatch.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** off; presenter: this window presents; audience: this window follows a presenter window. */
export type PresentMode = "off" | "presenter" | "audience";

export interface Presentation {
  /** The artifact is a deck. Everything else is inert when false. */
  available: boolean;
  /**
   * The deck was opened through a permanent version link (/a/:slug/v/:n): it never moves to a
   * newer version.
   */
  pinned: boolean;
  slide: number | null;
  count: number | null;
  mode: PresentMode;
  /**
   * An audience window that has heard from its presenter window: the viewer then shows only the
   * deck. A link with a pair id and no presenter in this browser keeps the whole page.
   */
  paired: boolean;
  /** The app has put the frame full screen. */
  fullscreen: boolean;
  /** Keeps the frame while presenting (no swap to a newer version mid-talk). */
  pause: WatchPause;
  present(): void;
  presenterView(): void;
  exit(): void;
  openAudience(): void;
}

export interface PresentationOptions {
  gate: OkGate;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
  slug: string;
  /** Opened through a permanent version link; the gate's version is the one on view. */
  pinned?: boolean;
  /** Loads another app URL in this window (an audience window following a new version). */
  navigate?: (href: string) => void;
}

/**
 * The URL of an audience window for `pair` on `version` (the presenter's), optionally at `slide`.
 * Without a version it is the artifact's current link.
 */
export function audienceHref(slug: string, pair: string, version?: number, slide?: number): string {
  const path =
    version === undefined
      ? route(APP_ROUTES.artifact, { slug })
      : route(APP_ROUTES.artifactVersion, { slug, n: version });
  const hash = `#present=audience&pair=${pair}`;
  return path + (slide === undefined ? hash : writeFragment(hash, slide));
}

function writeSlide(slide: number): void {
  try {
    const url = new URL(window.location.href);
    url.hash = writeFragment(url.hash, slide);
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    // A sandboxed or unusual history: the slide just is not remembered.
  }
}

const replaceLocation = (href: string) => window.location.replace(href);

export function usePresentation(o: PresentationOptions): Presentation {
  const { gate, frame, contentOrigin, config, slug } = o;
  const pinned = o.pinned === true;
  const version = gate.artifact.version;
  const artifactId = gate.artifact.id;
  const type = gate.artifact.type;
  const available = typeDef(type)?.present === true;
  const opaque = config?.content_isolation === "opaque" || !!config?.content_path_fallback;
  const target = rendererTargetOrigin(config, contentOrigin);

  const initial = useMemo(() => readFragment(window.location.hash), []);
  const [slide, setSlide] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [mode, setMode] = useState<PresentMode>(() =>
    available && initial.pair ? "audience" : "off",
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [paired, setPaired] = useState(false);

  const wanted = useRef<number | null>(initial.slide);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const targetRef = useRef(target);
  targetRef.current = target;
  const versionRef = useRef(version);
  versionRef.current = version;
  const navigateRef = useRef(o.navigate ?? replaceLocation);
  navigateRef.current = o.navigate ?? replaceLocation;
  /** The presenter's channel to its audience windows, and its pair id. */
  const channel = useRef<PresentChannel | null>(null);
  const pairRef = useRef<string | null>(null);
  /** In an audience window: the presenter's slide, once its window has sent one. */
  const lead = useRef<number | null>(null);

  /** Sets the mode now, so messages that arrive before the next render see it. */
  const changeMode = useCallback((next: PresentMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  /** The presenter's slide and version, to its audience windows. */
  const tellAudience = useCallback((n: number) => {
    if (modeRef.current === "audience") return;
    channel.current?.post({ v: 1, type: "slide", slide: n, version: versionRef.current });
  }, []);

  const goto = useCallback((n: number) => {
    postToDeck(frameRef.current, targetRef.current, gotoMessage(n));
  }, []);

  const showDeck = useCallback(() => {
    postToDeck(frameRef.current, targetRef.current, viewMessage("deck"));
  }, []);

  const requestFullscreen = useCallback((afterFail?: () => void) => {
    const f = frameRef.current;
    if (!f?.requestFullscreen) return;
    f.requestFullscreen().then(
      () => {
        f.focus();
        // Presenter view full screen stays presenter view; any other view becomes the deck.
        if (modeRef.current !== "presenter") {
          postToDeck(f, targetRef.current, viewMessage("deck"));
        }
      },
      () => afterFail?.(),
    );
  }, []);

  // The frame's messages: where the deck is, and the f key.
  useEffect(() => {
    if (!available) return;
    const onMessage = (e: MessageEvent) => {
      const m = readSlidesFrameMessage(e, { frame, contentOrigin, opaque, type });
      if (!m) return;
      const audience = modeRef.current === "audience";
      if (m.type === "fullscreen") {
        requestFullscreen(() => showToast({ title: "Use Present in the bar" }));
        return;
      }
      if (m.type === "view") {
        // An audience window shows the deck view, whatever its own frame switched to.
        if (audience) {
          if (lead.current !== null && m.mode !== "deck") showDeck();
          return;
        }
        if (m.mode === "presenter") {
          if (modeRef.current !== "presenter") changeMode("presenter");
        } else if (modeRef.current === "presenter") {
          changeMode("off");
        }
        return;
      }
      setCount(m.count);
      if (m.type === "ready") {
        if (audience && lead.current !== null) showDeck();
        const want = wanted.current;
        if (want !== null && want !== m.slide) goto(Math.min(want, m.count));
        else {
          wanted.current = m.slide;
          setSlide(m.slide);
          tellAudience(m.slide);
        }
        if (modeRef.current === "presenter") {
          postToDeck(frame, targetRef.current, viewMessage("presenter"));
        }
        return;
      }
      // An audience window stays on the presenter's slide, whatever paged its frame.
      if (audience && lead.current !== null && m.slide !== lead.current) {
        goto(lead.current);
        return;
      }
      wanted.current = m.slide;
      setSlide(m.slide);
      writeSlide(m.slide);
      tellAudience(m.slide);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    available,
    frame,
    contentOrigin,
    opaque,
    type,
    goto,
    showDeck,
    requestFullscreen,
    changeMode,
    tellAudience,
  ]);

  useEffect(() => {
    if (!available) return;
    const onChange = () => setFullscreen(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [available]);

  // An audience window follows its presenter window: the same version, the same slide, deck view.
  useEffect(() => {
    if (!available || mode !== "audience" || !initial.pair) return;
    const pair = initial.pair;
    const ch = openPresentChannel(artifactId, pair, (m) => {
      if (m.type !== "slide") return;
      if (m.version !== versionRef.current) {
        navigateRef.current(audienceHref(slug, pair, m.version, m.slide));
        return;
      }
      lead.current = m.slide;
      wanted.current = m.slide;
      setPaired(true);
      showDeck();
      goto(m.slide);
    });
    ch?.post({ v: 1, type: "hello" });
    return () => ch?.close();
  }, [available, mode, initial.pair, artifactId, slug, goto, showDeck]);

  useEffect(() => () => channel.current?.close(), []);

  const present = useCallback(() => {
    if (!available) return;
    requestFullscreen(() =>
      showToast({ title: "This browser did not allow full screen", tone: "danger" }),
    );
  }, [available, requestFullscreen]);

  const presenterView = useCallback(() => {
    if (!available) return;
    postToDeck(frameRef.current, targetRef.current, viewMessage("presenter"));
    changeMode("presenter");
  }, [available, changeMode]);

  const exit = useCallback(() => {
    if (modeRef.current === "presenter") {
      postToDeck(frameRef.current, targetRef.current, viewMessage("deck"));
      changeMode("off");
    }
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
  }, [changeMode]);

  // Every audience window of this presenter shares one pair, so a second one follows as well.
  const openAudience = useCallback(() => {
    if (!available) return;
    if (!channel.current || !pairRef.current) {
      const pair = newNonce();
      pairRef.current = pair;
      channel.current = openPresentChannel(artifactId, pair, (m) => {
        if (m.type === "hello" && wanted.current !== null) tellAudience(wanted.current);
      });
    }
    window.open(audienceHref(slug, pairRef.current, versionRef.current), "_blank", "noopener");
  }, [available, artifactId, slug, tellAudience]);

  const presenting = available && (fullscreen || mode === "presenter");
  return {
    available,
    pinned,
    slide,
    count,
    mode,
    paired: mode === "audience" && paired,
    fullscreen,
    pause: presenting ? "present" : null,
    present,
    presenterView,
    exit,
    openAudience,
  };
}
