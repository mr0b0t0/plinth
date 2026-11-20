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
export const PEOPLE_LIST_NOTICE = "The owner and editors see who has access.";

/**
 * Who is viewing. With a `people` block in the gate, this line says what the data line says, with
 * the viewer's name folded into who the page sees them as, in two sentences, and the data line
 * yields to it: "This page sees you as {name} ({email}) and saves what you enter. People with
 * access see entries and who wrote them; the owner and editors see who has access." Without a
 * name the email stands alone. Null without a `people` block, so other pages read as before.
 */
export function peopleNoticeText(gate: NoticeGate): string | null {
  const p = gate.people;
  if (!p || (!p.name && !p.list)) return null;
  const d = gate.data;
  const saves = d?.capabilities.includes("data") === true && d.available;
  const email = saves && d?.capabilities.includes("viewer") && d.identified ? d.email : undefined;
  const room = d?.room_email;
  const address = email ?? room;
  if (!address) {
    // Nothing to fold a name into: the data line as it reads, then the people sentence.
    if (!p.list) return null;
    const data = dataNoticeText(d);
    return data ? `${data} ${PEOPLE_LIST_NOTICE}` : PEOPLE_LIST_NOTICE;
  }
  const you = p.name ? `${p.name} (${address})` : address;
  const shows = "shows it to the other people who have it open";
  if (email) {
    const first = room
      ? `This page sees you as ${you}, ${shows}, and saves what you enter.`
      : `This page sees you as ${you} and saves what you enter.`;
    const list = p.list ? "; the owner and editors see who has access." : ".";
    return `${first} People with access see entries and who wrote them${list}`;
  }
  // A live room without shared data to save into.
  const rest = [
    d?.capabilities.includes("data") && !d.available ? UNAVAILABLE : null,
    p.list ? PEOPLE_LIST_NOTICE : null,
  ].filter((t) => t !== null);
  return [`This page sees you as ${you} and ${shows}.`, ...rest].join(" ");
}

/** The notice's lines, in the order they are read out. One line function per line. */
export const DATA_NOTICE_LINES: readonly NoticeLine[] = [
  // The people line, when it speaks, restates this one with the viewer's name in it.
  (gate) => (peopleNoticeText(gate) === null ? dataNoticeText(gate.data) : null),
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
