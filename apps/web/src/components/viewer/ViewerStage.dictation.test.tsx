// Dictation in the viewer chrome: the consent dialog over the frame, the listening control with
// Stop in the bar, and the ⋯ entry that appears only once the viewer allowed it on this page.
import type { ViewGate } from "@plinth/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, json, ME, stubApi } from "./test-utils.ts";
import { CONSENT_PREFIX, VOICE_LIMITS } from "./voiceProtocol.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;
const ORIGIN = "http://art123.content.localhost:8787";

const GATE: OkGate = {
  status: "ok",
  artifact: {
    id: "art123",
    slug: "field-notes",
    title: "Field notes",
    type: "html",
    current_version: 1,
    version: 1,
    visibility: "allowlist",
    owner_name: "Ada",
  },
  enter_url: `${ORIGIN}/__plinth/enter?t=token-1&next=%2F`,
  role: "viewer",
  voice: { dictation: { available: true, reason: null }, viewer_id: "u_viewer1" },
};

class FakeRec {
  static last: FakeRec | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  constructor() {
    FakeRec.last = this;
  }
  start() {}
  stop() {}
  abort() {}
}

beforeEach(() => {
  window.history.replaceState(null, "", "/a/field-notes");
  vi.stubGlobal("webkitSpeechRecognition", FakeRec);
  Object.defineProperty(navigator, "userActivation", {
    value: { isActive: true },
    configurable: true,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function open(gate: OkGate = GATE) {
  stubApi({
    me: ME,
    config: { ...CONFIG, dictation: true },
    handle: (c) => {
      if (c.path === "/view/art123/dictation") return json({ owner_email: "ada@example.com" });
      if (c.path.startsWith("/view/")) return json(gate);
      if (c.path.includes("/comments")) return json({ items: [] });
      return undefined;
    },
  });
  vi.resetModules();
  const ArtifactPage = (await import("../../pages/ArtifactPage.tsx")).default;
  render(<ArtifactPage params={{ slug: "field-notes" }} />);
  const frame = (await screen.findByTitle("Field notes, version 1")) as HTMLIFrameElement;
  // The test DOM loads no frame pages: a stand-in window receives the app's posts.
  const win = { postMessage: vi.fn() };
  Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
  const fromFrame = (data: Record<string, unknown>) =>
    act(() => {
      const e = new MessageEvent("message", {
        data: { source: "plinth-voice", v: 1, ...data },
        origin: ORIGIN,
      });
      Object.defineProperty(e, "source", { value: win });
      // As after a click in the page: focus is inside the frame.
      const focus = vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
      window.dispatchEvent(e);
      focus.mockRestore();
    });
  return { frame, fromFrame };
}

const menuItems = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Artifact actions" }));
  const names = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
  await user.keyboard("{Escape}");
  return names;
};

describe("dictation in the viewer", () => {
  it("asks, listens with a Stop in the bar, and offers Turn off once allowed", async () => {
    const user = userEvent.setup();
    const { fromFrame } = await open();
    expect(await menuItems(user)).not.toContain("Turn off dictation");
    fromFrame({ type: "start", id: "s1", interim: true });
    const dialog = await screen.findByRole("dialog", { name: "Allow dictation on this page?" });
    expect(dialog.textContent).toContain("Field notes");
    expect(dialog.textContent).toContain("by ada@example.com");
    await act(async () => {
      await new Promise((r) => setTimeout(r, VOICE_LIMITS.dialogArmMs + 50));
    });
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(localStorage.getItem(`${CONSENT_PREFIX}art123`)).toBe("u_viewer1");
    act(() => FakeRec.last?.onstart?.());
    const bar = document.querySelector(".pl-viewer__bar") as HTMLElement;
    await waitFor(() => expect(bar.textContent).toContain("Listening"));
    expect(bar.querySelector(".pl-viewer__listening [role=status]")?.textContent).toBe("Listening");
    await user.click(screen.getByRole("button", { name: "Stop dictation" }));
    await waitFor(() => expect(bar.textContent).not.toContain("Listening"));
    expect(await menuItems(user)).toContain("Turn off dictation");
  });

  it("shows no dictation control or menu entry on a page that does not declare it", async () => {
    const user = userEvent.setup();
    localStorage.setItem(`${CONSENT_PREFIX}art123`, "u_viewer1");
    await open({ ...GATE, voice: undefined });
    expect(document.querySelector(".pl-viewer__listening")).toBeNull();
    expect(await menuItems(user)).not.toContain("Turn off dictation");
  });
});
