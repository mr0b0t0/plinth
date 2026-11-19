// Data sources (docs/spec.md "Live data from the owner's agents"): the plinth-data-sourced
// declaration (absent from every declaration without it, so stored rows stay byte for byte), the
// text rules, the secret check, the source_ref sanitiser, the canonical config the confirmation
// hash covers, and the inputs.
import { describe, expect, it } from "vitest";
import {
  type Capabilities,
  canonicalSourceConfig,
  confirmDataSourceInput,
  DATA_SOURCED_META,
  docSourceInput,
  LIMITS,
  looksLikeSecret,
  normalizeRecipe,
  parseCapabilities,
  readStoredCapabilities,
  recipeProblem,
  type SourceConfig,
  sanitizeSourceRef,
  serializeCapabilities,
  setDataSourcesInput,
  sourceTextProblem,
  writeArtifactDataInput,
} from "../src/index.ts";

const caps = (content: string) => `<meta name="plinth-capabilities" content="${content}">`;
const sourced = (content: string) => `<meta name="${DATA_SOURCED_META}" content="${content}">`;

describe("plinth-data-sourced", () => {
  it("is absent from a declaration without it, so the four stored shapes stay byte for byte", () => {
    const shapes: [string, string][] = [
      [caps("data"), '{"data":true,"viewer":false,"shared":[]}'],
      [
        `${caps("data viewer")}<meta name="plinth-data-shared" content="tasks">`,
        '{"data":true,"viewer":true,"shared":["tasks"]}',
      ],
      [caps("room"), '{"data":false,"viewer":false,"shared":[],"room":true,"roomOpen":[]}'],
      [caps("room data"), '{"data":true,"viewer":false,"shared":[],"room":true,"roomOpen":[]}'],
    ];
    for (const [html, stored] of shapes) {
      const c = parseCapabilities(html) as Capabilities;
      expect(c, html).not.toHaveProperty("sourced");
      expect(serializeCapabilities(c), html).toBe(stored);
      expect(readStoredCapabilities(stored), html).not.toHaveProperty("sourced");
    }
  });

  it("reads names in order, any quote style, after the other metas, and ignores comments", () => {
    const html = `<!-- ${sourced("hidden")} -->${caps("data viewer")}<meta content='issues, revenue issues' name=${DATA_SOURCED_META}>`;
    const c = parseCapabilities(html) as Capabilities;
    expect(c.sourced).toEqual(["issues", "revenue"]);
    // Appended last in the stored JSON.
    expect(serializeCapabilities(c)).toBe(
      '{"data":true,"viewer":true,"shared":[],"sourced":["issues","revenue"]}',
    );
    expect(readStoredCapabilities(serializeCapabilities(c))).toEqual(c);
  });

  it("counts only with data, drops bad names, keeps at most 20, and may overlap shared", () => {
    expect(parseCapabilities(`${caps("room")}${sourced("issues")}`)).not.toHaveProperty("sourced");
    expect(parseCapabilities(sourced("issues"))).toBeNull();
    const many = Array.from({ length: 25 }, (_, i) => `c${i}`).join(" ");
    const c = parseCapabilities(
      `${caps("data")}<meta name="plinth-data-shared" content="tasks">${sourced(`-bad tasks ${many}`)}`,
    ) as Capabilities;
    expect(c.sourced?.length).toBe(LIMITS.maxDataSourced);
    expect(c.sourced?.[0]).toBe("tasks");
    expect(c.shared).toEqual(["tasks"]);
    expect(parseCapabilities(`${caps("data")}${sourced("-x _y 9z")}`)).not.toHaveProperty(
      "sourced",
    );
  });

  it("reads back a stored row only when data counts, and re-checks the names", () => {
    expect(
      readStoredCapabilities('{"data":true,"viewer":false,"shared":[],"sourced":["ok","No!"]}')
        ?.sourced,
    ).toEqual(["ok"]);
    expect(
      readStoredCapabilities(
        '{"data":false,"viewer":false,"shared":[],"room":true,"roomOpen":[],"sourced":["ok"]}',
      ),
    ).not.toHaveProperty("sourced");
    expect(
      readStoredCapabilities('{"data":true,"viewer":false,"shared":[],"sourced":[]}'),
    ).not.toHaveProperty("sourced");
  });
});

/**
 * Credential-shaped fixtures, built at run time so the source holds no string a secret scanner
 * would take for a real key. None of them is a credential.
 */
