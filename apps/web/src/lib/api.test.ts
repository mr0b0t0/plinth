import { describe, expect, it } from "vitest";
import { csrfCookieName, csrfToken } from "./api.ts";

describe("CSRF cookie", () => {
  it("is __Host- prefixed wherever cookies can be Secure, as the Worker decides", () => {
    expect(csrfCookieName({ protocol: "https:", hostname: "plinth.aconite.io" })).toBe(
      "__Host-plinth_csrf",
    );
    expect(csrfCookieName({ protocol: "http:", hostname: "app.localhost" })).toBe(
      "__Host-plinth_csrf",
    );
    expect(csrfCookieName({ protocol: "http:", hostname: "localhost" })).toBe("__Host-plinth_csrf");
    expect(csrfCookieName({ protocol: "http:", hostname: "plinth.lan" })).toBe("plinth_csrf");
  });

  it("reads only the cookie with the expected name", () => {
    const prefixed = "__Host-plinth_csrf";
    expect(csrfToken("a=1; __Host-plinth_csrf=abc; b=2", prefixed)).toBe("abc");
    // A leftover unprefixed cookie (from before the rename, or planted) is never used.
    expect(csrfToken("plinth_csrf=old", prefixed)).toBe("");
    expect(csrfToken("plinth_csrf=old; __Host-plinth_csrf=new", prefixed)).toBe("new");
    expect(csrfToken("plinth_csrf=plain", "plinth_csrf")).toBe("plain");
    expect(csrfToken("x_plinth_csrf=nope; plinth_csrf_x=nope", "plinth_csrf")).toBe("");
    expect(csrfToken("", prefixed)).toBe("");
  });
});
