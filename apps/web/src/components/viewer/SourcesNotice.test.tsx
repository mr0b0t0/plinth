// The viewer bar's sources line: where the page's figures come from, from the server's counts, as
// text; and the owner's line when a source waits for their confirmation.
import type { ViewSource } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourcesNotice, sourcesNoticeText, sourcesReviewText } from "./SourcesNotice.tsx";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");

const src = (over: Partial<ViewSource> = {}): ViewSource => ({
  id: "linear",
  label: "Open issues",
  connector: "Linear",
  collection: "issues",
  status: "active",
  last_fetched_at: "2026-11-19T11:48:00.000Z",
  fetched: 14,
  by_person: 0,
  by_agent: 0,
  ...over,
});

afterEach(() => cleanup());

describe("sourcesNoticeText", () => {
  it("says nothing without sources", () => {
    expect(sourcesNoticeText(undefined, NOW)).toBeNull();
    expect(sourcesNoticeText([], NOW)).toBeNull();
  });

  it("names each source with its count and age, written by an agent of the owner", () => {
    expect(
      sourcesNoticeText(
        [
          src(),
          src({
            id: "stripe",
            connector: "Stripe",
            collection: "revenue",
            fetched: 3,
            last_fetched_at: "2026-11-18T09:00:00.000Z",
          }),
        ],
        NOW,
      ),
    ).toBe(
      "Figures from Linear (14 figures, fetched 12 minutes ago) and Stripe (3 figures, fetched yesterday) were written by an agent of the owner.",
    );
    expect(sourcesNoticeText([src({ fetched: 1 })], NOW)).toBe(
      "Figures from Linear (1 figure, fetched 12 minutes ago) were written by an agent of the owner.",
    );
  });

  it("counts figures last changed by a person or by an agent without a source, once per collection", () => {
    const text = sourcesNoticeText(
      [
        src({ by_person: 2, by_agent: 1 }),
        // A second source on the same collection reports the same unstamped counts.
        src({ id: "linear2", label: "Closed", fetched: 0, by_person: 2, by_agent: 1 }),
      ],
      NOW,
    );
    expect(text).toContain(
      "2 were last changed by a person and 1 by an agent without a source, not fetched.",
    );
    expect(sourcesNoticeText([src({ by_person: 1 })], NOW)).toContain(
      "1 was last changed by a person, not fetched.",
    );
    expect(sourcesNoticeText([src({ by_agent: 2 })], NOW)).toContain(
      "2 were last changed by an agent without a source, not fetched.",
    );
  });

  it("says when nothing is stored as fetched (the inline fallback)", () => {
    expect(sourcesNoticeText([src({ fetched: 0, last_fetched_at: null })], NOW)).toBe(
      "This page says its figures come from Linear, but none are stored as fetched: what it shows comes from the page itself.",
    );
    expect(
      sourcesNoticeText([src(), src({ id: "s", connector: "Stripe", fetched: 0 })], NOW),
    ).toContain("None are stored as fetched from Stripe.");
  });

  it("names figures a source stamped before it was renamed as their stamps say, each with its own age", () => {
    const hubspot = {
      label: "Deals",
      connector: "HubSpot",
      fetched: 14,
      last_fetched_at: "2026-11-16T12:00:00.000Z",
    };
    const renamed = src({
      id: "crm",
      label: "Deals",
      connector: "Salesforce",
      fetched: 0,
      last_fetched_at: null,
      earlier: [hubspot],
    });
    expect(sourcesNoticeText([renamed], NOW)).toBe(
      "Figures from HubSpot (14 figures, fetched 3 days ago) were written by an agent of the owner. None are stored as fetched from Salesforce.",
    );
    expect(
      sourcesNoticeText(
        [{ ...renamed, fetched: 2, last_fetched_at: "2026-11-19T11:48:00.000Z" }],
        NOW,
      ),
    ).toBe(
      "Figures from Salesforce (2 figures, fetched 12 minutes ago) and HubSpot (14 figures, fetched 3 days ago) were written by an agent of the owner.",
    );
    // A new label on the same connector: the connector is named, not said to be missing.
    expect(
      sourcesNoticeText(
        [{ ...renamed, connector: "HubSpot", earlier: [{ ...hubspot, label: "Old" }] }],
        NOW,
      ),
    ).toBe(
      "Figures from HubSpot (14 figures, fetched 3 days ago) were written by an agent of the owner.",
    );
  });
});

describe("SourcesNotice", () => {
  it("renders labels as text, never markup", () => {
    const evil = '<img src=x onerror="alert(1)">';
    render(
      <SourcesNotice sources={[src({ connector: evil })]} isOwner={false} onReview={() => {}} />,
    );
    expect(screen.getByRole("note").textContent).toContain(evil);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it("shows the owner the sources waiting for them, with Review; nobody else", async () => {
    const onReview = vi.fn();
    const waiting = [src({ status: "awaiting_confirmation" })];
    expect(sourcesReviewText(waiting)).toBe("1 data source is waiting for you to confirm it.");
    expect(sourcesReviewText([...waiting, src({ id: "b", status: "awaiting_confirmation" })])).toBe(
      "2 data sources are waiting for you to confirm them.",
    );
    expect(sourcesReviewText([src()])).toBeNull();
    render(<SourcesNotice sources={waiting} isOwner onReview={onReview} />);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledOnce();
    cleanup();
    render(<SourcesNotice sources={waiting} isOwner={false} onReview={onReview} />);
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.queryByText(/waiting for you/)).toBeNull();
  });
});