const FAKE = {
  sk: ["use sk", "-live-0123"].join(""),
  ghp: ["token gh", "p_abcdefghijklmnop"].join(""),
  gho: ["gh", "o_1234"].join(""),
  xox: ["xo", "xb-1234-5678"].join(""),
  akia: ["AK", "IA", "EXAMPLE", "FIXTURE00"].join(""),
  mixed: ["Xk9pQ2mZ7v", "T4wR8sL1nB", "6cF3hJ5gD0", "aE2yU7iO9q"].join(""),
  /** A standard-base64 key with slashes in it (the shape of an AWS secret access key). */
  slashed: ["wJalrXUtnF", "EMI/K7MDEN", "G/bPxRfiCY", "FIXTUREKEY"].join(""),
  /** A base64url key whose random characters happen to hold separators. */
  dashed: ["Xk9pQ2-mZ7v", "T4wR8sL1nB", "6cF3h_J5gD", "0aE2yU7iO9q"].join(""),
};

/** Links to records in the trackers people use: none holds a credential. */
const RECORD_URLS = [
  "https://linear.app/acme/issue/ENG-123/fix-the-login-redirect-on-mobile",
  "https://acme.atlassian.net/jira/software/projects/ENG/boards/12",
  "https://linear.app/acme/team/ENG/view/open-issues-by-state-2026",
  "https://www.notion.so/acme/Q4-Roadmap-2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "https://www.notion.so/2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "https://github.com/acme/web/issues/4821",
  "https://app.hubspot.com/contacts/1234567/objects/0-3/views/all/list",
  "https://acme.notion.site/MyProject-Getting-Started-With-Our-API-v2",
];

describe("looksLikeSecret", () => {
  it("catches tokens, keys, JWTs, secret query parameters and long hex or mixed runs", () => {
    for (const s of [
      "Authorization: Bearer abc123",
      FAKE.sk,
      FAKE.ghp,
      FAKE.gho,
      FAKE.xox,
      FAKE.akia,
      "plinth_pat_0123",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      "https://api.example.com/v1/issues?api_key=1",
      "https://x.example/a?token=abc",
      "a sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "0123456789abcdef0123456789abcdef01234567",
      FAKE.mixed,
      FAKE.slashed,
      FAKE.dashed,
      `https://api.example.com/v1/${FAKE.mixed}/issues`,
    ]) {
      expect(looksLikeSecret(s), s).toBe(true);
    }
  });

  it("lets links to records through, and recipes that quote them", () => {
    for (const url of RECORD_URLS) {
      expect(looksLikeSecret(url), url).toBe(false);
      expect(recipeProblem(`Linear issues like ${url}, one document per state`), url).toBeNull();
    }
  });

  it("lets ordinary recipes through", () => {
    for (const s of [
      "Linear: count open issues in team ENG by state; one document per state in collection issues.",
      "Stripe: sum of paid invoices this month, in EUR, from the invoices list endpoint.",
      "count-open-issues-in-team-eng-by-state-and-label-and-priority",
      "Use the risk-free rate; a task-list of 12 items",
      "https://linear.app/acme/team/ENG/active",
    ]) {
      expect(looksLikeSecret(s), s).toBe(false);
    }
  });
});

describe("text rules", () => {
  it("labels and connectors: length, invisible characters and secrets", () => {
    expect(sourceTextProblem("Open issues", "label")).toBeNull();
    expect(sourceTextProblem("", "label")).toMatch(/at least one/);
    expect(sourceTextProblem("x".repeat(61), "connector")).toMatch(/at most 60/);
    expect(sourceTextProblem("Lin​ear", "connector")).toMatch(/invisible/);
    expect(sourceTextProblem("Lin‮ear", "connector")).toMatch(/invisible/);
    expect(sourceTextProblem(FAKE.gho, "label")).toMatch(/credential/);
  });

  it("recipes keep newlines but refuse other control, bidi and zero-width characters", () => {
    expect(normalizeRecipe("  a\r\nb\rc  ")).toBe("a\nb\nc");
    expect(recipeProblem("line one\nline two\tend")).toBeNull();
    expect(recipeProblem("x".repeat(1001))).toMatch(/at most 1000/);
    expect(recipeProblem("x".repeat(1000))).toBeNull();
    expect(recipeProblem("a‮b")).toMatch(/invisible/);
    expect(recipeProblem("a‍b")).toMatch(/invisible/);
    expect(recipeProblem("a\u0007b")).toMatch(/invisible/);
    expect(recipeProblem("send Bearer abc")).toMatch(/credential/);
  });
});

