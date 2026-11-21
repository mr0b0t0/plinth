// The review account's password page (/login/review) and the link to it from /login, which shows
// only when the instance has the review sign-in on.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  content_isolation: "origin",
  environment: "development",
};
const ME = {
  id: "u1",
  email: "review@example.org",
  name: null,
  created_at: "2026-11-01T00:00:00Z",
  artifact_limit: 100,
  artifact_count: 0,
  is_admin: false,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function backend(opts: { reviewLogin?: boolean; wrongFirst?: boolean } = {}) {
  let signedIn = false;
  let wrongLeft = opts.wrongFirst ? 1 : 0;
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/config")) return json({ ...CONFIG, review_login: !!opts.reviewLogin });
      if (url.endsWith("/me")) {
        return signedIn ? json(ME) : json({ error: { code: "unauthorized", message: "no" } }, 401);
      }
      if (url.endsWith("/auth/review-login")) {
        if (wrongLeft > 0) {
          wrongLeft -= 1;
          return json(
            { error: { code: "invalid_input", message: "That email and password do not match." } },
            400,
          );
        }
        signedIn = true;
        return json({ ok: true, user: { id: "u1", email: ME.email } });
      }
      return json({ error: { code: "not_found", message: "nope" } }, 404);
    }),
  );
  return calls;
}

// The session store is module state: load fresh copies for each test.
async function load(page: "ReviewLogin" | "Login") {
  vi.resetModules();
  return page === "ReviewLogin"
    ? (await import("./ReviewLogin.tsx")).default
    : (await import("./Login.tsx")).default;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReviewLogin", () => {
  it("signs in with the password and carries on to ?next= (an OAuth consent request)", async () => {
    window.history.replaceState(null, "", "/login/review?next=%2Foauth%2Fconsent%3Frequest%3Dr1");
    const calls = backend({ reviewLogin: true, wrongFirst: true });
    const ReviewLogin = await load("ReviewLogin");
    const user = userEvent.setup();
    render(<ReviewLogin />);

    await user.type(await screen.findByLabelText("Email"), " review@example.org ");
    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    await user.type(password, "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("That email and password do not match.")).toBeTruthy();
    // The wrong password is cleared, not kept in the field.
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect(window.location.pathname).toBe("/login/review");

    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(window.location.pathname).toBe("/oauth/consent"));
    expect(window.location.search).toBe("?request=r1");
    const sent = calls.filter((c) => c.url.endsWith("/auth/review-login")).at(-1);
    expect(sent?.body).toEqual({
      email: "review@example.org",
      password: "correct horse battery staple",
    });
  });

  it("asks for both fields without calling the API, and links back to the emailed sign-in", async () => {
    window.history.replaceState(null, "", "/login/review?next=%2Fconnections");
    const calls = backend({ reviewLogin: true });
    const ReviewLogin = await load("ReviewLogin");
    const user = userEvent.setup();
    render(<ReviewLogin />);
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Enter the review account's email and password/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/auth/review-login"))).toBe(false);
    expect(
      screen.getByRole("link", { name: "Sign in with an emailed link" }).getAttribute("href"),
    ).toBe("/login?next=%2Fconnections");
  });
});

describe("Login links to the review sign-in", () => {
  it("only when the instance has it on, keeping ?next=", async () => {
    window.history.replaceState(null, "", "/login?next=%2Foauth%2Fconsent%3Frequest%3Dr1");
    backend({ reviewLogin: true });
    const Login = await load("Login");
    render(<Login />);
    const link = await screen.findByRole("link", { name: "Sign in to the review account" });
    expect(link.getAttribute("href")).toBe("/login/review?next=%2Foauth%2Fconsent%3Frequest%3Dr1");
  });

  it("not on an instance without it", async () => {
    window.history.replaceState(null, "", "/login");
    backend({ reviewLogin: false });
    const Login = await load("Login");
    render(<Login />);
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    // Wait for the config to arrive before checking for the link's absence.
    await waitFor(() => expect(screen.queryByText(/New to Plinth/)).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Sign in to the review account" })).toBeNull();
  });
});
