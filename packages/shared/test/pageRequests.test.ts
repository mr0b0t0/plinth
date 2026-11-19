// Page requests in the shared package (docs/spec.md "Page requests"): the `requests` declaration
// and its plinth-requests-to meta, how they are stored and read back, the request body schema and
// the fixed limits.
import { describe, expect, it } from "vitest";
import {
  PAGE_REQUEST_BOUNDS,
  PAGE_REQUEST_DEFAULTS,
  PAGE_REQUEST_LIMITS,
  PAGE_REQUEST_TO_RE,
  pageRequestInput,
  parseCapabilities,
  REQUESTS_TO_META,
  readStoredCapabilities,
  requestTarget,
  serializeCapabilities,
} from "../src/index.ts";

const caps = (content: string) => `<meta name="plinth-capabilities" content="${content}">`;
const to = (content: string) => `<meta name="${REQUESTS_TO_META}" content="${content}">`;

describe("the requests declaration", () => {
  it("declares on its own, with no store and no room", () => {
    const c = parseCapabilities(caps("requests"));
    expect(c).toMatchObject({
      data: false,
      viewer: false,
      room: false,
      requests: true,
      requestsTo: [],
    });
    expect(serializeCapabilities(c as never)).toBe(
      '{"data":false,"viewer":false,"shared":[],"requests":true,"requestsTo":[]}',
    );
  });

  it("keeps one valid target only with requests, wherever the meta is", () => {
    for (const html of [
      `${to("claude")}${caps("requests")}<p>x</p>`,
      `${caps("requests")}<meta name="description" content="x">${to("claude")}`,
      `${caps("requests data")}<meta name="plinth-data-shared" content="a">${to("claude codex")}`,
    ]) {
      expect(parseCapabilities(html)?.requestsTo, html).toEqual(["claude"]);
    }
    // Names that break the rule are dropped; the first valid one is kept.
    expect(parseCapabilities(`${caps("requests")}${to("Bad! -x")}`)?.requestsTo).toEqual([]);
    expect(parseCapabilities(`${caps("requests")}${to("Bad! codex")}`)?.requestsTo).toEqual([
      "codex",
    ]);
    expect(parseCapabilities(`${caps("data")}${to("claude")}`)?.requestsTo).toEqual([]);
    // Only the first tag counts; tags inside comments are ignored.
    expect(
      parseCapabilities(`${caps("requests")}${to("build-bot")}${to("claude")}`)?.requestsTo,
    ).toEqual(["build-bot"]);
    expect(parseCapabilities(`${caps("requests")}<!-- ${to("claude")} -->`)?.requestsTo).toEqual(
      [],
    );
    expect(requestTarget(parseCapabilities(`${caps("requests")}${to("codex")}`))).toBe("codex");
    expect(requestTarget(parseCapabilities(caps("data")))).toBeNull();
    expect(requestTarget(null)).toBeNull();
  });

  it("stores every declaration without requests exactly as before", () => {
    for (const [html, json] of [
      [caps("data viewer"), '{"data":true,"viewer":true,"shared":[]}'],
      [caps("data room"), '{"data":true,"viewer":false,"shared":[],"room":true,"roomOpen":[]}'],
      [caps("files"), '{"data":false,"viewer":false,"shared":[],"files":true}'],
    ] as const) {
      expect(serializeCapabilities(parseCapabilities(html) as never), html).toBe(json);
    }
  });

  it("round-trips through the stored JSON, and reads a bad stored target as none", () => {
    const c = parseCapabilities(`${caps("data requests")}${to("claude")}`);
    const back = readStoredCapabilities(serializeCapabilities(c as never));
    expect(back).toEqual(c);
    expect(
      readStoredCapabilities(
        '{"data":false,"viewer":false,"shared":[],"requests":true,"requestsTo":["Bad One"]}',
      )?.requestsTo,
    ).toEqual([]);
    expect(
      readStoredCapabilities('{"data":false,"viewer":false,"shared":[],"requestsTo":["claude"]}'),
    ).toBeNull();
  });
});

describe("pageRequestInput and the limits", () => {
  it("is strict: a body of 1 to 4000 characters, an optional JSON object and target", () => {
    expect(pageRequestInput.safeParse({ body: " Add Q3 " }).data).toEqual({ body: "Add Q3" });
    expect(pageRequestInput.safeParse({ body: "x", data: { a: 1 }, to: "claude" }).success).toBe(
      true,
    );
    for (const bad of [
      {},
      { body: "" },
      { body: "   " },
      { body: "x".repeat(PAGE_REQUEST_LIMITS.maxBodyChars + 1) },
      { body: "x", data: [1] },
      { body: "x", data: { s: "y".repeat(PAGE_REQUEST_LIMITS.maxDataBytes) } },
      { body: "x", to: "Claude!" },
      { body: "x", author_email: "a@b.c" },
      { body: "x", state: "done" },
    ]) {
      expect(pageRequestInput.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it("names the limits and the env-var bounds", () => {
    expect(PAGE_REQUEST_LIMITS).toMatchObject({
      maxBodyChars: 4000,
      maxDataBytes: 8192,
      maxOpenPerRequester: 3,
      listed: 20,
      answers: 5,
      bodyCapBytes: 32 * 1024,
    });
    expect(PAGE_REQUEST_DEFAULTS).toEqual({
      perViewerPerHour: 10,
      perArtifactPerHour: 60,
      maxOpenPerArtifact: 25,
    });
    expect(PAGE_REQUEST_BOUNDS).toEqual({
      perViewerPerHour: [1, 100],
      perArtifactPerHour: [1, 1000],
      maxOpenPerArtifact: [1, 500],
    });
    expect(PAGE_REQUEST_TO_RE.test("build-bot")).toBe(true);
    expect(PAGE_REQUEST_TO_RE.test("-x")).toBe(false);
  });
});
