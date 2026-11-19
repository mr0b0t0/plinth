// /__plinth/runtime.js: the script a page loads to use its artifact's shared data, live room and
// comments from the page and dictation (docs/spec.md "Shared data and viewer identity", "Live
// rooms", "Comments from the page", "Voice: dictation and text to speech"). It holds no secrets and
// no artifact data, so it is served without a content cookie and is the same for every artifact on
// an instance. Its only configuration value is the instance's public app origin, which the app
// channel (runtime/app.ts) embeds for page comments and dictation. It talks only to its own
// origin's /__plinth/api/v1/ (connect-src 'self') and, by postMessage at that exact origin, to the
// app that frames it. Assembled from the fragments in runtime/.
//
// window.plinth:
//   ready      Promise<Session>, never rejects: { available, reason, viewer, canWrite,
//              capabilities, shared, limits, usage }; reason null | "opaque_isolation" | "disabled"
//              | "not_declared" | "preview" | "expired" | "network"
//   available, viewer ({ id, email | null, name | null, role } | null), canWrite, canListPeople:
//              set once ready resolves
//   db.collection(name): list({ limit, cursor }) -> { docs, nextCursor }, all(), get(id) -> Doc |
//              null, add(data), set(id, data, { ifRev }), update(id, fn), delete(id, { ifRev }),
//              mine(), setMine(data), deleteMine(), onSnapshot(onDocs, onError, { intervalMs });
//              a Doc's createdBy and updatedBy are { email, name | null, role, via }. While the
//              app pushes changes (live views, runtime/live.ts) onSnapshot re-reads when told and
//              polls only every 60 s; intervalMs applies while it does not
//   people     who has access (owners and editors, pages that declare `data viewer people`):
//              list({ q, limit }) -> [{ id, email, name | null, role, you }], get(id) -> that or
//              null; others get forbidden or unavailable
//   PlinthError: .code unavailable | read_only | forbidden | not_found | conflict |
//              quota_exceeded | too_large | rate_limited | expired | invalid | network;
//              .retryAfter, .currentRev, .limit
//
//   room       the live room (docs/spec.md "Live rooms"); nothing connects until first use:
//              ready Promise<{ available, reason, you: { id, viewer, role, email | null, name | null } | null,
//              canEmit(topic) }>, never rejects; presence(patch | null) -> bool (coalesced to
//              10 Hz, 400 bytes); onPeers(fn) -> off; emit(topic, data) -> bool (never echoed);
//              on(topic | "*", fn(data, from, topic)) -> off; onStatus(fn) -> off ("connecting",
//              "open", "reconnecting", "closed", "unavailable"); join(name) -> a sub-room with
//              the same methods (3 at most); leave()
//
//   comments   comments from the page (runtime/comments.ts); nothing is posted until first use:
//              ready, compose(anchor?), onThreads(fn), locate(fn), refresh(), open(id), onFocus(fn)
//
//   dictation  words the viewer speaks, recognized by the app (never the microphone): ready
//              Promise<{ available, reason }>, never rejects (reason null | "disabled" |
//              "opaque_isolation" | "not_declared" | "not_identified" | "unsupported" | "no_host");
//              start({ lang, interim }) -> Promise, from a click (rejects unavailable |
//              no_activation | not_granted | dismissed | busy | rate_limited | invalid | network);
//              stop() -> Promise; onPartial(fn({ text })), onFinal(fn({ text })), onState(fn({
//              state, reason })) -> off. Nothing is posted until ready is read or start() called.
//
//   files      files people add to the page (runtime/files.ts, pages that declare `files`):
//              ready Promise<{ available, reason, canUpload, accept, limits: { maxFileBytes,
//              maxFiles, maxBytes, maxBytesPerUploader, partBytes }, usage: { files, bytes,
//              mineBytes } }>, never rejects (reason null | "opaque_isolation" | "disabled" |
//              "not_declared" | "preview" | "expired" | "network"); upload(blob, { name,
//              onProgress(sent, total), signal }) -> File; list({ limit, cursor, mine }) -> { files,
//              nextCursor }; all({ mine }); get(id) -> File | null; delete(id); url(id, { download
//              }); download(id); onSnapshot(onFiles, onError, { intervalMs, mine }) -> off. A File
//              is { id, name, type, size, url, mine, createdAt, uploadedBy? { email, role, via } };
//              its name is untrusted text. Errors add unsupported_type, type_mismatch and aborted.
//              Nothing is fetched until ready is read or a method is called.
//
// Under opaque isolation the page's origin is "null": ready resolves unavailable without any
// request, and db calls reject with "unavailable". A 401 means the content pass expired: listeners
// get "expired" as their terminal error and a "plinth:expired" event fires on window. The room
// opens one WebSocket to its own origin's /__plinth/room/v1/page (connect-src names it) after
// GET /__plinth/api/v1/room says it may; close code 4401 re-checks and ends in "plinth:expired"
// when access is over, and reconnects back off from 1 to 30 s.
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";
import { APP_CHANNEL_FRAGMENT } from "./runtime/app.ts";
import { COMMENTS_FRAGMENT } from "./runtime/comments.ts";
import { CORE_HEAD, CORE_TAIL } from "./runtime/core.ts";
import { DATA_FRAGMENT } from "./runtime/data.ts";
import { DICTATION_FRAGMENT } from "./runtime/dictation.ts";
import { FILES_FRAGMENT } from "./runtime/files.ts";
import type { RuntimeContext, RuntimeFragment } from "./runtime/fragment.ts";
import { LIVE_FRAGMENT } from "./runtime/live.ts";
import { PEOPLE_FRAGMENT } from "./runtime/people.ts";
import { ROOM_FRAGMENT } from "./runtime/room.ts";

/**
 * The fragments, in their fixed order: core (head and tail, around the rest), app channel, data,
 * room, then features in merge order. A feature adds its own file under runtime/ and one line
 * here. The app channel is placed only when a listed fragment uses it.
 */
export const RUNTIME_FRAGMENTS: readonly RuntimeFragment[] = [
  DATA_FRAGMENT,
  ROOM_FRAGMENT,
  PEOPLE_FRAGMENT,
  COMMENTS_FRAGMENT,
  DICTATION_FRAGMENT,
  LIVE_FRAGMENT,
  FILES_FRAGMENT,
];

/** Assemble the script from `fragments`, with the app channel when one of them uses it. */
export function assembleRuntime(
  config: Pick<Config, "appOrigin">,
  fragments: readonly RuntimeFragment[] = RUNTIME_FRAGMENTS,
): string {
  const ctx: RuntimeContext = { appOriginJson: JSON.stringify(config.appOrigin) };
  const parts = fragments.some((f) => f.usesAppChannel)
    ? [APP_CHANNEL_FRAGMENT, ...fragments]
    : fragments;
  return CORE_HEAD + parts.map((f) => f.source(ctx)).join("") + CORE_TAIL;
}

const memo = new Map<string, string>();

/**
 * The runtime this instance serves, the same bytes for every artifact. Memoized per app origin,
 * the only configuration a fragment may embed.
 */
export function runtimeScript(config: Pick<Config, "appOrigin">): string {
  let s = memo.get(config.appOrigin);
  if (s === undefined) {
    s = assembleRuntime(config);
    memo.set(config.appOrigin, s);
  }
  return s;
}

export function serveRuntimeScript(config: Config): Response {
  const headers = new Headers({ "Content-Type": "text/javascript; charset=utf-8" });
  applyContentHeaders(config, headers, { publicFile: true });
  return new Response(runtimeScript(config), { status: 200, headers });
}
