// Live rooms (#36): the handshake path, subprotocol and close codes. Kept apart from room.ts
// (which holds the zod frame schemas) so the doc renderer, a bundle every doc viewer loads, can
// import them without zod. Re-exported by room.ts.

/** The WebSocket subprotocol every room handshake must offer, and the 101 echoes. */
export const ROOM_PROTOCOL = "plinth.room.v1";

/**
 * Path prefix of the room upgrade on a content origin: `page` for HTML, `doc` for docs, `slides`
 * for decks.
 */
export const ROOM_PATH_PREFIX = "/__plinth/room/v1/";

/**
 * What a socket is: a page's general room, Plinth's own doc editing channel, or Plinth's own
 * follow-the-presenter channel for decks (rooms/slides.ts). One kind per line.
 */
// biome-ignore format: one kind per line, so each kind adds its own line
export const ROOM_KINDS = [
  "page",
  "doc",
  "slides",
] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** What a doc socket may do: nothing, follow the live draft, or edit it. */
export type RoomDocRight = "none" | "watch" | "write";

/** What a slides socket may do: nothing, follow the presenter, or present (lead the others). */
export type RoomSlidesRight = "none" | "present" | "watch";

/**
 * Close codes a room sends (the 4000-4999 range is the application's). The client reacts to each:
 * 4401 re-checks access and fires `plinth:expired`, 4410 reconnects so the gate re-reads the
 * declaration, the others stop retrying.
 */
export const ROOM_CLOSE = {
  invalid: 4400,
  /** Access changed (a grant, visibility or password change) or the content pass expired. */
  unauthorized: 4401,
  forbidden: 4403,
  /** The artifact was deleted or taken down. */
  gone: 4404,
  /** Too many sockets on the artifact or for this viewer, or connects too fast. */
  full: 4409,
  /** The current version changed what it declares about rooms. */
  redeclared: 4410,
  /** Too many messages over the rate, even after the error replies. */
  rate: 4429,
} as const;
export type RoomCloseCode = (typeof ROOM_CLOSE)[keyof typeof ROOM_CLOSE];
