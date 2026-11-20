import {
  ACTION_REF,
  type ArtifactSummary,
  CI_NO_ARTIFACT_URL,
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
    // The guide sits in the step's caption; the step keeps its lines whole (YAML) and scrolls.
    const guide = screen.getByRole("link", { name: "CI guide" });
    expect(guide.closest("figcaption")?.textContent).toBe("GitHub Actions step · CI guide");
    const step = document.querySelector("pre");
    expect(step?.classList.contains("pl-acct-block__code--nowrap")).toBe(true);
    expect(step?.getAttribute("tabindex")).toBe("0");
    // Both copy buttons sit inside their boxes.
    const token = screen.getByLabelText("Token");
    expect(token.closest(".pl-acct-copy--box")?.querySelector("button")).toBeTruthy();
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

  it("with nothing to choose, points to the guide's No artifact yet section", async () => {
    backend([summary({ role: "viewer" })]);
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("checkbox", { name: "Limit to one artifact" }));
    const how = await screen.findByRole("link", { name: "how" });
    expect(how.getAttribute("href")).toBe(CI_NO_ARTIFACT_URL);
    expect(CI_NO_ARTIFACT_URL).toMatch(/docs\/ci\.md#no-artifact-yet$/);
    expect(document.body.textContent).toContain("You own or edit no artifact yet.");
    expect(screen.queryByLabelText("Artifact")).toBeNull();
    // It says what the token is, not "act as you".
    expect(document.body.textContent).toContain("reads one artifact");
    expect(document.body.textContent).not.toContain("act as you");
  });

  it("after a failed load, Try again loads the list", async () => {
    let fails = 1;
    stubApi({
      handle: (c) => {
        if (c.path !== "/artifacts") return undefined;
        if (fails-- > 0) return json({ error: { code: "internal", message: "x" } }, 500);
        return json({ items: [summary()], categories: [] });
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("checkbox", { name: "Limit to one artifact" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load your artifacts.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("option", { name: "Coverage report" });
  });

  it("tells equal titles apart by slug", async () => {
    backend([
      summary(),
      summary({ id: "second00000000000000", slug: "coverage-2", title: "coverage report " }),
      summary({ id: "other000000000000000", slug: "bench", title: "Bench" }),
    ]);
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("checkbox", { name: "Limit to one artifact" }));
    await screen.findByRole("option", { name: "Coverage report (coverage)" });
    expect(screen.getByRole("option", { name: "coverage report (coverage-2)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Bench" })).toBeTruthy();
  });

  it("past the list's 500, a search finds older artifacts, and the step fits a doc", async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      summary({ id: `recent${String(i).padStart(14, "0")}`, slug: `r-${i}`, title: `Recent ${i}` }),
    );
    const old = summary({
      id: "old00000000000000000",
      slug: "old-notes",
      title: "Old notes",
      type: "doc",
    });
    const s = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts") return json({ items: many, categories: [] });
        if (c.path === "/artifacts?query=old") return json({ items: [old], categories: [] });
        if (c.path === "/connections" && c.method === "POST")
          return json(
            {
              token: TOKEN,
              connection: connection({
                artifact: { id: old.id, slug: old.slug, title: old.title },
              }),
            },
            201,
          );
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText("Name"), "CI: notes");
    await user.click(screen.getByRole("checkbox", { name: "Limit to one artifact" }));
    await screen.findByRole("option", { name: "Recent 0" });
    expect(screen.queryByRole("option", { name: "Old notes" })).toBeNull();
    await user.type(screen.getByLabelText("Find an artifact"), "old");
    await screen.findByRole("option", { name: "Old notes" });
    expect(s.calls.some((c) => c.path === "/artifacts?query=old")).toBe(true);
    await user.selectOptions(screen.getByLabelText("Artifact"), old.id);
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByLabelText("Token");
    const text = document.body.textContent ?? "";
    expect(text).toContain(`id: ${old.id}`);
    expect(text).toContain("path: content.md");
    expect(text).not.toContain("path: dist");
  });

  it("the step's path matches the type", () => {
    const path = (type: ArtifactSummary["type"]) =>
      ciWorkflowSnippet({ id: ID, appOrigin: HOSTED_ORIGIN, type }).split("\n")[2];
    expect(path("html")).toBe("    path: dist");
    expect(path("doc")).toBe("    path: content.md");
    expect(path("slides")).toBe("    path: slides # a folder with slides.md at its top");
    expect(path("design_system")).toBe(
      "    path: design-system # a folder with system.json at its top",
    );
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
