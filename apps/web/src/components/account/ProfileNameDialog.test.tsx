import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { apiError, json, ME } from "../viewer/test-utils.ts";
import { PROFILE_NAME_HELP, ProfileNameDialog } from "./ProfileNameDialog.tsx";

/** PATCH /api/v1/me answered as the Worker does (stubApi answers every /me with the session). */
function backend(fail = false) {
  const calls: { method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, body });
      if (String(input).endsWith("/api/v1/me") && method === "PATCH") {
        if (fail) return apiError(400, "invalid_input", "A name cannot contain @.");
        const { name } = body as { name: string };
        return json({ ...ME, name: name === "" ? null : name });
      }
      return apiError(404, "not_found");
    }),
  );
  return { calls };
}

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});
afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const field = () => screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;

describe("ProfileNameDialog", () => {
  it("explains where the name shows, and saves it normalised", async () => {
    const { calls } = backend();
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <ProfileNameDialog current={null} onClose={() => {}} onSaved={onSaved} />
        <Toaster />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Your name" })).toBeTruthy();
    expect(screen.getByText(PROFILE_NAME_HELP)).toBeTruthy();
    expect(field().maxLength).toBe(100);
    // One way to leave a name empty: save an empty field. No separate Clear button.
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    await user.type(field(), "  Ana   Lima ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Ana Lima" });
    expect(onSaved.mock.calls[0]?.[0].name).toBe("Ana Lima");
  });

  it("clears the name when the field is saved empty", async () => {
    const { calls } = backend();
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<ProfileNameDialog current="Ana" onClose={() => {}} onSaved={onSaved} />);
    expect(field().value).toBe("Ana");
    await user.clear(field());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "" });
  });

  it("refuses @ and invisible characters before sending, and shows a server error", async () => {
    const { calls } = backend(true);
    const user = userEvent.setup();
    render(<ProfileNameDialog current={null} onClose={() => {}} onSaved={() => {}} />);
    await user.type(field(), "ana@example.org");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("A name cannot contain @.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await user.clear(field());
    await user.type(field(), "Ana");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A name cannot contain @.")).toBeTruthy();
  });

  it("refuses a name that shows nothing (fillers, blank Braille, combining marks) before sending", async () => {
    const { calls } = backend();
    const user = userEvent.setup();
    render(<ProfileNameDialog current={null} onClose={() => {}} onSaved={() => {}} />);
    for (const blank of ["\u3164", "\u115F", "\u1160", "\uFFA0", "\u2800", "\u0301\u0302"]) {
      await user.clear(field());
      await user.type(field(), blank);
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(
        screen.getByText("A name needs a letter, number or symbol you can see."),
        JSON.stringify(blank),
      ).toBeTruthy();
    }
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
