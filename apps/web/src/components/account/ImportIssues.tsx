// The cells a refused spreadsheet names, under the dialog's one-line cause: the body of New's
// Import error and of a sheet's Replace problem, so both dialogs read the same. And what an
// import would leave out or change, under Replace's confirmation, in the same list.
import type { SheetImportWarning } from "@plinth/shared";
import { type ImportProblem, warningTexts } from "./newArtifact.ts";
import "./account.css";

/** The listed cells and "and N more", or nothing when the refusal names no cells. */
export function ImportIssues({ problem }: { problem: ImportProblem }) {
  if (problem.issues.length === 0) return null;
  return (
    <>
      <ul className="pl-import-issues">
        {problem.issues.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two issues may read the same
          <li key={i}>{m}</li>
        ))}
      </ul>
      {problem.count > problem.issues.length && (
        <p className="text-muted">{`and ${problem.count - problem.issues.length} more`}</p>
      )}
    </>
  );
}

/** Whether ImportIssues has anything to show (the Dialog renders a body only for children). */
export const hasIssues = (problem: ImportProblem): boolean => problem.issues.length > 0;

/**
 * What the import would leave out or change, one plain sentence each, in a polite live region: it
 * appears with the confirmation, which is announced too.
 */
export function ImportWarnings({ warnings }: { warnings: readonly SheetImportWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div role="status">
      <ul className="pl-import-issues">
        {warningTexts(warnings).map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}
