// Presenting a deck (an artifact whose type has `present`, the slides type) from the viewer: the
// slide the frame is on, Present (the app puts its own frame full screen), Presenter view (the
// frame shows notes, the next slide and a timer) with an optional audience window in step, and
// printing. The app only ever handles slide numbers and view names; the deck's text stays in the
// frame, on the artifact's own origin.
//
// The slide is kept in the app URL's fragment (#slide=N), written with history.replaceState and
// never sent to the server, so a reload or a shared link opens the same slide. A new frame (a newer
// version, review mode) reports `ready` and is sent back to that slide.
//
// The frame can change view on its own (its `s` key and Presenter control, Escape, its Exit button)
// and reports every change with `view`, so `mode`, the strip, the version pause and the audience
// window follow what is on screen, whoever switched it.
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
  postPrint,
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
   * newer version, and its audience window opens the same version.
   */
  pinned: boolean;
  slide: number | null;
  count: number | null;
  mode: PresentMode;
  /** The app has put the frame full screen. */
  fullscreen: boolean;
  /** Keeps the frame while presenting (no swap to a newer version mid-talk). */
  pause: WatchPause;
  present(): void;
  presenterView(): void;
  exit(): void;
  openAudience(): void;
  print(notes: boolean): void;
}

export interface PresentationOptions {
  gate: OkGate;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
  slug: string;
  /** Opened through a permanent version link; the gate's version is the one on view. */
  pinned?: boolean;
}

/**
 * The URL of an audience window for `pair`: the artifact's current version, or `version` itself
 * when the presenter is on a permanent version link, so both windows show the same deck.
 */
export function audienceHref(slug: string, pair: string, version?: number): string {
  const path =
    version === undefined
      ? route(APP_ROUTES.artifact, { slug })
      : route(APP_ROUTES.artifactVersion, { slug, n: version });
  return `${path}#present=audience&pair=${pair}`;
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

export function usePresentation(o: PresentationOptions): Presentation {
  const { gate, frame, contentOrigin, config, slug } = o;
  const pinned = o.pinned === true;
  const pinnedVersion = pinned ? gate.artifact.version : undefined;
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

  const wanted = useRef<number | null>(initial.slide);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const targetRef = useRef(target);
  targetRef.current = target;
  const channel = useRef<PresentChannel | null>(null);

  /** Sets the mode now, so messages that arrive before the next render see it. */
  const changeMode = useCallback((next: PresentMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  /** Presenter view is over (the strip's Exit, or the frame left it): the audience is let go. */
  const leavePresenter = useCallback(() => {
    channel.current?.close();
    channel.current = null;
    changeMode("off");
  }, [changeMode]);

  const goto = useCallback((n: number) => {
    postToDeck(frameRef.current, targetRef.current, gotoMessage(n));
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
      if (m.type === "fullscreen") {
        requestFullscreen(() => showToast({ title: "Use Present in the bar" }));
        return;
      }
      if (m.type === "view") {
        // An audience window follows its presenter window whatever its own frame shows.
        if (modeRef.current === "audience") return;
        if (m.mode === "presenter") {
          if (modeRef.current !== "presenter") changeMode("presenter");
        } else if (modeRef.current === "presenter") {
          leavePresenter();
        }
        return;
      }
      setCount(m.count);
      if (m.type === "ready") {
        const want = wanted.current;
        if (want !== null && want !== m.slide) goto(Math.min(want, m.count));
        else {
          wanted.current = m.slide;
          setSlide(m.slide);
        }
        if (modeRef.current === "presenter") {
          postToDeck(frame, targetRef.current, viewMessage("presenter"));
        }
        return;
      }
      wanted.current = m.slide;
      setSlide(m.slide);
      writeSlide(m.slide);
      if (modeRef.current === "presenter") {
        channel.current?.post({ v: 1, type: "slide", slide: m.slide });
      }
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
    requestFullscreen,
    changeMode,
    leavePresenter,
  ]);

  useEffect(() => {
    if (!available) return;
    const onChange = () => setFullscreen(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [available]);

  // An audience window follows its presenter window.
  useEffect(() => {
    if (!available || mode !== "audience" || !initial.pair) return;
    const ch = openPresentChannel(artifactId, initial.pair, (m) => {
      if (m.type !== "slide") return;
      wanted.current = m.slide;
      goto(m.slide);
    });
    channel.current = ch;
    ch?.post({ v: 1, type: "hello" });
    return () => {
      ch?.close();
      if (channel.current === ch) channel.current = null;
    };
  }, [available, mode, initial.pair, artifactId, goto]);

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
      leavePresenter();
    }
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
  }, [leavePresenter]);

  const openAudience = useCallback(() => {
    if (!available) return;
    const pair = newNonce();
    channel.current?.close();
    channel.current = openPresentChannel(artifactId, pair, (m) => {
      if (m.type === "hello" && wanted.current !== null) {
        channel.current?.post({ v: 1, type: "slide", slide: wanted.current });
      }
    });
    window.open(audienceHref(slug, pair, pinnedVersion), "_blank", "noopener");
  }, [available, artifactId, slug, pinnedVersion]);

  const print = useCallback((notes: boolean) => {
    postPrint(frameRef.current, targetRef.current, notes);
  }, []);

  const presenting = available && (fullscreen || mode === "presenter");
  return {
    available,
    pinned,
    slide,
    count,
    mode,
    fullscreen,
    pause: presenting ? "present" : null,
    present,
    presenterView,
    exit,
    openAudience,
    print,
  };
}
