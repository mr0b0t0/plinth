// Client networks for per-client caps. One IPv4 address is one client. An IPv6 line or server
// usually gets a whole /64 and may pick any address inside it, so keying by the full IPv6 address
// would give one person 2^64 clients; the /64 is the client instead.

/**
 * The network a client address belongs to, for caps: an IPv4 address as it is, an IPv6 address as
 * its /64 prefix (`2001:db8:1:2::/64`), an IPv4-mapped IPv6 address as its IPv4 address. Anything
 * that does not parse is returned trimmed and lowercased, so it is still one client of its own.
 */
export function clientNetwork(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  const groups = ipv6Groups(raw.split("%")[0] ?? "");
  if (!groups) return raw;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = groups[6] ?? 0;
    const b = groups[7] ?? 0;
    return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(s: string): number[] | null {
  if (!s) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    const items = h.split(":");
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? "";
      if (item.includes(".")) {
        // An embedded IPv4 address, only as the last two groups.
        if (i !== items.length - 1) return null;
        const v4 = item.split(".");
        if (v4.length !== 4) return null;
        const bytes = v4.map((b) => (/^\d{1,3}$/.test(b) ? Number(b) : Number.NaN));
        if (bytes.some((b) => !(b >= 0 && b <= 255))) return null;
        out.push(
          ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0),
          ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
        );
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
        out.push(Number.parseInt(item, 16));
      }
    }
    return out;
  };
  const head = part(halves[0] ?? "");
  const tail = halves.length === 2 ? part(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}
