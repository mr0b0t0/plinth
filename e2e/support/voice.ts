// Pages and fakes for the dictation and text-to-speech specs (docs/spec.md "Voice: dictation and
// text to speech").
import type { Frame, Page } from "@playwright/test";

export const VOICE_TITLE = "Voice notes";

/** The image a `slowImage` voice page waits for: the test holds its response to delay load. */
export const SLOW_IMAGE = "slow.png";

/**
 * A page that declares dictation: a Speak button that calls plinth.dictation.start() straight from
 * its click, and lines that show what the runtime reports. With `auto`, it also starts on load,
 * without any click. With `slowImage`, its load event waits for SLOW_IMAGE.
 */
export function voicePage(opts: { auto?: boolean; slowImage?: boolean } = {}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${VOICE_TITLE}</title>
<meta name="plinth-capabilities" content="dictation">
<script src="/__plinth/runtime.js"></script></head>
<body>
<button id="mic" type="button">Speak</button>${opts.slowImage ? `\n<img src="${SLOW_IMAGE}" alt="">` : ""}
<p id="ready"></p><p id="partial"></p><p id="final"></p><p id="state"></p><p id="result"></p>
<script>
  var d = window.plinth.dictation;
  var $ = function (id) { return document.getElementById(id); };
  d.onPartial(function (e) { $("partial").textContent = e.text; });
  d.onFinal(function (e) { $("final").textContent += e.text; });
  d.onState(function (e) { $("state").textContent = e.state + (e.reason ? ":" + e.reason : ""); });
  $("mic").addEventListener("click", function () {
    d.start().then(
      function () { $("result").textContent = "started"; },
      function (e) { $("result").textContent = e.code; }
    );
  });
  ${
    opts.auto
      ? `d.start().then(
    function () { $("result").textContent = "started"; },
    function (e) { $("result").textContent = e.code; }
  );`
      : ""
  }
  d.ready.then(function (r) {
    $("ready").textContent = r.available ? "available" : r.reason;
    document.body.dataset.ready = "1";
  });
</script>
</body></html>`;
}

/**
 * A page that reaches for the microphone itself (what Plinth never allows), after a click: it
 * reports getUserMedia's outcome, what a recognizer constructed in the frame does, and whether the
 * frame's policy allows the microphone.
 */
export const MIC_PROBE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mic probe</title></head>
<body>
<button id="probe" type="button">Probe</button>
<script>
  var policy = document.featurePolicy;
  document.body.dataset.policy = policy ? String(policy.allowsFeature("microphone")) : "none";
  document.getElementById("probe").addEventListener("click", async function () {
    var out = {};
    try {
      var s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(function (t) { t.stop(); });
      out.gum = "granted";
    } catch (e) {
      out.gum = e.name;
    }
    out.rec = await new Promise(function (resolve) {
      var R = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!R) return resolve("none");
      try {
        var r = new R();
        r.onaudiostart = function () { resolve("audiostart"); };
        r.onerror = function (e) { resolve("error:" + e.error); };
        r.start();
        setTimeout(function () { resolve("no-audio"); }, 3000);
      } catch (e) {
        resolve("throw:" + e.name);
      }
    });
    document.body.dataset.probe = JSON.stringify(out);
  });
</script>
</body></html>`;

/**
 * A page that speaks with the browser's own speechSynthesis: once on load (no click), then from a
 * button. Each attempt records its first event: start, end or error:<code>, or none after 3 s.
 */
export const SPEAK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Speak</title></head>
<body>
<button id="say" type="button">Read aloud</button>
<script>
  function attempt(key) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; document.body.dataset[key] = v; resolve(v); } };
      try {
        var u = new SpeechSynthesisUtterance("Hello");
        u.onstart = function () { finish("start"); };
        u.onend = function () { finish("end"); };
        u.onerror = function (e) { finish("error:" + e.error); };
        speechSynthesis.speak(u);
      } catch (e) {
        finish("throw:" + e.name);
      }
      setTimeout(function () { finish("none"); }, 3000);
    });
  }
  attempt("onload");
  document.getElementById("say").addEventListener("click", function () {
    speechSynthesis.cancel();
    attempt("clicked");
  });
</script>
</body></html>`;

/**
 * A fake speech recognizer for the app document only (never the artifact's): it starts, sends a
 * partial then a final, and ends when stopped. Installed before any script runs.
 */
export async function fakeRecognizer(page: Page, appOrigin: string): Promise<void> {
  await page.addInitScript((origin: string) => {
    if (location.origin !== origin) return;
    class FakeRecognizer {
      continuous = false;
      interimResults = false;
      lang = "";
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onresult: ((e: unknown) => void) | null = null;
      start() {
        const w = window as unknown as { __recognizers?: number };
        w.__recognizers = (w.__recognizers ?? 0) + 1;
        setTimeout(() => {
          this.onstart?.();
          setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: [{ isFinal: false, 0: { transcript: "hello wor" } }],
            });
            setTimeout(() => {
              this.onresult?.({
                resultIndex: 0,
                results: [{ isFinal: true, 0: { transcript: "hello world" } }],
              });
            }, 150);
          }, 100);
        }, 50);
      }
      stop() {
        setTimeout(() => this.onend?.(), 20);
      }
      abort() {}
    }
    Object.defineProperty(window, "SpeechRecognition", {
      value: FakeRecognizer,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: FakeRecognizer,
      configurable: true,
      writable: true,
    });
  }, appOrigin);
}

/** The artifact frame being shown, once its body carries `attr`. */
export async function artifactFrame(page: Page, attr: string): Promise<Frame> {
  const sel = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
  await page.frameLocator(sel).locator(`body[${attr}]`).waitFor({ timeout: 15_000 });
  const frame = await (await page.locator(sel).elementHandle())?.contentFrame();
  if (!frame) throw new Error("the artifact frame is not attached");
  return frame;
}
