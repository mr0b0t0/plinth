// The whiteboard type's Worker hooks: its source is board.json (packages/shared/src/whiteboard.ts),
// refused with the path of the first problem; it names no title of its own (the publish's title
// does); its capabilities are fixed by the server from the settings (shared data with `blocks` and
// `arrows` shared, viewer identity, the room, and the write floor `writers`), never read from the
// source; it takes no assets. Before staging, the version keeps only the canonical settings and a
// starting board is set aside to be written into shared data after the commit (services/board.ts).
// A new version, a restore included, tells the board's live room, whose sockets reconnect when the
// settings changed who may edit.
import { boardCapabilities, parseBoardSettings, serializeCapabilities } from "@plinth/shared";
import { notifyVersion } from "../../rooms/notify.ts";
import type { TypeHooks } from "../artifactTypes.ts";
import { parseBoard, prepareBoardSource } from "../board.ts";

export const whiteboardHooks: TypeHooks = {
  title: () => null,
  capabilities: (text) => serializeCapabilities(boardCapabilities(parseBoardSettings(text))),
  validate(_def, text) {
    parseBoard(text);
  },
  prepare: (ctx, p) => prepareBoardSource(ctx, p),
  async afterCommit(ctx, v) {
    try {
      notifyVersion(ctx, v.result.id, v.result.version, v.capabilities);
    } catch {
      // Best effort; the room's alarm re-reads the declaration.
    }
    return v.result;
  },
};
