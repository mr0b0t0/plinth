// Publish warnings (services/publishCheck.ts): advisory, derived from the CSP's own sources, on
// real Vite output and hand-written cases, bounded in time and in what they echo.
import {
  LIMITS,
  PROJECT_FILES_RECORD,
  type PublishWarning,
  SENSITIVE_PATH_RULES,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { contentSources } from "../src/content/csp.ts";
import { echo, isSensitivePath, scanPublish } from "../src/services/publishCheck.ts";
import type { FileEntry } from "../src/services/storage.ts";
import { contentTypeFor } from "../src/services/storage.ts";
import defaultFiles from "./fixtures/vite/default/files.txt?raw";
import defaultHtml from "./fixtures/vite/default/index.html.txt?raw";
import defaultJs from "./fixtures/vite/default/index-C1hg2R_H.js.txt?raw";
import defaultCss from "./fixtures/vite/default/index-ec00kzzP.css.txt?raw";
import defaultLazy from "./fixtures/vite/default/lazy-CGOUc0_U.js.txt?raw";
import relativeFiles from "./fixtures/vite/relative/files.txt?raw";
import relativeHtml from "./fixtures/vite/relative/index.html.txt?raw";
import relativeCss from "./fixtures/vite/relative/index-C9-cblZV.css.txt?raw";
import relativeJs from "./fixtures/vite/relative/index-k1RVcvWO.js.txt?raw";
import relativeLazy from "./fixtures/vite/relative/lazy-CGOUc0_U.js.txt?raw";
import {
  agent,
  call,
  config,
  contentOrigin,
  enterContent,
  fetchWith,
  json,
  publish,
} from "./helpers.ts";

const enc = new TextEncoder();
const file = (path: string, text: string): FileEntry => ({
  path,
  bytes: enc.encode(text),
  contentType: contentTypeFor(path),
});
const sources = contentSources(config());

function scan(
  files: FileEntry[],
  paths: string[] = files.map((f) => f.path),
  isolation: "origin" | "opaque" = "origin",
) {
  return scanPublish({ files, manifestPaths: new Set(paths), sources, isolation });
}

const lines = (s: string) => s.split("\n").filter((l) => l !== "");

const vite = {
  default: {
    paths: lines(defaultFiles),
    files: [
      file("index.html", defaultHtml),
      file("assets/index-C1hg2R_H.js", defaultJs),
      file("assets/index-ec00kzzP.css", defaultCss),
      file("assets/lazy-CGOUc0_U.js", defaultLazy),
    ],
  },
  relative: {
    paths: lines(relativeFiles),
    files: [
      file("index.html", relativeHtml),
      file("assets/index-k1RVcvWO.js", relativeJs),
      file("assets/index-C9-cblZV.css", relativeCss),
      file("assets/lazy-CGOUc0_U.js", relativeLazy),
    ],
  },
};

const codes = (w: PublishWarning[]) => w.map((x) => `${x.code} ${x.file}`).sort();

describe("publish warnings on a real Vite build", () => {
  it("a relative build (base './') is clean under origin isolation", () => {
    expect(scan(vite.relative.files, vite.relative.paths)).toEqual([]);
  });

  it("a default build (base '/') gets one root_absolute per file, with a count", () => {
    const w = scan(vite.default.files, vite.default.paths);
    expect(codes(w)).toEqual([
      "root_absolute assets/index-C1hg2R_H.js",
      "root_absolute assets/index-ec00kzzP.css",
      "root_absolute index.html",
    ]);
    expect(w.find((x) => x.file.endsWith(".css"))).toMatchObject({ count: 2 });
    const html = w.find((x) => x.file === "index.html");
    expect(html).toMatchObject({ count: 3, ref: "/favicon.svg" });
    expect(html?.message).toContain("Vite base: './'");
  });

  it("finds what a relative build references but the version does not hold", () => {
    const without = vite.relative.paths.filter(
      (p) => p !== "assets/lazy-CGOUc0_U.js" && p !== "assets/font-CpRM4X3c.woff2",
    );
    const w = scan(vite.relative.files, without);
    expect(codes(w)).toEqual([
      "missing_file assets/index-C9-cblZV.css",
      "missing_file assets/index-k1RVcvWO.js",
    ]);
    expect(w.find((x) => x.file.endsWith(".js"))).toMatchObject({ ref: "./lazy-CGOUc0_U.js" });
    expect(w.find((x) => x.file.endsWith(".css"))?.message).toContain("assets/font-CpRM4X3c.woff2");
  });

  it("opaque isolation: opaque_module for the module entry, import() and the CSS font; none under origin", () => {
    const w = scan(vite.relative.files, vite.relative.paths, "opaque");
    expect(codes(w)).toEqual([
      "opaque_module assets/index-C9-cblZV.css",
      "opaque_module assets/index-k1RVcvWO.js",
      "opaque_module index.html",
    ]);
    expect(w[0]?.message).toMatch(/classic bundle/);
    expect(scan(vite.relative.files, vite.relative.paths, "origin")).toEqual([]);
  });

  it("artboards: opaque_module only for loads of the artifact's own files, never for CDN or data: ones", () => {
    const artboard = (files: FileEntry[]) =>
      scanPublish({
        files,
        manifestPaths: new Set([...files.map((f) => f.path), "font.woff2"]),
        sources,
        isolation: "opaque",
        opaqueReason: "artboard",
      }).filter((x) => x.code === "opaque_module");
    // The fixes the warning itself names: Google Fonts' own embed, a data: font, a CDN module.
    const fine = [
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      '<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">',
      "<style>@font-face { font-family: B; src: url(data:font/woff2;base64,AAAA) format('woff2'); }</style>",
      '<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>',
      '<script type="module" src="https://cdn.jsdelivr.net/npm/lit@3.2.1/index.js"></script>',
      '<script type="module">import "https://cdn.jsdelivr.net/npm/lit@3.2.1/index.js";</script>',
    ];
    for (const line of fine) expect(artboard([file("design.html", line)]), line).toEqual([]);
    // Loads of the artifact's own files fail from an opaque document.
    const own = [
      '<script type="module" src="app.js"></script>',
      '<script crossorigin src="app.js"></script>',
      '<link rel="stylesheet" href="brand.css" crossorigin>',
      '<link rel="modulepreload" href="./chunk.js">',
      '<script type="module">import "./chunk.js";</script>',
      "<script type=\"module\">import('./chunk.js');</script>",
      "<style>@font-face { font-family: B; src: url(font.woff2); }</style>",
      "<style>@font-face { font-family: B; src: url('/font.woff2'); }</style>",
    ];
    for (const line of own) {
      expect(artboard([file("design.html", line)]), line).toEqual([
        expect.objectContaining({ code: "opaque_module", file: "design.html" }),
      ]);
    }
    expect(
      artboard([file("brand.css", "@font-face { font-family: B; src: url(font.woff2); }")]),
    ).toHaveLength(1);
    // An opaque-isolation instance keeps its own, wider check (instance wording).
    for (const line of [fine[1], fine[3], fine[4]] as string[]) {
      expect(
        scan([file("index.html", line)], ["index.html"], "opaque").map((x) => x.code),
        line,
      ).toContain("opaque_module");
    }
  });
});

describe("publish warning rules", () => {
  it("blocked_host follows the CSP's sources per directive; allowed hosts pass", () => {
    const html = `<!doctype html>
      <script src="https://cdn.jsdelivr.net/npm/x@1/x.js"></script>
      <script src="https://evil.example/x.js"></script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=A">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/x@1/x.css">
      <img src="https://images.example/a.png" srcset="https://images.example/b.png 2x, ok.png 1x">`;
    const w = scan([file("index.html", html)], ["index.html", "ok.png"]);
    expect(w.map((x) => [x.code, x.host])).toEqual([
      ["blocked_host", "evil.example"],
      ["blocked_host", "cdn.jsdelivr.net"],
      ["blocked_host", "images.example"],
      ["blocked_host", "images.example"],
    ]);
    expect(w[0]?.message).toContain("cdn_allowlist");
  });

  it("insecure_url for http: references", () => {
    const w = scan([file("index.html", '<img src="http://example.com/a.png">')]);
    expect(w).toEqual([
      expect.objectContaining({
        code: "insecure_url",
        host: "example.com",
        ref: "http://example.com/a.png",
      }),
    ]);
  });

  it("resolves relative paths, queries, fragments, percent-encoding and directories", () => {
    const html = `<a href="nowhere.html">links are not loads</a>
      <img src="img/a%20b.png?v=1#x"><img src="./img/../img/c.png"><iframe src="sub/"></iframe>
      <script src="data:text/javascript,1"></script><img src="#frag"><img src="../../up.png">
      <meta http-equiv="refresh" content="0; url=gone.html">
      <base href="https://elsewhere.example/">
      <div style="background:url('bg.png')"></div>
      <video poster="poster.jpg"></video>`;
    const w = scan(
      [file("pages/index.html", html)],
      [
        "pages/index.html",
        "pages/img/a b.png",
        "pages/img/c.png",
        "pages/sub/index.html",
        "pages/bg.png",
      ],
    );
    expect(w.map((x) => [x.code, x.ref])).toEqual([
      ["missing_file", "../../up.png"],
      ["missing_file", "gone.html"],
      ["blocked_host", "https://elsewhere.example/"],
      ["missing_file", "poster.jpg"],
    ]);
  });

  it("reads CSS url(), @import and @font-face, and JS imports, exports and new URL()", () => {
    const css = `@import "theme.css"; @import url(missing.css);
      @font-face { font-family: X; src: url(fonts/x.woff2) format("woff2"); }
      .a { background: url("img/a.png") } /* url(commented.png) */`;
    const js = `import a from "./a.js"; import "./side.js"; export { b } from "./b.js";
      export * from "../escape.js"; import x from "react";
      const u = new URL("./data.json", import.meta.url); const s = "import('./not-code.js')";
      // import "./commented.js"
      const m = await import("./chunk.js"); const re = /"import('x')"/;`;
    const w = scan(
      [file("style.css", css), file("js/main.js", js)],
      ["style.css", "theme.css", "fonts/x.woff2", "img/a.png", "js/main.js", "js/a.js", "js/b.js"],
    );
    expect(w.map((x) => [x.code, x.file, x.ref])).toEqual([
      ["missing_file", "style.css", "missing.css"],
      ["missing_file", "js/main.js", "./side.js"],
      ["missing_file", "js/main.js", "../escape.js"],
      ["missing_file", "js/main.js", "./data.json"],
      ["missing_file", "js/main.js", "./chunk.js"],
    ]);
  });

  it("not_scanned for small chunks past the total budget says no action is needed", () => {
    // A big build: 200 chunks of 60 KB, each far under the per-file cap, past 8 MB in all.
    const chunks = Array.from({ length: 200 }, (_, i) =>
      file(`assets/c${i}.js`, `export const c${i} = "${"y".repeat(60 * 1024)}";`),
    );
    const w = scan(chunks);
    expect(w).toHaveLength(1);
    const [n] = w;
    expect(n?.code).toBe("not_scanned");
    expect(n?.message).not.toMatch(/too large/);
    expect(n?.message).toMatch(/were not checked for references/);
    expect(n?.message).toMatch(/8 MB per publish\. No action needed$/);
  });

  it("not_scanned past the per-file budget; a clean file gives []", () => {
    const big = file("big.js", `/*${"x".repeat(LIMITS.maxScanFileBytes)}*/`);
    const w = scan([big, file("ok.css", "a{color:red}")]);
    expect(w).toEqual([expect.objectContaining({ code: "not_scanned", file: "big.js", count: 1 })]);
    expect(scan([file("ok.css", "a{color:red}")])).toEqual([]);
  });

  it("returns at most 50 warnings, then 'and N more'", () => {
    const html = Array.from({ length: 80 }, (_, i) => `<img src="m${i}.png">`).join("");
    const w = scan([file("index.html", html)]);
    expect(w).toHaveLength(LIMITS.maxWarnings);
    expect(w.at(-1)).toMatchObject({ code: "missing_file", count: 31, message: "and 31 more" });
  });

  it("echoes caller text truncated to 200 characters with control characters escaped", () => {
    expect(echo(`a\u0000b\u001bc\u007f`)).toBe("a\\u0000b\\u001bc\\u007f");
    const long = `${"z".repeat(300)}.png`;
    const w = scan([file("index.html", `<img src="${long}">`)]);
    expect(w[0]?.ref?.length).toBe(201);
    expect(w[0]?.ref?.endsWith("…")).toBe(true);
  });

  it("finishes a pathological 2 MB input within a time budget", () => {
    const size = LIMITS.maxScanFileBytes - 16;
    const inputs = [
      file("a.html", "<a <b <c=".repeat(size / 9)),
      file("b.html", `<img src="${"x".repeat(size - 20)}`),
      file("c.css", "url(url(@import @font-face{".repeat(size / 27)),
      file("d.js", "import import( new URL( / ` ${ ".repeat(size / 31)),
      file("e.js", "'".repeat(size)),
      file("f.html", "<!--".repeat(size / 4)),
    ];
    const t0 = Date.now();
    for (const f of inputs) scan([f]);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("publish results carry warnings", () => {
  it("a clean publish returns []; a broken one lists its warnings; they never block", async () => {
    const a = await agent();
    const clean = await publish(a.auth, {
      html: '<!doctype html><link rel="stylesheet" href="style.css"><img src="img/a.png">',
      assets: [
        { path: "style.css", content: "body{background:url(img/a.png)}" },
        { path: "img/a.png", content: "iVBORw0KGgo=", encoding: "base64" },
      ],
    });
    expect(clean.res.status).toBe(201);
    expect(clean.body.warnings).toEqual([]);
    const broken = await publish(a.auth, {
      html: '<!doctype html><script src="/assets/app.js"></script><img src="missing.png">',
    });
    expect(broken.res.status).toBe(201);
    expect(broken.body.warnings.map((w: PublishWarning) => w.code).sort()).toEqual([
      "missing_file",
      "root_absolute",
    ]);
  });

  it("opaque_module appears only on an opaque-isolation instance", async () => {
    const a = await agent();
    const body = JSON.stringify({
      title: "m",
      html: '<!doctype html><script type="module" src="app.js"></script>',
      assets: [{ path: "app.js", content: "console.log(1)" }],
    });
    const req = (vars: Record<string, string>) =>
      fetchWith(vars, "/api/v1/artifacts", {
        method: "POST",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body,
      });
    const origin = await json(await req({}));
    expect(origin.warnings).toEqual([]);
    const opaque = await json(await req({ CONTENT_ISOLATION: "opaque" }));
    expect(opaque.warnings).toEqual([
      expect.objectContaining({ code: "opaque_module", file: "index.html" }),
    ]);
  });
});

describe("sensitive_file (names of the files a request sent)", () => {
  const sentScan = (
    sent: string[],
    files: FileEntry[] = [],
    isolation: "origin" | "opaque" = "origin",
  ) =>
    scanPublish({
      files,
      manifestPaths: new Set([...files.map((f) => f.path), ...sent]),
      sources,
      isolation,
      sent,
    });

  it.each([
    ".env",
    "config/.env.production",
    "keys/server.pem",
    ".ssh/id_ed25519",
    "x/.git/config",
    "credentials.json",
    "deploy/service-account-prod.json",
    ".dev.vars",
    "files/id_rsa",
    "infra/terraform.tfstate",
    "files/.aws/credentials",
    ".plinth-files.json",
    "files/.plinth-files.json",
    ".ENV",
    "Server.PEM",
    ".PLINTH-FILES.JSON",
  ])("%s is sensitive", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    ".env.example",
    "env.js",
    "files/keyboard.png",
    "monkey.js",
    ".well-known/security.txt",
    "README.md",
    // Only the last segment's final extension counts.
    "public.key.md",
  ])("%s is not sensitive", (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it("the project files record has one spelling, and the rules list it", () => {
    expect(PROJECT_FILES_RECORD).toBe(".plinth-files.json");
    expect(SENSITIVE_PATH_RULES).toContainEqual({ kind: "name", value: PROJECT_FILES_RECORD });
  });

  it("the record gets its own message; a key gets the rotate message", () => {
    const w = sentScan(["files/.plinth-files.json", "keys/a.pem"]);
    expect(w.map((x) => [x.code, x.file])).toEqual([
      ["sensitive_file", "files/.plinth-files.json"],
      ["sensitive_file", "keys/a.pem"],
    ]);
    expect(w[0]?.message).toMatch(/unlisted/);
    expect(w[0]?.message).toMatch(/cannot be changed/);
    expect(w[1]?.message).toMatch(/rotate the secret/);
    expect(w[1]?.message).not.toMatch(/unlisted/);
  });

  it("flags only sent paths that match, under both isolations", () => {
    for (const isolation of ["origin", "opaque"] as const) {
      const w = sentScan(
        ["files/.env", "index.html"],
        [file("index.html", "<!doctype html><p>x</p>")],
        isolation,
      );
      expect(w).toEqual([expect.objectContaining({ code: "sensitive_file", file: "files/.env" })]);
    }
  });

  it("echoes the path truncated and with control characters escaped", () => {
    const [w] = sentScan([`${"d".repeat(300)}/id_rsa`]);
    expect(w?.file.length).toBe(201);
    expect(w?.file.endsWith("…")).toBe(true);
    const [c] = sentScan(["a\u0001b/.env"]);
    expect(c?.file).toBe("a\\u0001b/.env");
  });

  it("comes first, so the cap never folds it into the overflow", () => {
    const max = LIMITS.maxWarnings;
    const html = Array.from({ length: 60 }, (_, i) => `<img src="missing${i}.png">`).join("");
    const w = sentScan(["files/id_rsa"], [file("index.html", html)]);
    expect(w).toHaveLength(max);
    expect(w[0]).toMatchObject({ code: "sensitive_file", file: "files/id_rsa" });
    const middle = w.slice(1, max - 1);
    expect(middle).toHaveLength(max - 2);
    expect(middle.every((x) => x.code === "missing_file")).toBe(true);
    // 61 warnings before the cap: 1 sensitive_file and 60 missing_file.
    const overflow = w[max - 1];
    expect(overflow).toMatchObject({ code: "missing_file", count: 61 - (max - 1) });
    expect(overflow?.count).toBe(12);
    expect((overflow?.count ?? 0) + (max - 1)).toBe(61);
  });

  it("many sensitive paths are capped like any warning", () => {
    const max = LIMITS.maxWarnings;
    const sent = Array.from({ length: 60 }, (_, i) => `keys/k${i}.pem`);
    const w = sentScan(sent);
    expect(w).toHaveLength(max);
    expect(w.slice(0, max - 1).every((x) => x.code === "sensitive_file" && !x.count)).toBe(true);
    expect(w[max - 1]).toMatchObject({ code: "sensitive_file", count: 60 - (max - 1) });
    expect(w[max - 1]?.count).toBe(11);
  });
});

describe("project files shown as data (files/ with .txt added)", () => {
  // A code tour: the project's app.js imports a file the user never chose, and a vendored page
  // loads a stylesheet that is not in the version and a script from another host. The server
  // checks and serves files/ like any path; the recipe (PROJECT_FILES_NOTE, the skill) adds .txt,
  // so these files are neither checked as page code nor run as documents on the artifact's origin.
  const APP_JS = 'import { x } from "./util.js";\nconsole.log(x);\n';
  const PAGE_HTML =
    '<!doctype html><link rel="stylesheet" href="./style.css">' +
    '<script src="https://evil.example/x.js"></script>';
  const TOUR = "<!doctype html><title>Tour</title><pre>tour</pre>";

  const served = async (id: string, path: string) => {
    const { cookie } = await enterContent(id);
    return call(`${contentOrigin(id)}/${path}`, { headers: { Cookie: cookie ?? "" } });
  };

  it("at their own extensions they are checked and served as page code", async () => {
    const a = await agent();
    const raw = await publish(a.auth, {
      html: TOUR,
      assets: [
        { path: "files/src/app.js", content: APP_JS },
        { path: "files/src/page.html", content: PAGE_HTML },
      ],
    });
    expect(raw.res.status).toBe(201);
    const codes = raw.body.warnings.map((w: PublishWarning) => `${w.code} ${w.file}`).sort();
    expect(codes).toEqual([
      "blocked_host files/src/page.html",
      "missing_file files/src/app.js",
      "missing_file files/src/page.html",
    ]);
    const page = await served(raw.body.id, "files/src/page.html");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("with .txt added they give no reference warnings and are served as text/plain", async () => {
    const a = await agent();
    const txt = await publish(a.auth, {
      html: TOUR,
      assets: [
        { path: "files/src/app.js.txt", content: APP_JS },
        { path: "files/src/page.html.txt", content: PAGE_HTML },
      ],
    });
    expect(txt.res.status).toBe(201);
    expect(txt.body.warnings).toEqual([]);
    for (const [path, text] of [
      ["files/src/app.js.txt", APP_JS],
      ["files/src/page.html.txt", PAGE_HTML],
    ] as const) {
      const res = await served(txt.body.id, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(await res.text(), path).toBe(text);
    }
  });
});
