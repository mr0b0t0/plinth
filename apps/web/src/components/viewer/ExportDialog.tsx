// Download a design as PNG or PDF, rendered by the server (docs/spec.md "Designs"): PNG is one
// artboard at 1x or 2x, PDF every board or one, each on a page of its own size. Offered only where
// the instance renders exports (AppConfig.design_export). Board names come from the design's
// source, untrusted text, and reach the page only as React text.
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { DESIGN_EXPORT, type DesignExportOptions } from "@plinth/shared";
import { useEffect, useState } from "react";
import { ApiRequestError, fetchDesignExport, getDesignExportOptions } from "../../lib/api.ts";
import { Button, Dialog, SegmentedControl, Select, Stack, useToast } from "../ui/index.ts";

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** The artifact id or slug. */
  artifactRef: string;
  /** The version on screen, which is the one exported. */
  version: number;
}

type Format = "png" | "pdf";
type Scale = "1" | "2";
/** No board picked: every board for a PDF, the first board for a PNG. */
const ALL = "";

/** Whether a board fits the PNG pixel cap at this scale. */
export function fitsPixels(
  b: { width: number; height: number },
  scale: number,
  max: number = DESIGN_EXPORT.maxPixels,
): boolean {
  return b.width * b.height * scale * scale <= max;
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

function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return "The export could not be made. Try again.";
}

export function ExportDialog({ open, onClose, artifactRef, version }: ExportDialogProps) {
  const toast = useToast();
  const [options, setOptions] = useState<DesignExportOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [format, setFormat] = useState<Format>("png");
  const [board, setBoard] = useState<string>(ALL);
  const [scale, setScale] = useState<Scale>("2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOptions(null);
    setLoadError(null);
    setError(null);
    const ctrl = new AbortController();
    getDesignExportOptions(artifactRef, version, ctrl.signal)
      .then((o) => {
        setOptions(o);
        // Keep the choice unless this version lacks that board. Never pick a board here: the
        // dialog outlives a close and the format can change while the boards load, so a PDF's
        // "All boards" must survive a reload.
        setBoard((b) => (b === ALL || o.boards.some((x) => x.id === b) ? b : ALL));
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(errorText(err));
      });
    return () => ctrl.abort();
  }, [open, artifactRef, version]);

  const boards = options?.boards ?? [];
  // A PNG is one board: "All boards" is a PDF choice only, so a PNG without a pick takes the first.
  const chosen = boards.find((b) => b.id === board) ?? (format === "png" ? boards[0] : undefined);
  const scaleNumber = Number(scale) as 1 | 2;
  const tooBig =
    format === "png" &&
    chosen !== undefined &&
    !fitsPixels(chosen, scaleNumber, options?.max_pixels ?? DESIGN_EXPORT.maxPixels);

  const boardOptions = [
    ...(format === "pdf" ? [{ value: ALL, label: "All boards" }] : []),
    ...boards.map((b) => ({ value: b.id, label: `${b.name} (${b.width} × ${b.height})` })),
  ];

  const download = async () => {
    if (!options) return;
    setBusy(true);
    setError(null);
    try {
      const file = await fetchDesignExport(artifactRef, {
        format,
        version: options.version,
        ...(chosen ? { board: chosen.id } : {}),
        ...(format === "png" ? { scale: scaleNumber } : {}),
      });
      saveBlob(file.blob, file.filename);
      toast.success(format === "png" ? "PNG downloaded" : "PDF downloaded");
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
      title="Download PNG or PDF"
      description={`Rendered by the server from version ${version}. A PNG is one artboard; a PDF puts each board on a page of its own size.`}
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
            disabled={!options || tooBig || (format === "png" && !chosen)}
          >
            {busy ? "Rendering…" : `Download ${format.toUpperCase()}`}
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <SegmentedControl<Format>
          label="Format"
          showLabel
          value={format}
          onChange={(f) => {
            setFormat(f);
            setError(null);
            // A PDF starts at every board, its default; a PNG without a pick takes the first.
            if (f === "pdf" && f !== format) setBoard(ALL);
          }}
          options={[
            { value: "png", label: "PNG" },
            { value: "pdf", label: "PDF" },
          ]}
        />
        {loadError ? (
          <p className="pl-field__error" role="alert">
            {loadError}
          </p>
        ) : (
          <Select
            label="Artboard"
            value={format === "png" ? (chosen?.id ?? "") : board}
            onChange={(e) => {
              setBoard(e.currentTarget.value);
              setError(null);
            }}
            disabled={!options}
            options={options ? boardOptions : [{ value: "", label: "Loading boards…" }]}
          />
        )}
        {format === "png" && (
          <SegmentedControl<Scale>
            label="Size"
            showLabel
            value={scale}
            onChange={(s) => {
              setScale(s);
              setError(null);
            }}
            options={[
              { value: "1", label: "1x" },
              { value: "2", label: "2x" },
            ]}
          />
        )}
        {tooBig && (
          <p className="pl-field__error" role="alert">
            This board is too big for a 2x PNG. Choose 1x.
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
