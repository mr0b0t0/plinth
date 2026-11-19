import {
  ACTION_REF,
  type ArtifactSummary,
  type ConnectionInfo,
  ciWorkflowSnippet,
  HOSTED_ORIGIN,
} from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, stubApi } from "../viewer/test-utils.ts";
import { NewTokenDialog } from "./NewTokenDialog.tsx";

const ID = "k3x9mq2v7d8p4t6w1n5r";
const TOKEN = "plinth_pat_ExampleExampleExampleExample0123";

const summary = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: ID,
  slug: "coverage",
  title: "Coverage report",
  type: "html",
  visibility: "allowlist",
  current_version: 3,
  version_count: 3,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  url: "http://app.localhost:8787/a/coverage",
  content_url: `http://${ID}.content.localhost:8787/`,
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  ...over,
});

const connection = (over: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  id: "c1",
  label: "CI: Coverage report",
  client_type: "other",
  kind: "token",
  scopes: ["artifacts:read", "artifacts:write"],
  created_at: "2026-11-19T00:00:00Z",
  last_used_at: null,
  revoked_at: null,
  artifact: { id: ID, slug: "coverage", title: "Coverage report" },
  ...over,
});

/** A backend that creates tokens, and lists the person's artifacts. */
function backend(items: ArtifactSummary[] = []) {
  const posted: unknown[] = [];
  const s = stubApi({
    handle: (c) => {
      if (c.path === "/connections" && c.method === "POST") {
        posted.push(c.body);
        const body = c.body as { artifact?: string; scopes: string[] };
        return json(
          {
            token: TOKEN,
            connection: connection({
              scopes: body.scopes,
              artifact: body.artifact
                ? { id: ID, slug: "coverage", title: "Coverage report" }
                : null,
            }),
          },
          201,
        );
      }
      if (c.path === "/artifacts" && c.method === "GET") return json({ items, categories: [] });
      return undefined;
    },
  });
  return { ...s, posted };
}

const renderDialog = () =>
  render(<NewTokenDialog open onClose={() => undefined} onCreated={() => undefined} />);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("New token: Limit to one artifact", () => {
  it("lists what you own or edit, limits the scopes and shows the workflow step", async () => {
    const b = backend([
      summary(),
      summary({ id: "viewonly000000000000", title: "Not mine", role: "viewer" }),
    ]);
    const user = userEvent.setup();
    renderDialog();
    expect(b.calls.some((c) => c.path === "/artifacts")).toBe(false);
    await user.type(screen.getByLabelText("Name"), "CI: Coverage report");
    await user.click(screen.getByRole("checkbox", { name: "Limit to one artifact" }));
    const select = (await screen.findByLabelText("Artifact")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Coverage report" });
    expect(screen.queryByRole("option", { name: "Not mine" })).toBeNull();
    // A limited token answers no mentions: no client, no mention permission.
    expect(screen.queryByLabelText("Client")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Answer mentions/ })).toBeNull();
    // Without a choice it asks for one.
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByText("Choose an artifact.")).toBeTruthy();
    await user.selectOptions(select, ID);
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(((await screen.findByLabelText("Token")) as HTMLTextAreaElement).value).toBe(TOKEN);
    expect(b.posted[0]).toEqual({
      label: "CI: Coverage report",
      client_type: "other",
      scopes: ["artifacts:read", "artifacts:write"],
      artifact: ID,
    });
    // The step names the artifact and, off the hosted instance, the instance.
    const text = document.body.textContent ?? "";
    expect(text).toContain(`uses: ${ACTION_REF}`);
    expect(text).toContain(`id: ${ID}`);
    expect(text).toContain(`url: ${window.location.origin}`);
    expect(text).toContain("secrets.PLINTH_TOKEN");
  });

  it("a read-only token for the artifact sends artifacts:read alone", async () => {
    const b = backend([summary()]);
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText("Name"), "Reader");
    await user.click(screen.getByRole("checkbox", { name: "Limit to one artifact" }));
    await screen.findByRole("option", { name: "Coverage report" });
    await user.selectOptions(screen.getByLabelText("Artifact"), ID);
    await user.click(screen.getByRole("checkbox", { name: "Publish new versions" }));
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByLabelText("Token");
    expect(b.posted[0]).toMatchObject({ scopes: ["artifacts:read"], artifact: ID });
  });

  it("an account-wide token shows no workflow step", async () => {
    backend();
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText("Name"), "Laptop");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByLabelText("Token");
    expect(document.body.textContent).not.toContain(ACTION_REF);
  });

  it("the workflow step leaves url out on the hosted instance", () => {
    expect(ciWorkflowSnippet({ id: ID, appOrigin: HOSTED_ORIGIN })).toBe(
      [
        `- uses: ${ACTION_REF}`,
        "  with:",
        "    path: dist",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax
        "    token: ${{ secrets.PLINTH_TOKEN }}",
        `    id: ${ID}`,
      ].join("\n"),
    );
    expect(ciWorkflowSnippet({ id: ID, appOrigin: "https://plinth.example.com/" })).toContain(
      "    url: https://plinth.example.com",
    );
    expect(() => ciWorkflowSnippet({ id: "not an id: x", appOrigin: HOSTED_ORIGIN })).toThrow();
  });
});
