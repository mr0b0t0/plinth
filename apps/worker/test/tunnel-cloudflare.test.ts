import { describe, expect, it } from "vitest";
import { CloudflareError, provision } from "../scripts/tunnel-cloudflare.mjs";

const TOKEN = "cf-test-token-SECRET-1234567890";

type Record = { id: string; type: string; name: string; content: string };
type State = {
  zones: { [name: string]: { id: string; account: string } };
  tunnels: { id: string; name: string }[];
  records: { [zoneId: string]: Record[] };
  failWith?: { status: number; errors: { code: number; message: string }[] };
};

/** A fake Cloudflare API over `state`. Records every call as "METHOD path?query". */
function fakeCloudflare(state: State) {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method,
      url: url.pathname + url.search,
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (state.failWith)
      return Response.json(
        { success: false, errors: state.failWith.errors, result: null },
        { status: state.failWith.status },
      );
    const p = url.pathname.replace("/client/v4", "");
    if (method === "GET" && p === "/zones") {
      const z = state.zones[url.searchParams.get("name") ?? ""];
      return ok(
        z ? [{ id: z.id, name: url.searchParams.get("name"), account: { id: z.account } }] : [],
      );
    }
    let m = /^\/accounts\/([^/]+)\/cfd_tunnel$/.exec(p);
    if (m && method === "GET")
      return ok(state.tunnels.filter((t) => t.name === url.searchParams.get("name")));
    if (m && method === "POST") {
      const t = { id: "tun-new", name: (body as { name: string }).name };
      state.tunnels.push(t);
      return ok({ id: t.id, name: t.name, account_tag: m[1] });
    }
    m = /^\/zones\/([^/]+)\/dns_records$/.exec(p);
    const zoneId = m?.[1] ?? "";
    if (m && method === "GET")
      return ok(
        (state.records[zoneId] ?? []).filter(
          (r: Record) => r.name === url.searchParams.get("name"),
        ),
      );
    if (m && method === "POST") {
      const r = { id: `r${calls.length}`, ...(body as Omit<Record, "id">) };
      const list = state.records[zoneId] ?? [];
      list.push(r);
      state.records[zoneId] = list;
      return ok(r);
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: "no route" }] },
      { status: 404 },
    );
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const zones = {
  "example.com": { id: "zapp", account: "acct1" },
  "example-content.net": { id: "zcontent", account: "acct1" },
};
const args = (fetch: typeof globalThis.fetch, hasCredentials = false) => ({
  token: TOKEN,
  fetch,
  tunnelName: "plinth-plinth",
  appHost: "plinth.example.com",
  contentHost: "example-content.net",
  appZone: "example.com",
  contentZone: "example-content.net",
  hasCredentials,
  newSecret: () => "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTMyYg==",
});
const writes = (calls: { method: string }[]) => calls.filter((c) => c.method !== "GET");

describe("tunnel-cloudflare: provision", () => {
  it("creates a locally managed tunnel and three proxied CNAMEs on a fresh account", async () => {
    const cf = fakeCloudflare({ zones, tunnels: [], records: {} });
    const r = await provision(args(cf.fetch));
    expect(r.accountId).toBe("acct1");
    expect(r.tunnelId).toBe("tun-new");
    expect(JSON.parse(r.credentials ?? "null")).toEqual({
      AccountTag: "acct1",
      TunnelID: "tun-new",
      TunnelSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTMyYg==",
    });
    const tunnelPost = cf.calls.find((c) => c.method === "POST" && c.url.includes("cfd_tunnel"));
    expect(tunnelPost?.body).toEqual({
      name: "plinth-plinth",
      config_src: "local",
      tunnel_secret: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTMyYg==",
    });
    const dnsPosts = cf.calls.filter((c) => c.method === "POST" && c.url.includes("dns_records"));
    expect(dnsPosts.map((c) => [c.url, c.body])).toEqual([
      [
        "/client/v4/zones/zapp/dns_records",
        {
          type: "CNAME",
          name: "plinth.example.com",
          content: "tun-new.cfargotunnel.com",
          proxied: true,
        },
      ],
      [
        "/client/v4/zones/zcontent/dns_records",
        {
          type: "CNAME",
          name: "example-content.net",
          content: "tun-new.cfargotunnel.com",
          proxied: true,
        },
      ],
      [
        "/client/v4/zones/zcontent/dns_records",
        {
          type: "CNAME",
          name: "*.example-content.net",
          content: "tun-new.cfargotunnel.com",
          proxied: true,
        },
      ],
    ]);
    expect(r.records).toEqual([
      { name: "plinth.example.com", action: "created" },
      { name: "example-content.net", action: "created" },
      { name: "*.example-content.net", action: "created" },
    ]);
    expect(cf.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("changes nothing on a rerun when the tunnel and records exist", async () => {
    const state: State = { zones, tunnels: [], records: {} };
    await provision(args(fakeCloudflare(state).fetch));
    const cf = fakeCloudflare(state);
    const r = await provision(args(cf.fetch, true));
    expect(writes(cf.calls)).toEqual([]);
    expect(r.tunnelId).toBe("tun-new");
    expect(r.credentials).toBeNull();
    expect(r.records.map((x) => x.action)).toEqual(["kept", "kept", "kept"]);
  });

  it("refuses when the tunnel exists but its credentials file is gone", async () => {
    const cf = fakeCloudflare({
      zones,
      tunnels: [{ id: "tun-old", name: "plinth-plinth" }],
      records: {},
    });
    const p = provision(args(cf.fetch, false));
    await expect(p).rejects.toThrow(CloudflareError);
    await expect(provision(args(cf.fetch, false))).rejects.toThrow(/credentials/);
    await expect(provision(args(cf.fetch, false))).rejects.toThrow(
      /cloudflared tunnel delete plinth-plinth/,
    );
    expect(writes(cf.calls)).toEqual([]);
  });

  it("refuses to overwrite a record that points elsewhere, before writing anything", async () => {
    const cf = fakeCloudflare({
      zones,
      tunnels: [],
      records: { zapp: [{ id: "x", type: "A", name: "plinth.example.com", content: "192.0.2.1" }] },
    });
    await expect(provision(args(cf.fetch))).rejects.toThrow(/plinth\.example\.com already exists/);
    expect(writes(cf.calls)).toEqual([]);
  });

  it("refuses zones in different accounts", async () => {
    const cf = fakeCloudflare({
      zones: { ...zones, "example-content.net": { id: "zcontent", account: "acct2" } },
      tunnels: [],
      records: {},
    });
    await expect(provision(args(cf.fetch))).rejects.toThrow(/same Cloudflare account/);
    expect(writes(cf.calls)).toEqual([]);
  });

  it("refuses a zone that is not on the account", async () => {
    const cf = fakeCloudflare({
      zones: { "example.com": zones["example.com"] },
      tunnels: [],
      records: {},
    });
    await expect(provision(args(cf.fetch))).rejects.toThrow(
      /example-content\.net is not on this Cloudflare account/,
    );
  });

  it("explains a permission error without echoing the token", async () => {
    const cf = fakeCloudflare({
      zones,
      tunnels: [],
      records: {},
      failWith: { status: 403, errors: [{ code: 10000, message: "Authentication error" }] },
    });
    const err = (await provision(args(cf.fetch)).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(CloudflareError);
    expect(err.message).toContain("Authentication error");
    expect(err.message).toContain(
      "Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone · Read",
    );
    expect(err.message).not.toContain(TOKEN);
  });
});
