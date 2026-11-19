// The notice's page-requests line (docs/spec.md "Page requests"): after the data, people and files
// lines, in the same single note, only when the gate says this viewer may file.
import type { ViewGateData } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataNotice, noticeText, requestsNoticeText } from "./DataNotice.tsx";

afterEach(cleanup);

const LINE =
  "This page can send requests to the owner's agent as ann@example.com. The owner and editors see them, and so do you, under Comments.";

describe("DataNotice: page requests", () => {
  it("names the email requests are filed under, only when the viewer may file", () => {
    expect(requestsNoticeText({ requests: { can_file: true, email: "ann@example.com" } })).toBe(
      LINE,
    );
    expect(
      requestsNoticeText({ requests: { can_file: false, email: "ann@example.com" } }),
    ).toBeNull();
    expect(requestsNoticeText({})).toBeNull();
  });

  it("joins the data and files lines in one note, last", () => {
    const data: ViewGateData = {
      available: true,
      capabilities: ["data", "requests"],
      identified: true,
      can_write: true,
    };
    const text = noticeText({ data, requests: { can_file: true, email: "ann@example.com" } });
    expect(text?.endsWith(LINE)).toBe(true);
    expect(text?.startsWith("This page saves what you enter.")).toBe(true);
    render(
      <DataNotice
        gate={{
          files: { available: true, can_upload: false, uploaders_shown: false },
          requests: { can_file: true, email: "ann@example.com" },
        }}
      />,
    );
    expect(screen.getByRole("note").textContent).toBe(
      `This page shows files added by people it is shared with. ${LINE}`,
    );
  });
});
