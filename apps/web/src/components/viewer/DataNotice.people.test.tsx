// The notice's people line (who is viewing): with a people block, the name goes into who the page
// sees the viewer as, in two sentences that replace the data line. Without one, nothing changes.
import type { ViewGateData } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataNotice, dataNoticeText, noticeText, PEOPLE_LIST_NOTICE } from "./DataNotice.tsx";

afterEach(cleanup);

const EMAIL = "ada@example.org";
const data: ViewGateData = {
  available: true,
  capabilities: ["data", "viewer", "people"],
  identified: true,
  can_write: true,
  email: EMAIL,
};

describe("DataNotice: names and the people list", () => {
  it("folds the name into the first sentence and the list into the second", () => {
    render(<DataNotice gate={{ data, people: { name: "Ada Lovelace", list: true } }} />);
    expect(screen.getByRole("note").textContent).toBe(
      `This page sees you as Ada Lovelace (${EMAIL}) and saves what you enter. People with access see entries and who wrote them; the owner and editors see who has access.`,
    );
  });

  it("uses the email alone without a name, and leaves the list out without one", () => {
    expect(noticeText({ data, people: { list: true } })).toBe(
      `This page sees you as ${EMAIL} and saves what you enter. People with access see entries and who wrote them; the owner and editors see who has access.`,
    );
    expect(noticeText({ data, people: { name: "Ada" } })).toBe(
      `This page sees you as Ada (${EMAIL}) and saves what you enter. People with access see entries and who wrote them.`,
    );
  });

  it("says the same in a live room, with or without shared data", () => {
    expect(noticeText({ data: { ...data, room_email: EMAIL }, people: { name: "Ada" } })).toBe(
      `This page sees you as Ada (${EMAIL}), shows it to the other people who have it open, and saves what you enter. People with access see entries and who wrote them.`,
    );
    const room: ViewGateData = {
      available: false,
      capabilities: ["room", "viewer"],
      identified: false,
      can_write: false,
      room_email: EMAIL,
    };
    expect(noticeText({ data: room, people: { name: "Ada" } })).toBe(
      `This page sees you as Ada (${EMAIL}) and shows it to the other people who have it open.`,
    );
  });

  it("adds the list sentence to the data line when there is no address to name", () => {
    const anon: ViewGateData = { ...data, identified: false, email: undefined };
    expect(noticeText({ data: anon, people: { list: true } })).toBe(
      `${dataNoticeText(anon)} ${PEOPLE_LIST_NOTICE}`,
    );
    expect(noticeText({ data: anon, people: { name: "Ada" } })).toBe(dataNoticeText(anon));
  });

  it("changes nothing when the gate has no people block", () => {
    expect(noticeText({ data })).toBe(dataNoticeText(data));
    expect(noticeText({ data, people: {} })).toBe(dataNoticeText(data));
    expect(noticeText({})).toBeNull();
  });

  it("renders a name as text", () => {
    render(<DataNotice gate={{ data, people: { name: "<img src=x onerror=alert(1)>" } }} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("note").textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
