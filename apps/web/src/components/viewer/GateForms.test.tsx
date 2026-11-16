import type { ViewGate } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailForm, PasswordForm } from "./GateForms.tsx";
import { apiError, json, stubApi } from "./test-utils.ts";

const OK: ViewGate = {
  status: "ok",
  artifact: {
    id: "a1",
    slug: "s1",
    title: "T",
    type: "html",
    current_version: 1,
    version: 1,
    visibility: "allowlist",
    owner_name: null,
  },
  enter_url: "http://a1.content.localhost:8787/__plinth/enter?t=x",
  role: "viewer",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PasswordForm", () => {
  it("passes the gate query along and reports rate limits", async () => {
    const { calls } = stubApi({ handle: () => apiError(429, "rate_limited") });
    const onGate = vi.fn();
    const user = userEvent.setup();
    render(<PasswordForm artifactRef="s1" query={{ version: 2 }} onGate={onGate} />);
    await user.click(screen.getByRole("button", { name: "Open artifact" }));
    expect(screen.getByText("Enter the password.")).toBeTruthy();
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.click(screen.getByRole("button", { name: "Open artifact" }));
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/view/s1/password?version=2",
      body: { password: "pw" },
    });
    expect(onGate).not.toHaveBeenCalled();
  });
});

describe("EmailForm", () => {
  it("asks for a code, then confirms it", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/view/s1/email") return json({ ok: true });
        if (c.path === "/view/s1/code")
          return (c.body as { code: string }).code === "123456"
            ? json(OK)
            : apiError(403, "forbidden");
        return undefined;
      },
    });
    const onGate = vi.fn();
    const user = userEvent.setup();
    render(<EmailForm artifactRef="s1" query={{}} onGate={onGate} />);
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(screen.getByText("Enter a valid email address.")).toBeTruthy();

    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "guest@example.org");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "If this address has access, we sent a code to guest@example.org",
    );
    expect(calls.at(-1)).toMatchObject({ body: { email: "guest@example.org" } });

    await user.type(screen.getByLabelText("Six-digit code"), "000000");
    await user.click(screen.getByRole("button", { name: "Confirm code" }));
    expect(await screen.findByText(/That code did not work/)).toBeTruthy();
    expect(onGate).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Six-digit code"));
    await user.type(screen.getByLabelText("Six-digit code"), "12a3456");
    expect((screen.getByLabelText("Six-digit code") as HTMLInputElement).value).toBe("123456");
    await user.click(screen.getByRole("button", { name: "Confirm code" }));
    await vi.waitFor(() => expect(onGate).toHaveBeenCalledWith(OK));
    expect(calls.filter((c) => c.path === "/view/s1/code").at(-1)).toMatchObject({
      body: { email: "guest@example.org", code: "123456" },
    });
    // A confirmed code may have signed the owner in, so the session is reloaded.
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/me" });
  });

  it("tells a signed-in person their address is not on the list", () => {
    stubApi();
    render(
      <EmailForm artifactRef="s1" query={{}} onGate={() => {}} signedInEmail="ada@example.org" />,
    );
    expect(screen.getByText(/You are signed in as/).textContent).toContain(
      "ada@example.org, which is not on the list",
    );
  });
});
