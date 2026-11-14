// Creates the Cloudflare side of a local instance: one locally managed tunnel and the proxied
// CNAMEs for the app host, the content apex and its wildcard. Uses the REST API with a setup-time
// API token, so one token covers both zones (a `cloudflared tunnel login` certificate covers one).
// Node-free (fetch is injected) so the Workers test pool can test it. Every read happens before the
// first write, so a refusal leaves the account unchanged. Error messages never include the token.
import { credentialsJson, dnsRecordNames } from "./tunnel-lib.mjs";

const API = "https://api.cloudflare.com/client/v4";
export const REQUIRED_PERMISSIONS =
  "Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone · Read";

export class CloudflareError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

/**
 * A minimal Cloudflare API client: `call(method, path, body)` returns `result` or throws
 * CloudflareError. `permissions` names what the token needs, for 401 and 403 errors. Also used by
 * deploy-lib.mjs for the content wildcard record of `plinth deploy`.
 */
export function cloudflareApi(token, fetchFn, permissions = REQUIRED_PERMISSIONS) {
  return async (method, path, body) => {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Not JSON: handled below.
    }
    if (!res.ok || !json?.success) {
      const detail =
        (json?.errors ?? []).map((e) => `${e.message} (${e.code})`).join("; ") ||
        `HTTP ${res.status}`;
      const auth = res.status === 401 || res.status === 403;
      throw new CloudflareError(
        `Cloudflare API ${method} ${path.split("?")[0]} failed: ${detail}` +
          (auth ? `. The API token needs: ${permissions}, on both zones` : ""),
        res.status,
      );
    }
    return json.result;
  };
}

/** Provision (or confirm) the tunnel and DNS records. See tunnel-cloudflare.d.mts. */
export async function provision(a) {
  const call = cloudflareApi(a.token, a.fetch);
  const q = encodeURIComponent;

  // Reads.
  const zoneIds = {};
  let accountId = null;
  for (const zone of [...new Set([a.appZone, a.contentZone])]) {
    const found = await call("GET", `/zones?name=${q(zone)}`);
    if (!found?.length)
      throw new CloudflareError(
        `${zone} is not on this Cloudflare account (or the API token cannot read it)`,
      );
    zoneIds[zone] = found[0].id;
    if (accountId && accountId !== found[0].account.id)
      throw new CloudflareError(
        `${a.appZone} and ${a.contentZone} must be in the same Cloudflare account as the tunnel`,
      );
    accountId = found[0].account.id;
  }

  const tunnels = await call(
    "GET",
    `/accounts/${accountId}/cfd_tunnel?name=${q(a.tunnelName)}&is_deleted=false`,
  );
  const existing = tunnels?.[0] ?? null;
  if (existing && !a.hasCredentials && !a.replaceTunnel)
    throw new CloudflareError(
      `Tunnel ${a.tunnelName} exists but its credentials file is missing, and Cloudflare cannot ` +
        "show the secret again. Rerun setup with --replace-tunnel to delete it, create a new one " +
        "and repoint its DNS records",
    );
  const replacing = existing && a.replaceTunnel;
  const target = existing && !replacing ? `${existing.id}.cfargotunnel.com` : null;

  // A CNAME to <id>.cfargotunnel.com is "stale" when that tunnel is the one being replaced, or no
  // longer exists. Stale records may be repointed with --replace-tunnel; live ones never are.
  const staleCache = new Map();
  const isStale = async (record) => {
    const id = /^([0-9a-z-]+)\.cfargotunnel\.com$/.exec(record.content ?? "")?.[1];
    if (record.type !== "CNAME" || !id) return false;
    if (replacing && id === existing.id) return true;
    if (!staleCache.has(id)) {
      let gone;
      try {
        const t = await call("GET", `/accounts/${accountId}/cfd_tunnel/${id}`);
        gone = !!t?.deleted_at;
      } catch (e) {
        if (!(e instanceof CloudflareError) || e.status !== 404) throw e;
        gone = true;
      }
      staleCache.set(id, gone);
    }
    return staleCache.get(id);
  };

  const names = dnsRecordNames(a.appHost, a.contentHost);
  const zoneOf = (name) => (name === a.appHost ? zoneIds[a.appZone] : zoneIds[a.contentZone]);
  const plan = [];
  for (const name of names) {
    const records = await call("GET", `/zones/${zoneOf(name)}/dns_records?name=${q(name)}`);
    const single = records.length === 1 ? records[0] : null;
    if (records.length === 0) plan.push({ name, action: "created" });
    else if (target && single?.type === "CNAME" && single.content === target)
      plan.push({ name, action: "kept" });
    else if (single && (await isStale(single))) {
      if (!a.replaceTunnel)
        throw new CloudflareError(
          `The DNS record for ${name} points at an earlier tunnel (${single.content}) that no ` +
            "longer exists. Rerun setup with --replace-tunnel to repoint it",
        );
      plan.push({ name, action: "updated", id: single.id });
    } else
      throw new CloudflareError(
        `A DNS record for ${name} already exists and does not point at this tunnel ` +
          `(${records.map((r) => `${r.type} ${r.content}`).join(", ")}). ` +
          "Remove it in the Cloudflare dashboard, or choose another host, then rerun setup",
      );
  }

  // Writes.
  if (replacing) {
    await call("DELETE", `/accounts/${accountId}/cfd_tunnel/${existing.id}/connections`);
    await call("DELETE", `/accounts/${accountId}/cfd_tunnel/${existing.id}`);
  }
  let tunnelId = existing && !replacing ? existing.id : null;
  let credentials = null;
  if (!tunnelId) {
    const secret = a.newSecret();
    const created = await call("POST", `/accounts/${accountId}/cfd_tunnel`, {
      name: a.tunnelName,
      config_src: "local",
      tunnel_secret: secret,
    });
    tunnelId = created.id;
    credentials = credentialsJson({ accountId, tunnelId, secret });
    // Saved before any DNS write: Cloudflare never shows the secret again.
    a.onTunnelCreated(credentials);
  }
  const content = `${tunnelId}.cfargotunnel.com`;
  const records = [];
  for (const { name, action, id } of plan) {
    if (action === "created")
      await call("POST", `/zones/${zoneOf(name)}/dns_records`, {
        type: "CNAME",
        name,
        content,
        proxied: true,
      });
    else if (action === "updated")
      await call("PATCH", `/zones/${zoneOf(name)}/dns_records/${id}`, { content });
    records.push({ name, action });
  }
  return { accountId, tunnelId, credentials, records };
}
