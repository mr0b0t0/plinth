import { describe, expect, it } from "vitest";
import { agent, call, contentOrigin, enterContent, json, publish } from "./helpers.ts";

describe("content host basics", () => {
  it("unlisted: gate issues a one-time token, exchange sets a host-only cookie, content has a CSP", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, {
      html: "<!doctype html><link rel=stylesheet href=style.css><h1>Hi</h1>",
      assets: [{ path: "style.css", content: "h1{}" }],
    });
    const { gate, cookie, enter } = await enterContent(p.slug);
    expect(gate.status).toBe("ok");
    expect(gate.enter_url.startsWith(`${contentOrigin(p.id)}/__plinth/enter?t=`)).toBe(true);
    expect(enter?.status).toBe(302);
    const setCookie = enter?.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).not.toMatch(/Domain=/i);
    const page = await call(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie ?? "" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Hi</h1>");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const css = await call(`${contentOrigin(p.id)}/style.css`, {
      headers: { Cookie: cookie ?? "" },
    });
    expect(css.headers.get("content-type")).toContain("text/css");
    // The one-time token cannot be replayed.
    expect((await call(gate.enter_url)).status).toBe(403);
  });

  it("without the cookie, the content host redirects to the app gate", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const res = await call(`${contentOrigin(p.id)}/`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://app.localhost:8787/open/${p.id}?next=%2F`);
  });

  it("a viewer token for artifact A is rejected on artifact B", async () => {
    const a = await agent();
    const { body: pa } = await publish(a.auth);
    const { body: pb } = await publish(a.auth);
    const gate = await json(await call(`/api/v1/view/${pa.id}`));
    const token = new URL(gate.enter_url).searchParams.get("t") ?? "";
    const onB = await call(`${contentOrigin(pb.id)}/__plinth/enter?t=${encodeURIComponent(token)}`);
    expect(onB.status).toBe(403);
    const { cookie } = await enterContent(pa.id);
    const crossCookie = await call(`${contentOrigin(pb.id)}/`, {
      headers: { Cookie: cookie ?? "" },
    });
    expect(crossCookie.status).toBe(302);
  });

  it("password: gate asks, wrong password refused, right one opens", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { visibility: "password", password: "open sesame" });
    const gate = await json(await call(`/api/v1/view/${p.slug}`));
    expect(gate.status).toBe("password_required");
    const csrf = {
      Cookie: "__Host-plinth_csrf=abc",
      "x-plinth-csrf": "abc",
      "Content-Type": "application/json",
    };
    const wrong = await call(`/api/v1/view/${p.slug}/password`, {
      method: "POST",
      headers: csrf,
      body: JSON.stringify({ password: "nope" }),
    });
    expect(wrong.status).toBe(403);
    const right = await call(`/api/v1/view/${p.slug}/password`, {
      method: "POST",
      headers: csrf,
      body: JSON.stringify({ password: "open sesame" }),
    });
    expect(right.status).toBe(200);
    expect((await json(right)).status).toBe("ok");
    const pass = (right.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(pass.startsWith(`__Host-plinth_pw_${p.id}=`)).toBe(true);
    const again = await json(await call(`/api/v1/view/${p.slug}`, { headers: { Cookie: pass } }));
    expect(again.status).toBe("ok");
  });

  it("changing visibility ends existing content cookies", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { cookie } = await enterContent(p.id);
    expect(
      (await call(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie ?? "" } })).status,
    ).toBe(200);
    await call(`/api/v1/artifacts/${p.id}/visibility`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "password", password: "secret1" }),
    });
    expect(
      (await call(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie ?? "" } })).status,
    ).toBe(302);
  });

  it("version paths serve old versions", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: "<p>one</p>" });
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>two</p>" }),
    });
    const { cookie } = await enterContent(p.id);
    const v1 = await call(`${contentOrigin(p.id)}/__plinth/v/1/`, {
      headers: { Cookie: cookie ?? "" },
    });
    expect(await v1.text()).toBe("<p>one</p>");
    const cur = await call(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie ?? "" } });
    expect(await cur.text()).toBe("<p>two</p>");
    expect(
      (await call(`${contentOrigin(p.id)}/__plinth/v/9/`, { headers: { Cookie: cookie ?? "" } }))
        .status,
    ).toBe(404);
  });

  it("the bare content host and unknown hosts serve nothing", async () => {
    expect((await call("http://content.localhost:8787/")).status).toBe(404);
    expect((await call("http://evil.localhost:8787/")).status).toBe(404);
    expect((await call("http://not-an-id.content.localhost:8787/")).status).toBe(404);
  });
});
