// Share: the artifact's app link to copy, what the link opens for whoever gets it, and (for the
// owner) the way to the sharing settings.
import { CopyIcon, GearSixIcon } from "@phosphor-icons/react";
import { APP_ROUTES, route, type Visibility } from "@plinth/shared";
import { useRef } from "react";
import {
  Button,
  ButtonLink,
  Dialog,
  Input,
  Stack,
  useToast,
  VISIBILITY_META,
} from "../ui/index.ts";

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

  const copy = async () => {
    if (await copyText(link)) {
      toast.success("Link copied");
    } else {
      inputRef.current?.select();
      toast.error("Could not copy the link", "It is selected: copy it with your keyboard.");
    }
  };

  return (
    <Dialog
      open={open}
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
      </Stack>
    </Dialog>
  );
}
