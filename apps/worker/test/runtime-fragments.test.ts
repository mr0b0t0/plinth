// /__plinth/runtime.js is assembled from fragments (content/runtime/). The assembly replaced one
// static string without a behaviour change, so the fragments before page comments, without the app
// channel, are pinned. A change that means to alter that script updates the pin here, on purpose:
// display names and the people fragment (who is viewing) did. Page comments and dictation added the
// app channel and their own fragments after them; the channel is also tested on its own, and the
// dictation fragment in runtime-dictation.test.ts. Live views add theirs last: pushed data
// (runtime-behaviour.test.ts) and new versions with carried state (runtime-version.test.ts),
// then files people add to a page theirs (runtime-files.test.ts), then data sources theirs
// (runtime-sources.test.ts); data sources also map a stamped document's source in the core's toDoc,
// which changed the pin below on purpose (documents without a stamp map as before).
import { describe, expect, it } from "vitest";
import { COMMENTS_FRAGMENT } from "../src/content/runtime/comments.ts";
import { DATA_FRAGMENT } from "../src/content/runtime/data.ts";
import { DICTATION_FRAGMENT } from "../src/content/runtime/dictation.ts";
import { FILES_FRAGMENT } from "../src/content/runtime/files.ts";
import type { RuntimeFragment } from "../src/content/runtime/fragment.ts";
import { LIVE_FRAGMENT } from "../src/content/runtime/live.ts";
import { PEOPLE_FRAGMENT } from "../src/content/runtime/people.ts";
import { ROOM_FRAGMENT } from "../src/content/runtime/room.ts";
import { SOURCES_FRAGMENT } from "../src/content/runtime/sources.ts";
import { VERSION_FRAGMENT } from "../src/content/runtime/version.ts";
import { assembleRuntime, RUNTIME_FRAGMENTS, runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

/**
 * sha256 and length of the script: at 94ea515, the last commit before the fragments, it was
 * 409e0c69… (24787 characters); names and plinth.people changed it to 9a9a912c… (26439), and
 * doc.source (data sources) to this.
 */
const GOLDEN_SHA256 = "96560a8deb6b172ba9198fdf262b4d91aeb524ec14c62fdd7f8116f93d435329";
const GOLDEN_LENGTH = 26898;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const APP = "https://app.example";

/** A fragment that uses the app channel and exposes it to the test. */
const probe: RuntimeFragment = {
  name: "probe",
  usesAppChannel: true,
  source: () =>
    `  window.__probe = { got: [], post: toApp };
  onApp("plinth-probe", function (m) {
    window.__probe.got.push(m);
  });
  onApp("plinth-throws", function () {
    throw new Error("page callback");
  });

`,
};

const WITH_PROBE = [...RUNTIME_FRAGMENTS, probe];
/** The fragments before page comments: no app channel. */
const BEFORE = [DATA_FRAGMENT, ROOM_FRAGMENT, PEOPLE_FRAGMENT];

/** Evaluate a script with an opaque origin (no session fetch) and capture window listeners. */
function boot(script: string, opts: { framed: boolean }) {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const posted: [unknown, string][] = [];
  const parent = {
    postMessage(msg: unknown, target: string) {
      posted.push([msg, target]);
    },
  };
  const win: Record<string, any> = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent: () => true,
  };
  win.parent = opts.framed ? parent : win;
  const doc = { visibilityState: "visible", addEventListener() {} };
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    script,
  )(
    win,
    { origin: "null" },
    doc,
    () => Promise.reject(new Error("no fetch")),
    setTimeout,
    clearTimeout,
    class {},
  );
  const message = (e: unknown) => {
    for (const fn of listeners.get("message") ?? []) fn(e);
  };
  return { win, parent, posted, message, listeners };
}

