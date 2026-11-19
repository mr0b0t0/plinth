// The runtime's app channel: messages between the page and the Plinth app that frames it. It is
// in the script only when a fragment that uses it is (RuntimeFragment.usesAppChannel), and then it
// embeds the instance's app origin, as bridge.js does: public configuration, the same for every
// artifact on the instance, no secrets and no artifact data.
//
// Posts go only to window.parent, with targetOrigin APP_ORIGIN, so the browser drops them when
// the parent is anything else (an MCP host's in-chat preview, another site, no frame at all). A
// message counts only when it comes from window.parent at APP_ORIGIN and names a `source` a
// fragment listens on. Page script shares this window and can forge a MessageEvent or post to the
// parent itself, so what arrives is a hint for the page: every check that matters is in the app.
//
//   toApp(msg) -> bool      posted (false when not framed, or the post threw)
//   onApp(source, fn) -> off  fn(message) for each authenticated message with that `source`
import type { RuntimeFragment } from "./fragment.ts";

export const APP_CHANNEL_FRAGMENT: RuntimeFragment = {
  name: "app",
  source: ({
    appOriginJson,
  }) => `  // ---------- app channel: messages to and from the app that frames the page ----------

  var APP_ORIGIN = ${appOriginJson};
  var framed = window.parent !== window;
  var appHandlers = new Map();

  function toApp(msg) {
    if (!framed) return false;
    try {
      window.parent.postMessage(msg, APP_ORIGIN);
      return true;
    } catch (e) {
      return false;
    }
  }

  function onApp(source, fn) {
    var fns = appHandlers.get(source);
    if (!fns) {
      fns = new Set();
      appHandlers.set(source, fns);
    }
    fns.add(fn);
    return function () {
      fns.delete(fn);
    };
  }

  window.addEventListener("message", function (e) {
    if (!framed || e.source !== window.parent || e.origin !== APP_ORIGIN) return;
    var m = e.data;
    if (!m || typeof m !== "object" || typeof m.source !== "string") return;
    var fns = appHandlers.get(m.source);
    if (!fns) return;
    fns.forEach(function (fn) {
      try {
        fn(m);
      } catch (err) {}
    });
  });

`,
};
