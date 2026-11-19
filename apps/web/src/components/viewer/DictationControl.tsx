// The listening control in the viewer bar: app chrome, so the page can neither hide nor restyle
// it. While dictation listens it shows a red dot, "Listening" and Stop; the status region stays in
// the bar (empty while idle) so screen readers hear when listening starts and ends. It is never
// folded into the ⋯ menu, at any width.
import { Button } from "../ui/index.ts";
import type { Dictation } from "./useDictation.ts";

export function DictationControl({ dictation }: { dictation: Dictation }) {
  if (!dictation.declared) return null;
  return (
    <span className={`pl-viewer__listening${dictation.listening ? " is-on" : ""}`}>
      <span role="status" aria-live="polite" className="pl-viewer__listening-label">
        {dictation.listening && (
          <>
            <span className="pl-viewer__listening-dot" aria-hidden="true" />
            {dictation.onDevice ? "Listening, on this device" : "Listening"}
          </>
        )}
      </span>
      {dictation.listening && (
        <Button size="sm" variant="secondary" onClick={dictation.stop}>
          Stop
        </Button>
      )}
    </span>
  );
}
