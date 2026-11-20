import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewTokenDialog } from "./NewTokenDialog.tsx";

const TOKEN = "plinth_pat_ExampleExampleExampleExample0123";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NewTokenDialog", () => {
  it("creates a token, shows it once, and forgets it when closed", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/config")) return json({});
        if (url.endsWith("/connections") && init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return json(
            {
              token: TOKEN,
              connection: {
                id: "c1",
                label: "Codex laptop",
                client_type: "codex",
                kind: "token",
                scopes: ["artifacts:read", "artifacts:write"],
                created_at: "2026-11-13T00:00:00Z",
                last_used_at: null,
                revoked_at: null,
              },
            },
            201,
          );
        }
        return json({ error: { code: "not_found", message: "no" } }, 404);
      }),
    );
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<NewTokenDialog open onClose={onClose} onCreated={onCreated} />);

    // Empty name is refused before any request.
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByText(/Name the token/)).toBeTruthy();
    expect(posted).toHaveLength(0);

    await user.type(screen.getByLabelText("Name"), "Codex laptop");
    await user.selectOptions(screen.getByLabelText(/Client/), "codex");
    await user.click(screen.getByRole("checkbox", { name: /Answer mentions/ }));
    await user.click(screen.getByRole("button", { name: "Create token" }));

    const field = (await screen.findByLabelText("Token")) as HTMLTextAreaElement;
    expect(field.value).toBe(TOKEN);
    expect(field.readOnly).toBe(true);
    expect(screen.getByText(/Shown only once/)).toBeTruthy();
    expect(posted[0]).toEqual({
      label: "Codex laptop",
      client_type: "codex",
      scopes: ["artifacts:read", "artifacts:write"],
    });
    expect(onCreated).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();

    // Closing and opening again starts from an empty form; the token is gone from the page.
    rerender(<NewTokenDialog open={false} onClose={onClose} onCreated={onCreated} />);
    rerender(<NewTokenDialog open onClose={onClose} onCreated={onCreated} />);
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
  });

  it("asks for at least one permission", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    render(<NewTokenDialog open onClose={() => undefined} onCreated={() => undefined} />);
    await user.type(screen.getByLabelText("Name"), "x");
    for (const name of [/Read artifacts/, /Publish and manage/, /Answer mentions/]) {
      await user.click(screen.getByRole("checkbox", { name }));
    }
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByText("Choose at least one permission.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says which handle the typed name becomes, and when it cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    const existing = {
      id: "c0",
      label: "Nightly CI",
      client_type: "other" as const,
      kind: "token" as const,
      scopes: ["artifacts:read", "artifacts:write", "mentions"],
      created_at: "2026-11-01T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
      artifact: null,
    };
    render(
      <NewTokenDialog
        open
        connections={[existing]}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    );
    const name = screen.getByLabelText("Name");
    const hint = () => document.getElementById(`${name.id}-hint`)?.textContent ?? "";
    expect(hint()).toBe("Shown on this page and in the version history of what it publishes.");
    await user.type(name, "Gemini CLI");
    expect(hint()).toContain("Collaborators reach it by writing @gemini-cli in a comment.");
    await user.clear(name);
    await user.type(name, "nightly ci");
    expect(hint()).toContain("@nightly-ci reaches “Nightly CI” instead");
    await user.click(screen.getByRole("checkbox", { name: /Answer mentions/ }));
    expect(hint()).toContain("does not have the Answer mentions permission");
  });
});
