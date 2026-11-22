// Presenting a deck (an artifact whose type has `present`, the slides type) from the viewer: the
// slide the frame is on, Present (the app puts its own frame full screen), Presenter view (the
// frame shows notes, the next slide and a timer) with an optional audience window in step, and the
// .pptx download (the frame builds and saves the file; the app sends a nonce and hears back
// booleans and a count). The app only ever handles slide numbers, version numbers and view names;
// the deck's text stays in the frame, on the artifact's own origin.
//
// The slide is kept in the app URL's fragment (#slide=N), written with history.replaceState and
// never sent to the server, so a reload or a shared link opens the same slide. A new frame (a newer
// version, review mode) reports `ready` and is sent back to that slide. The slide lives in refs,
// not state, so paging never re-renders the viewer.
//
// The frame can change view on its own (its `s` key, Escape, its Exit button)
// and reports every change with `view`, so `mode`, the menu and the version pause follow what is
// on screen, whoever switched it.
//
// Review mode (the comments panel's frame) shows every slide stacked and refuses every other view,
// so Present and Presenter view chosen there (or the frame's f key) first leave review mode: the
// page closes the panel and loads the deck without it, and the new frame presents once it reports
// `ready`.
//
// An audience window shows exactly the presenter window's slide of the presenter window's
// version: it opens on that version's permanent link (so it never moves to a newer version by
// itself), keeps its frame in deck view at any size, sends its frame back to the presenter's slide
// whatever paged it, and loads another version only when the presenter's window shows one. It
// follows the presenter's window until either window closes.
//
// An audience window tells its frame it is paired (on every `ready`), so a deck that follows the
// presenter over the room (follow.ts) leaves that to the presenter window and shows no note.
//
// Leading viewers over the room lives in the frame, and the frame is replaced for a newer version
// or a sharing change whenever the deck is not presented. So the app remembers what the frame last
// said (`leading`) and asks the next frame to lead again (`lead`, after its `goto`): the audience
// keeps following through the swap. It is memory only: a reload starts without a lead.
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
  exportMessage,
  gotoMessage,
  leadMessage,
  newNonce,
  pairedMessage,
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
  mode: PresentMode;
  /**
   * An audience window that has heard from its presenter window: the viewer then shows only the
   * deck. A link with a pair id and no presenter in this browser keeps the whole page.
   */
  paired: boolean;
  /** Keeps the frame while presenting (no swap to a newer version mid-talk). */
  pause: WatchPause;
  present(): void;
  presenterView(): void;
  openAudience(): void;
  /** A .pptx is being made in the frame. */
  exporting: boolean;
  /** Ask the frame to build the deck as .pptx and download it. */
  exportPptx(): void;
}

/** How long the app waits for the frame's answer to an export before it gives up. */
export const EXPORT_TIMEOUT_MS = 90_000;

/**
 * The toast when the deck's frame is replaced while it makes the file. The app cannot tell whether
 * the old frame saved it first, so it says what to do if it did not.
 */
export const EXPORT_INTERRUPTED_TOAST = {
  title: "The .pptx download was interrupted",
  description: "If no file was saved, download it again.",
  tone: "warning",
} as const;

/**
 * The toast for a finished export, or null for a clean one: the browser shows its own download.
 * Exported for tests.
 */
export function exportedToast(m: {
  ok: boolean;
  images_skipped: number;
  embeds_skipped?: number;
  opaque: boolean;
}): {
  title: string;
  description?: string;
  tone: "warning" | "danger";
} | null {
  if (!m.ok) {
    return { title: "The .pptx could not be made", tone: "danger" };
  }
  const embeds = m.embeds_skipped ?? 0;
  if (m.images_skipped === 0 && embeds === 0) return null;
  const parts: string[] = [];
  if (m.images_skipped > 0) {
    parts.push(
      m.opaque
        ? "Images were left out."
        : m.images_skipped === 1
          ? "1 image could not be added."
          : `${m.images_skipped} images could not be added.`,
    );
  }
  // A live embed runs code, which a .pptx cannot hold.
  if (embeds > 0) {
    parts.push(
      embeds === 1 ? "1 live embed was left out." : `${embeds} live embeds were left out.`,
    );
  }
  return { title: "Downloaded the .pptx", description: parts.join(" "), tone: "warning" };
}

export interface PresentationOptions {
  gate: OkGate;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
  slug: string;
  /** The frame is in review mode (the comments panel's stacked overview). */
  review?: boolean;
  /** Leaves review mode: closes the comments panel and loads the deck without it. */
  leaveReview?: () => void;
  /** Loads another app URL in this window (an audience window following a new version). */
  navigate?: (href: string) => void;
}

