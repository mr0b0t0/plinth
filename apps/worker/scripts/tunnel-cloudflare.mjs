// Creates the Cloudflare side of a local instance: one locally managed tunnel and the proxied
// CNAMEs for the app host, the content apex and its wildcard. Uses the REST API with a setup-time
// API token, so one token covers both zones (a `cloudflared tunnel login` certificate covers one).
// Node-free (fetch is injected) so the Workers test pool can test it. Every read happens before the
// first write, so a refusal leaves the account unchanged. Error messages never include the token.
import { credentialsJson, dnsRecordNames } from "./tunnel-lib.mjs";

const API = "https://api.cloudflare.com/client/v4";
export const REQUIRED_PERMISSIONS =
  "Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone · Read";

export class CloudflareError extends Error {}

function client(token, fetchFn) {
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
          (auth ? `. The API token needs: ${REQUIRED_PERMISSIONS}, on both zones` : ""),
      );
    }
    return json.result;
  };
}

/** Provision (or confirm) the tunnel and DNS records. See tunnel-cloudflare.d.mts. */
export async function provision(a) {
  const call = client(a.token, a.fetch);
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
  if (existing && !a.hasCredentials)
    throw new CloudflareError(
      `Tunnel ${a.tunnelName} exists but its credentials file is missing, and Cloudflare cannot ` +
        `show the secret again. Delete the tunnel (cloudflared tunnel delete ${a.tunnelName}, or ` +
        "in the dashboard) and rerun setup",
    );
  const target = existing ? `${existing.id}.cfargotunnel.com` : null;

  const names = dnsRecordNames(a.appHost, a.contentHost);
  const zoneOf = (name) => (name === a.appHost ? zoneIds[a.appZone] : zoneIds[a.contentZone]);
  const plan = [];
  for (const name of names) {
    const records = await call("GET", `/zones/${zoneOf(name)}/dns_records?name=${q(name)}`);
    const ours =
      target &&
      records.length === 1 &&
      records[0].type === "CNAME" &&
      records[0].content === target;
    if (records.length && !ours)
      throw new CloudflareError(
        `A DNS record for ${name} already exists and does not point at this tunnel. ` +
          "Remove it in the Cloudflare dashboard, or choose another host, then rerun setup",
      );
    plan.push({ name, create: !ours });
  }

  // Writes.
  let tunnelId = existing?.id ?? null;
  let credentials = null;
  if (!existing) {
    const secret = a.newSecret();
    const created = await call("POST", `/accounts/${accountId}/cfd_tunnel`, {
      name: a.tunnelName,
      config_src: "local",
      tunnel_secret: secret,
    });
    tunnelId = created.id;
    credentials = credentialsJson({ accountId, tunnelId, secret });
  }
  const records = [];
  for (const { name, create } of plan) {
    if (create)
      await call("POST", `/zones/${zoneOf(name)}/dns_records`, {
        type: "CNAME",
        name,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      });
    records.push({ name, action: create ? "created" : "kept" });
  }
  return { accountId, tunnelId, credentials, records };
}
