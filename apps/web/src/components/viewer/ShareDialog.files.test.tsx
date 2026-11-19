// The share dialog's Files block: the owner sees the files people uploaded (names as text, no
// previews), deletes one, or deletes them all after a confirmation. Nobody else loads them. A page
// that does not declare `files` shows the block only while it still has files a version that
// declared them left behind.
import { type ArtifactFilesList, CSRF_HEADER, type DataSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import { json, stubApi } from "./test-utils.ts";

const summary = (caps: DataSummary["capabilities"]): DataSummary => ({
  capabilities: caps,
  available: true,
  usage: { docs: 0, bytes: 0 },
  limits: { max_doc_bytes: 16384, max_docs: 1000, max_bytes: 1048576 },
  collections: [],
  untrusted: "UNTRUSTED",
});

const file = (id: string, name: string, size = 2048): ArtifactFilesList["files"][number] => ({
  id,
  name,
  type: "image/png",
  size,
  state: "ready",
  created_at: "2026-11-18T10:00:00.000Z",
  uploaded_by: {
    email: "bea@example.org",
    role: "viewer",
    viewer_id: "u_0123456789abcdef01234567",
  },
});

const list = (files: ArtifactFilesList["files"]): ArtifactFilesList => ({
  available: true,
  files,
  next_cursor: null,
  usage: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
  limits: {
    max_file_bytes: 20971520,
    max_files: 500,
    max_bytes: 268435456,
    max_bytes_per_uploader: 67108864,
    part_bytes: 5242880,
  },
  untrusted: "UNTRUSTED",
});

function renderDialog(isOwner = true) {
  return render(
    <>
      <ShareDialog
        open
        onClose={() => undefined}
        link="http://app.localhost:8787/a/s1"
        slug="s1"
        visibility="allowlist"
        isOwner={isOwner}
      />
      <Toaster />
    </>,
  );
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

describe("ShareDialog files", () => {
  it("lists the files by name as text, with type, size and uploader", async () => {
    const evil = '<img src=x onerror="alert(1)">.png';
    stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/data") return json(summary(["files"]));
        if (c.path === "/artifacts/s1/files") return json(list([file("a".repeat(20), evil)]));
        return undefined;
      },
    });
    renderDialog();
    expect((await screen.findByText(/Uploaded files:/)).textContent).toBe(
      "Uploaded files: 1 file, 2 KB",
    );
    // The name is text, never markup.
    expect(screen.getByText(evil).tagName).toBe("SPAN");
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText(/PNG image, 2 KB, by bea@example.org/)).toBeTruthy();
    expect(screen.getByRole("button", { name: `Delete ${evil}` })).toBeTruthy();
  });

  it("shows nothing for a page that has no files and does not declare them, and never asks for other people", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/data") return json(summary(["data"]));
        if (c.path === "/artifacts/s1/files") return json(list([]));
        return undefined;
      },
    });
    renderDialog();
    await waitFor(() => expect(calls.some((c) => c.path === "/artifacts/s1/files")).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.path === "/artifacts/s1/data")).toBe(true));
    expect(screen.queryByText(/Uploaded files:/)).toBeNull();
    expect(screen.queryByText(/Could not load the uploaded files/)).toBeNull();
    cleanup();

    // Nor when the list cannot load.
    stubApi({
      handle: (c) => (c.path === "/artifacts/s1/data" ? json(summary(["data"])) : undefined),
    });
    renderDialog();
    await screen.findByRole("dialog", { name: "Share this artifact" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Could not load the uploaded files/)).toBeNull();
    cleanup();

    const other = stubApi({ handle: () => json(summary(["files"])) });
    renderDialog(false);
    await screen.findByRole("dialog", { name: "Share this artifact" });
    expect(other.calls.some((c) => c.path.startsWith("/artifacts/s1/files"))).toBe(false);
    expect(other.calls.some((c) => c.path === "/artifacts/s1/data")).toBe(false);
  });

  it("still shows the files of a page whose current version dropped `files`, so the owner can delete them", async () => {
    let files = [file("a".repeat(20), "one.png"), file("b".repeat(20), "two.png")];
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/data") return json(summary(["data"]));
        if (c.path !== "/artifacts/s1/files") return undefined;
        if (c.method === "DELETE") {
          const n = files.length;
          files = [];
          return json({ files: n });
        }
        return json(list(files));
      },
    });
    const user = userEvent.setup();
    renderDialog();
    expect((await screen.findByText(/Uploaded files:/)).textContent).toBe(
      "Uploaded files: 2 files, 4.1 KB",
    );
    await user.click(screen.getByRole("button", { name: "Delete all uploaded files" }));
    await user.click(await screen.findByRole("button", { name: "Delete 2 files" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/artifacts/s1/files")).toBe(
        true,
      ),
    );
    // Once they are gone, a page that does not declare `files` shows no block at all.
    await waitFor(() => expect(screen.queryByText(/Uploaded files:/)).toBeNull());
  });

  it("deletes one file with the CSRF header and shows the list again", async () => {
    let files = [file("a".repeat(20), "one.png"), file("b".repeat(20), "two.png")];
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/data") return json(summary(["files"]));
        if (c.path === "/artifacts/s1/files" && c.method === "GET") return json(list(files));
        if (c.method === "DELETE" && c.path === `/artifacts/s1/files/${"a".repeat(20)}`) {
          files = files.slice(1);
          return json({ deleted: "a".repeat(20) });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Delete one.png" }));
    await waitFor(() => expect(screen.queryByText("one.png")).toBeNull());
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.headers[CSRF_HEADER]).toBe("tok-123");
    expect(screen.getByText("Uploaded files: 1 file, 2 KB")).toBeTruthy();
    expect(await screen.findByText("File deleted")).toBeTruthy();
  });

  it("asks before deleting all, then sends DELETE for the whole store", async () => {
    let files = [file("a".repeat(20), "one.png"), file("b".repeat(20), "two.png")];
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/data") return json(summary(["files"]));
        if (c.path !== "/artifacts/s1/files") return undefined;
        if (c.method === "DELETE") {
          const n = files.length;
          files = [];
          return json({ files: n });
        }
        return json(list(files));
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Delete all uploaded files" }));
    const confirm = await screen.findByRole("alertdialog", { name: /Delete all uploaded files/ });
    expect(confirm.textContent).toContain("2 files");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(await screen.findByRole("button", { name: "Delete all uploaded files" }));
    await user.click(await screen.findByRole("button", { name: "Delete 2 files" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/artifacts/s1/files")).toBe(
        true,
      ),
    );
    expect(await screen.findByText("Uploaded files: 0 files, 0 B")).toBeTruthy();
    expect(await screen.findByText("Uploaded files deleted")).toBeTruthy();
  });
});
