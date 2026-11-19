// The share dialog's Files block (the owner only): the files people uploaded from the page, by
// name as text, type, size, uploader and date, with Delete per file and Delete all. No previews:
// the app never loads bytes from the content host, and a file's name is untrusted text.
import { TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { AgentFile, ArtifactFilesList } from "@plinth/shared";
import { useEffect, useState } from "react";
import { deleteArtifactFile, getArtifactFiles } from "../../lib/api.ts";
import { formatBytes, fullTimestamp, relativeTime } from "../history/format.ts";
import { Button, useToast } from "../ui/index.ts";

export const filesCount = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

export interface FilesState {
  status: "idle" | "loading" | "ok" | "error";
  list: ArtifactFilesList | null;
  reload: () => void;
}

/** The first page of the artifact's files, read while `active` (the owner's open dialog). */
export function useArtifactFiles(active: boolean, ref: string): FilesState {
  const [status, setStatus] = useState<FilesState["status"]>("idle");
  const [list, setList] = useState<ArtifactFilesList | null>(null);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the reload trigger
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    setStatus("loading");
    getArtifactFiles(ref, ctrl.signal)
      .then((l) => {
        setList(l);
        setStatus("ok");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus("error");
      });
    return () => ctrl.abort();
  }, [active, ref, nonce]);
  return { status, list, reload: () => setNonce((n) => n + 1) };
}

/** A file's type, short: "PNG image", "PDF", "MP4 video". */
export function fileKind(type: AgentFile["type"]): string {
  const [family, sub] = type.split("/") as [string, string];
  const label = sub === "mpeg" ? "MP3" : sub === "mp4" && family === "audio" ? "M4A" : sub;
  if (family === "application") return label.toUpperCase();
  return `${label.toUpperCase()} ${family}`;
}

function FileItem({
  file,
  slug,
  onDeleted,
}: {
  file: AgentFile;
  slug: string;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteArtifactFile(slug, file.id);
      toast.success("File deleted");
      onDeleted();
    } catch (err) {
      toast.error("Could not delete the file", err instanceof Error ? err.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };
  const who = file.uploaded_by.email ?? "a person whose account was erased";
  return (
    <li className="pl-share-files__item">
      <div className="pl-share-files__meta">
        <span className="pl-share-files__name">{file.name}</span>
        <span className="pl-share-files__detail">
          {fileKind(file.type)}, {formatBytes(file.size)}, by {who},{" "}
          <time dateTime={file.created_at} title={fullTimestamp(file.created_at)}>
            {relativeTime(file.created_at)}
          </time>
          {file.state === "pending" ? " (still uploading)" : ""}
        </span>
      </div>
      {file.state === "ready" && (
        <Button
          variant="ghost"
          size="sm"
          icon={TrashIcon}
          onClick={remove}
          loading={busy}
          aria-label={`Delete ${file.name}`}
        >
          Delete
        </Button>
      )}
    </li>
  );
}

/**
 * "Uploaded files: N files, X MB" with the list and Delete all, only when the page declares
 * `files` or has some. Nothing while loading, so pages without files show no flash.
 */
export function FilesBlock({
  state,
  slug,
  declared,
  deleteError,
  onDeleteAll,
}: {
  state: FilesState;
  slug: string;
  declared: boolean;
  deleteError: string | null;
  onDeleteAll: () => void;
}) {
  // A page that never declared `files` says nothing, not even when its list could not load.
  if (state.status === "error" && declared) {
    return (
      <p className="pl-field__error" role="alert">
        <WarningCircleIcon aria-hidden="true" />
        <span>Could not load the uploaded files. Close and reopen this dialog to try again.</span>
      </p>
    );
  }
  const l = state.status === "error" ? null : state.list;
  if (!l || (l.usage.files === 0 && !declared)) return null;
  return (
    <section className="pl-share-data" aria-label="Uploaded files">
      <div className="pl-share-data__row">
        <p className="pl-share-data__usage" role="status">
          Uploaded files: {filesCount(l.usage.files)}, {formatBytes(l.usage.bytes)}
        </p>
        {l.usage.files > 0 && (
          <Button variant="danger" size="sm" icon={TrashIcon} onClick={onDeleteAll}>
            Delete all uploaded files
          </Button>
        )}
      </div>
      {l.files.length > 0 && (
        <ul className="pl-share-files">
          {l.files.map((f) => (
            <FileItem key={f.id} file={f} slug={slug} onDeleted={state.reload} />
          ))}
        </ul>
      )}
      {l.next_cursor && (
        <p className="pl-share-data__usage">
          Showing the first {filesCount(l.files.length)}. Delete some to see the rest.
        </p>
      )}
      {deleteError && (
        <p className="pl-field__error" role="alert">
          <WarningCircleIcon aria-hidden="true" />
          <span>Could not delete the uploaded files. {deleteError}</span>
        </p>
      )}
    </section>
  );
}
