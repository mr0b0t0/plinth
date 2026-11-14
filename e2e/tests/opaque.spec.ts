// Opaque content isolation (CONTENT_ISOLATION=opaque), against the second e2e Worker. Staging,
// and any instance whose content host shares a registrable domain with the app, runs like this:
// every artifact document gets an opaque origin from the CSP sandbox, so it has no cookies and no storage, and
// cannot set cookies on the shared parent domain. Checked here: the artifact and its own
// subresources still load (the host-only, partitioned content cookie reaches them), cookies and
// storage throw inside it, and the editor preview and comment pins work over the opaque-origin
// postMessage protocol (origin "null", identified by window and nonce).
import { expect, type Page, type Request, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, OPAQUE_CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";

// The frame being shown. A reload keeps the outgoing frame (marked) until the new one loads.
const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const OPAQUE_FRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Opaque</title><link rel="stylesheet" href="style.css"></head>
<body>
<h1>Opaque artifact</h1>
<p id="probe">probing</p>
<img id="pic" src="pic.svg" alt="A square" width="10" height="10">
<script src="app.js"></script>
<script>
  var r = { origin: self.origin };
  function attempt(name, fn) {
    try { fn(); r[name] = "allowed"; } catch (e) { r[name] = e && e.name ? e.name : String(e); }
  }
  attempt("cookie", function () { return document.cookie; });
  attempt("setCookie", function () { document.cookie = "tossed=1; Domain=localhost; Path=/"; });
  attempt("localStorage", function () { return window.localStorage.length; });
  attempt("sessionStorage", function () { return window.sessionStorage.length; });
  attempt("indexedDB", function () { return window.indexedDB.open("x"); });
  document.getElementById("probe").textContent = JSON.stringify(r);
</script>
</body>
</html>
`;

const ASSETS = [
  { path: "style.css", content: "h1 { color: rgb(1, 2, 3); }" },
  { path: "app.js", content: "document.documentElement.setAttribute('data-app', 'ran');" },
  {
    path: "pic.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    content_type: "image/svg+xml",
  },
];

interface Published {
  id: string;
  slug: string;
}

async function publish(token: string, title: string): Promise<Published> {
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, html: HTML, assets: ASSETS }),
  });
  const body = (await res.json()) as Published;
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body;
}

/** A signed-in owner with one published artifact on the opaque Worker. */
async function owner(page: Page, title: string) {
  const email = uniqueEmail("opaque");
  const { token } = await seedToken(email, {
    label: "Opaque agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  return publish(token, title);
}

const onContentHost = (r: Request) => new URL(r.url()).host.endsWith(`.${OPAQUE_CONTENT_HOST}`);

/** CSP violations and page errors in the page and its frames. */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to|ERR_BLOCKED/i.test(msg.text()))
      problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test("the instance reports opaque isolation", async ({ request }) => {
  const res = await request.get(`${OPAQUE_APP_ORIGIN}/api/v1/config`);
  expect(await res.json()).toMatchObject({
    content_isolation: "opaque",
    content_path_fallback: false,
  });
});

test("an artifact renders with its own subresources, and has no cookies or storage", async ({
  page,
}) => {
  const problems = watchConsole(page);
  const art = await owner(page, "Opaque artifact");
  const sub: { url: string; cookie: string; status: number }[] = [];
  page.on("requestfinished", async (r) => {
    if (!onContentHost(r) || r.resourceType() === "document") return;
    const res = await r.response();
    sub.push({
      url: new URL(r.url()).pathname,
      cookie: (await r.allHeaders()).cookie ?? "",
      status: res?.status() ?? 0,
    });
  });
  const documents: { url: string; csp: string }[] = [];
  page.on("response", (res) => {
    if (onContentHost(res.request()) && res.request().resourceType() === "document")
      documents.push({ url: res.url(), csp: res.headers()["content-security-policy"] ?? "" });
  });

  await page.goto(`/a/${art.slug}`);
  const iframe = page.locator(CURRENT_FRAME);
  // Both layers agree: the frame attribute and the response CSP drop allow-same-origin.
  await expect(iframe).toHaveAttribute("sandbox", OPAQUE_FRAME_SANDBOX);
  const frame = page.frameLocator(CURRENT_FRAME);
  await expect(frame.locator("h1")).toHaveText("Opaque artifact", { timeout: 15_000 });

  // Its own CSS, script and image loaded.
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
  await expect(frame.locator("html")).toHaveAttribute("data-app", "ran");
  await expect
    .poll(() => frame.locator("#pic").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(10);

  // An opaque origin: no cookie, no storage, from the artifact's point of view.
  const probe = JSON.parse((await frame.locator("#probe").textContent()) ?? "{}");
  expect(probe).toEqual({
    origin: "null",
    cookie: "SecurityError",
    setCookie: "SecurityError",
    localStorage: "SecurityError",
    sessionStorage: "SecurityError",
    indexedDB: "SecurityError",
  });

  // The host-only, partitioned content cookie reached every subresource request the
  // opaque-origin document made.
  await expect
    .poll(() => sub.map((s) => s.url).sort())
    .toEqual(["/app.js", "/pic.svg", "/style.css"]);
  for (const s of sub) {
    expect(s.status, s.url).toBe(200);
    expect(s.cookie, s.url).toContain("plinth_content=");
  }
  // Every artifact document carries the sandbox directive, without allow-same-origin.
  const artifactDoc = documents.find((d) => new URL(d.url).pathname === "/");
  expect(artifactDoc?.csp).toMatch(/; sandbox allow-scripts /);
  expect(artifactDoc?.csp).not.toContain("allow-same-origin");
  // Nothing set a cookie for the artifact, and the app's cookies stayed on the app host. The
  // only cookie on the artifact's host is its own host-only content cookie.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "tossed")).toBeUndefined();
  for (const c of cookies.filter((c) => c.name.startsWith("__Host-"))) {
    if (c.name === "__Host-plinth_content")
      expect(c.domain).toMatch(/^[a-z0-9]{20}\.content\.localhost$/);
    else expect(c.domain).toBe("app.localhost");
  }
  expect(problems).toEqual([]);
});

test("a direct visit to the artifact still goes to the app page", async ({ page }) => {
  const art = await owner(page, "Direct visit");
  await page.goto(`http://${art.id}.${OPAQUE_CONTENT_HOST}/`);
  await expect(page).toHaveURL(`${OPAQUE_APP_ORIGIN}/a/${art.id}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toHaveText("Opaque artifact", {
    timeout: 15_000,
  });
});

const TYPED_START =
  '<!doctype html><html lang="en"><head><title>Doc</title><link rel="stylesheet" href="style.css"></head><body><h1>';
const TYPED_END = "</h1></body></html>";

async function typeDraft(page: Page, heading: string) {
  await page.locator(".pl-editor .monaco-editor .view-lines").first().click();
  const mac = await page.evaluate(() => /Macintosh/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+A" : "Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(TYPED_START);
  await page.keyboard.type(heading);
  await page.keyboard.insertText(TYPED_END);
}

test("the editor's live preview works with an opaque-origin loader", async ({ page }) => {
  test.setTimeout(60_000);
  const problems = watchConsole(page);
  const art = await owner(page, "Opaque editor");
  await page.goto(`/a/${art.slug}/edit`);
  await expect(page.locator(".pl-editor .monaco-editor .view-lines").first()).toBeVisible({
    timeout: 15_000,
  });
  const frame = page.locator('iframe[title^="Preview of"]');
  await expect(frame).toHaveAttribute("sandbox", OPAQUE_FRAME_SANDBOX);
  const preview = page.frameLocator('iframe[title^="Preview of"]');
  await expect(preview.locator("h1")).toHaveText("Opaque artifact", { timeout: 15_000 });
  // The draft's relative assets load with the content cookie, as on the published page.
  await expect(preview.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
  expect(await preview.locator("#probe").textContent()).toContain('"origin":"null"');

  await typeDraft(page, "Typed under opaque isolation");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(preview.locator("h1")).toHaveText("Typed under opaque isolation");
  await expect(preview.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");

  // Twice more: every render is a fresh frame with a fresh nonce.
  await typeDraft(page, "Second render");
  await expect(preview.locator("h1")).toHaveText("Second render");
  await expect(page.locator('iframe[title^="Preview of"]')).toHaveCount(1);
  expect(problems).toEqual([]);
});

test("comment pins work through the bridge with an opaque-origin frame", async ({ page }) => {
  test.setTimeout(60_000);
  const art = await owner(page, "Opaque comments");
  await page.goto(`/a/${art.slug}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const panel = page.getByRole("region", { name: "Comments" });
  await expect(panel).toBeVisible();
  const frame = page.frameLocator(CURRENT_FRAME);
  await expect(frame.locator("h1")).toBeVisible({ timeout: 15_000 });
  // Review mode: the bridge script is in the opaque-origin document.
  await expect(frame.locator("script[data-plinth-bridge]")).toHaveCount(1);
  await expect(page.locator(CURRENT_FRAME)).toHaveAttribute("sandbox", OPAQUE_FRAME_SANDBOX);

  await panel.getByRole("button", { name: "Pin to an element" }).click();
  await expect(panel.getByText("Click an element in the artifact (Esc to cancel)")).toBeVisible();
  await frame.locator("h1").click();
  await expect(panel.getByText("Pinned to")).toBeVisible();
  await expect(panel.getByText("Opaque artifact").first()).toBeVisible();

  await panel.getByRole("textbox", { name: "New comment" }).fill("Pinned in opaque mode");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel.locator("article").filter({ hasText: "Pinned in opaque mode" })).toBeVisible();
  // The frame reported the element's position: the pin is on the frame.
  const pin = page.getByTestId("comment-pins").getByRole("button", { name: /^Comment 1/ });
  await expect(pin).toBeVisible();
});
