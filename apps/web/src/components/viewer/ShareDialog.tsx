// Share: the artifact's app link to copy, what the link opens for whoever gets it, and (for the
// owner) the way to the sharing settings, to who opened it (the artifact's Stats) and to the page's
// shared data (how much, and delete all).
import {
  ChartLineUpIcon,
  CopyIcon,
  GearSixIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES, type DataSummary, route, type Visibility } from "@plinth/shared";
import { useEffect, useRef, useState } from "react";
import { deleteAllData, getDataSummary } from "../../lib/api.ts";
import { formatBytes } from "../history/format.ts";
import {
  Button,
  ButtonLink,
  ConfirmDialog,
  Dialog,
  Input,
  Stack,
  useToast,
  VISIBILITY_META,
} from "../ui/index.ts";
import "./viewer.css";

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  link: string;
  slug: string;
  visibility: Visibility;
  isOwner: boolean;
}

/** Copy text to the clipboard. Resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareDialog({ open, onClose, link, slug, visibility, isOwner }: ShareDialogProps) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const meta = VISIBILITY_META[visibility];
  const data = useSharedData(open && isOwner, slug);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const docs = data.summary?.usage.docs ?? 0;

  // Closing the dialog from outside drops a pending confirmation and an old error.
  useEffect(() => {
    if (open) return;
    setConfirming(false);
    setDeleteError(null);
  }, [open]);

  // The confirmation replaces the share dialog while it is open (one modal at a time), and the
  // share dialog comes back when it closes.
  const deleteAll = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAllData(slug);
      toast.success("Shared data deleted");
      data.reload();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Try again.");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const copy = async () => {
    if (await copyText(link)) {
      toast.success("Link copied");
    } else {
      inputRef.current?.select();
      toast.error("Could not copy the link", "It is selected: copy it with your keyboard.");
    }
  };

  return (
    <>
      <Dialog
        open={open && !confirming}
        onClose={onClose}
        title="Share this artifact"
        description={`${meta.label}: ${meta.description}`}
        initialFocus={inputRef}
        footer={
          <>
            {isOwner && (
              <ButtonLink
                to={route(APP_ROUTES.settings, { slug })}
                variant="ghost"
                icon={GearSixIcon}
              >
                Sharing settings
              </ButtonLink>
            )}
            <Button variant="primary" icon={CopyIcon} onClick={copy}>
              Copy link
            </Button>
          </>
        }
      >
        <Stack gap={3}>
          <Input
            ref={inputRef}
            label="Link"
            value={link}
            readOnly
            mono
            onFocus={(e) => e.currentTarget.select()}
          />
          {isOwner && (
            <div>
              <ButtonLink
                to={route(APP_ROUTES.artifactStats, { slug })}
                size="sm"
                icon={ChartLineUpIcon}
              >
                See who opened it
              </ButtonLink>
            </div>
          )}
          {isOwner && (
            <SharedDataRow
              state={data}
              deleteError={deleteError}
              onDelete={() => {
                setDeleteError(null);
                setConfirming(true);
              }}
            />
          )}
        </Stack>
      </Dialog>
      <ConfirmDialog
        open={open && confirming}
        onClose={() => !deleting && setConfirming(false)}
        onConfirm={deleteAll}
        loading={deleting}
        danger
        title="Delete all shared data?"
        description={`This deletes ${entries(docs)} saved by people using this page. It cannot be undone; the page keeps working and starts empty.`}
        confirmLabel={`Delete ${entries(docs)}`}
      />
    </>
  );
}

const entries = (n: number) => `${n} ${n === 1 ? "entry" : "entries"}`;

interface SharedDataState {
  status: "idle" | "loading" | "ok" | "error";
  summary: DataSummary | null;
  reload: () => void;
}

/** The artifact's shared data summary, read while `active` (the owner's open dialog). */
function useSharedData(active: boolean, ref: string): SharedDataState {
  const [status, setStatus] = useState<SharedDataState["status"]>("idle");
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the reload trigger
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    setStatus("loading");
    getDataSummary(ref, ctrl.signal)
      .then((s) => {
        setSummary(s);
        setStatus("ok");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus("error");
      });
    return () => ctrl.abort();
  }, [active, ref, nonce]);
  return { status, summary, reload: () => setNonce((n) => n + 1) };
}

/**
 * "Shared data: N entries, X KB" with Delete all, only when the page declares shared data or has
 * some. Nothing while loading, so pages without data show no flash.
 */
function SharedDataRow({
  state,
  deleteError,
  onDelete,
}: {
  state: SharedDataState;
  deleteError: string | null;
  onDelete: () => void;
}) {
  if (state.status === "error") {
    return (
      <p className="pl-field__error" role="alert">
        <WarningCircleIcon aria-hidden="true" />
        <span>
          Could not load the shared data usage. Close and reopen this dialog to try again.
        </span>
      </p>
    );
  }
  const s = state.summary;
  // `room` alone is not shared data; a page keeps data only when it declares `data`.
  if (!s || (s.usage.docs === 0 && !s.capabilities.includes("data"))) return null;
  return (
    <div className="pl-share-data">
      <div className="pl-share-data__row">
        <p className="pl-share-data__usage" role="status">
          Shared data: {entries(s.usage.docs)}, {formatBytes(s.usage.bytes)}
        </p>
        {s.usage.docs > 0 && (
          <Button variant="danger" size="sm" icon={TrashIcon} onClick={onDelete}>
            Delete all shared data
          </Button>
        )}
      </div>
      {deleteError && (
        <p className="pl-field__error" role="alert">
          <WarningCircleIcon aria-hidden="true" />
          <span>Could not delete the shared data. {deleteError}</span>
        </p>
      )}
    </div>
  );
}
