import type { ViewGateData } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataNotice, dataNoticeText } from "./DataNotice.tsx";

afterEach(cleanup);

const EMAIL = "ada@example.org";

const data = (over: Partial<ViewGateData>): ViewGateData => ({
  available: true,
  capabilities: ["data"],
  identified: false,
  can_write: false,
  ...over,
});

describe("DataNotice", () => {
  it("renders nothing when the page declares nothing", () => {
    const { container } = render(<DataNotice data={undefined} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("identified, viewer declared: names the email", () => {
    render(
      <DataNotice
        data={data({
          capabilities: ["data", "viewer"],
          identified: true,
          can_write: true,
          email: EMAIL,
        })}
      />,
    );
    expect(screen.getByRole("note").textContent).toBe(
      `This page can see that you are ${EMAIL} and saves what you enter. People with access can see the entries and who wrote them.`,
    );
  });

  it("identified, data only: no email", () => {
    render(<DataNotice data={data({ identified: true, can_write: true })} />);
    const text = screen.getByRole("note").textContent ?? "";
    expect(text).toBe(
      "This page saves what you enter. People with access can see the entries; the owner and editors can see who wrote them.",
    );
    expect(text).not.toContain("@");
  });

  it("anonymous: read only, no email", () => {
    render(<DataNotice data={data({ capabilities: ["data", "viewer"] })} />);
    const text = screen.getByRole("note").textContent ?? "";
    expect(text).toBe(
      "This page shows entries saved by people it is shared with. You can view them but not add your own.",
    );
    expect(text).not.toContain("@");
  });

  it("not available on this server", () => {
    render(<DataNotice data={data({ available: false, capabilities: ["data", "viewer"] })} />);
    expect(screen.getByRole("note").textContent).toBe(
      "Shared data is not available on this server.",
    );
  });

  it("shows the email only in the identified-with-viewer case", () => {
    // An email that leaked into another state is never shown.
    for (const d of [
      data({ identified: true, can_write: true, email: EMAIL }),
      data({ capabilities: ["data", "viewer"], email: EMAIL }),
      data({ available: false, capabilities: ["data", "viewer"], identified: true, email: EMAIL }),
    ]) {
      expect(dataNoticeText(d) ?? "").not.toContain(EMAIL);
    }
    // Identified with viewer but no email to show: the data-only copy, never "you are undefined".
    expect(
      dataNoticeText(data({ capabilities: ["data", "viewer"], identified: true, can_write: true })),
    ).toBe(
      "This page saves what you enter. People with access can see the entries; the owner and editors can see who wrote them.",
    );
  });

  it("a live room that shows the viewer's email says so, with or without shared data", () => {
    const roomOnly = `This page can see that you are ${EMAIL} and shows it to the other people who have it open.`;
    expect(
      dataNoticeText(
        data({ capabilities: ["viewer", "room"], identified: false, room_email: EMAIL }),
      ),
    ).toBe(roomOnly);
    // Shared data off on this server, the room still shows the email.
    expect(
      dataNoticeText(
        data({ available: false, capabilities: ["data", "viewer", "room"], room_email: EMAIL }),
      ),
    ).toBe(`${roomOnly} Shared data is not available on this server.`);
    expect(
      dataNoticeText(
        data({
          capabilities: ["data", "viewer", "room"],
          identified: true,
          can_write: true,
          email: EMAIL,
          room_email: EMAIL,
        }),
      ),
    ).toBe(
      `This page can see that you are ${EMAIL}, shows it to the other people who have it open, and saves what you enter. People with access can see the entries and who wrote them.`,
    );
    // A room page without viewer shows nobody's email: no room line.
    expect(dataNoticeText(data({ capabilities: ["room"] }))).toBeNull();
  });

  it("viewer without data: nothing to say, the page learns nothing", () => {
    // The server never sends this (viewer alone declares nothing); the notice stays quiet anyway.
    expect(
      dataNoticeText(data({ capabilities: ["viewer"], identified: true, email: EMAIL })),
    ).toBeNull();
    expect(dataNoticeText(data({ capabilities: ["viewer"] }))).toBeNull();
  });
});
