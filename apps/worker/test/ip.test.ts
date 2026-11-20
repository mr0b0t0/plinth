// Client networks for per-client caps (lib/ip.ts): an IPv6 line is one client, not 2^64.
import { describe, expect, it } from "vitest";
import { clientNetwork } from "../src/lib/ip.ts";

describe("clientNetwork", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(clientNetwork("203.0.113.7")).toBe("203.0.113.7");
    expect(clientNetwork(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("keys every address in one IPv6 /64 the same, and different /64s apart", () => {
    const one = [
      "2001:db8:1:2::1",
      "2001:db8:1:2::ffff",
      "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd",
      "2001:DB8:1:2:0:0:0:9",
      "2001:db8:1:2:1::",
      "2001:db8:1:2::1%eth0",
      "2001:db8:1:2::192.0.2.1",
    ];
    for (const ip of one) expect(clientNetwork(ip), ip).toBe("2001:db8:1:2::/64");
    expect(clientNetwork("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientNetwork("::1")).toBe("0:0:0:0::/64");
  });

  it("reads an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(clientNetwork("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientNetwork("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("keeps anything that does not parse as one client of its own", () => {
    for (const bad of [
      "1:2:3",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "zz::1",
      "1::2.3.4",
      "1::300.1.1.1",
    ]) {
      expect(clientNetwork(bad), bad).toBe(bad);
    }
    expect(clientNetwork("1:2:3:4:5:6:7::8")).toBe("1:2:3:4:5:6:7::8");
  });
});
