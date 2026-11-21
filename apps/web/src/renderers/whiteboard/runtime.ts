// The part of the page runtime (/__plinth/runtime.js, window.plinth) the whiteboard renderer uses.
// The runtime is Plinth's own script, loaded by the shell right before the renderer; these types
// describe what it offers (apps/worker/src/content/runtime.ts). Every value it hands over that came
// from other people (documents, peers, room events) is still checked before it is drawn.

export interface RuntimeDoc {
  id: string;
  data: unknown;
  rev: number;
}

export interface RuntimeError extends Error {
  code?: string;
  retryAfter?: number;
  /** Why an expired one was refused: "stale_page" for a page older than its board's format. */
  reason?: string;
  currentRev?: number;
}

export interface RuntimeCollection {
  /** The format its writes name (x-plinth-format); a runtime older than the option has none. */
  readonly format?: string | null;
  list(opts?: { limit?: number; cursor?: string }): Promise<{ docs: RuntimeDoc[] }>;
  all(): Promise<RuntimeDoc[]>;
  get(id: string): Promise<RuntimeDoc | null>;
  add(data: unknown): Promise<RuntimeDoc>;
  set(id: string, data: unknown, opts?: { ifRev?: number }): Promise<RuntimeDoc>;
  update(id: string, fn: (data: unknown) => unknown): Promise<RuntimeDoc>;
  delete(id: string, opts?: { ifRev?: number }): Promise<void>;
  onSnapshot(
    onDocs: (docs: RuntimeDoc[]) => void,
    onError?: (e: RuntimeError) => void,
    opts?: { intervalMs?: number },
  ): () => void;
}

export interface RuntimeSession {
  available: boolean;
  reason: string | null;
  viewer: { id: string; email: string | null; name: string | null; role: string } | null;
  canWrite: boolean;
}

export interface RuntimePeer {
  id: string;
  viewer: string;
  you: boolean;
  role?: string;
  email?: string;
  name?: string | null;
  presence: Record<string, unknown>;
}

export type RoomStatus = "connecting" | "open" | "reconnecting" | "closed" | "unavailable";

export interface RuntimeRoomReady {
  available: boolean;
  reason: string | null;
  canEmit(topic: string): boolean;
}

export interface RuntimeRoom {
  /** Reading it starts the room (the runtime connects on first use). */
  readonly ready: Promise<RuntimeRoomReady>;
  presence(patch: Record<string, unknown> | null): boolean;
  onPeers(fn: (peers: RuntimePeer[]) => void): () => void;
  emit(topic: string, data: unknown): boolean;
  on(topic: string, fn: (data: unknown, from: unknown, topic: string) => void): () => void;
  onStatus(fn: (s: RoomStatus) => void): () => void;
  join(name: string): RuntimeRoom;
}

export interface PlinthRuntime {
  ready: Promise<RuntimeSession>;
  db: { collection(name: string, opts?: { format?: string }): RuntimeCollection };
  room: RuntimeRoom;
}

/** The page's shared-data API on its own origin, as the runtime calls it. */
const SESSION_PATH = "/__plinth/api/v1/session";

/**
 * The session's can_write as the server says it now, or null when it could not be read. The
 * runtime reads the session once, at load; a board reads it again when its room reconnects after
 * a settings version, with the same request the runtime makes (same origin, the x-plinth-data
 * header, no body), so it passes every check the data API makes.
 */
export async function readSessionCanWrite(win: Window): Promise<boolean | null> {
  try {
    const res = await win.fetch(SESSION_PATH, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "x-plinth-data": "1" },
    });
    if (!res.ok) return null;
    const s = (await res.json()) as { available?: unknown; can_write?: unknown } | null;
    return s?.available === true ? s.can_write === true : null;
  } catch {
    return null;
  }
}

/** window.plinth when it is the runtime's object, read once at boot; null otherwise. */
export function runtimeOf(win: Window): PlinthRuntime | null {
  const p = (win as unknown as { plinth?: unknown }).plinth;
  if (typeof p !== "object" || p === null) return null;
  // An element named "plinth" is an HTMLElement, never the runtime: it has no db and no ready.
  if (typeof (p as Node).nodeType === "number") return null;
  const r = p as Partial<PlinthRuntime>;
  if (!r.ready || typeof r.db?.collection !== "function" || typeof r.room !== "object") {
    return null;
  }
  return r as PlinthRuntime;
}
