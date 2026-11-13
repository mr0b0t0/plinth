import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CONFIG = {
  app_origin: "http://app.localhost:8787",
  content_host: "content.localhost:8787",
  content_protocol: "http:",
  single_user_mode: false,
  public_visibility_enabled: false,
  content_path_fallback: false,
  environment: "development",
};
const ME = {
  id: "u1",
  email: "ada@example.org",
  name: null,
  created_at: "2026-11-01T00:00:00Z",
  artifact_limit: 100,
  artifact_count: 0,
  is_admin: false,
};

// The session store is module state: load fresh copies for each test.
async function loadLogin() {
  vi.resetModules();
  return (await import("./Login.tsx")).default;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function backend(opts: { singleUser?: boolean; wrongCodeFirst?: boolean } = {}) {
  let signedIn = false;
  let wrongLeft = opts.wrongCodeFirst ? 1 : 0;
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/config")) return json({ ...CONFIG, single_user_mode: !!opts.singleUser });
    if (url.endsWith("/me")) {
      return signedIn ? json(ME) : json({ error: { code: "unauthorized", message: "no" } }, 401);
    }
    if (url.endsWith("/auth/login")) return json({ ok: true });
    if (url.endsWith("/auth/verify-code")) {
      if (wrongLeft > 0) {
        wrongLeft -= 1;
        return json(
          { error: { code: "invalid_input", message: "That code is wrong or has expired." } },
          400,
        );
      }
      signedIn = true;
      return json({ ok: true, user: { id: "u1", email: ME.email } });
    }
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/login?next=%2Fconnections");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Login", () => {
  it("sends the email, verifies the code and goes to ?next=", async () => {
    const calls = backend({ wrongCodeFirst: true });
    const Login = await loadLogin();
    const user = userEvent.setup();
    render(<Login />);

    await user.type(await screen.findByLabelText("Email"), "Ada@Example.org");
    await user.click(screen.getByRole("button", { name: "Send sign-in link" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    const sent = calls.find((c) => c.url.endsWith("/auth/login"));
    expect(sent?.body).toEqual({ email: "ada@example.org" });

    const codeInput = screen.getByLabelText("Six-digit code");
    await user.type(codeInput, "12a34 56");
    expect((codeInput as HTMLInputElement).value).toBe("123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("That code is wrong or has expired.")).toBeTruthy();
    expect(window.location.pathname).toBe("/login");

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(window.location.pathname).toBe("/connections"));
    const verify = calls.filter((c) => c.url.endsWith("/auth/verify-code"));
    expect(verify.at(-1)?.body).toEqual({ email: "ada@example.org", code: "123456" });
  });

  it("rejects an invalid email without calling the API", async () => {
    const calls = backend();
    const Login = await loadLogin();
    const user = userEvent.setup();
    render(<Login />);
    await user.type(await screen.findByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Send sign-in link" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/auth/login"))).toBe(false);
  });

  it("ignores an off-site ?next= and says who may sign in on a single-user instance", async () => {
    window.history.replaceState(null, "", "/login?next=%2F%2Fevil.example%2F");
    backend({ singleUser: true, wrongCodeFirst: false });
    const Login = await loadLogin();
    const user = userEvent.setup();
    render(<Login />);
    expect(await screen.findByText(/single-user instance/)).toBeTruthy();
    await user.type(screen.getByLabelText("Email"), "ada@example.org");
    await user.click(screen.getByRole("button", { name: "Send sign-in link" }));
    await user.type(await screen.findByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(window.location.pathname).toBe("/dashboard"));
  });

  it("can go back and use a different email", async () => {
    backend();
    const Login = await loadLogin();
    const user = userEvent.setup();
    render(<Login />);
    await user.type(await screen.findByLabelText("Email"), "ada@example.org");
    await user.click(screen.getByRole("button", { name: "Send sign-in link" }));
    await user.click(await screen.findByRole("button", { name: "Use a different email" }));
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
  });
});
