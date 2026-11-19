// Boots a whiteboard: reads the payload the shell embeds (typedShellHtml in @plinth/shared) and the
// board's settings, then shows the board in one of three ways.
//
// - Preview (payload.preview, set only by the app's editor preview): no shared-data or room call at
//   all. Only the draft's own starting blocks are drawn, read-only, under a banner.
// - Without the runtime, or when the runtime says shared data is unavailable: an empty, read-only
//   board that says why.
// - Live: the board's blocks and arrows from shared data (snapshots, with writes through BoardSync)
//   and the room for cursors and drags (Live).
//
// window.plinth is read once, before any DOM is built, so nothing the page draws later can stand
// in for it. html[data-ready="ok"|"error"] is set for thumbnails and end-to-end tests.
import {
  parseBoardContent,
  parseBoardSettings,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import { Board } from "./board.ts";
import { loadCamera } from "./camera.ts";
import { Live } from "./live.ts";
import { type PlinthRuntime, type RoomStatus, type RuntimeError, runtimeOf } from "./runtime.ts";
import { BoardSync, READ_ONLY_TEXT } from "./sync.ts";

const ROOT_ID = "__plinth-whiteboard";
const DATA_ID = "__plinth-content";

export const PREVIEW_TEXT = "Preview: the board's blocks are not shown here; settings apply.";

/** Why the board's blocks are not available, after "The board is not available here: ". */
export const DATA_WHY: Record<string, string> = {
  opaque_isolation: "this server does not keep page data",
  disabled: "page data is turned off on this server",
  not_declared: "this version of the board keeps no data",
  preview: "this is a preview",
  expired: "your access changed; reload the page",
  network: "the connection failed; reload the page",
};

/** Why live cursors are off. */
export const ROOM_WHY: Record<string, string> = {
  opaque_isolation: "this server does not run live rooms",
  disabled: "live rooms are turned off on this server",
  not_configured: "live rooms are not set up on this server",
  not_declared: "this board has no room",
  preview: "this is a preview",
  not_identified: "only people the board is shared with see each other",
  expired: "your access changed",
  full: "the board has too many people on it",
  rate_limited: "too many messages were sent",
  network: "the connection failed",
};

const STATUS_TEXT: Record<RoomStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  closed: "Offline",
  unavailable: "Live cursors off",
};

export function readPayload(doc: Document): TypedPayload | null {
  const raw = doc.getElementById(DATA_ID)?.textContent;
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (p.v !== TYPED_PAYLOAD_VERSION || p.type !== "whiteboard") return null;
  if (typeof p.text !== "string" || typeof p.app_origin !== "string") return null;
  return value as TypedPayload;
}

/** Boots the board. Returns it (null when the page is not a board), for tests. */
export function boot(win: Window): Board | null {
  // Before anything else: the runtime the shell loaded, if any.
  const runtime = runtimeOf(win);
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  if (!root || !payload) {
    if (root) {
      const p = doc.createElement("p");
      p.className = "wb-problem";
      p.textContent = "This page is not a whiteboard.";
      root.replaceChildren(p);
    }
    html.setAttribute("data-ready", "error");
    return null;
  }
  const settings = parseBoardSettings(payload.text);
  const board = new Board({ win, root, title: doc.title, settings });

  if (payload.preview === true) {
    showPreview(board, payload.text);
    html.setAttribute("data-ready", "ok");
    return board;
  }
  if (!runtime) {
    board.banner("This board's blocks are not available here: the page runtime did not load.");
    board.setStatus(STATUS_TEXT.unavailable, "unavailable");
    html.setAttribute("data-ready", "ok");
    return board;
  }
  void startLive(win, board, runtime);
  return board;
}

/** The editor preview: the draft's starting blocks, read-only, and nothing from the server. */
function showPreview(board: Board, text: string): void {
  try {
    const { seed } = parseBoardContent(text);
    for (const s of seed) {
      if (s.collection === "blocks") board.model.upsertBlock(s.id, s.data, 0);
      else board.model.upsertArrow(s.id, s.data, 0);
    }
  } catch {
    // A draft that does not parse yet: the editor lists its problems.
  }
  board.banner(PREVIEW_TEXT);
  board.setStatus("Preview", "preview");
  board.setReadOnly(true);
  if (board.model.blocks.size > 0) board.fitBoard();
}

async function startLive(win: Window, board: Board, runtime: PlinthRuntime): Promise<void> {
  const html = win.document.documentElement;
  const session = await runtime.ready;
  if (!session.available) {
    board.banner(
      `This board's blocks are not available here: ${DATA_WHY[session.reason ?? ""] ?? "they could not be loaded"}.`,
    );
    board.setStatus(STATUS_TEXT.unavailable, "unavailable");
    html.setAttribute("data-ready", "ok");
    return;
  }
  const blocks = runtime.db.collection("blocks");
  const arrows = runtime.db.collection("arrows");
  board.sync = new BoardSync({
    blocks,
    arrows,
    model: board.model,
    changed: () => board.redraw(),
    readOnly: () => {
      board.setReadOnly(true);
      board.banner(READ_ONLY_TEXT);
    },
    say: (t) => board.say(t),
    emit: (topic, d) => board.live?.saved(topic, d.id),
  });

  win.addEventListener("plinth:expired", () => {
    board.setReadOnly(true);
    board.banner("Your access changed. Reload the page.");
  });

  // The first snapshot of both collections: then the board is ready, fitted on a first visit.
  let loaded = 0;
  const fitOnce = !loadCamera(win);
  const onLoaded = () => {
    loaded++;
    if (loaded !== 2) return;
    if (fitOnce) board.fitBoard();
    html.setAttribute("data-ready", "ok");
  };
  const onError = (e: RuntimeError) => {
    if (e?.code === "expired") return; // the plinth:expired handler says it
    board.say("Could not load the board. Reload the page.");
  };
  let firstBlocks = true;
  let firstArrows = true;
  blocks.onSnapshot((docs) => {
    board.applySnapshot("blocks", docs);
    if (firstBlocks) {
      firstBlocks = false;
      onLoaded();
    }
  }, onError);
  arrows.onSnapshot((docs) => {
    board.applySnapshot("arrows", docs);
    if (firstArrows) {
      firstArrows = false;
      onLoaded();
    }
  }, onError);

  if (!session.canWrite) {
    board.banner(
      "You can view this board and see who is here. Only people it lets edit can change it.",
    );
  }
  board.setStatus(STATUS_TEXT.connecting, "connecting");
  const live = new Live(runtime.room, session.canWrite, {
    peers: (list) => board.setPeers(list),
    moved: (id, x, y) => board.peerMoved(id, x, y),
    saved: (collection, id) => void board.sync?.refetch(collection, id),
    status: (s) => board.setStatus(STATUS_TEXT[s], s),
    canWrite: (may) => {
      board.setReadOnly(!may);
      if (!may && session.canWrite) {
        board.banner("You can view this board and see who is here. Only editors can change it.");
      } else if (may) board.banner("");
    },
  });
  board.live = live;
  const ready = await live.start();
  if (!ready.available) {
    board.setStatus(STATUS_TEXT.unavailable, "unavailable");
    const why = ROOM_WHY[ready.reason ?? ""] ?? "the room is unavailable";
    const saves = session.canWrite ? " Changes still save." : "";
    board.say(`Live cursors are off here (${why}).${saves}`);
  }
}
