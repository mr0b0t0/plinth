// A design's deep link: the board on view is kept in the app URL's fragment (#board=<id>), written
// with history.replaceState and never sent to the server, so a reload or a shared link opens the
// same board, as #slide=N does for a deck. The design's frame says which board it shows (`ready`
// when it is up, `board` when that changes: zoomed to a board, a prototype flow, or none after
// Fit), and the app sends a new frame (a newer version, review mode) back to that board (`goto`).
//
// Only board ids cross: [a-z0-9-], up to 40 characters, from Plinth's own parser. The frame is the
// design shell, Plinth's renderer on the artifact's origin (script-src 'self'); its boards are
// nested opaque frames whose messages have another source window, so they are never read here.
// Under opaque isolation and the path fallback the shell's origin is "null", and it is identified
// by its window (frameGuard.ts acceptFrom). A forged message could at most change the fragment.
import {
  type AppConfig,
  BOARD_LINK_PREFIX,
  boardLinkId,
  isArtboardId,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
} from "@plinth/shared";
import { useEffect, useRef } from "react";
import { acceptFrom } from "../comments/frameGuard.ts";
import { rendererTargetOrigin } from "./rendererProtocol.ts";

export type DesignFrameMessage =
  | { type: "ready"; board: string | null }
  | { type: "board"; board: string | null };

/** A message from the design in `frame`, validated, or null. */
export function readDesignFrameMessage(
  e: Pick<MessageEvent, "source" | "origin" | "data">,
  o: { frame: HTMLIFrameElement | null; contentOrigin: string; opaque: boolean },
): DesignFrameMessage | null {
  if (!o.frame || !acceptFrom(o.frame, o.contentOrigin, o.opaque)(e)) return null;
  const m = e.data as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) return null;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type !== "ready" && m.type !== "board") return null;
  const board = m.board === null ? null : isArtboardId(m.board) ? m.board : undefined;
  if (board === undefined) return null;
  return { type: m.type, board };
}

export function designGotoMessage(board: string) {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "goto", board };
}

/** The board an app URL fragment names (#board=<id>), or null. */
export function readBoardFragment(hash: string): string | null {
  return boardLinkId(hash);
}

/** The fragment for `board`: #board=<id>, or none. */
export function writeBoardFragment(board: string | null): string {
  return board === null ? "" : `${BOARD_LINK_PREFIX}${board}`;
}

function writeBoard(board: string | null): void {
  try {
    const url = new URL(window.location.href);
    const hash = writeBoardFragment(board);
    if (url.hash === hash || (url.hash === "" && hash === "")) return;
    url.hash = hash;
    const href = hash === "" ? `${url.pathname}${url.search}` : url.toString();
    window.history.replaceState(window.history.state, "", href);
  } catch {
    // A sandboxed or unusual history: the board just is not remembered.
  }
}

export interface DesignLinkOptions {
  /** The artifact is a design. Everything else is inert when false. */
  available: boolean;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
}

export function useDesignLink(o: DesignLinkOptions): void {
  const { available, frame, contentOrigin, config } = o;
  const opaque = config?.content_isolation === "opaque" || !!config?.content_path_fallback;
  const target = rendererTargetOrigin(config, contentOrigin);
  /** The board to show: from the address at first, then whatever the frame last showed. */
  const wanted = useRef<string | null>(readBoardFragment(window.location.hash));

  useEffect(() => {
    if (!available) return;
    const onMessage = (e: MessageEvent) => {
      const m = readDesignFrameMessage(e, { frame, contentOrigin, opaque });
      if (!m) return;
      if (m.type === "ready") {
        const want = wanted.current;
        if (want !== null && want !== m.board && target) {
          frame?.contentWindow?.postMessage(designGotoMessage(want), target);
        }
        return;
      }
      wanted.current = m.board;
      writeBoard(m.board);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [available, frame, contentOrigin, opaque, target]);
}
