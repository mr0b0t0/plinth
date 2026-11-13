import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./Report.tsx")).default;
}

const stub = { id: "a1", slug: "s1", title: "Odd page" };
const okGate = {
  status: "ok",
  artifact: {
    ...stub,
    current_version: 1,
    version: 1,
    visibility: "unlisted",
    owner_name: null,
  },
  enter_url: "http://a1.content.localhost:8787/__plinth/enter?t=x",
  role: null,
};

beforeEach(() => {
  window.history.replaceState(null, "", "/a/s1/report");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Report", () => {
  it("prefills the signed-in email, sends the report and thanks the reporter", async () => {
    const { calls } = stubApi({
      me: ME,
      handle: (c) => {
        if (c.path === "/view/s1") return json(okGate);
        if (c.path === "/artifacts/s1/report") return json({ id: "r1", state: "open" }, 201);
        return undefined;
      },
    });
    const Report = await loadPage();
    const user = userEvent.setup();
    render(<Report params={{ slug: "s1" }} />);
    expect(await screen.findByText("Odd page")).toBeTruthy();
    const email = screen.getByLabelText("Your email (optional)") as HTMLInputElement;
    await vi.waitFor(() => expect(email.value).toBe("ada@example.org"));

    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(screen.getByText("Say what is wrong with this artifact.")).toBeTruthy();
    await user.type(screen.getByLabelText("What is wrong with this artifact?"), "  Phishing  ");
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Thank you. Your report was sent.")).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      body: { reason: "Phishing", reporter_email: "ada@example.org" },
    });
  });

  it("leaves the email out when empty and explains rate limits", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/view/s1") return json(okGate);
        if (c.path === "/artifacts/s1/report") return apiError(429, "rate_limited");
        return undefined;
      },
    });
    const Report = await loadPage();
    const user = userEvent.setup();
    render(<Report params={{ slug: "s1" }} />);
    await user.type(await screen.findByLabelText("What is wrong with this artifact?"), "Spam");
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText(/Too many reports/)).toBeTruthy();
    expect(calls.at(-1)?.body).toEqual({ reason: "Spam" });
  });

  it("asks people to open a protected artifact first", async () => {
    stubApi({ handle: () => json({ status: "password_required", artifact: stub }) });
    const Report = await loadPage();
    render(<Report params={{ slug: "s1" }} />);
    expect(await screen.findByText("Open the artifact first")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
  });
});
