// The notice's files line (files people add to a page): after the data and people lines, in the
// same single note, only when the gate has a files block.
import type { ViewGateData } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataNotice, dataNoticeText, filesNoticeText, noticeText } from "./DataNotice.tsx";

afterEach(cleanup);

const data: ViewGateData = {
  available: true,
  capabilities: ["data", "files"],
  identified: true,
  can_write: true,
};
const KEEPS =
  "This page keeps files people add. People with access can see them; the owner and editors can see who added them.";

describe("DataNotice: files", () => {
  it("tells an identified viewer the page keeps what they add, and who sees who added it", () => {
    expect(
      filesNoticeText({ files: { available: true, can_upload: true, uploaders_shown: false } }),
    ).toBe(KEEPS);
    expect(
      filesNoticeText({ files: { available: true, can_upload: true, uploaders_shown: true } }),
    ).toBe("This page keeps files people add. People with access can see them and who added them.");
  });

  it("tells an anonymous reader the page only shows files", () => {
    expect(
      filesNoticeText({ files: { available: true, can_upload: false, uploaders_shown: true } }),
    ).toBe("This page shows files added by people it is shared with.");
  });

  it("says when files are not available here", () => {
    expect(
      filesNoticeText({ files: { available: false, can_upload: false, uploaders_shown: false } }),
    ).toBe("Files people add are not available on this server.");
  });

  it("joins the data line in one note, and says nothing without a files block", () => {
    render(
      <DataNotice
        gate={{ data, files: { available: true, can_upload: true, uploaders_shown: false } }}
      />,
    );
    expect(screen.getByRole("note").textContent).toBe(`${dataNoticeText(data)} ${KEEPS}`);
    expect(noticeText({ data })).toBe(dataNoticeText(data));
    expect(filesNoticeText({})).toBeNull();
  });

  it("is the whole note for a page that declares only files", () => {
    expect(
      noticeText({ files: { available: true, can_upload: false, uploaders_shown: false } }),
    ).toBe("This page shows files added by people it is shared with.");
  });
});
