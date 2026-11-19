// /__plinth/runtime.js is assembled from fragments (content/runtime/). The assembly replaced one
// static string without a behaviour change, so the served bytes are pinned to the script on main
// before the split; and the app channel, which no fragment uses yet, is tested on its own.
import { describe, expect, it } from "vitest";
import type { RuntimeFragment } from "../src/content/runtime/fragment.ts";
import { assembleRuntime, RUNTIME_FRAGMENTS, runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

/** sha256 and length of RUNTIME_SCRIPT on main (unchanged from 94ea515 to 2110cc4), before the fragments. */
const GOLDEN_SHA256 = "409e0c6962e06426cc55e4593f7a054085255e0de4ab391446c1eb6fbebcc680";
const GOLDEN_LENGTH = 24787;

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
  it("serves the same bytes as the script before the fragments, on every instance", async () => {
    const served = runtimeScript(config());
    expect(served.length).toBe(GOLDEN_LENGTH);
    expect(await sha256(served)).toBe(GOLDEN_SHA256);
    // No listed fragment uses the app channel yet, so no configuration value is in the script.
    expect(served).not.toContain("APP_ORIGIN");
    expect(runtimeScript({ appOrigin: APP })).toBe(served);
    expect(assembleRuntime(config())).toBe(served);
    // Memoized per app origin.
    expect(runtimeScript(config())).toBe(served);
  });

  it("places the app channel after the core head and before the other fragments", () => {
    const plain = assembleRuntime({ appOrigin: APP });
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
    const { listeners } = boot(runtimeScript({ appOrigin: APP }), { framed: true });
    expect(listeners.has("message")).toBe(false);
  });
});
