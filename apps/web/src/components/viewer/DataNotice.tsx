// One quiet line under the viewer bar when the page keeps shared data or learns who is viewing:
// what the page can see and what it saves. It is the main anti-phishing signal for pages that
// collect input, so it says plainly who sees the entries. Design: shared-state section 12.
//
// The notice is a list of line functions (DATA_NOTICE_LINES), each reading the gate and saying
// one thing or nothing. A feature that lets a page see or save more adds its own line function
// and one line in the list; its text joins the others in one paragraph, in list order.
import { DatabaseIcon } from "@phosphor-icons/react";
import type { ViewGate, ViewGateData } from "@plinth/shared";

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

/** What a notice line reads: the open gate's fields. A feature reads its own sibling of `data`. */
export type NoticeGate = Partial<Omit<Extract<ViewGate, { status: "ok" }>, "status">>;

/** One line of the notice, or null when it has nothing to say for this gate. */
export type NoticeLine = (gate: NoticeGate) => string | null;

/** The people list (`people`), told to every identified viewer: their own address is on it. */
export const PEOPLE_LIST_NOTICE = "The owner and editors can see who has access.";

/**
 * Who is viewing: the display name the page sees beside the email the data line names, and
 * whether the page lists everyone it is shared with. Null when neither applies.
 */
export function peopleNoticeText(gate: NoticeGate): string | null {
  const p = gate.people;
  if (!p) return null;
  const parts: string[] = [];
  if (p.name) {
    parts.push(`The page also sees your name, ${p.name}, and shows it with your email.`);
  }
  if (p.list) parts.push(PEOPLE_LIST_NOTICE);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The notice's lines, in the order they are read out. One line function per line. */
export const DATA_NOTICE_LINES: readonly NoticeLine[] = [
  (gate) => dataNoticeText(gate.data),
  peopleNoticeText,
];

/** The whole notice for a gate, or null when no line has anything to say. */
export function noticeText(gate: NoticeGate): string | null {
  const lines = DATA_NOTICE_LINES.map((line) => line(gate)).filter((t) => t !== null);
  return lines.length > 0 ? lines.join(" ") : null;
}

/** The notice for a gate (or, on its own, for a gate's data block). */
export function DataNotice({ data, gate }: { data?: ViewGateData; gate?: NoticeGate }) {
  const text = noticeText(gate ?? { data });
  if (!text) return null;
  return (
    <p className="pl-viewer__notice pl-viewer__data" role="note">
      <DatabaseIcon size={14} aria-hidden="true" className="pl-viewer__data-icon" />
      <span>{text}</span>
    </p>
  );
}
