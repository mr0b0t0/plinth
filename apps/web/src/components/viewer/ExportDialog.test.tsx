// The design export dialog and its menu item: offered only where the instance renders exports,
// it lists the version's boards (names as text), asks for one board for a PNG (1x or 2x, 2x only
// within the pixel cap) or every board or one for a PDF, fetches the file from the app host and
// saves it, and shows the server's message when the export is refused.
import type { DesignExportOptions } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentName, designExportUrl } from "../../lib/api.ts";
import { clearToasts, Toaster } from "../ui/index.ts";
import { downloadDesign } from "./designItems.ts";
import { ExportDialog, fitsPixels } from "./ExportDialog.tsx";
import { type StageContext, TYPE_MENU_ITEMS } from "./stageItems.tsx";
import { apiError, CONFIG, json, stubApi } from "./test-utils.ts";

const OPTIONS: DesignExportOptions = {
  id: "abcdefghij0123456789",
  version: 2,
  boards: [
    { id: "home", name: 'Home <img src=x onerror="window.__pwned=1">', width: 393, height: 852 },
    { id: "poster", name: "Poster", width: 4096, height: 4096 },
  ],
  formats: ["png", "pdf"],
  scales: [1, 2],
  max_pixels: 33_554_432,
  available: true,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function file(type: string, name: string) {
  return new Response(PNG, {
    status: 200,
    headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"` },
  });
}

let saved: { href: string; download: string }[] = [];

beforeEach(() => {
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, download: this.download });
  });
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://app.localhost:8787/1");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderDialog(onClose = vi.fn()) {
  render(
    <>
      <ExportDialog open onClose={onClose} artifactRef="launch-kit" version={2} />
      <Toaster />
    </>,
  );
  return onClose;
}

