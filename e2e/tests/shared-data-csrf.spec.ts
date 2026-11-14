// Cross-artifact request forgery against the shared-data API. Every artifact framed by the app
// shares one partitioned cookie jar, and the content cookie is SameSite=None, so another
// artifact's script is the attacker that matters. Artifact B (another user's) opens in the same
// browser that holds A's content cookie and tries A's API with fetch (with and without the
// x-plinth-data header, credentials included), a form POST and sendBeacon. Then the same requests
// go straight to the server with A's real cookie, past the browser's CSP, to check the server's
// own refusals. A's data must be unchanged.
import { expect, test } from "@playwright/test";
import { contentOrigin, newApiContext, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { CURRENT_FRAME, POLL_HTML, pollFrame } from "../support/poll.ts";
import { seedToken } from "../support/tokens.ts";

/** B's page: every way a page can send a request to A's API, results written to #out. */
const attackerHtml = (target: string, collection: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Innocent page</title></head>
<body>
<h1>Innocent page</h1>
<pre id="out">running</pre>
<iframe name="sink" title="sink" hidden></iframe>
<form id="form" method="POST" action="${collection}" target="sink" enctype="text/plain">
  <input type="hidden" name='{"data":{"choice":"ramen"},"pad":"' value='"}'>
</form>
<script>
const r = { violations: [] };
document.addEventListener("securitypolicyviolation", (e) => r.violations.push(e.effectiveDirective));
const body = JSON.stringify({ data: { choice: "ramen" } });
async function attempt(name, url, init) {
  try {
    const res = await fetch(url, init);
    r[name] = "status:" + res.status + ":" + res.type;
  } catch (e) {
    r[name] = "error:" + e.name;
  }
}
(async () => {
  await attempt("put_without_header", ${JSON.stringify(target)}, {
    method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body,
  });
  await attempt("put_with_header", ${JSON.stringify(target)}, {
    method: "PUT", credentials: "include",
    headers: { "content-type": "application/json", "x-plinth-data": "1" }, body,
  });
  await attempt("delete_with_header", ${JSON.stringify(target)}, {
    method: "DELETE", credentials: "include", headers: { "x-plinth-data": "1" },
  });
  await attempt("post_no_cors", ${JSON.stringify(collection)}, {
    method: "POST", mode: "no-cors", credentials: "include",
    headers: { "content-type": "text/plain" }, body,
  });
  await attempt("get_with_header", ${JSON.stringify(target)}, {
    credentials: "include", headers: { "x-plinth-data": "1" },
  });
  try {
    r.beacon = String(navigator.sendBeacon(${JSON.stringify(collection)}, new Blob([body], { type: "text/plain" })));
  } catch (e) {
    r.beacon = "error:" + e.name;
  }
  try {
    document.getElementById("form").submit();
    r.form = "submitted";
  } catch (e) {
    r.form = "error:" + e.name;
  }
  await new Promise((done) => setTimeout(done, 1500));
  document.getElementById("out").textContent = JSON.stringify(r);
  document.body.dataset.done = "1";
})();
</script>
</body></html>
`;

test("another artifact cannot read or change an artifact's shared data", async ({ page }) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("csrf-owner");
  const { token } = await seedToken(owner, { label: "Owner agent", clientType: "claude" });
  const client = await mcpClient(token);
  try {
    // A: the owner's poll, with one vote written by the agent.
    const pub = await tool<{ id: string; slug: string; url: string }>(client, "publish_artifact", {
      title: "Poll under attack",
      html: POLL_HTML,
    });
    expect(pub.isError, pub.text).toBe(false);
    const a = pub.data;
    const seeded = await tool<{ results: { ok: boolean }[] }>(client, "write_artifact_data", {
      id: a.id,
      ops: [{ op: "set", collection: "votes", doc_id: "x", data: { choice: "tacos" }, if_rev: 0 }],
    });
    expect(seeded.data.results[0]?.ok, seeded.text).toBe(true);
    const unchanged = async () => {
      const r = await tool<{ docs: { id: string; rev: number; data: unknown }[] }>(
        client,
        "list_artifact_data",
        { id: a.id, collection: "votes" },
      );
      expect(r.isError, r.text).toBe(false);
      expect(r.data.docs.map((d) => ({ id: d.id, rev: d.rev, data: d.data }))).toEqual([
        { id: "x", rev: 1, data: { choice: "tacos" } },
      ]);
    };

    // The owner opens A, so this browser holds A's content cookie and could write with it.
    await seedSession(page.context(), owner);
    await page.goto(a.url);
    const frameA = await pollFrame(page);
    expect(await frameA.evaluate(() => (window as any).plinth.canWrite)).toBe(true);
    await expect(page.frameLocator(CURRENT_FRAME).locator("#total")).toHaveText("1");

    // B: another user's unlisted artifact, opened in the same browser.
    const origin = contentOrigin(a.id);
    const target = `${origin}/__plinth/api/v1/data/votes/x`;
    const collection = `${origin}/__plinth/api/v1/data/votes`;
    const { token: other } = await seedToken(uniqueEmail("csrf-attacker"));
    const b = await publishArtifact(page.request, other, {
      title: "Innocent page",
      html: attackerHtml(target, collection),
    });
    const toA: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith(`${origin}/__plinth/api/`)) toA.push(`${r.method()} ${r.url()}`);
    });
    await page.goto(b.url);
    const out = page.frameLocator(CURRENT_FRAME).locator("body[data-done] #out");
    await expect(out).not.toHaveText("running", { timeout: 15_000 });
    const r = JSON.parse((await out.textContent()) ?? "{}") as Record<string, unknown>;
    for (const k of [
      "put_without_header",
      "put_with_header",
      "delete_with_header",
      "post_no_cors",
      "get_with_header",
    ]) {
      expect(r[k], k).toMatch(/^error:/);
    }
    expect(r.violations).toEqual(expect.arrayContaining(["connect-src"]));
    expect(toA).toEqual([]);
    await unchanged();

    // The server refuses the same requests on its own, with A's valid cookie.
    const cookies = await page.context().cookies(origin);
    // __Host- on an artifact's own subdomain: a sibling cannot toss one onto the parent domain.
    const pass = cookies.find((c) => c.name === "__Host-plinth_content");
    expect(pass, "the browser holds A's content cookie").toBeTruthy();
    const direct = await newApiContext();
    try {
      const cookie = `__Host-plinth_content=${pass?.value}`;
      const json = JSON.stringify({ data: { choice: "ramen" } });
      const send = (method: string, url: string, headers: Record<string, string>, data?: string) =>
        direct.fetch(url, { method, headers: { cookie, ...headers }, data, maxRedirects: 0 });

      // The cookie works for A's own page: same origin, header, no fetch metadata.
      const own = await send("GET", `${origin}/__plinth/api/v1/session`, {
        "x-plinth-data": "1",
        origin,
      });
      expect(own.status()).toBe(200);
      expect(await own.json()).toMatchObject({ available: true, can_write: true });

      const bOrigin = contentOrigin(b.id);
      const refused = [
        ["PUT", target, { "content-type": "application/json" }, json], // no header
        [
          "PUT",
          target,
          { "content-type": "application/json", "x-plinth-data": "1", origin: bOrigin },
          json,
        ],
        [
          "PUT",
          target,
          { "content-type": "application/json", "x-plinth-data": "1", origin: "null" },
          json,
        ],
        [
          "PUT",
          target,
          {
            "content-type": "application/json",
            "x-plinth-data": "1",
            "sec-fetch-site": "same-site",
          },
          json,
        ],
        [
          "POST",
          collection,
          {
            "content-type": "text/plain",
            "x-plinth-data": "1",
            "sec-fetch-site": "same-site",
            "sec-fetch-mode": "no-cors",
          },
          json,
        ],
        ["POST", collection, { "content-type": "text/plain" }, json], // form and beacon shape
        ["DELETE", target, { "x-plinth-data": "1", "sec-fetch-site": "cross-site" }],
        ["GET", target, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }],
      ] as const;
      for (const [method, url, headers, data] of refused) {
        const res = await send(method, url, headers, data);
        expect(res.status(), `${method} ${JSON.stringify(headers)}`).toBe(403);
        expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
      }
      // A preflight never succeeds, so no browser sends the custom header cross-origin.
      const preflight = await send("OPTIONS", target, {
        origin: bOrigin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "x-plinth-data,content-type",
      });
      expect(preflight.status()).toBe(405);
      expect(
        Object.keys(preflight.headers()).filter((h) => h.startsWith("access-control-")),
      ).toEqual([]);
    } finally {
      await direct.dispose();
    }
    await unchanged();
  } finally {
    await client.close();
  }
});
