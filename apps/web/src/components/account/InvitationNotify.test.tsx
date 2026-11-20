// Invitation emails in the app (docs/spec.md "Invitation emails"): "Notify people" is ticked by
// default; adding a person then asks the Worker to email them (`notify: true`), unticking it does
// not, role changes and Undo never do, and people the Worker did not email are named in the one
// toast the change shows.
import type { ArtifactSummary, SharingSettings } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { json, stubApi } from "../viewer/test-utils.ts";
import { PeopleSection } from "./SettingsSections.tsx";
import { ShareCategoryDialog } from "./ShareCategoryDialog.tsx";

const artifact = { id: "art1", slug: "plan", title: "Plan", version_count: 1 } as ArtifactSummary;

const settings = (grants: SharingSettings["grants"] = []): SharingSettings => ({
  visibility: "allowlist",
  has_password: false,
  public_allowed: false,
  grants,
});

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-plinth_csrf=t; plinth_csrf=t");
});
afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function people(onChange = vi.fn(), sharing = settings()) {
  return render(
    <>
      <PeopleSection
        artifact={artifact}
        sharing={sharing}
        ownerEmail="ada@example.org"
        onChange={onChange}
      />
      <Toaster />
    </>,
  );
}

describe("PeopleSection: Notify people", () => {
  it("is ticked by default and adding a person asks to email them", async () => {
    const api = stubApi({
      handle: (c) =>
        c.method === "PUT"
          ? json({
              ...settings([
                { email: "bo@example.org", role: "viewer", created_at: "x", name: null },
              ]),
              invitations: { emailed: ["bo@example.org"], skipped: [] },
            })
          : undefined,
    });
    const onChange = vi.fn();
    people(onChange);
    const box = screen.getByRole("checkbox", { name: /Notify people/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "bo@example.org");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      grants: [{ email: "bo@example.org", role: "viewer" }],
      notify: true,
    });
    // The settings the page keeps have no invitation report in them.
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("invitations");
    // One toast, and no "Invitation emailed" in it: the ticked box already says so.
    expect(await screen.findByText("bo@example.org · Viewer")).toBeTruthy();
    expect(screen.queryByText(/Invitation emailed/)).toBeNull();
  });

  it("unticked, adding a person sends no notify", async () => {
    const api = stubApi({
      handle: (c) => (c.method === "PUT" ? json(settings()) : undefined),
    });
    const onChange = vi.fn();
    people(onChange);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Notify people/ }));
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "cy@example.org");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      grants: [{ email: "cy@example.org", role: "viewer" }],
    });
  });

  it("a role change never asks to email", async () => {
    const api = stubApi({
      handle: (c) => (c.method === "PUT" ? json(settings()) : undefined),
    });
    const onChange = vi.fn();
    people(
      onChange,
      settings([{ email: "bo@example.org", role: "viewer", created_at: "x", name: null }]),
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Role for bo@example.org"), "editor");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      grants: [{ email: "bo@example.org", role: "editor" }],
    });
  });

  it("names the people who were not emailed, and why", async () => {
    stubApi({
      handle: (c) =>
        c.method === "PUT"
          ? json({
              ...settings(),
              invitations: {
                emailed: [],
                skipped: [{ email: "bo@example.org", reason: "already_emailed" }],
              },
            })
          : undefined,
    });
    people();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "bo@example.org");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    // One warning toast, not a second one beside "Person added".
    expect(await screen.findByText("Person added")).toBeTruthy();
    expect(screen.queryByText("No invitation sent")).toBeNull();
    expect(
      screen.getByText(
        /Not emailed: bo@example.org\. They were emailed about it in the last day\./,
      ),
    ).toBeTruthy();
  });
});

