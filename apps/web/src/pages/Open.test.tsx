import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./Open.tsx")).default;
}

const ENTER = "http://art123.content.localhost:8787/__plinth/enter?t=tok&next=%2Fdeep";

beforeEach(() => {
  window.history.replaceState(null, "", "/open/art123?next=%2Fdeep%3Fx%3D1");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Open", () => {
  it("runs the gate with next, then moves the whole tab to the enter URL", async () => {
    const replace = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      pathname: "/open/art123",
      search: "?next=%2Fdeep%3Fx%3D1",
      origin: "http://app.localhost:8787",
      replace,
    } as Location);
    const { calls } = stubApi({
      handle: (c) =>
        c.path.startsWith("/view/art123")
          ? json({
              status: "ok",
              artifact: {
                id: "art123",
                slug: "s",
                title: "Deep link",
                current_version: 1,
                version: 1,
                visibility: "unlisted",
                owner_name: null,
              },
              enter_url: ENTER,
              role: null,
            })
          : undefined,
    });
    const Open = await loadPage();
    render(<Open params={{ id: "art123" }} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(ENTER));
    expect(calls.find((c) => c.path.startsWith("/view/"))?.path).toBe(
      "/view/art123?next=%2Fdeep%3Fx%3D1",
    );
    expect(screen.getByRole("heading", { name: "Opening Deep link" })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("shows the email gate when the artifact needs one", async () => {
    stubApi({
      handle: () =>
        json({
          status: "email_required",
          artifact: { id: "art123", slug: "s", title: "Private notes" },
        }),
    });
    const Open = await loadPage();
    render(<Open params={{ id: "art123" }} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Private notes" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });
});
