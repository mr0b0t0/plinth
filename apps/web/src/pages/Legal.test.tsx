import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGAL_DOC_IDS,
  LEGAL_UPDATED,
  type LegalConfig,
  legalDoc,
} from "../components/viewer/legalDocs.tsx";
import { CONFIG, stubApi } from "../components/viewer/test-utils.ts";
import Legal from "./Legal.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withOperator: LegalConfig = CONFIG;
const personal: LegalConfig = { ...CONFIG, operator: null };

describe("Legal", () => {
  it.each(LEGAL_DOC_IDS)("renders %s as final text naming the operator", async (doc) => {
    stubApi();
    render(<Legal params={{ doc }} />);
    const title = legalDoc(doc, withOperator)?.title ?? "";
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/placeholder|template|\[[a-z ]+\]/i);
    expect(text).toContain(`Last updated: ${LEGAL_UPDATED}`);
    expect(text).toContain("hello@example.org");
    expect(document.title).toBe(`${title} · Plinth`);
  });

  it("names the operator, its address and registration, and the processors", () => {
    const render = (id: "terms" | "privacy") =>
      JSON.stringify(legalDoc(id, withOperator), (_k, v) => (typeof v === "function" ? "" : v));
    expect(render("terms")).toContain("Rua Exemplo 1");
    expect(render("privacy")).toContain("Twilio SendGrid");
    expect(legalDoc("terms", withOperator)?.sections.map((s) => s.heading)).toContain(
      "Reporting content",
    );
  });

  it("the privacy notice covers unsaved page edits and says live room traffic is never stored", async () => {
    stubApi();
    render(<Legal params={{ doc: "privacy" }} />);
    await screen.findByRole("heading", { level: 1 });
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Unsaved page edits: when you edit a document on its page");
    expect(text).toContain("are passed along and never stored.");
    expect(text).toContain("Unsaved page drafts: until saved or discarded, at most 30 days.");
  });

  it("publishes no terms or privacy notice without an operator, but keeps the acceptable use policy", () => {
    expect(legalDoc("terms", personal)).toBeNull();
    expect(legalDoc("privacy", personal)).toBeNull();
    expect(legalDoc("acceptable-use", personal)?.title).toBe("Acceptable use policy");
  });

  it("is not found for any other document", async () => {
    stubApi();
    render(<Legal params={{ doc: "cookies" }} />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});