describe("sanitizeSourceRef", () => {
  it("keeps only a URL's origin and path", () => {
    expect(sanitizeSourceRef("https://u:p@x.example/a?token=1#f")).toEqual({
      ok: true,
      ref: "https://x.example/a",
    });
    expect(sanitizeSourceRef("HTTPS://X.Example")).toEqual({ ok: true, ref: "https://x.example/" });
    expect(sanitizeSourceRef("https://a:b@c@host.example/p")).toEqual({
      ok: true,
      ref: "https://host.example/p",
    });
    expect(sanitizeSourceRef("  ENG-123  ")).toEqual({ ok: true, ref: "ENG-123" });
    for (const url of RECORD_URLS)
      expect(sanitizeSourceRef(url), url).toEqual({ ok: true, ref: url });
    expect(sanitizeSourceRef("   ")).toEqual({ ok: true, ref: null });
  });

  it("refuses long, invisible or secret-looking refs", () => {
    expect(sanitizeSourceRef("x".repeat(301)).ok).toBe(false);
    expect(sanitizeSourceRef("a​b").ok).toBe(false);
    expect(sanitizeSourceRef(FAKE.ghp.slice(6)).ok).toBe(false);
    expect(sanitizeSourceRef("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x").ok).toBe(false);
    expect(sanitizeSourceRef("0123456789abcdef0123456789abcdef01234567").ok).toBe(false);
    expect(sanitizeSourceRef("https://").ok).toBe(false);
    expect(sanitizeSourceRef(`https://x.example/files/${FAKE.slashed}`).ok).toBe(false);
  });
});

describe("canonicalSourceConfig", () => {
  const base: SourceConfig = {
    label: "Open issues",
    connector: "Linear",
    recipe: "count",
    collection: "issues",
    every_minutes: null,
    requestable_by: "editor",
    target_client_type: "claude",
    target_connection: null,
  };
  it("does not depend on key order and changes with every field", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as SourceConfig;
    expect(canonicalSourceConfig(reordered)).toBe(canonicalSourceConfig(base));
    const changes: Partial<SourceConfig>[] = [
      { label: "x" },
      { connector: "x" },
      { recipe: "x" },
      { collection: "x" },
      { every_minutes: 60 },
      { requestable_by: "commenter" },
      { target_client_type: "codex" },
      { target_connection: "c1" },
    ];
    for (const ch of changes) {
      expect(canonicalSourceConfig({ ...base, ...ch }), JSON.stringify(ch)).not.toBe(
        canonicalSourceConfig(base),
      );
    }
  });
});

describe("inputs", () => {
  const entry = {
    id: "linear",
    label: "Open issues",
    connector: "Linear",
    recipe: "count",
    collection: "issues",
  };
  it("set_data_sources: at most 10, unique ids, strict entries", () => {
    expect(setDataSourcesInput.safeParse({ id: "a1", sources: [entry] }).success).toBe(true);
    expect(setDataSourcesInput.safeParse({ id: "a1", sources: [] }).success).toBe(true);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...entry, id: `s${i}` }));
    expect(setDataSourcesInput.safeParse({ id: "a1", sources: eleven }).success).toBe(false);
    expect(setDataSourcesInput.safeParse({ id: "a1", sources: [entry, entry] }).success).toBe(
      false,
    );
    expect(
      setDataSourcesInput.safeParse({ id: "a1", sources: [{ ...entry, token: "x" }] }).success,
    ).toBe(false);
    expect(
      setDataSourcesInput.safeParse({ id: "a1", sources: [{ ...entry, id: "Bad" }] }).success,
    ).toBe(false);
  });

  it("confirm takes exactly a 32-hex config_hash", () => {
    expect(confirmDataSourceInput.safeParse({ config_hash: "a".repeat(32) }).success).toBe(true);
    expect(confirmDataSourceInput.safeParse({ config_hash: "A".repeat(32) }).success).toBe(false);
    expect(
      confirmDataSourceInput.safeParse({ config_hash: "a".repeat(32), every_minutes: 60 }).success,
    ).toBe(false);
  });

  it("a set op may carry a source; a delete may not", () => {
    const set = {
      op: "set",
      collection: "issues",
      doc_id: "open",
      data: { count: 3 },
      if_rev: 0,
      source: { id: "linear", ref: "ENG", fetched_at: "2026-11-19T10:00:00Z" },
    };
    expect(writeArtifactDataInput.safeParse({ id: "a1", ops: [set] }).success).toBe(true);
    expect(docSourceInput.safeParse({ id: "linear", fetched_at: "yesterday" }).success).toBe(false);
    expect(
      docSourceInput.safeParse({ id: "linear", fetched_at: "2026-11-19T10:00:00Z", extra: 1 })
        .success,
    ).toBe(false);
    const del = {
      op: "delete",
      collection: "issues",
      doc_id: "open",
      if_rev: 1,
      source: set.source,
    };
    const parsed = writeArtifactDataInput.safeParse({ id: "a1", ops: [del] });
    expect(parsed.success && "source" in (parsed.data.ops[0] ?? {})).toBe(false);
  });
});
