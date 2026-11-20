// The allowlist gate says one thing at a time: the lead with "Sign in" for someone signed out, the
// lead without it beside the signed-in notice, and only the sent-code line on the code step.
import type { ViewGate } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "./test-utils.ts";

async function loadGate() {
  vi.resetModules();
  return (await import("./GateScreen.tsx")).GateScreen;
}

const GATE: Extract<ViewGate, { status: "email_required" }> = {
  status: "email_required",
  artifact: { id: "a1", slug: "s1", title: "Q4 client brief" },
};
const LEAD = "Only the people the owner listed can open this artifact.";

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-plinth_csrf=t; plinth_csrf=t");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GateScreen", () => {
  it("asks someone signed out to sign in, then shows only the sent-code line", async () => {
    stubApi({ handle: (c) => (c.path === "/view/s1/email" ? json({ ok: true }) : undefined) });
    const GateScreen = await loadGate();
    const user = userEvent.setup();
    render(<GateScreen gate={GATE} artifactRef="s1" query={{}} onGate={() => {}} />);
    expect(await screen.findByText(`${LEAD} Sign in with a one-time code.`)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Email" }), "jonas@example.org");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("textbox", { name: "Six-digit code" });
    expect(screen.queryByText(LEAD, { exact: false })).toBeNull();
    expect(screen.getByText(/we sent a code to/)).toBeTruthy();
  });

  it("does not ask a signed-in person to sign in beside the notice", async () => {
    stubApi({ me: ME });
    const GateScreen = await loadGate();
    render(<GateScreen gate={GATE} artifactRef="s1" query={{}} onGate={() => {}} />);
    await screen.findByText(/You are signed in as/);
    expect(screen.getByText(LEAD)).toBeTruthy();
    expect(screen.queryByText(/Sign in with/)).toBeNull();
  });
});