describe("ShareCategoryDialog: Notify people", () => {
  it("unticked, a new share sends no notify", async () => {
    const api = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/category-shares/preview"))
          return json({ category: "Acme", artifacts: [] });
        if (c.method === "POST")
          return json(
            {
              share: {
                id: "share00000000000000a",
                category: "Acme",
                title: "Acme",
                portal_url: "http://app.localhost:8787/p/share00000000000000a",
                people: [],
                counts: { shared: 0, pending: 0, private: 0 },
              },
              review: { shared: 0, private: 0, skipped: [] },
            },
            201,
          );
        return undefined;
      },
    });
    const onDone = vi.fn();
    render(
      <ShareCategoryDialog category="Acme" shareId={null} onClose={vi.fn()} onDone={onDone} />,
    );
    const user = userEvent.setup();
    await screen.findByText("This category has no artifacts yet.");
    const box = screen.getByRole("checkbox", { name: /Notify people/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(box);
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "client@example.org");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("notify");
  });

  it("names the people who were not emailed in the one Category shared toast", async () => {
    const api = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/category-shares/preview"))
          return json({ category: "Acme", artifacts: [] });
        if (c.method === "POST")
          return json(
            {
              share: {
                id: "share00000000000000a",
                category: "Acme",
                title: "Acme",
                portal_url: "http://app.localhost:8787/p/share00000000000000a",
                people: [{ email: "client@example.org", role: "viewer" }],
                counts: { shared: 0, pending: 0, private: 0 },
              },
              review: { shared: 0, private: 0, skipped: [] },
              invitations: {
                emailed: [],
                skipped: [{ email: "client@example.org", reason: "recipient_limit" }],
              },
            },
            201,
          );
        return undefined;
      },
    });
    const onDone = vi.fn();
    render(
      <>
        <ShareCategoryDialog category="Acme" shareId={null} onClose={vi.fn()} onDone={onDone} />
        <Toaster />
      </>,
    );
    const user = userEvent.setup();
    await screen.findByText("This category has no artifacts yet.");
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "client@example.org");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === "POST")?.body).toHaveProperty("notify", true);
    expect(await screen.findByText("Category shared")).toBeTruthy();
    expect(screen.getByText(/Not emailed: client@example\.org\./)).toBeTruthy();
    expect(screen.queryByText("No invitation sent")).toBeNull();
  });
});

describe("Notify people when the instance sends no invitation emails", () => {
  it("PeopleSection has no box and adding a person sends no notify", async () => {
    const api = stubApi({
      handle: (c) => (c.method === "PUT" ? json(settings()) : undefined),
    });
    const onChange = vi.fn();
    render(
      <>
        <PeopleSection
          artifact={artifact}
          sharing={settings()}
          ownerEmail="ada@example.org"
          onChange={onChange}
          invitations={false}
        />
        <Toaster />
      </>,
    );
    expect(screen.queryByRole("checkbox", { name: /Notify people/ })).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "bo@example.org");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      grants: [{ email: "bo@example.org", role: "viewer" }],
    });
  });

  it("ShareCategoryDialog has no box and a new share sends no notify", async () => {
    const api = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/category-shares/preview"))
          return json({ category: "Acme", artifacts: [] });
        if (c.method === "POST")
          return json(
            {
              share: {
                id: "share00000000000000a",
                category: "Acme",
                title: "Acme",
                portal_url: "http://app.localhost:8787/p/share00000000000000a",
                people: [],
                counts: { shared: 0, pending: 0, private: 0 },
              },
              review: { shared: 0, private: 0, skipped: [] },
            },
            201,
          );
        return undefined;
      },
    });
    const onDone = vi.fn();
    render(
      <ShareCategoryDialog
        category="Acme"
        shareId={null}
        onClose={vi.fn()}
        onDone={onDone}
        invitations={false}
      />,
    );
    const user = userEvent.setup();
    await screen.findByText("This category has no artifacts yet.");
    expect(screen.queryByRole("checkbox", { name: /Notify people/ })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "client@example.org");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("notify");
  });
});
