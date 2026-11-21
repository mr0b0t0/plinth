// A design's server-rendered downloads (docs/spec.md "Designs"): "Download .png" downloads a
// design's one board straight from the menu, or opens this dialog to pick one when it has more;
// "Download .pdf" downloads every board straight from the menu. A PNG is at 2x where the board
// fits the pixel cap, else at 1x. Offered only where the instance renders exports
// (AppConfig.design_export). Board names come from the design's source, untrusted text, and reach
// the page only as React text.
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { DESIGN_EXPORT, type DesignExportOptions } from "@plinth/shared";
import { useEffect, useState } from "react";
import { ApiRequestError, fetchDesignExport, getDesignExportOptions } from "../../lib/api.ts";
import { Button, Dialog, dismissToast, Select, Stack, showToast } from "../ui/index.ts";

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** The artifact id or slug. */
  artifactRef: string;
  /** The version on screen, which is the one exported. */
  version: number;
}

/** The PNG scale for a board: 2x where it fits the pixel cap, else 1x, else null (PDF only). */
export function pngScale(
  b: { width: number; height: number },
  max: number = DESIGN_EXPORT.maxPixels,
): 1 | 2 | null {
  const px = b.width * b.height;
  if (px * 4 <= max) return 2;
  return px <= max ? 1 : null;
}

/** Save a file the app fetched, as a download. */
export function saveBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The words for a refusal over the instance's or the design's hourly export limit. */
export const TOO_MANY = "Too many downloads. Try again later.";

const TOO_BIG = "Too big for a .png. Download the .pdf.";

function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    if (err.code === "rate_limited" && (reason === "instance_limit" || reason === "artifact_limit"))
      return TOO_MANY;
    return err.message;
  }
  return "The export could not be made. Try again.";
}

/** Designs whose PDF is being made, so a second click waits for the first. */
const makingPdf = new Set<string>();
/** Designs whose Download .png is under way, likewise. */
const makingPng = new Set<string>();

/**
 * Download .png from the menu: a design with one board downloads it at once, with a toast while
 * it renders, as Download .pdf does; a design with more opens the board picker (`pick`).
 */
export async function downloadDesignPng(
  artifactRef: string,
  version: number,
  pick: () => void,
): Promise<void> {
  if (makingPng.has(artifactRef)) return;
  makingPng.add(artifactRef);
  let toast: number | null = null;
  try {
    const options = await getDesignExportOptions(artifactRef, version);
    const [board, ...more] = options.boards;
    if (!board || more.length > 0) {
      pick();
      return;
    }
    const scale = pngScale(board, options.max_pixels);
    if (scale === null) {
      showToast({ title: TOO_BIG, tone: "danger" });
      return;
    }
    toast = showToast({ title: "Making the .png…", duration: 0 });
    const file = await fetchDesignExport(artifactRef, {
      format: "png",
      version: options.version,
      board: board.id,
      scale,
    });
    saveBlob(file.blob, file.filename);
  } catch (err) {
    showToast({ title: errorText(err), tone: "danger" });
  } finally {
    if (toast !== null) dismissToast(toast);
    makingPng.delete(artifactRef);
  }
}

/**
 * Download every board of the version on screen as one PDF. A toast shows while the server
 * renders it; a clean download needs no other word (the browser shows it), a refusal says why.
 */
export async function downloadDesignPdf(artifactRef: string, version: number): Promise<void> {
  if (makingPdf.has(artifactRef)) return;
  makingPdf.add(artifactRef);
  const toast = showToast({ title: "Making the .pdf…", duration: 0 });
  try {
    const file = await fetchDesignExport(artifactRef, { format: "pdf", version });
    saveBlob(file.blob, file.filename);
  } catch (err) {
    showToast({ title: errorText(err), tone: "danger" });
  } finally {
    dismissToast(toast);
    makingPdf.delete(artifactRef);
  }
}

export function ExportDialog({ open, onClose, artifactRef, version }: ExportDialogProps) {
  const [options, setOptions] = useState<DesignExportOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [board, setBoard] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOptions(null);
    setLoadError(null);
    setError(null);
    const ctrl = new AbortController();
    getDesignExportOptions(artifactRef, version, ctrl.signal)
      .then(setOptions)
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(errorText(err));
      });
    return () => ctrl.abort();
  }, [open, artifactRef, version]);

  const boards = options?.boards ?? [];
  // No pick yet, or a board this version lacks: the first board.
  const chosen = boards.find((b) => b.id === board) ?? boards[0];
  const scale = chosen ? pngScale(chosen, options?.max_pixels) : null;

  const download = async () => {
    if (!options || !chosen || scale === null) return;
    setBusy(true);
    setError(null);
    try {
      const file = await fetchDesignExport(artifactRef, {
        format: "png",
        version: options.version,
        board: chosen.id,
        scale,
      });
      saveBlob(file.blob, file.filename);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Download .png"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={DownloadSimpleIcon}
            onClick={() => void download()}
            loading={busy}
            disabled={!chosen || scale === null}
          >
            Download
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        {loadError ? (
          <p className="pl-field__error" role="alert">
            {loadError}
          </p>
        ) : (
          <Select
            label="Artboard"
            value={chosen?.id ?? ""}
            onChange={(e) => {
              setBoard(e.currentTarget.value);
              setError(null);
            }}
            disabled={!options || busy}
            options={
              options
                ? boards.map((b) => ({
                    value: b.id,
                    label: `${b.name} (${b.width} × ${b.height})`,
                  }))
                : [{ value: "", label: "Loading boards…" }]
            }
          />
        )}
        {chosen && scale === null && (
          <p className="pl-field__error" role="alert">
            {TOO_BIG}
          </p>
        )}
        {error && (
          <p className="pl-field__error" role="alert">
            {error}
          </p>
        )}
      </Stack>
    </Dialog>
  );
}
