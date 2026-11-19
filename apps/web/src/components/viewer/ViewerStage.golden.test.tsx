// Golden DOM of the viewer chrome: the bar, the strip under it and the ⋯ menu, for each kind of
// viewer, type and width. Recorded before ViewerStage built them from item lists (stageItems.tsx),
// so a refactor of how they are assembled must leave every element, label, link and attribute as
// it was. A feature that adds an item adds a scenario here and re-records only that one.
import type { CommentInfo, ViewArtifact, ViewGate, ViewGateData } from "@plinth/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, json, ME, stubApi } from "./test-utils.ts";
import { VIEWER_COMPACT_QUERY } from "./ViewerStage.tsx";

type OkGate = Extract<ViewGate, { status: "ok" }>;

const ARTIFACT: ViewArtifact = {
  id: "art123",
  slug: "garden-plan",
  title: "Garden plan",
  type: "html",
  current_version: 3,
  version: 3,
  visibility: "unlisted",
  owner_name: null,
};
const DOC: ViewArtifact = { ...ARTIFACT, type: "doc" };
const SLIDES: ViewArtifact = { ...ARTIFACT, type: "slides" };
const BOARD: ViewArtifact = { ...ARTIFACT, type: "whiteboard" };
const ENTER = "http://art123.content.localhost:8787/__plinth/enter?t=token-1&next=%2F";

const DATA: ViewGateData = {
  available: true,
  capabilities: ["data", "viewer"],
  identified: true,
  can_write: true,
  email: "ada@example.org",
};

const OPEN_THREAD: CommentInfo = {
  id: "c1",
  parent_id: null,
  status: "open",
} as CommentInfo;

interface Scenario {
  name: string;
  gate: Partial<OkGate>;
  signedIn: boolean;
  compact: boolean;
  comments?: CommentInfo[];
  opaque?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: "html, anonymous viewer, wide", gate: { role: null }, signedIn: false, compact: false },
  {
    name: "html, owner, wide, open threads",
    gate: { role: "owner" },
    signedIn: true,
    compact: false,
    comments: [OPEN_THREAD],
  },
  { name: "html, owner, compact", gate: { role: "owner" }, signedIn: true, compact: true },
  {
    name: "html, editor, older version with shared data",
    gate: { role: "editor", artifact: { ...ARTIFACT, version: 2 }, data: DATA },
    signedIn: true,
    compact: false,
  },
  {
    name: "html, viewer, compact, room only",
    gate: {
      role: "viewer",
      data: { ...DATA, capabilities: ["room", "viewer"], room_email: "ada@example.org" },
    },
    signedIn: true,
    compact: true,
  },
  {
    name: "doc, editor, live room, wide",
    gate: { role: "editor", artifact: DOC, live: { mode: "room", draft: null } },
    signedIn: true,
    compact: false,
  },
  {
    name: "doc, owner, live room, compact",
    gate: { role: "owner", artifact: DOC, live: { mode: "room", draft: null } },
    signedIn: true,
    compact: true,
  },
  {
    name: "doc, editor, sign in to edit, wide",
    gate: { role: "editor", artifact: DOC, live: { mode: "room", sign_in: true, draft: null } },
    signedIn: false,
    compact: false,
  },
  {
    name: "doc, editor, sign in to edit, compact",
    gate: { role: "editor", artifact: DOC, live: { mode: "solo", sign_in: true, draft: null } },
    signedIn: false,
    compact: true,
  },
  {
    name: "doc, commenter, opaque isolation",
    gate: { role: "commenter", artifact: DOC },
    signedIn: true,
    compact: false,
    opaque: true,
  },
  {
    name: "slides, anonymous viewer, wide",
    gate: { role: null, artifact: SLIDES },
    signedIn: false,
    compact: false,
  },
  {
    name: "slides, owner, compact",
    gate: { role: "owner", artifact: SLIDES },
    signedIn: true,
    compact: true,
  },
  {
    name: "whiteboard, editor, wide",
    gate: { role: "editor", artifact: BOARD },
    signedIn: true,
    compact: false,
  },
  {
    name: "whiteboard, commenter, wide",
    gate: { role: "commenter", artifact: BOARD },
    signedIn: true,
    compact: false,
  },
];

/** React's generated ids, renumbered in order of appearance so they do not depend on mounts. */
function normalizeIds(html: string): string {
  const seen = new Map<string, string>();
  return html.replace(/«[^»]+»|_r_[0-9a-z]+_|:r[0-9a-z]+:/g, (id) => {
    let n = seen.get(id);
    if (!n) {
      n = `{id${seen.size + 1}}`;
      seen.set(id, n);
    }
    return n;
  });
}

async function loadPage() {
  vi.resetModules();
  return (await import("../../pages/ArtifactPage.tsx")).default;
}

async function capture(s: Scenario): Promise<string> {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: s.compact && query === VIEWER_COMPACT_QUERY,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
  const gate: OkGate = {
    status: "ok",
    artifact: ARTIFACT,
    enter_url: ENTER,
    role: null,
    ...s.gate,
  };
  stubApi({
    me: s.signedIn ? ME : null,
    config: s.opaque ? { ...CONFIG, content_isolation: "opaque" } : CONFIG,
    handle: (c) => {
      if (c.path.startsWith("/view/")) return json(gate);
      if (c.path.startsWith("/artifacts/art123/comments")) return json({ items: s.comments ?? [] });
      return undefined;
    },
  });
  const ArtifactPage = await loadPage();
  const user = userEvent.setup();
  render(<ArtifactPage params={{ slug: "garden-plan" }} />);
  await screen.findByTitle(`Garden plan, version ${gate.artifact.version}`);
  if (s.comments?.length) await screen.findByText(String(s.comments.length));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const bar = document.querySelector(".pl-viewer__bar")?.outerHTML ?? "";
  const stage = document.querySelector(".pl-viewer__stage");
  const strip = [...(stage?.children ?? [])]
    .filter((el) => !el.classList.contains("pl-viewer__room"))
    .map((el) => el.outerHTML)
    .join("\n");
  await user.click(screen.getByRole("button", { name: "Artifact actions" }));
  const menu = screen.getByRole("menu").outerHTML;
  cleanup();
  vi.restoreAllMocks();
  return normalizeIds(`## ${s.name}\n### bar\n${bar}\n### strip\n${strip}\n### menu\n${menu}\n`);
}

beforeEach(() => {
  window.history.replaceState(null, "", "/a/garden-plan");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("viewer chrome golden", () => {
  it("renders the bar, the strip and the menu exactly as before", async () => {
    const out: string[] = [];
    for (const s of SCENARIOS) out.push(await capture(s));
    await expect(out.join("\n")).toMatchFileSnapshot("./__golden__/viewer-stage.txt");
  }, 60_000);
});
