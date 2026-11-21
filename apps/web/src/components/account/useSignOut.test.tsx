// Every sign-out (the account pages' useSignOut as much as the shell's) drops the page edits this
// tab kept to rescue, for every account: they belong to the session that ended.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countRescue, mergeRescue } from "../editor/draft.ts";
import { useSignOut } from "./hooks.tsx";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("useSignOut", () => {
  it("clears every rescue store in the tab on a sign-out", async () => {
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) return json({ single_user_mode: false });
        if (url.endsWith("/me")) return json({ error: { code: "unauthorized" } }, 401);
        return new Response(null, { status: 204 });
      }),
    );
    mergeRescue("u1", "art1", [{ id: "r1", text: "Kept", near: 0 }], []);
    mergeRescue("u0", "art2", [{ id: "r2", text: "Kept", near: 0 }], []);
    const { result } = renderHook(() => useSignOut());
    await act(() => result.current());
    expect(countRescue("art1")).toBe(0);
    expect(countRescue("art2")).toBe(0);
    expect(window.location.pathname).toBe("/login");
  });
});
