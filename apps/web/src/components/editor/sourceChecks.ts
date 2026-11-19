// What the editor checks in a draft before Save, per artifact type: the same parser the Worker
// runs, so the author sees each problem (with its path) while typing, and Save waits until there
// are none. The Worker refuses the same drafts anyway. A type with a format to check adds one line.
import {
  type ArtifactType,
  BoardContentError,
  parseBoardContent,
  parseDesign,
  parseDesignSystem,
} from "@plinth/shared";

export interface SourceProblem {
  path: string;
  message: string;
}

/** One check per type that has one; one type per line. */
export const SOURCE_CHECKS: Partial<Record<ArtifactType, (text: string) => SourceProblem[]>> = {
  design_system: (text) => {
    const r = parseDesignSystem(text);
    return r.ok ? [] : r.errors;
  },
  design: (text) => {
    const r = parseDesign(text);
    if (r.ok) return [];
    // Shown as <code>path</code> message: the line goes in the path, once.
    return r.issues.map((i) => ({
      path: i.line > 0 ? `line ${i.line}` : "design.html",
      message: i.message.replace(/^Line [0-9]+: /, ""),
    }));
  },
  whiteboard: (text) => {
    try {
      parseBoardContent(text);
      return [];
    } catch (e) {
      if (!(e instanceof BoardContentError)) throw e;
      const message = e.path ? e.message.slice(e.path.length + 2) : e.message;
      return [{ path: e.path || "board.json", message }];
    }
  },
};

/** The draft's problems for its type, or none. */
export function sourceProblems(type: ArtifactType, text: string): SourceProblem[] {
  return SOURCE_CHECKS[type]?.(text) ?? [];
}
