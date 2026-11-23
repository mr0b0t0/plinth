// A design system's draft that only this frame edits (solo mode: no rooms, or a room that never
// answered): the same line projection and the same rules as the room's draft, so every edit and op
// is checked as the room would check it. Leases are granted at once; struct ops apply at once with
// the same pure function. The app publishes the storage form of the lines (designSystemFromLive).
import {
  applyDesignSystemStruct,
  blockLines,
  type DsStructOp,
  type DsStructProblem,
  joinLines,
  type LineRange,
  type LiveStructOp,
  liveRules,
  splitLines,
} from "@plinth/shared";
import type { ClientLease, LiveBackend } from "../common/live.ts";

const RULES = liveRules("design_system");

/** What the editor needs of a design system's draft: the room's (LiveDocClient) or this one. */
export interface SystemBackend extends LiveBackend {
  readonly rev: number;
  readonly baseVersion: number;
  struct(op: LiveStructOp): boolean;
}

export interface LocalEvents {
  granted(l: ClientLease): void;
  changed(): void;
  structLanded(op: LiveStructOp): void;
}

export class LocalSystem implements SystemBackend {
  lines: string[];
  readonly ready = true;
  readonly connected = true;
  readonly settled = true;
  mine: ClientLease | null = null;
  readonly leases = new Map<string, ClientLease>();
  readonly you = { id: "local", email: "", right: "write" as const };
  readonly conflictVersion = null;
  ackedText: string | null = null;
  readonly durableText = null;
  rev = 0;
  readonly baseVersion = 0;
  /** Why the last struct op was not applied. */
  refusal: DsStructProblem | null = null;
  private n = 0;

  constructor(
    /** The base version's projection. */
    public baseText: string,
    private readonly events: LocalEvents,
  ) {
    this.lines = splitLines(baseText);
  }

  get text(): string {
    return joinLines(this.lines);
  }

  get dirty(): boolean {
    return this.text !== this.baseText;
  }

  /**
   * Solo: this text was just published (the app's `saved`): `dirty` compares against it from now
   * on, so a change back to the text the frame loaded is a change again.
   */
  rebase(text: string): void {
    this.baseText = text;
  }

  lease(range: LineRange): boolean {
    const id = `local${++this.n}`;
    this.mine = { id, ...range, by: "", holder: "local", at: Date.now() };
    this.ackedText = joinLines(this.lines.slice(range.start, range.end));
    this.events.granted(this.mine);
    return true;
  }

  /** The room's checks, here: a refused edit changes nothing and says false. */
  edit(text: string): boolean {
    const l = this.mine;
    if (!l || !RULES) return false;
    const ins = blockLines(text);
    if (RULES.checkEdit(this.lines, l.start, l.end - l.start, ins)) return false;
    const next = [...this.lines.slice(0, l.start), ...ins, ...this.lines.slice(l.end)];
    if (RULES.tooLarge(joinLines(next))) return false;
    this.lines = next;
    this.rev++;
    this.mine = { ...l, end: l.start + ins.length, at: Date.now() };
    this.ackedText = text;
    this.events.changed();
    return true;
  }

  release(): void {
    this.mine = null;
    this.events.changed();
  }

  takeover(): boolean {
    return false;
  }

  struct(op: LiveStructOp): boolean {
    const r = applyDesignSystemStruct(this.lines, op as DsStructOp);
    if (typeof r === "string") {
      this.refusal = r;
      return false;
    }
    if (!RULES || RULES.tooLarge(joinLines(r.lines))) {
      this.refusal = "invalid";
      return false;
    }
    this.refusal = null;
    this.mine = null;
    this.lines = r.lines;
    this.rev++;
    this.events.structLanded(op);
    this.events.changed();
    return true;
  }
}