/** What Present or Presenter view asked for while the frame was in review mode. */
type Pending = { action: "fullscreen" | "presenter"; from: HTMLIFrameElement | null };

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
  const version = gate.artifact.version;
  const artifactId = gate.artifact.id;
  const type = gate.artifact.type;
  const available = typeDef(type)?.present === true;
  const opaque = config?.content_isolation === "opaque" || !!config?.content_path_fallback;
  const target = rendererTargetOrigin(config, contentOrigin);

  const initial = useMemo(() => readFragment(window.location.hash), []);
  const [mode, setMode] = useState<PresentMode>(() =>
    available && initial.pair ? "audience" : "off",
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [paired, setPaired] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** The export the app is waiting for: its nonce, its timeout and the frame it was sent to. */
  const pendingExport = useRef<{
    nonce: string;
    timer: ReturnType<typeof setTimeout>;
    frame: HTMLIFrameElement | null;
  } | null>(null);

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
  const reviewRef = useRef(o.review === true);
  reviewRef.current = o.review === true;
  const leaveReviewRef = useRef(o.leaveReview);
  leaveReviewRef.current = o.leaveReview;
  /** The presenter's channel to its audience windows, and its pair id. */
  const channel = useRef<PresentChannel | null>(null);
  const pairRef = useRef<string | null>(null);
  /** In an audience window: the presenter's slide, once its window has sent one. */
  const lead = useRef<number | null>(null);
  /** In an audience window: it is already loading the presenter's other version. */
  const moving = useRef(false);
  /** Present chosen in review mode, done when the frame without review mode is ready. */
  const pending = useRef<Pending | null>(null);
  /** The deck's frame said the person leads viewers over the room: the next frame leads again. */
  const leading = useRef(false);
  // A lead belongs to one deck: the page moving to another artifact (the same stage, new params)
  // never makes that one's frame lead its viewers. Reset in render, as the refs above are kept,
  // so no message handled after this render sees the old deck's lead.
  const leadingFor = useRef(artifactId);
  if (leadingFor.current !== artifactId) {
    leadingFor.current = artifactId;
    leading.current = false;
  }

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

  /**
   * In review mode, leaves it and keeps `action` for the frame that replaces this one; true when
   * it did. Outside review mode it does nothing and returns false.
   */
  const leaveReviewFirst = useCallback((action: Pending["action"]): boolean => {
    const leave = leaveReviewRef.current;
    if (!reviewRef.current || !leave) return false;
    pending.current = { action, from: frameRef.current };
    leave();
    return true;
  }, []);

  // The frame's messages: where the deck is, and the f key.
  useEffect(() => {
    if (!available) return;
    const onMessage = (e: MessageEvent) => {
      const m = readSlidesFrameMessage(e, { frame, contentOrigin, opaque, type });
      if (!m) return;
      const audience = modeRef.current === "audience";
      if (m.type === "fullscreen") {
        if (!audience && leaveReviewFirst("fullscreen")) return;
        requestFullscreen(() => showToast({ title: "Use Present in the bar" }));
        return;
      }
      if (m.type === "exported") {
        const pending = pendingExport.current;
        if (!pending || m.nonce !== pending.nonce) return;
        clearTimeout(pending.timer);
        pendingExport.current = null;
        setExporting(false);
        const toast = exportedToast(m);
        if (toast) showToast(toast);
        return;
      }
      if (m.type === "leading") {
        if (!audience) leading.current = m.on;
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
      if (m.type === "ready") {
        // An audience window's frame follows this window's presenter window, not the room: told
        // before any goto, so the presenter window's slides never read as paging by hand.
        if (audience) postToDeck(frame, targetRef.current, pairedMessage());
        if (audience && lead.current !== null) showDeck();
        const want = wanted.current;
        if (want !== null && want !== m.slide) goto(Math.min(want, m.count));
        else {
          wanted.current = m.slide;
          tellAudience(m.slide);
        }
        // A frame that replaced one that was leading leads again, from the slide just sent.
        if (!audience && leading.current) postToDeck(frame, targetRef.current, leadMessage());
        // The frame that replaced a review frame: what Present asked for there happens now.
        const asked = pending.current;
        if (!audience && asked && asked.from !== frame) {
          pending.current = null;
          if (asked.action === "presenter") changeMode("presenter");
          else {
            requestFullscreen(() => showToast({ title: "Press Present again for full screen" }));
          }
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
    leaveReviewFirst,
  ]);

  // A new frame (a newer version, review mode) replaced the one making the file: its answer can no
  // longer be heard, so the app stops waiting now rather than at the timeout.
  useEffect(() => {
    const pending = pendingExport.current;
    if (!pending || pending.frame === frame) return;
    clearTimeout(pending.timer);
    pendingExport.current = null;
    setExporting(false);
    showToast(EXPORT_INTERRUPTED_TOAST);
  }, [frame]);

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
      if (m.type !== "slide" || moving.current) return;
      if (m.version !== versionRef.current) {
        // One load: later messages while this window navigates would start it again.
        moving.current = true;
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

  useEffect(
    () => () => {
      channel.current?.close();
      if (pendingExport.current) clearTimeout(pendingExport.current.timer);
    },
    [],
  );

  const present = useCallback(() => {
    if (!available || leaveReviewFirst("fullscreen")) return;
    requestFullscreen(() =>
      showToast({ title: "This browser did not allow full screen", tone: "danger" }),
    );
  }, [available, requestFullscreen, leaveReviewFirst]);

  const presenterView = useCallback(() => {
    if (!available || leaveReviewFirst("presenter")) return;
    postToDeck(frameRef.current, targetRef.current, viewMessage("presenter"));
    changeMode("presenter");
  }, [available, changeMode, leaveReviewFirst]);

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

  const exportPptx = useCallback(() => {
    if (!available || pendingExport.current) return;
    const nonce = newNonce();
    if (!postToDeck(frameRef.current, targetRef.current, exportMessage(nonce))) {
      showToast({ title: "The .pptx could not be made", tone: "danger" });
      return;
    }
    const timer = setTimeout(() => {
      if (pendingExport.current?.nonce !== nonce) return;
      pendingExport.current = null;
      setExporting(false);
      showToast({ title: "The .pptx could not be made", tone: "danger" });
    }, EXPORT_TIMEOUT_MS);
    pendingExport.current = { nonce, timer, frame: frameRef.current };
    setExporting(true);
  }, [available]);

  const presenting = available && (fullscreen || mode === "presenter");
  return {
    available,
    mode,
    paired: mode === "audience" && paired,
    pause: presenting ? "present" : null,
    present,
    presenterView,
    openAudience,
    exporting,
    exportPptx,
  };
}
