import type { ConnectionInfo } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionItem } from "./ConnectionItem.tsx";

const conn = (over: Partial<ConnectionInfo>): ConnectionInfo => ({
  id: "c1",
  label: "Claude Code",
  client_type: "claude",
  kind: "oauth",
  scopes: ["artifacts:read", "artifacts:write", "mentions"],
  created_at: "2026-11-10T00:00:00Z",
  last_used_at: null,
  revoked_at: null,
  artifact: null,
  ...over,
});

const NOW = Date.parse("2026-11-19T12:00:00Z");

afterEach(cleanup);

function renderItem(c: ConnectionInfo, all: ConnectionInfo[] = [c]) {
  return render(
    <ul>
      <ConnectionItem connection={c} connections={all} now={NOW} onChanged={() => undefined} />
    </ul>,
  );
}

describe("ConnectionItem mention line", () => {
  it("shows the handle a label becomes", () => {
    renderItem(conn({}));
    expect(screen.getByText("@claude-code").closest("p")?.textContent).toBe(
      "Mention as @claude-code",
    );
  });

  it("warns when an older connection takes the handle, or the name is an agent name", () => {
    const older = conn({ id: "c0", label: "claude-code", created_at: "2026-11-01T00:00:00Z" });
    const { unmount } = renderItem(conn({}), [older, conn({})]);
    const line = screen.getByText(
      "@claude-code reaches “claude-code” instead. Rename one of them.",
    );
    expect(line.getAttribute("data-warn")).toBe("true");
    unmount();

    const other = renderItem(conn({ label: "Claude", client_type: "other" }));
    expect(
      screen.getByText("@claude means your Claude connections. Pick another name."),
    ).toBeTruthy();
    other.unmount();

    // A Claude connection named Claude is reached by @claude: the row shows the handle.
    renderItem(conn({ label: "Claude" }));
    expect(screen.getByText("@claude").closest("p")?.textContent).toBe("Mention as @claude");
  });

  it("says nothing about mentions where the row already shows that none reach it", () => {
    const revoked = renderItem(conn({ revoked_at: "2026-11-12T00:00:00Z" }));
    expect(screen.queryByText(/Mention as|reaches|Pick another/)).toBeNull();
    revoked.unmount();
    // Without the mentions scope, the permissions list says so.
    const scoped = renderItem(conn({ scopes: ["artifacts:read"] }));
    expect(screen.queryByText(/Mention as|mentions permission/)).toBeNull();
    scoped.unmount();
    // Limited to one artifact: the row names the artifact.
    renderItem(conn({ artifact: { id: "a1", slug: "a1", title: "Coverage report" } }));
    expect(screen.queryByText(/Mention as|one artifact, so/)).toBeNull();
  });

  it("the rename dialog's hint follows the typed name", async () => {
    const user = userEvent.setup();
    renderItem(conn({ label: "Laptop" }));
    await user.click(screen.getByRole("button", { name: /Rename/ }));
    const input = screen.getByLabelText("Name");
    expect(screen.getByText("Mention as @laptop.")).toBeTruthy();
    await user.clear(input);
    await user.type(input, "Gemini CLI");
    expect(screen.getByText("Mention as @gemini-cli.")).toBeTruthy();
    await user.clear(input);
    await user.type(input, "???");
    expect(
      screen.getByText("Cannot be mentioned: start the name with a letter or digit."),
    ).toBeTruthy();
    await user.clear(input);
    await user.type(input, "claude");
    expect(
      screen.getByText("Mention as @claude, with your other Claude connections."),
    ).toBeTruthy();
  });
});
