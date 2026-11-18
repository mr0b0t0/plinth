// One quiet line under the viewer bar when the page keeps shared data or learns who is viewing:
// what the page can see and what it saves. It is the main anti-phishing signal for pages that
// collect input, so it says plainly who sees the entries. Design: shared-state section 12.
import { DatabaseIcon } from "@phosphor-icons/react";
import type { ViewGateData } from "@plinth/shared";

const SAVES_WITH_AUTHORS =
  "saves what you enter. People with access can see the entries and who wrote them.";
const SAVES =
  "This page saves what you enter. People with access can see the entries; the owner and editors can see who wrote them.";
const READ_ONLY =
  "This page shows entries saved by people it is shared with. You can view them but not add your own.";
const UNAVAILABLE = "Shared data is not available on this server.";

/** The notice for a gate's data block, or null when there is nothing to say. */
export function dataNoticeText(data: ViewGateData | undefined): string | null {
  if (!data) return null;
  // A live room that shows this viewer's email to the page and to the others in it.
  const room = data.room_email;
  const roomOnly = room
    ? `This page can see that you are ${room} and shows it to the other people who have it open.`
    : null;
  if (!data.capabilities.includes("data")) return roomOnly;
  if (!data.available) return roomOnly ? `${roomOnly} ${UNAVAILABLE}` : UNAVAILABLE;
  const email = data.capabilities.includes("viewer") && data.identified ? data.email : undefined;
  if (email && room) {
    return `This page can see that you are ${email}, shows it to the other people who have it open, and ${SAVES_WITH_AUTHORS}`;
  }
  if (email) return `This page can see that you are ${email} and ${SAVES_WITH_AUTHORS}`;
  const saves = data.identified ? SAVES : READ_ONLY;
  return roomOnly ? `${roomOnly} ${saves}` : saves;
}

export function DataNotice({ data }: { data: ViewGateData | undefined }) {
  const text = dataNoticeText(data);
  if (!text) return null;
  return (
    <p className="pl-viewer__notice pl-viewer__data" role="note">
      <DatabaseIcon size={14} aria-hidden="true" className="pl-viewer__data-icon" />
      <span>{text}</span>
    </p>
  );
}
