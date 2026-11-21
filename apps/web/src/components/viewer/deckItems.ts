// A deck's ⋯ menu item while it is edited on the page, "Deck settings…": the frame opens its
// settings popover (aspect, theme, page numbers, footer) and writes them with its own struct op
// over the draft socket, so nothing here touches the deck's text. The item exists only in edit
// mode, where the frame is at the exact content origin (inline editing runs only under origin
// isolation); the message carries no data. Also the words the strip and the Ask dialog use when a
// draft cannot be published yet, per type.
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import type { ArtifactType } from "@plinth/shared";
import { deckSettingsMessage, editTargetOrigin, postToRenderer } from "./rendererProtocol.ts";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem } from "./stageItems.tsx";

export const DECK_SETTINGS_LABEL = "Deck settings…";

/** "Deck settings…", while the deck is edited on the page. */
export const deckSettings: MenuItem = (c) =>
  c.editing && c.live.mode !== null
    ? [
        {
          label: DECK_SETTINGS_LABEL,
          icon: SlidersHorizontalIcon,
          onSelect: () =>
            void postToRenderer(
              c.frame,
              editTargetOrigin(c.config, c.contentOrigin),
              deckSettingsMessage(),
            ),
        },
      ]
    : [];

/**
 * A deck's item that waits until editing ends, as Present does: Print and Download .pptx would
 * take edit mode's slides, empty ones the deck never shows included.
 */
export const notWhileEditing =
  (item: MenuItem): MenuItem =>
  (c) =>
    c.editing ? [] : item(c);

/** Why a draft of the type cannot be published yet (its rules' `unpublishable`), in its words. */
const UNPUBLISHABLE: Partial<Record<ArtifactType, string>> = {
  slides: "Write something on a slide to publish",
};

/** The reason Publish is off for a draft of `type` that cannot be a version yet, if it has one. */
export function unpublishableReason(type: string): string | undefined {
  return Object.hasOwn(UNPUBLISHABLE, type) ? UNPUBLISHABLE[type as ArtifactType] : undefined;
}
