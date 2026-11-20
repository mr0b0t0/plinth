// /invitation-emails: signed-in people turn invitation emails to their own address off and on
// again; without a session the page sends them to sign in and comes back here.
import { invitationSkippedSummary } from "@plinth/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./InvitationEmails.tsx")).default;
}

function backend(initial: boolean, me: typeof ME | null = ME) {
  const s = { receive: initial, puts: [] as unknown[] };
  const api = stubApi({
    me,
    handle: (c) => {
      if (c.path !== "/me/invitation-emails") return undefined;
      if (c.method === "PUT") {
        s.puts.push(c.body);
        s.receive = (c.body as { receive: boolean }).receive;
      }
      return json({ email: ME.email, receive: s.receive });
    },
  });
  return { ...s, state: s, calls: api.calls };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/invitation-emails");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InvitationEmails", () => {
  it("turns them off with one button and on again, for the signed-in address", async () => {
    const b = backend(true);
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByText(ME.email)).toBeTruthy();
    // The page is its title, one sentence and one button, in either state.
    const page = () => within(screen.getByRole("main"));
    const onlyText = () =>
      [...screen.getByRole("main").querySelectorAll("p")].map((p) => p.textContent);
    expect(onlyText()).toEqual([`Invitation emails to ${ME.email} are on.`]);
    expect(page().getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Stop these emails" }));
    expect(await screen.findByRole("button", { name: "Turn them back on" })).toBeTruthy();
    expect(onlyText()).toEqual([`Invitation emails to ${ME.email} are off.`]);
    expect(page().getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Turn them back on" }));
    expect(await screen.findByRole("button", { name: "Stop these emails" })).toBeTruthy();
    // Only the setting goes up: never an address.
    expect(b.state.puts).toEqual([{ receive: false }, { receive: true }]);
  });

  it("sends someone who is not signed in to sign in, and asks nothing of the Worker", async () => {
    const b = backend(true, null);
    const Page = await loadPage();
    render(<Page />);
    await vi.waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(b.calls.some((c) => c.path === "/me/invitation-emails")).toBe(false);
  });

  it("an owner's toast says the person turned these emails off, and no more", () => {
    expect(
      invitationSkippedSummary({
        emailed: [],
        skipped: [{ email: "bo@example.org", reason: "opted_out" }],
      }),
    ).toBe(
      "Not emailed: bo@example.org. They turned these emails off. Send them the link yourself.",
    );
  });
});