describe("the menu item", () => {
  const ctx = (designExport: boolean | undefined, openExport = vi.fn()) =>
    ({
      config: { ...CONFIG, design_export: designExport },
      actions: { openExport },
    }) as unknown as StageContext;

  it("is a design's, after Print, and only where the instance renders exports", () => {
    expect(TYPE_MENU_ITEMS.design?.[1]).toBe(downloadDesign);
    expect(TYPE_MENU_ITEMS.doc).not.toContain(downloadDesign);
    expect(downloadDesign(ctx(undefined))).toEqual([]);
    expect(downloadDesign(ctx(false))).toEqual([]);
    const open = vi.fn();
    const [entry] = downloadDesign(ctx(true, open));
    expect(entry).toMatchObject({ label: "Download PNG or PDF…" });
    (entry as { onSelect: () => void }).onSelect();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("ExportDialog", () => {
  it("lists the version's boards as text and downloads a 2x PNG of the chosen board", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/launch-kit/export/options?version=2") return json(OPTIONS);
        if (c.path.startsWith("/artifacts/launch-kit/export?"))
          return file("image/png", "launch-kit-home.png");
        return undefined;
      },
    });
    const onClose = renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    // A PNG is one board: no "All boards"; names are text, never markup.
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Home <img src=x onerror="window.__pwned=1"> (393 × 852)',
      "Poster (4096 × 4096)",
    ]);
    expect(document.querySelector("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Download PNG" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const exp = calls.find((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exp?.method).toBe("GET");
    expect(exp?.path).toBe("/artifacts/launch-kit/export?format=png&version=2&board=home&scale=2");
    expect(saved).toEqual([
      { href: "blob:http://app.localhost:8787/1", download: "launch-kit-home.png" },
    ]);
    expect(await screen.findByText("PNG downloaded")).toBeTruthy();
  });

  it("offers every board for a PDF, and sends no scale", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/artifacts/launch-kit/export/options")) return json(OPTIONS);
        if (c.path.startsWith("/artifacts/launch-kit/export?"))
          return file("application/pdf", "launch-kit.pdf");
        return undefined;
      },
    });
    renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    expect(screen.queryByRole("radio", { name: "2x" })).toBeNull();
    await userEvent.selectOptions(select, "");
    expect(select.value).toBe("");
    expect([...select.options][0]?.textContent).toBe("All boards");
    await userEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const exp = calls.find((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exp?.path).toBe("/artifacts/launch-kit/export?format=pdf&version=2");
    expect(saved[0]?.download).toBe("launch-kit.pdf");
  });

  it("switches to every board when PDF is picked, and a board can still be chosen after", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/artifacts/launch-kit/export/options")) return json(OPTIONS);
        if (c.path.startsWith("/artifacts/launch-kit/export?"))
          return file("application/pdf", "launch-kit.pdf");
        return undefined;
      },
    });
    renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("home");
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    expect(select.value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const exports = () => calls.filter((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exports()[0]?.path).toBe("/artifacts/launch-kit/export?format=pdf&version=2");
  });

  it("keeps a board picked for the PDF, and back on PNG picks one again for All boards", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/artifacts/launch-kit/export/options")) return json(OPTIONS);
        if (c.path.startsWith("/artifacts/launch-kit/export?"))
          return file("application/pdf", "launch-kit-poster.pdf");
        return undefined;
      },
    });
    renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    await userEvent.click(screen.getByRole("radio", { name: "PNG" }));
    expect(select.value).toBe("home");
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    await userEvent.selectOptions(select, "poster");
    await userEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const exp = calls.find((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exp?.path).toBe("/artifacts/launch-kit/export?format=pdf&version=2&board=poster");
  });

  it("keeps every board for a PDF when the dialog is opened again", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/artifacts/launch-kit/export/options")) return json(OPTIONS);
        if (c.path.startsWith("/artifacts/launch-kit/export?"))
          return file("application/pdf", "launch-kit.pdf");
        return undefined;
      },
    });
    // The viewer keeps the dialog mounted, so its choices outlive a close.
    const view = (open: boolean) => (
      <ExportDialog open={open} onClose={vi.fn()} artifactRef="launch-kit" version={2} />
    );
    const { rerender } = render(view(true));
    let select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    expect(select.value).toBe("");
    rerender(view(false));
    rerender(view(true));
    select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect((screen.getByRole("radio", { name: "PDF" }) as HTMLInputElement).checked).toBe(true);
    expect(select.value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const exp = calls.find((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exp?.path).toBe("/artifacts/launch-kit/export?format=pdf&version=2");
  });

  it("keeps every board for a PDF picked while the boards are still loading", async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/artifacts/launch-kit/export/options")) return pending;
        if (c.path.startsWith("/artifacts/launch-kit/export?"))
          return file("application/pdf", "launch-kit.pdf");
        return undefined;
      },
    });
    renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    release(json(OPTIONS));
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const exp = calls.find((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exp?.path).toBe("/artifacts/launch-kit/export?format=pdf&version=2");
  });

  it("keeps every board for a PDF across a version change, and drops a board the version lacks", async () => {
    const v3: DesignExportOptions = {
      ...OPTIONS,
      version: 3,
      boards: [{ id: "cover", name: "Cover", width: 800, height: 600 }],
    };
    stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/launch-kit/export/options?version=2") return json(OPTIONS);
        if (c.path === "/artifacts/launch-kit/export/options?version=3") return json(v3);
        if (c.path === "/artifacts/launch-kit/export/options?version=4") return json(OPTIONS);
        return undefined;
      },
    });
    const view = (version: number) => (
      <ExportDialog open onClose={vi.fn()} artifactRef="launch-kit" version={version} />
    );
    const { rerender } = render(view(2));
    let select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    rerender(view(3));
    select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    expect(select.value).toBe("");
    // A board picked for the PDF that the next version does not have falls back to every board.
    await userEvent.selectOptions(select, "cover");
    rerender(view(4));
    await waitFor(() => expect(select.options).toHaveLength(3));
    expect(select.value).toBe("");
    // Back on PNG, the first board is chosen.
    await userEvent.click(screen.getByRole("radio", { name: "PNG" }));
    expect(select.value).toBe("home");
  });

  it("keeps 2x off for a board over the pixel cap", async () => {
    stubApi({ handle: (c) => (c.path.includes("/export/options") ? json(OPTIONS) : undefined) });
    renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "poster");
    expect(await screen.findByText("This board is too big for a 2x PNG. Choose 1x.")).toBeTruthy();
    const download = screen.getByRole("button", { name: "Download PNG" }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "1x" }));
    expect(download.disabled).toBe(false);
  });

  it("shows the server's message when the export is refused, and saves nothing", async () => {
    stubApi({
      handle: (c) => {
        if (c.path.includes("/export/options")) return json(OPTIONS);
        if (c.path.includes("/export?"))
          return apiError(429, "rate_limited", "Export limit reached (30 per hour)");
        return undefined;
      },
    });
    const onClose = renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Download PNG" }));
    const message = await screen.findByText("Export limit reached (30 per hour)");
    expect(message.getAttribute("role")).toBe("alert");
    expect(saved).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says when the boards cannot be read", async () => {
    stubApi({ handle: () => apiError(404, "not_found", "Artifact not found") });
    renderDialog();
    const message = await screen.findByText("Artifact not found");
    expect(message.getAttribute("role")).toBe("alert");
  });
});

describe("helpers", () => {
  it("build the export URL on the app host", () => {
    expect(designExportUrl("s1", { format: "png", version: 3, board: "home", scale: 1 })).toBe(
      "/api/v1/artifacts/s1/export?format=png&version=3&board=home&scale=1",
    );
    expect(designExportUrl("s1", { format: "pdf", version: 3, scale: 2 })).toBe(
      "/api/v1/artifacts/s1/export?format=pdf&version=3",
    );
  });

  it("take only a plain file name from Content-Disposition", () => {
    expect(attachmentName('attachment; filename="kit-home.png"', "design.png")).toBe(
      "kit-home.png",
    );
    expect(attachmentName('attachment; filename="../x\\y.png"', "design.png")).toBe("design.png");
    expect(attachmentName(null, "design.pdf")).toBe("design.pdf");
  });

  it("check the pixel cap", () => {
    expect(fitsPixels({ width: 4096, height: 4096 }, 1)).toBe(true);
    expect(fitsPixels({ width: 4096, height: 4096 }, 2)).toBe(false);
    expect(fitsPixels({ width: 4096, height: 2048 }, 2)).toBe(true);
  });
});
