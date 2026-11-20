// The runtime's live-view fragment (docs/spec.md "Live views"): while the app that frames the page
// holds a watch socket, it tells the page when shared data changed, so onSnapshot re-reads at once
// instead of on its 15 s poll. Two app-channel messages, both hints (page script can forge either):
//   { source: "plinth-view", v: 1, type: "data" }        re-read /changes now (the data fragment's
//                                                        coalesced kick(): refetch when seq moved)
//   { source: "plinth-view", v: 1, type: "push", on }    signals are pushed: poll /changes only
//                                                        every 60 s, as a backstop; off, back to the
//                                                        page's own interval
// Nothing is fetched that the page could not fetch itself, and no data crosses postMessage: every
// read still goes through the shared-data API with all of its checks. The data fragment's
// schedule() is wrapped here, not edited, so its bytes stay as they were.
import type { RuntimeFragment } from "./fragment.ts";

export const LIVE_FRAGMENT: RuntimeFragment = {
  name: "live",
  usesAppChannel: true,
  source: () => `  // ---------- live views: shared-data changes pushed by the app ----------

  var PUSHED_POLL_MS = 60000;
  var pushed = false;
  var scheduleOwn = schedule;
  schedule = function (ms) {
    scheduleOwn(ms === undefined && pushed ? PUSHED_POLL_MS : ms);
  };
  onApp("plinth-view", function (m) {
    if (m.v !== 1) return;
    if (m.type === "data") {
      kick();
    } else if (m.type === "push") {
      var on = m.on === true;
      if (on === pushed) return;
      pushed = on;
      if (!ticking) schedule();
    }
  });

`,
};
