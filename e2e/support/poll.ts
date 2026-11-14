// The poll page from the plinth-artifacts skill (design: shared-state section 8), with a tally and
// a few data attributes the shared-data specs read: body[data-can-write], body[data-reason] and
// #note[data-error] (the last PlinthError code, or "" after a saved vote).
import type { Frame, Page } from "@playwright/test";

export const POLL_TITLE = "Lunch poll";

export const POLL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="plinth-capabilities" content="data viewer">
<title>${POLL_TITLE}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 16px; background: Canvas; color: CanvasText; }
  button { font: inherit; padding: 6px 14px; }
</style>
<script src="/__plinth/runtime.js"></script>
</head>
<body>
<main>
  <h1>Where should we eat?</h1>
  <p id="me"></p>
  <p>
    <button type="button" data-choice="tacos">Tacos</button>
    <button type="button" data-choice="ramen">Ramen</button>
  </p>
  <p>Votes: <output id="total">-</output> (tacos <output id="tacos">-</output>, ramen <output id="ramen">-</output>)</p>
  <p id="note" role="status"></p>
</main>
<script>
const note = document.getElementById("note");
function render(docs) {
  const n = { tacos: 0, ramen: 0 };
  for (const d of docs) if (d.data.choice in n) n[d.data.choice]++;
  document.getElementById("total").textContent = String(docs.length);
  document.getElementById("tacos").textContent = String(n.tacos);
  document.getElementById("ramen").textContent = String(n.ramen);
}
window.plinth?.ready.then((s) => {
  document.body.dataset.canWrite = String(s.canWrite);
  document.body.dataset.reason = String(s.reason);
  if (s.viewer && s.viewer.email) document.getElementById("me").textContent = "Voting as " + s.viewer.email;
  if (!s.available) {
    note.textContent = s.reason === "opaque_isolation"
      ? "Voting is not available on this server." : "Voting is unavailable. Reload the page.";
    return;
  }
  if (!s.canWrite) note.textContent = "Only people this poll was shared with can vote.";
  const votes = plinth.db.collection("votes");
  votes.onSnapshot(render, (e) => {
    note.dataset.error = e.code;
    note.textContent = e.code === "expired" ? "Your access changed. Reload the page." : "Could not load votes.";
  });
  for (const b of document.querySelectorAll("button[data-choice]")) {
    b.disabled = !s.canWrite;
    b.onclick = () => votes.setMine({ choice: b.dataset.choice })   // one doc per voter
      .then(() => { note.dataset.error = ""; note.textContent = "Saved: " + b.dataset.choice; })
      .catch((e) => {
        note.dataset.error = e.code;
        note.textContent = e.code === "rate_limited" ? "Slow down a moment." : e.message;
      });
  }
});
</script>
</body>
</html>
`;

/** The frame being shown. A reload keeps the outgoing frame (marked) until the new one loads. */
export const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

/** The poll's frame once its runtime is ready (body[data-can-write] is set). */
export async function pollFrame(page: Page): Promise<Frame> {
  await page
    .frameLocator(CURRENT_FRAME)
    .locator("body[data-can-write]")
    .waitFor({ timeout: 15_000 });
  const handle = await page.locator(CURRENT_FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("the artifact frame is not attached");
  return frame;
}
