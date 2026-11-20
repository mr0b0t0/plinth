// The notice's people line (who is viewing): the viewer's name beside the email the data line
// names, and the people-list sentence, after the data line and only when the gate says so.
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
  it("adds the name and the people sentence after the data line", () => {
    render(<DataNotice gate={{ data, people: { name: "Ada Lovelace", list: true } }} />);
    expect(screen.getByRole("note").textContent).toBe(
      `${dataNoticeText(data)} The page also sees your name, Ada Lovelace, and shows it with your email. ${PEOPLE_LIST_NOTICE}`,
    );
    expect(PEOPLE_LIST_NOTICE).toBe("The owner and editors can see who has access.");
  });

  it("says each one alone", () => {
    expect(noticeText({ data, people: { list: true } })).toBe(
      `${dataNoticeText(data)} ${PEOPLE_LIST_NOTICE}`,
    );
    expect(noticeText({ data, people: { name: "Ada" } })).toBe(
      `${dataNoticeText(data)} The page also sees your name, Ada, and shows it with your email.`,
    );
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
