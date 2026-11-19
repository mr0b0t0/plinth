// What the editor checks in a draft before Save, per artifact type: the same parser the Worker
// runs, so the author sees each problem (with its path) while typing, and Save waits until there
// are none. The Worker refuses the same drafts anyway. A type with a format to check adds one line.
import { type ArtifactType, parseDesignSystem, parseSheet } from "@plinth/shared";

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
  sheet: (text) => {
    const r = parseSheet(text);
    return r.ok
      ? []
      : r.errors.map((e) => ({ path: e.cell ?? `line ${e.line}`, message: e.message }));
  },
};

/** The draft's problems for its type, or none. */
export function sourceProblems(type: ArtifactType, text: string): SourceProblem[] {
  return SOURCE_CHECKS[type]?.(text) ?? [];
}
