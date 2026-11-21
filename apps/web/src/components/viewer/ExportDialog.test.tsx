// A design's downloads, offered only where the instance renders exports: "Download .png" saves a
// design's one board straight from the menu or opens a board picker (names as text), and takes the
// board at 2x where it fits the pixel cap, else at 1x; "Download .pdf" saves every board straight
// from the menu with a toast while it renders. Each fetches the file from the app host, saves it,
// and shows the server's message when refused (a short one past the shared hourly limits).
import { DESIGN_EXPORT, type DesignExportOptions } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentName, designExportUrl } from "../../lib/api.ts";
import { clearToasts, Toaster } from "../ui/index.ts";
import { DESIGN_EXPORT_DIALOG, downloadDesign } from "./designItems.tsx";
import { downloadDesignPdf, ExportDialog, pngScale, TOO_MANY } from "./ExportDialog.tsx";
import { STAGE_DIALOGS, type StageContext, TYPE_MENU_ITEMS } from "./stageItems.tsx";
import { apiError, CONFIG, json, stubApi } from "./test-utils.ts";

const OPTIONS: DesignExportOptions = {
  id: "abcdefghij0123456789",
  version: 2,
  boards: [
    { id: "home", name: 'Home <img src=x onerror="window.__pwned=1">', width: 393, height: 852 },
    { id: "poster", name: "Poster", width: 1728, height: 2304 },
  ],
  max_pixels: DESIGN_EXPORT.maxPixels,
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

describe("the menu items", () => {
  const ctx = (designExport: boolean | undefined, openDialog = vi.fn()) =>
    ({
      config: { ...CONFIG, design_export: designExport },
      gate: { artifact: { id: "launch-kit", version: 2 } },
      actions: { openDialog },
    }) as unknown as StageContext;

  it("are a design's, only where the instance renders exports", async () => {
    stubApi({
      handle: (c) =>
        c.path === "/artifacts/launch-kit/export/options?version=2" ? json(OPTIONS) : undefined,
    });
    expect(TYPE_MENU_ITEMS.design?.[1]).toBe(downloadDesign);
    expect(TYPE_MENU_ITEMS.doc).not.toContain(downloadDesign);
    expect(downloadDesign(ctx(undefined))).toEqual([]);
    expect(downloadDesign(ctx(false))).toEqual([]);
    const open = vi.fn();
    const [png, pdf] = downloadDesign(ctx(true, open));
    expect(png).toMatchObject({ label: "Download .png" });
    expect(pdf).toMatchObject({ label: "Download .pdf" });
    // Two boards: the picker.
    (png as { onSelect: () => void }).onSelect();
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith(DESIGN_EXPORT_DIALOG);
    expect(saved).toEqual([]);
    expect(STAGE_DIALOGS.map((d) => d.id)).toContain(DESIGN_EXPORT_DIALOG);
  });

  it("download a design's one board as a PNG straight from the menu, with no picker", async () => {
    const one: DesignExportOptions = {
      ...OPTIONS,
      boards: [{ id: "post", name: "Launch post", width: 1080, height: 1080 }],
    };
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/launch-kit/export/options?version=2") return json(one);
        if (c.path.startsWith("/artifacts/launch-kit/export?")) return pending;
        return undefined;
      },
    });
    render(<Toaster />);
    const open = vi.fn();
    const [png] = downloadDesign(ctx(true, open));
    (png as { onSelect: () => void }).onSelect();
    expect(await screen.findByText("Making the .png…")).toBeTruthy();
    // A second click while it renders asks for nothing more.
    (png as { onSelect: () => void }).onSelect();
    release(file("image/png", "launch-kit-post.png"));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(open).not.toHaveBeenCalled();
    const exports = calls.filter((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    // 1080x1080 is over 4,000,000 px at 2x: 1x.
    expect(exports.map((c) => c.path)).toEqual([
      "/artifacts/launch-kit/export?format=png&version=2&board=post&scale=1",
    ]);
    expect(saved[0]?.download).toBe("launch-kit-post.png");
    await waitFor(() => expect(screen.queryByText("Making the .png…")).toBeNull());
  });

  it("say only that there are too many downloads when the instance's or the design's limit is reached", async () => {
    for (const reason of ["instance_limit", "artifact_limit"]) {
      stubApi({
        handle: (c) =>
          c.path.includes("/export?")
            ? new Response(
                JSON.stringify({
                  error: {
                    code: "rate_limited",
                    message: "This instance's export limit is reached (120 per hour)",
                    details: { retry_after: 600, reason },
                  },
                }),
                { status: 429, headers: { "Content-Type": "application/json" } },
              )
            : undefined,
      });
      render(<Toaster />);
      await downloadDesignPdf("launch-kit", 2);
      expect(await screen.findByText(TOO_MANY), reason).toBeTruthy();
      expect(TOO_MANY).toBe("Too many downloads. Try again later.");
      expect(saved).toEqual([]);
      cleanup();
      clearToasts();
    }
  });

  it("download every board as a PDF from the menu, with a toast while it renders", async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { calls } = stubApi({
      handle: (c) => (c.path.startsWith("/artifacts/launch-kit/export?") ? pending : undefined),
    });
    render(<Toaster />);
    const [, pdf] = downloadDesign(ctx(true));
    (pdf as { onSelect: () => void }).onSelect();
    expect(await screen.findByText("Making the .pdf…")).toBeTruthy();
    // A second click while it renders asks for nothing more.
    (pdf as { onSelect: () => void }).onSelect();
    release(file("application/pdf", "launch-kit.pdf"));
    await waitFor(() => expect(saved).toHaveLength(1));
    const exports = calls.filter((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exports.map((c) => c.path)).toEqual([
      "/artifacts/launch-kit/export?format=pdf&version=2",
    ]);
    expect(saved[0]?.download).toBe("launch-kit.pdf");
    await waitFor(() => expect(screen.queryByText("Making the .pdf…")).toBeNull());
  });

  it("say why a PDF was refused, and save nothing", async () => {
    stubApi({
      handle: (c) =>
        c.path.includes("/export?")
          ? apiError(429, "rate_limited", "Export limit reached (30 per hour)")
          : undefined,
    });
    render(<Toaster />);
    await downloadDesignPdf("launch-kit", 2);
    expect(await screen.findByText("Export limit reached (30 per hour)")).toBeTruthy();
    expect(screen.queryByText("Making the .pdf…")).toBeNull();
    expect(saved).toEqual([]);
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
    expect(screen.getByRole("dialog", { name: "Download .png" })).toBeTruthy();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    // Names are text, never markup.
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Home <img src=x onerror="window.__pwned=1"> (393 × 852)',
      "Poster (1728 × 2304)",
    ]);
    expect(document.querySelector("img")).toBeNull();
    expect(select.value).toBe("home");
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const exp = calls.find((c) => c.path.startsWith("/artifacts/launch-kit/export?"));
    expect(exp?.method).toBe("GET");
    expect(exp?.path).toBe("/artifacts/launch-kit/export?format=png&version=2&board=home&scale=2");
    expect(saved).toEqual([
      { href: "blob:http://app.localhost:8787/1", download: "launch-kit-home.png" },
    ]);
  });

  it("takes a board too big for 2x at 1x", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.includes("/export/options")) return json(OPTIONS);
        if (c.path.includes("/export?")) return file("image/png", "launch-kit-poster.png");
        return undefined;
      },
    });
    renderDialog();
    const select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "poster");
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const exp = calls.find((c) => c.path.includes("/export?"));
    expect(exp?.path).toBe(
      "/artifacts/launch-kit/export?format=png&version=2&board=poster&scale=1",
    );
  });

  it("says a board over the pixel cap at 1x is a PDF's", async () => {
    const big: DesignExportOptions = {
      ...OPTIONS,
      boards: [{ id: "poster", name: "Poster", width: 4096, height: 4096 }],
    };
    stubApi({ handle: (c) => (c.path.includes("/export/options") ? json(big) : undefined) });
    renderDialog();
    expect(await screen.findByText("Too big for a .png. Download the .pdf.")).toBeTruthy();
    const download = screen.getByRole("button", { name: "Download" }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
  });

  it("takes the first board when the version lacks the one picked", async () => {
    const v3: DesignExportOptions = {
      ...OPTIONS,
      version: 3,
      boards: [{ id: "cover", name: "Cover", width: 800, height: 600 }],
    };
    stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/launch-kit/export/options?version=2") return json(OPTIONS);
        if (c.path === "/artifacts/launch-kit/export/options?version=3") return json(v3);
        return undefined;
      },
    });
    const view = (version: number) => (
      <ExportDialog open onClose={vi.fn()} artifactRef="launch-kit" version={version} />
    );
    const { rerender } = render(view(2));
    let select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "poster");
    rerender(view(3));
    select = (await screen.findByRole("combobox", { name: "Artboard" })) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(1));
    await waitFor(() => expect(select.value).toBe("cover"));
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
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
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

  it("pick the PNG scale within the pixel cap", () => {
    // DESIGN_EXPORT.maxPixels (4,000,000): a PNG that does not compress still fits maxBytes.
    expect(DESIGN_EXPORT.maxPixels).toBe(4_000_000);
    expect(pngScale({ width: 1000, height: 1000 })).toBe(2);
    expect(pngScale({ width: 1280, height: 720 })).toBe(2);
    expect(pngScale({ width: 1080, height: 1080 })).toBe(1);
    expect(pngScale({ width: 1920, height: 1080 })).toBe(1);
    // A fluid board grows as it renders: never 2x.
    expect(pngScale({ width: 1000, height: 1000, auto_height: true })).toBe(1);
    expect(pngScale({ width: 1728, height: 2304 })).toBe(1);
    expect(pngScale({ width: 2000, height: 3000 })).toBeNull();
    expect(pngScale({ width: 4096, height: 4096 })).toBeNull();
    expect(pngScale({ width: 100, height: 100 }, 20_000)).toBe(1);
  });
});