describe("runtime fragments", () => {
  it("keeps the data, room and people code byte for byte, and serves it with page comments and dictation", async () => {
    const before = assembleRuntime(config(), BEFORE);
    expect(before.length).toBe(GOLDEN_LENGTH);
    expect(await sha256(before)).toBe(GOLDEN_SHA256);
    // Without a fragment that uses the app channel, no configuration value is in the script.
    expect(before).not.toContain("APP_ORIGIN");
    expect(assembleRuntime({ appOrigin: APP }, BEFORE)).toBe(before);
    expect(RUNTIME_FRAGMENTS.map((f) => f.name)).toEqual([
      "data",
      "room",
      "people",
      "comments",
      "dictation",
      "live",
      "version",
      "files",
      "sources",
    ]);
    const served = runtimeScript(config());
    expect(assembleRuntime(config())).toBe(served);
    expect(served).toBe(
      assembleRuntime(config(), [
        ...BEFORE,
        COMMENTS_FRAGMENT,
        DICTATION_FRAGMENT,
        LIVE_FRAGMENT,
        VERSION_FRAGMENT,
        FILES_FRAGMENT,
        SOURCES_FRAGMENT,
      ]),
    );
    // Memoized per app origin, which page comments and dictation embed.
    expect(runtimeScript(config())).toBe(served);
    expect(served).toContain(`var APP_ORIGIN = ${JSON.stringify(config().appOrigin)};`);
    expect(runtimeScript({ appOrigin: APP })).not.toBe(served);
    // The core head, the data, room and people fragments and the core tail are all still there.
    const start = before.indexOf("  // ---------- live updates");
    const end = before.indexOf("  Object.defineProperty(window");
    expect(served.startsWith(before.slice(0, start))).toBe(true);
    expect(served).toContain(before.slice(start, end));
    expect(served.endsWith(before.slice(end))).toBe(true);
  });

  it("places the app channel after the core head and before the other fragments", () => {
    const plain = assembleRuntime({ appOrigin: APP }, BEFORE);
    const withChannel = assembleRuntime({ appOrigin: APP }, WITH_PROBE);
    expect(withChannel).toContain(`var APP_ORIGIN = ${JSON.stringify(APP)};`);
    const at = withChannel.indexOf("// ---------- app channel");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(withChannel.indexOf("// ---------- live updates"));
    expect(withChannel.indexOf("// ---------- live room")).toBeLessThan(
      withChannel.indexOf("window.__probe"),
    );
    // Core head and tail are unchanged around it.
    const head = plain.slice(0, plain.indexOf("  // ---------- live updates"));
    const rest = plain.slice(head.length, plain.indexOf("  Object.defineProperty(window"));
    const tail = plain.slice(head.length + rest.length);
    expect(withChannel.startsWith(`${head}  // ---------- app channel`)).toBe(true);
    expect(withChannel).toContain(rest);
    expect(withChannel.endsWith(tail)).toBe(true);
    // The origin is embedded as a JSON string, never spliced raw.
    const odd = assembleRuntime({ appOrigin: 'https://x.example";alert(1);"' }, WITH_PROBE);
    expect(odd).toContain('var APP_ORIGIN = "https://x.example\\";alert(1);\\"";');
  });

  it("delivers only messages from the parent at the app origin, by source", () => {
    const { win, parent, message } = boot(assembleRuntime({ appOrigin: APP }, WITH_PROBE), {
      framed: true,
    });
    const got = () => win.__probe.got as unknown[];
    const m = { source: "plinth-probe", v: 1, n: 1 };
    message({ source: parent, origin: APP, data: m });
    expect(got()).toEqual([m]);
    // Another origin, another window, the page itself: dropped.
    message({ source: parent, origin: "https://evil.example", data: m });
    message({ source: {}, origin: APP, data: m });
    message({ source: win, origin: APP, data: m });
    message({ source: parent, origin: "null", data: m });
    // Not an object, no source, or a source nobody listens on: dropped.
    message({ source: parent, origin: APP, data: "plinth-probe" });
    message({ source: parent, origin: APP, data: null });
    message({ source: parent, origin: APP, data: { v: 1 } });
    message({ source: parent, origin: APP, data: { source: "plinth-other" } });
    expect(got()).toEqual([m]);
    // A throwing page callback never breaks the channel.
    message({ source: parent, origin: APP, data: { source: "plinth-throws" } });
    message({ source: parent, origin: APP, data: m });
    expect(got()).toEqual([m, m]);
  });

  it("posts only to the parent, at the app origin, and not when unframed", () => {
    const framed = boot(assembleRuntime({ appOrigin: APP }, WITH_PROBE), { framed: true });
    expect(framed.win.__probe.post({ source: "plinth-probe", type: "hello" })).toBe(true);
    expect(framed.posted).toEqual([[{ source: "plinth-probe", type: "hello" }, APP]]);

    const top = boot(assembleRuntime({ appOrigin: APP }, WITH_PROBE), { framed: false });
    expect(top.win.__probe.post({ type: "hello" })).toBe(false);
    expect(top.posted).toEqual([]);
    top.message({ source: top.win, origin: APP, data: { source: "plinth-probe" } });
    expect(top.win.__probe.got).toEqual([]);
  });

  it("adds no message listener when no fragment uses the app channel", () => {
    const { listeners } = boot(assembleRuntime({ appOrigin: APP }, BEFORE), { framed: true });
    expect(listeners.has("message")).toBe(false);
  });
});
